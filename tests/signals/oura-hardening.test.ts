// no provider or transport text in errors,
// a lock that never breaks a live owner, no reuse of a spent refresh token, PKCE,
// IPv4-only callback, explicit timeouts. No network: fake fetch and local sockets only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOKEN_URL,
  authorizeUrl,
  exchangeCode,
  getAccessToken,
  loadTokens,
  pkcePair,
  runAuthFlow,
  type FetchFn,
} from "../../adapters/signals/oura/auth.ts";
import { formatCliError } from "../../adapters/signals/oura/errors.ts";
import { fetchOura } from "../../adapters/signals/oura/fetch.ts";
import { LOCK_NAME, breakIfStale, processStartTime, withLock } from "../../adapters/signals/oura/lock.ts";
import type { SecretStore } from "../../adapters/signals/oura/secrets.ts";
import { CoachError } from "../../engine/errors.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const SECRET = "SECRET-ECHO-7f3a9c2e";
const T0 = Date.parse("2026-10-10T08:00:00-07:00");

class MemoryStore implements SecretStore {
  items = new Map<string, string>();
  get(a: string) {
    return this.items.get(a) ?? null;
  }
  set(a: string, v: string) {
    this.items.set(a, v);
  }
}

function store(expiresAt = T0 - 1): MemoryStore {
  const s = new MemoryStore();
  s.items.set("client_id", "dummy-client-id");
  s.items.set("client_secret", "dummy-client-secret");
  s.items.set("tokens", JSON.stringify({ access_token: "access-0", refresh_token: "refresh-0", expires_at: expiresAt, token_type: "bearer", saved_at: "x" }));
  return s;
}

const lockDir = () => mkdtempSync(join(tmpdir(), "coach-oura-lock-"));
const repo = () => mkdtempSync(join(tmpdir(), "coach-oura-repo-"));

function noSecret(e: unknown): boolean {
  const text = e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ""}` : String(e);
  return !text.includes(SECRET);
}

// ---------- P1: no provider or transport text in errors ----------

test("leak: token endpoint errors never carry provider or transport text", async () => {
  const cases: [string, FetchFn][] = [
    ["transport error", async () => { throw new Error(`connect failed: ${SECRET}`); }],
    ["unknown OAuth error code", async () => Response.json({ error: SECRET, error_description: SECRET }, { status: 400 })],
    ["error description", async () => Response.json({ error: "invalid_grant", error_description: SECRET }, { status: 400 })],
    ["non-JSON error body", async () => new Response(`<html>${SECRET}</html>`, { status: 502 })],
    ["non-JSON success body", async () => new Response(`{"access_token": ${SECRET}`, { status: 200 })],
  ];
  for (const [name, f] of cases) {
    await assert.rejects(getAccessToken({ store: store(), fetch: f, lock: { dir: lockDir() }, now: () => T0 }), (e: unknown) => {
      assert.ok(e instanceof CoachError, `${name}: CoachError`);
      assert.ok(noSecret(e), `${name}: leaked: ${(e as Error).message}`);
      return true;
    });
  }
  // A known OAuth code is still shown.
  await assert.rejects(
    getAccessToken({ store: store(), fetch: async () => Response.json({ error: "invalid_grant", error_description: SECRET }, { status: 400 }), lock: { dir: lockDir() }, now: () => T0 }),
    (e: unknown) => e instanceof CoachError && e.code === "OURA_REAUTH" && /invalid_grant/.test(e.message) && noSecret(e),
  );
});

test("leak: data fetch errors never carry provider or transport text", async () => {
  const cases: [string, FetchFn][] = [
    ["transport error", async () => { throw new TypeError(`fetch failed ${SECRET}`); }],
    ["invalid JSON", async () => new Response(`{"data": [${SECRET}`, { status: 200 })],
    ["retry-after header", async () => new Response("", { status: 429, headers: { "retry-after": SECRET } })],
    ["500 body", async () => new Response(SECRET, { status: 500 })],
  ];
  for (const [name, f] of cases) {
    await assert.rejects(
      fetchOura({ root: repo(), days: 1, tz: "UTC", personalToken: "dummy", deps: { store: new MemoryStore(), fetch: f, now: () => T0 } }),
      (e: unknown) => {
        assert.ok(e instanceof CoachError, `${name}: CoachError`);
        assert.ok(noSecret(e), `${name}: leaked: ${(e as Error).message}`);
        return true;
      },
    );
  }
});

test("leak: the CLI error formatter never prints an unexpected error's message", () => {
  const out = formatCliError(new Error(`boom ${SECRET}`));
  assert.equal(out.code, "INTERNAL");
  assert.ok(!JSON.stringify(out).includes(SECRET));
  assert.deepEqual(formatCliError(new CoachError("OURA_LOCKED", "fixed text")), { code: "OURA_LOCKED", message: "fixed text" });
});

// ---------- P1: a missing replacement refresh token ----------

test("refresh: a response without a new refresh_token requires sign-in and never reuses the old one", async () => {
  const s = store();
  const before = s.items.get("tokens");
  const f: FetchFn = async () => Response.json({ access_token: "access-1", expires_in: 86400, token_type: "bearer" });
  await assert.rejects(getAccessToken({ store: s, fetch: f, lock: { dir: lockDir() }, now: () => T0 }), (e: unknown) => {
    return e instanceof CoachError && e.code === "OURA_REAUTH" && !e.message.includes("access-1");
  });
  assert.equal(s.items.get("tokens"), before, "the spent refresh token is not saved again as if it were new");
  // Also when the code exchange gives no refresh token.
  await assert.rejects(exchangeCode({ store: store(), fetch: f, lock: { dir: lockDir() }, now: () => T0 }, "code", "v".repeat(43)), (e: unknown) => e instanceof CoachError && e.code === "OURA_TOKEN");
});

// ---------- P1: the lock ----------

function lockFile(dir: string) {
  return join(dir, LOCK_NAME);
}

function writeLock(dir: string, owner: Record<string, unknown> | string, ageMs = 0) {
  mkdirSync(dir, { recursive: true });
  const p = lockFile(dir);
  writeFileSync(p, typeof owner === "string" ? owner : JSON.stringify(owner));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(p, t, t);
}

test("lock: an abandoned lock from a killed process is recovered", async () => {
  const dir = lockDir();
  const script = `
    const { withLock } = await import(${JSON.stringify(join(REPO, "adapters/signals/oura/lock.ts"))});
    await withLock(() => { process.kill(process.pid, "SIGKILL"); return new Promise(() => {}); }, { dir: process.argv[1] });
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, dir], { encoding: "utf8" });
  assert.equal(r.signal, "SIGKILL", r.stderr);
  assert.ok(existsSync(lockFile(dir)), "the killed process left its lock behind");
  assert.equal(await withLock(() => "recovered", { dir, timeoutMs: 2000, pollMs: 10 }), "recovered");
  assert.equal(existsSync(lockFile(dir)), false);
});

test("lock: a live owner is never broken, however old its lock", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const dir = lockDir();
    const start = processStartTime(child.pid!);
    assert.ok(start, "ps reports the child's start time");
    writeLock(dir, { pid: child.pid, start, nonce: "live-owner", at: "2026-01-01T00:00:00Z" }, 3600_000);
    await assert.rejects(withLock(() => "stolen", { dir, timeoutMs: 300, pollMs: 10 }), (e: unknown) => e instanceof CoachError && e.code === "OURA_LOCKED");
    assert.match(readFileSync(lockFile(dir), "utf8"), /live-owner/, "the live owner's lock is intact");
  } finally {
    child.kill("SIGKILL");
  }
});

test("lock: a reused pid (alive, different start time) is a dead owner", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const dir = lockDir();
    writeLock(dir, { pid: child.pid, start: "Thu Jan  1 00:00:00 1970", nonce: "old-owner", at: "1970-01-01T00:00:00Z" });
    assert.equal(await withLock(() => "ok", { dir, timeoutMs: 1000, pollMs: 10 }), "ok");
  } finally {
    child.kill("SIGKILL");
  }
});

test("lock: an empty or corrupt lock file is recovered after the grace period, not before", async () => {
  for (const content of ["", "{\"pid\": 12", "null"]) {
    const dir = lockDir();
    writeLock(dir, content, 60_000);
    assert.equal(await withLock(() => "ok", { dir, timeoutMs: 1000, pollMs: 10 }), "ok", JSON.stringify(content));
  }
  const fresh = lockDir();
  writeLock(fresh, "");
  await assert.rejects(withLock(() => "early", { dir: fresh, timeoutMs: 100, pollMs: 10, corruptGraceMs: 10_000 }), (e: unknown) => e instanceof CoachError && e.code === "OURA_LOCKED");
});

test("lock: a breaker verifies ownership; a lock replaced since it was judged stale is kept", () => {
  const dir = lockDir();
  const stale = JSON.stringify({ pid: 2 ** 22 + 4321, start: "x", nonce: "dead", at: "x" });
  const live = JSON.stringify({ pid: process.pid, start: processStartTime(process.pid), nonce: "new-owner", at: "x" });
  writeLock(dir, live);
  assert.equal(breakIfStale(lockFile(dir), stale), false);
  assert.equal(readFileSync(lockFile(dir), "utf8"), live);
  writeLock(dir, stale);
  assert.equal(breakIfStale(lockFile(dir), stale), true);
  assert.equal(existsSync(lockFile(dir)), false);
});

test("lock: release never deletes a lock owned by someone else", async () => {
  const dir = lockDir();
  const other = JSON.stringify({ pid: process.pid, start: processStartTime(process.pid), nonce: "someone-else", at: "x" });
  await withLock(() => writeFileSync(lockFile(dir), other), { dir });
  assert.equal(readFileSync(lockFile(dir), "utf8"), other);
});

// ---------- P2: PKCE ----------

test("PKCE: S256 challenge on authorize, verifier on the exchange", async () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  const u = new URL(authorizeUrl("dummy-client-id", "s1", challenge));
  assert.equal(u.searchParams.get("code_challenge"), challenge);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");

  let body = new URLSearchParams();
  const f: FetchFn = async (_u, init) => {
    body = new URLSearchParams(String(init?.body));
    return Response.json({ access_token: "a", refresh_token: "r", expires_in: 60 });
  };
  const s = new MemoryStore();
  s.items.set("client_id", "id");
  s.items.set("client_secret", "secret");
  await exchangeCode({ store: s, fetch: f, lock: { dir: lockDir() }, now: () => T0 }, "code", verifier);
  assert.equal(body.get("code_verifier"), verifier);
});

// ---------- P2: callback binding ----------

const freePort = () => 20000 + Math.floor(Math.random() * 5000);

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ host, port });
    sock.once("connect", () => {
      sock.destroy();
      res(true);
    });
    sock.once("error", () => res(false));
  });
}

function listen(host: string, port: number): Promise<Server | null> {
  return new Promise((res) => {
    const s = createServer((_q, r) => r.end("other"));
    s.once("error", () => res(null));
    s.listen(port, host, () => res(s));
  });
}

test("callback: listens on 127.0.0.1 only, with PKCE in the URL and the verifier on the exchange", async () => {
  const s = new MemoryStore();
  s.items.set("client_id", "id");
  s.items.set("client_secret", "secret");
  let body = new URLSearchParams();
  const f: FetchFn = async (_u, init) => {
    body = new URLSearchParams(String(init?.body));
    return Response.json({ access_token: "a", refresh_token: "r", expires_in: 60 });
  };
  const port = freePort();
  let url = "";
  const flow = runAuthFlow({ store: s, fetch: f, lock: { dir: lockDir() }, now: () => T0, port, timeoutMs: 5000, onUrl: (u) => (url = u) });
  while (!url) await new Promise((r) => setTimeout(r, 5));
  assert.equal(await canConnect("::1", port), false, "nothing of ours on ::1");
  const u = new URL(url);
  await fetch(`http://127.0.0.1:${port}/callback?code=c&state=${u.searchParams.get("state")}`);
  await flow;
  assert.equal(createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url"), u.searchParams.get("code_challenge"));
});

test("callback: fails loudly when 127.0.0.1 is taken, or when another listener holds ::1", async () => {
  const s = new MemoryStore();
  s.items.set("client_id", "id");
  s.items.set("client_secret", "secret");
  const deps = { store: s, fetch: (async () => Response.json({})) as FetchFn, lock: { dir: lockDir() }, timeoutMs: 2000, onUrl: () => undefined };

  const p4 = freePort();
  const v4 = await listen("127.0.0.1", p4);
  assert.ok(v4);
  await assert.rejects(runAuthFlow({ ...deps, port: p4 }), (e: unknown) => e instanceof CoachError && e.code === "OURA_AUTH_PORT");
  v4.close();

  const p6 = freePort();
  const v6 = await listen("::1", p6);
  if (!v6) return; // no IPv6 loopback on this machine
  await assert.rejects(runAuthFlow({ ...deps, port: p6 }), (e: unknown) => e instanceof CoachError && e.code === "OURA_AUTH_PORT" && /::1/.test(e.message));
  v6.close();
});

test("callback: an error parameter is reported by allowlisted code only", async () => {
  const s = new MemoryStore();
  s.items.set("client_id", "id");
  s.items.set("client_secret", "secret");
  const port = freePort();
  let url = "";
  const flow = runAuthFlow({ store: s, fetch: (async () => Response.json({})) as FetchFn, lock: { dir: lockDir() }, port, timeoutMs: 5000, onUrl: (u) => (url = u) });
  const settled = assert.rejects(flow, (e: unknown) => e instanceof CoachError && e.code === "OURA_AUTH_DENIED" && noSecret(e));
  while (!url) await new Promise((r) => setTimeout(r, 5));
  await fetch(`http://127.0.0.1:${port}/callback?error=${SECRET}&state=${new URL(url).searchParams.get("state")}`);
  await settled;
});

// ---------- P2: explicit timeouts ----------

const hang: FetchFn = (_u, init) =>
  new Promise((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
  });

test("timeout: the token request is aborted after timeoutMs", { timeout: 3000 }, async () => {
  await assert.rejects(getAccessToken({ store: store(), fetch: hang, lock: { dir: lockDir() }, now: () => T0, timeoutMs: 50 }), (e: unknown) => e instanceof CoachError && e.code === "OURA_TIMEOUT");
});

test("timeout: a data request is aborted after timeoutMs", { timeout: 3000 }, async () => {
  await assert.rejects(
    fetchOura({ root: repo(), days: 1, tz: "UTC", personalToken: "dummy", deps: { store: new MemoryStore(), fetch: hang, now: () => T0, timeoutMs: 50 } }),
    (e: unknown) => e instanceof CoachError && e.code === "OURA_TIMEOUT",
  );
});

test("token URL constant is the documented one", () => {
  assert.equal(TOKEN_URL, "https://api.ouraring.com/oauth/token");
  assert.equal(loadTokens(store())?.refresh_token, "refresh-0");
});
