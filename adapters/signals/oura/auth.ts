// Oura OAuth (authorization-code flow with PKCE) with the user's own Oura app. Mac only in v1.
//
//   node adapters/signals/oura/auth.ts          # opens the browser, waits for the callback
//
// - The client ID and secret come from the Keychain (service coach-harness.oura, accounts
//   client_id and client_secret). Create the app at https://developer.ouraring.com with the
//   redirect URI http://localhost:8723/callback.
// - The callback server listens on 127.0.0.1 only. Oura's docs do not say whether a
//   127.0.0.1 redirect URI is accepted, so the URI keeps `localhost`. If something else
//   listens on [::1]:8723 (where `localhost` may resolve), the flow stops.
// - PKCE (S256) binds the returned code to this sign-in.
// - Tokens are stored in the Keychain (account `tokens`, a JSON value), under a lock file
//   in ~/.config/coach-harness/.
// - Refresh tokens are single-use (Oura docs). A refresh saves the new tokens and reads
//   them back BEFORE the new access token is returned for use. A refresh response without
//   a new refresh token is an error: the old one is spent, so the user signs in again.
// - Nothing here prints or logs a token, the client secret, or provider text (errors.ts).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { CoachError } from "../../../engine/errors.ts";
import { formatCliError, oauthCode, transportError } from "./errors.ts";
import { withLock, type LockOptions } from "./lock.ts";
import {
  ACCOUNT_CLIENT_ID,
  ACCOUNT_CLIENT_SECRET,
  ACCOUNT_TOKENS,
  KeychainStore,
  storeCommand,
  type SecretStore,
} from "./secrets.ts";

export const AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
export const TOKEN_URL = "https://api.ouraring.com/oauth/token";
export const CALLBACK_PORT = 8723;
export const CALLBACK_HOST = "127.0.0.1";
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
export const SCOPES = "daily heartrate workout session";
/** Refresh this long before the access token expires. */
export const EXPIRY_MARGIN_MS = 5 * 60_000;
/** Default limit for one HTTP request to Oura. */
export const REQUEST_TIMEOUT_MS = 20_000;

const REAUTH = "Run: node adapters/signals/oura/auth.ts";

export type FetchFn = typeof fetch;

export type StoredTokens = {
  access_token: string;
  refresh_token: string;
  /** Epoch milliseconds. */
  expires_at: number;
  token_type: string;
  scope?: string;
  saved_at: string;
};

export type OuraDeps = {
  store: SecretStore;
  fetch: FetchFn;
  lock?: LockOptions;
  /** Epoch milliseconds; injectable for tests. */
  now?: () => number;
  /** Limit for each HTTP request. Default REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
};

export type ClientCreds = { client_id: string; client_secret: string };

export function readClientCreds(store: SecretStore): ClientCreds {
  const client_id = store.get(ACCOUNT_CLIENT_ID);
  const client_secret = store.get(ACCOUNT_CLIENT_SECRET);
  const missing = [!client_id && ACCOUNT_CLIENT_ID, !client_secret && ACCOUNT_CLIENT_SECRET].filter(Boolean) as string[];
  if (missing.length > 0) {
    throw new CoachError(
      "OURA_NOT_CONFIGURED",
      `no Oura ${missing.join(" or ")} in the Keychain. Store each with: ${missing.map((a) => storeCommand(a)).join(" ; ")}`,
    );
  }
  return { client_id: client_id!, client_secret: client_secret! };
}

/** A PKCE pair (RFC 7636): a 43-character verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(clientId: string, state: string, challenge: string, redirectUri = REDIRECT_URI): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

/** POSTs to the token endpoint. Errors carry fixed text and an allowlisted OAuth code only. */
async function postToken(fetchFn: FetchFn, form: Record<string, string>, nowMs: number, timeoutMs: number): Promise<StoredTokens> {
  const refreshing = form.grant_type === "refresh_token";
  let res: Response;
  let body: Record<string, unknown> | null = null;
  try {
    res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    try {
      const parsed: unknown = await res.json();
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch (e) {
      if ((e as { name?: string })?.name === "TimeoutError" || (e as { name?: string })?.name === "AbortError") throw e;
      // Not JSON: handled below without showing the body.
    }
  } catch (e) {
    throw transportError(e, "the Oura token request");
  }
  if (!res.ok) {
    const code = body ? oauthCode(body.error) : "unknown";
    if (refreshing && (res.status === 400 || res.status === 401)) {
      throw new CoachError("OURA_REAUTH", `Oura rejected the refresh token (HTTP ${res.status}, ${code}). ${REAUTH}`);
    }
    throw new CoachError("OURA_TOKEN", `Oura token request failed (HTTP ${res.status}, ${code})`);
  }
  if (!body) throw new CoachError(refreshing ? "OURA_REAUTH" : "OURA_TOKEN", `Oura token response is not JSON${refreshing ? `; the refresh token may be spent. ${REAUTH}` : ""}`);
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new CoachError(refreshing ? "OURA_REAUTH" : "OURA_TOKEN", `Oura token response has no access_token${refreshing ? `. ${REAUTH}` : ""}`);
  }
  if (typeof body.refresh_token !== "string" || body.refresh_token === "") {
    // Never fall back to the old refresh token: it is single-use and now spent.
    if (refreshing) throw new CoachError("OURA_REAUTH", `Oura returned no new refresh token, and the old one is spent. ${REAUTH}`);
    throw new CoachError("OURA_TOKEN", "Oura token response has no refresh_token");
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in);
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: nowMs + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000),
    token_type: "bearer",
    ...(typeof body.scope === "string" && /^[a-z_ ]{0,200}$/.test(body.scope) ? { scope: body.scope } : {}),
    saved_at: new Date(nowMs).toISOString(),
  };
}

export function loadTokens(store: SecretStore): StoredTokens | null {
  const raw = store.get(ACCOUNT_TOKENS);
  if (raw === null) return null;
  let t: StoredTokens;
  try {
    t = JSON.parse(raw);
  } catch {
    throw new CoachError("OURA_TOKEN_STORE", `the Keychain item coach-harness.oura/tokens is not JSON. ${REAUTH}`);
  }
  if (typeof t?.access_token !== "string" || typeof t.refresh_token !== "string" || typeof t.expires_at !== "number") {
    throw new CoachError("OURA_TOKEN_STORE", `the Keychain item coach-harness.oura/tokens is incomplete. ${REAUTH}`);
  }
  return t;
}

/** Saves the tokens, then reads them back. Throws unless the read-back matches exactly. */
export function saveTokensConfirmed(store: SecretStore, tokens: StoredTokens): void {
  const json = JSON.stringify(tokens);
  store.set(ACCOUNT_TOKENS, json);
  if (store.get(ACCOUNT_TOKENS) !== json) {
    throw new CoachError("OURA_TOKEN_SAVE", "the new Oura tokens did not read back from the Keychain; the access token was not used. Run auth again if fetch keeps failing.");
  }
}

export async function exchangeCode(deps: OuraDeps, code: string, verifier: string, redirectUri = REDIRECT_URI): Promise<StoredTokens> {
  const creds = readClientCreds(deps.store);
  const now = deps.now ?? Date.now;
  const tokens = await postToken(
    deps.fetch,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
    },
    now(),
    deps.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );
  await withLock(() => saveTokensConfirmed(deps.store, tokens), deps.lock);
  return tokens;
}

/**
 * Returns a usable access token. Under the lock: reads the stored tokens; when the access
 * token is close to expiry, refreshes, saves and confirms the new tokens, and only then
 * returns the new access token.
 */
export async function getAccessToken(deps: OuraDeps): Promise<string> {
  const now = deps.now ?? Date.now;
  return withLock(async () => {
    const stored = loadTokens(deps.store);
    if (!stored) throw new CoachError("OURA_NOT_AUTHORIZED", `no Oura tokens in the Keychain. ${REAUTH}`);
    if (stored.expires_at - EXPIRY_MARGIN_MS > now()) return stored.access_token;
    const creds = readClientCreds(deps.store);
    const next = await postToken(
      deps.fetch,
      { grant_type: "refresh_token", refresh_token: stored.refresh_token, client_id: creds.client_id, client_secret: creds.client_secret },
      now(),
      deps.timeoutMs ?? REQUEST_TIMEOUT_MS,
    );
    // Order matters: the single-use refresh token is persisted before anything uses the access token.
    saveTokensConfirmed(deps.store, next);
    return next.access_token;
  }, deps.lock);
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const PAGE_OK = "<!doctype html><meta charset=utf-8><title>coach-harness</title><p>Oura is connected. You can close this tab.</p>";
const PAGE_BAD = "<!doctype html><meta charset=utf-8><title>coach-harness</title><p>This callback is not valid for the running sign-in.</p>";

function listenOnce(host: string, port: number, handler?: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  return new Promise((res, rej) => {
    const s = createServer(handler);
    s.once("error", rej);
    s.listen(port, host, () => res(s));
  });
}

/**
 * Refuses to start when another program listens on [::1]:port: a browser that resolves
 * `localhost` to ::1 would send the code there. No IPv6 loopback at all is fine.
 */
async function checkIpv6Free(port: number): Promise<void> {
  try {
    const probe = await listenOnce("::1", port);
    await new Promise<void>((r) => probe.close(() => r()));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" || code === "EACCES") {
      throw new CoachError("OURA_AUTH_PORT", `another program listens on [::1]:${port}; a browser could send the Oura code to it. Stop it and try again.`);
    }
    // EADDRNOTAVAIL / EAFNOSUPPORT: no IPv6 loopback, so localhost resolves to 127.0.0.1.
  }
}

/** Listens on 127.0.0.1 only and resolves with the code. */
async function startCallbackServer(port: number, state: string, timeoutMs: number): Promise<{ done: Promise<string>; close: () => void }> {
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const done = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  // A rejection before anyone awaits must not crash the process.
  done.catch(() => undefined);
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    if (!sameString(url.searchParams.get("state") ?? "", state)) {
      res.writeHead(400, { "Content-Type": "text/html" }).end(PAGE_BAD);
      return;
    }
    const err = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (err !== null || !code) {
      res.writeHead(400, { "Content-Type": "text/html" }).end(PAGE_BAD);
      rejectCode(new CoachError("OURA_AUTH_DENIED", `Oura sign-in did not complete (${err === null ? "no code" : oauthCode(err)})`));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" }).end(PAGE_OK);
    resolveCode(code);
  };
  await checkIpv6Free(port);
  let server: Server;
  try {
    server = await listenOnce(CALLBACK_HOST, port, handler);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new CoachError("OURA_AUTH_PORT", `cannot listen on ${CALLBACK_HOST}:${port}${typeof code === "string" && /^E[A-Z]+$/.test(code) ? ` (${code})` : ""}. Stop the program that uses the port and try again.`);
  }
  const timer = setTimeout(() => rejectCode(new CoachError("OURA_AUTH_TIMEOUT", `no Oura callback within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  return {
    done,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

export type AuthFlowOptions = OuraDeps & {
  port?: number;
  /** How long to wait for the browser callback. Default 5 minutes. */
  callbackTimeoutMs?: number;
  /** Called with the URL to open. Default: print it and run `open`. */
  onUrl?: (url: string) => void;
};

export async function runAuthFlow(opts: AuthFlowOptions): Promise<{ scope?: string; expires_at: number }> {
  const port = opts.port ?? CALLBACK_PORT;
  const redirectUri = `http://localhost:${port}/callback`;
  const creds = readClientCreds(opts.store);
  const state = randomBytes(16).toString("hex");
  const { verifier, challenge } = pkcePair();
  const server = await startCallbackServer(port, state, opts.callbackTimeoutMs ?? opts.timeoutMs ?? 5 * 60_000);
  try {
    (opts.onUrl ?? defaultOnUrl)(authorizeUrl(creds.client_id, state, challenge, redirectUri));
    const code = await server.done;
    const tokens = await exchangeCode(opts, code, verifier, redirectUri);
    return { scope: tokens.scope, expires_at: tokens.expires_at };
  } finally {
    server.close();
  }
}

function defaultOnUrl(url: string): void {
  process.stderr.write(`Open this URL to connect Oura (it opens in your browser now):\n${url}\n`);
  try {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // The URL is printed; the user opens it by hand.
  }
}

async function main(): Promise<number> {
  try {
    const result = await runAuthFlow({ store: new KeychainStore(), fetch });
    process.stdout.write(JSON.stringify({ ok: true, scope: result.scope ?? null, expires_at: new Date(result.expires_at).toISOString() }, null, 2) + "\n");
    return 0;
  } catch (e) {
    const err = formatCliError(e);
    process.stdout.write(JSON.stringify({ error: err }, null, 2) + "\n");
    process.stderr.write(`${err.code}: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
