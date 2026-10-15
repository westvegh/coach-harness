// The Oura adapter: normalization from recorded-shape fixtures (Oura OpenAPI 1.41), token
// refresh ordering, crash recovery, lock contention and the localhost callback.
// No network: every HTTP call goes to a fake fetch. Token values here are dummies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPIRY_MARGIN_MS,
  SCOPES,
  TOKEN_URL,
  authorizeUrl,
  exchangeCode,
  getAccessToken,
  loadTokens,
  runAuthFlow,
  type FetchFn,
  type StoredTokens,
} from "../../adapters/signals/oura/auth.ts";
import { CACHE_RELATIVE, fetchOura, mainSleep, normalizeOura, type OuraReadiness, type OuraSleep } from "../../adapters/signals/oura/fetch.ts";
import { LOCK_NAME, withLock } from "../../adapters/signals/oura/lock.ts";
import type { SecretStore } from "../../adapters/signals/oura/secrets.ts";
import { CoachError } from "../../engine/errors.ts";
import type { DayRecord } from "../../engine/types.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/oura/${name}`, import.meta.url), "utf8"));
const SLEEP: OuraSleep[] = [...fixture("sleep-page1.json").data, ...fixture("sleep-page2.json").data];
const READINESS: OuraReadiness[] = fixture("daily_readiness.json").data;

const T0 = Date.parse("2026-10-10T08:00:00-07:00");
const CLIENT_SECRET = "dummy-client-secret-value";

class MemoryStore implements SecretStore {
  items = new Map<string, string>();
  log: string[] = [];
  failSet = false;
  dropWrites = false;
  get(account: string): string | null {
    this.log.push(`get:${account}`);
    return this.items.get(account) ?? null;
  }
  set(account: string, value: string): void {
    this.log.push(`set:${account}`);
    if (this.failSet) throw new CoachError("OURA_KEYCHAIN", "write failed");
    if (!this.dropWrites) this.items.set(account, value);
  }
}

function configured(tokens?: Partial<StoredTokens>): MemoryStore {
  const s = new MemoryStore();
  s.items.set("client_id", "dummy-client-id");
  s.items.set("client_secret", CLIENT_SECRET);
  if (tokens) {
    s.items.set(
      "tokens",
      JSON.stringify({ access_token: "access-0", refresh_token: "refresh-0", expires_at: T0 + 3600_000, token_type: "bearer", saved_at: "x", ...tokens }),
    );
  }
  return s;
}

type Call = { url: string; init?: RequestInit };

/** A fake fetch: the token endpoint issues access-N/refresh-N; API paths answer from `routes`. */
function fakeFetch(opts: { routes?: Record<string, unknown[]>; tokenStatus?: number; onToken?: () => void } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const fn: FetchFn = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === TOKEN_URL) {
      opts.onToken?.();
      if (opts.tokenStatus && opts.tokenStatus !== 200) return Response.json({ error: "invalid_grant" }, { status: opts.tokenStatus });
      n++;
      return Response.json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 86400, token_type: "bearer", scope: SCOPES });
    }
    const path = new URL(url).pathname;
    const pages = opts.routes?.[path];
    if (!pages) return new Response("not found", { status: 404 });
    const nextToken = new URL(url).searchParams.get("next_token");
    return Response.json(pages[nextToken ? Number(nextToken.replace("page-", "")) - 1 : 0]);
  };
  return { fn, calls };
}

function form(c: Call): URLSearchParams {
  return new URLSearchParams(String(c.init?.body));
}

function lockDir(): string {
  return mkdtempSync(join(tmpdir(), "coach-oura-lock-"));
}

// ---------- normalization ----------

test("mainSleep: the long_sleep wins over a nap, deleted and rest are ignored", () => {
  assert.equal(mainSleep(SLEEP.filter((s) => s.day === "2026-10-09"))?.id, "8f9a5221-639e-4a85-81cb-4065ef23f979");
  assert.equal(mainSleep(SLEEP.filter((s) => s.day === "2026-10-10"))?.type, "long_sleep");
  assert.equal(mainSleep([{ ...SLEEP[0], type: "deleted" }, { ...SLEEP[0], type: "rest" }]), undefined);
});

test("normalizeOura: RMSSD HRV, lowest HR, main period, readiness score", () => {
  const { records, warnings } = normalizeOura(SLEEP, READINESS, { from: "2026-10-08", to: "2026-10-10" });
  assert.deepEqual(warnings, []);
  assert.deepEqual(records, [
    { date: "2026-10-08", source: "oura", observed_at: "2026-10-08T00:00:00.000-07:00", complete: false, vendor_score: 77, temperature: { deviation_c: 0.12 } },
    {
      date: "2026-10-09",
      source: "oura",
      observed_at: "2026-10-09T06:52:31-07:00",
      complete: true,
      sleep: { duration_min: 391, start_at: "2026-10-08T22:41:01-07:00", end_at: "2026-10-09T06:52:31-07:00", efficiency: 89 },
      hrv: { value_ms: 48, method: "rmssd" },
      rhr: { bpm: 51 },
      vendor_score: 82,
      temperature: { deviation_c: -0.11 },
    },
    {
      date: "2026-10-10",
      source: "oura",
      observed_at: "2026-10-10T06:31:12-07:00",
      complete: true,
      sleep: { duration_min: 368, start_at: "2026-10-09T23:12:44-07:00", end_at: "2026-10-10T06:31:12-07:00", efficiency: 84 },
      hrv: { value_ms: 39, method: "rmssd" },
      rhr: { bpm: 55 },
      vendor_score: 71,
      temperature: { deviation_c: 0.21 },
    },
  ]);
});

test("normalizeOura: temperature accepts bounds and zero, drops missing or invalid values", () => {
  const range = { from: "2026-10-09", to: "2026-10-09" };
  const ready = READINESS.find((r) => r.day === range.from)!;
  for (const sleep of [[], SLEEP.filter((s) => s.day === range.from)]) {
    for (const value of [-5, 0, 5, null, undefined, "x", Number.NaN, Infinity, -Infinity, -6, 9]) {
      const input = { ...ready, temperature_deviation: value };
      if (value === undefined) delete input.temperature_deviation;
      const { records, warnings } = normalizeOura(sleep, [input as OuraReadiness], range);
      assert.equal(records.length, 1, `record kept for ${value}`);
      if (typeof value === "number" && Number.isFinite(value) && value >= -5 && value <= 5) {
        assert.deepEqual(records[0].temperature, { deviation_c: value });
      } else {
        assert.equal("temperature" in records[0], false);
      }
      assert.deepEqual(warnings, value === -6 || value === 9 ? ["daily_readiness on 2026-10-09: temperature_deviation out of range; dropped"] : []);
    }
  }
});

test("normalizeOura: a readiness-only temperature record needs no score", () => {
  const ready = { ...READINESS[0], score: null, temperature_deviation: 0.12 };
  const { records, warnings } = normalizeOura([], [ready], { from: ready.day, to: ready.day });
  assert.deepEqual(warnings, []);
  assert.deepEqual(records, [{ date: ready.day, source: "oura", observed_at: ready.timestamp, complete: false, temperature: { deviation_c: 0.12 } }]);
});

test("normalizeOura: nulls are dropped, a short main sleep is incomplete, bad instants warn", () => {
  const s: OuraSleep = { ...SLEEP[1], day: "2026-10-09", type: "sleep", average_hrv: null, lowest_heart_rate: null };
  const { records } = normalizeOura([s], [], { from: "2026-10-09", to: "2026-10-09" });
  assert.equal(records[0].complete, false);
  assert.equal(records[0].hrv, undefined);
  assert.equal(records[0].rhr, undefined);
  const bad = normalizeOura([{ ...SLEEP[0], bedtime_end: "2026-10-09 06:52" }], [], { from: "2026-10-09", to: "2026-10-09" });
  assert.deepEqual(bad.records, []);
  assert.match(bad.warnings[0], /bedtime is not an ISO instant/);
});

// ---------- auth ----------

test("authorizeUrl asks for exactly the brief's scopes and the localhost:8723 callback", () => {
  const u = new URL(authorizeUrl("dummy-client-id", "s1", "challenge"));
  assert.equal(u.origin + u.pathname, "https://cloud.ouraring.com/oauth/authorize");
  assert.equal(u.searchParams.get("scope"), "daily heartrate workout session");
  assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:8723/callback");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("state"), "s1");
});

test("missing client credentials name the Keychain command", async () => {
  const s = new MemoryStore();
  await assert.rejects(exchangeCode({ store: s, fetch: fakeFetch().fn, lock: { dir: lockDir() } }, "code", "v".repeat(43)), (e: unknown) => {
    return e instanceof CoachError && e.code === "OURA_NOT_CONFIGURED" && /security add-generic-password -U -s coach-harness\.oura -a client_id -w/.test(e.message);
  });
});

test("exchangeCode stores the tokens in the Keychain item `tokens`", async () => {
  const s = configured();
  const f = fakeFetch();
  await exchangeCode({ store: s, fetch: f.fn, lock: { dir: lockDir() }, now: () => T0 }, "the-code", "v".repeat(43));
  const sent = form(f.calls[0]);
  assert.equal(sent.get("grant_type"), "authorization_code");
  assert.equal(sent.get("code"), "the-code");
  assert.equal(sent.get("redirect_uri"), "http://localhost:8723/callback");
  const t = loadTokens(s)!;
  assert.equal(t.access_token, "access-1");
  assert.equal(t.refresh_token, "refresh-1");
  assert.equal(t.expires_at, T0 + 86400_000);
});

test("a valid access token is used without a refresh", async () => {
  const s = configured({});
  const f = fakeFetch();
  assert.equal(await getAccessToken({ store: s, fetch: f.fn, lock: { dir: lockDir() }, now: () => T0 }), "access-0");
  assert.equal(f.calls.length, 0);
});

test("refresh: the new tokens are saved and read back before the access token is returned", async () => {
  const s = configured({ expires_at: T0 + EXPIRY_MARGIN_MS - 1 });
  const f = fakeFetch();
  const token = await getAccessToken({ store: s, fetch: f.fn, lock: { dir: lockDir() }, now: () => T0 });
  assert.equal(token, "access-1");
  assert.equal(form(f.calls[0]).get("refresh_token"), "refresh-0");
  assert.equal(form(f.calls[0]).get("grant_type"), "refresh_token");
  // Order in the store: read tokens, read creds, write tokens, read them back.
  const tail = s.log.slice(s.log.indexOf("set:tokens"));
  assert.deepEqual(tail, ["set:tokens", "get:tokens"]);
  assert.equal(loadTokens(s)!.refresh_token, "refresh-1");
});

test("refresh: a crash between the save and the use loses nothing; the next run uses the new refresh token", async () => {
  const s = configured({ expires_at: T0 - 1 });
  const f = fakeFetch();
  const dir = lockDir();
  // Run 1: refresh succeeds and is saved, then the process "crashes" before using the token.
  await assert.rejects(
    (async () => {
      await getAccessToken({ store: s, fetch: f.fn, lock: { dir }, now: () => T0 });
      throw new Error("simulated crash before the access token is used");
    })(),
    /simulated crash/,
  );
  assert.equal(loadTokens(s)!.refresh_token, "refresh-1");
  assert.equal(existsSync(join(dir, LOCK_NAME)), false, "the lock is released");
  // Run 2, after expiry: it spends refresh-1 (the saved one), never the spent refresh-0.
  const later = T0 + 2 * 86400_000;
  assert.equal(await getAccessToken({ store: s, fetch: f.fn, lock: { dir }, now: () => later }), "access-2");
  assert.deepEqual(f.calls.map((c) => form(c).get("refresh_token")), ["refresh-0", "refresh-1"]);
});

test("refresh: when the save fails or does not read back, the access token is never returned", async () => {
  for (const mode of ["failSet", "dropWrites"] as const) {
    const s = configured({ expires_at: T0 - 1 });
    s[mode] = true;
    await assert.rejects(getAccessToken({ store: s, fetch: fakeFetch().fn, lock: { dir: lockDir() }, now: () => T0 }), (e: unknown) => {
      return e instanceof CoachError && (e.code === "OURA_KEYCHAIN" || e.code === "OURA_TOKEN_SAVE") && !/access-1|refresh-1/.test(e.message);
    });
  }
});

test("refresh: a rejected refresh token asks for a new sign-in and leaks nothing", async () => {
  const s = configured({ expires_at: T0 - 1 });
  await assert.rejects(getAccessToken({ store: s, fetch: fakeFetch({ tokenStatus: 400 }).fn, lock: { dir: lockDir() }, now: () => T0 }), (e: unknown) => {
    return e instanceof CoachError && e.code === "OURA_REAUTH" && !e.message.includes("refresh-0") && !e.message.includes(CLIENT_SECRET);
  });
});

test("no tokens yet → run auth", async () => {
  await assert.rejects(getAccessToken({ store: configured(), fetch: fakeFetch().fn, lock: { dir: lockDir() } }), (e: unknown) => e instanceof CoachError && e.code === "OURA_NOT_AUTHORIZED");
});

// ---------- lock ----------

test("lock contention: a second refresh waits, then times out with OURA_LOCKED", async () => {
  const dir = lockDir();
  let release!: () => void;
  const held = withLock(() => new Promise<void>((r) => (release = r)), { dir });
  await new Promise((r) => setTimeout(r, 20));
  const s = configured({ expires_at: T0 - 1 });
  const f = fakeFetch();
  await assert.rejects(getAccessToken({ store: s, fetch: f.fn, lock: { dir, timeoutMs: 150, pollMs: 10 }, now: () => T0 }), (e: unknown) => e instanceof CoachError && e.code === "OURA_LOCKED");
  assert.equal(f.calls.length, 0, "no refresh while another holds the lock");
  release();
  await held;
  assert.equal(await getAccessToken({ store: s, fetch: f.fn, lock: { dir, timeoutMs: 150, pollMs: 10 }, now: () => T0 }), "access-1");
});

test("lock contention: two concurrent refreshes spend the refresh token once", async () => {
  const s = configured({ expires_at: T0 - 1 });
  const f = fakeFetch();
  const dir = lockDir();
  const deps = { store: s, fetch: f.fn, lock: { dir, pollMs: 5 }, now: () => T0 };
  const [a, b] = await Promise.all([getAccessToken(deps), getAccessToken(deps)]);
  assert.equal(a, "access-1");
  assert.equal(b, "access-1");
  assert.equal(f.calls.length, 1);
});

test("lock: a lock left by a dead process is broken", async () => {
  const dir = lockDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ pid: 2 ** 22 + 12345, at: "2026-01-01T00:00:00Z" }));
  assert.equal(await withLock(() => "ran", { dir, timeoutMs: 500, pollMs: 5 }), "ran");
  assert.equal(existsSync(join(dir, LOCK_NAME)), false);
});

// ---------- the callback flow ----------

test("runAuthFlow: a wrong state is refused, the right one stores tokens", async () => {
  const s = configured();
  const f = fakeFetch();
  const port = 18000 + Math.floor(Math.random() * 2000);
  let authUrl = "";
  const flow = runAuthFlow({
    store: s,
    fetch: f.fn,
    lock: { dir: lockDir() },
    now: () => T0,
    port,
    timeoutMs: 5000,
    onUrl: (u) => (authUrl = u),
  });
  while (!authUrl) await new Promise((r) => setTimeout(r, 5));
  const state = new URL(authUrl).searchParams.get("state")!;
  assert.equal(new URL(authUrl).searchParams.get("redirect_uri"), `http://localhost:${port}/callback`);
  const bad = await fetch(`http://127.0.0.1:${port}/callback?code=evil&state=wrong`);
  assert.equal(bad.status, 400);
  const good = await fetch(`http://127.0.0.1:${port}/callback?code=good-code&state=${state}`);
  assert.equal(good.status, 200);
  const result = await flow;
  assert.equal(result.scope, SCOPES);
  assert.equal(form(f.calls[0]).get("code"), "good-code");
  assert.equal(loadTokens(s)!.access_token, "access-1");
});

// ---------- fetch ----------

function repo(): string {
  return mkdtempSync(join(tmpdir(), "coach-oura-repo-"));
}

test("fetchOura: paginates, normalizes and merges into the cache, keeping older dates", async () => {
  const root = repo();
  const cache = join(root, CACHE_RELATIVE);
  mkdirSync(join(root, "athlete/.cache/signals"), { recursive: true });
  writeFileSync(
    cache,
    JSON.stringify([
      { date: "2026-09-01", source: "oura", observed_at: "2026-09-01T06:00:00-07:00", complete: true, hrv: { value_ms: 50, method: "rmssd" }, temperature: { deviation_c: -0.2 } },
      { date: "2026-10-09", source: "oura", observed_at: "2026-10-09T06:00:00-07:00", complete: false },
    ]),
  );
  const f = fakeFetch({
    routes: {
      "/v2/usercollection/sleep": [fixture("sleep-page1.json"), fixture("sleep-page2.json")],
      "/v2/usercollection/daily_readiness": [fixture("daily_readiness.json")],
    },
  });
  const s = configured({});
  const r = await fetchOura({ root, days: 3, tz: "America/Los_Angeles", deps: { store: s, fetch: f.fn, lock: { dir: lockDir() }, now: () => T0 } });
  assert.deepEqual({ from: r.from, to: r.to, records: r.records, kept: r.kept, auth: r.auth }, { from: "2026-10-08", to: "2026-10-10", records: 3, kept: 1, auth: "oauth" });
  const api = f.calls.map((c) => new URL(c.url));
  assert.deepEqual(api.map((u) => u.pathname), ["/v2/usercollection/sleep", "/v2/usercollection/sleep", "/v2/usercollection/daily_readiness"]);
  assert.equal(api[0].searchParams.get("start_date"), "2026-10-08");
  assert.equal(api[0].searchParams.get("end_date"), "2026-10-11");
  assert.equal(api[1].searchParams.get("next_token"), "page-2");
  assert.equal((f.calls[0].init?.headers as Record<string, string>).Authorization, "Bearer access-0");
  const written = JSON.parse(readFileSync(cache, "utf8"));
  assert.deepEqual(written.map((x: { date: string }) => x.date), ["2026-09-01", "2026-10-08", "2026-10-09", "2026-10-10"]);
  assert.equal(written[2].complete, true, "the fetched record replaced the stale one");
  assert.deepEqual(written.map((x: DayRecord) => x.temperature), [{ deviation_c: -0.2 }, { deviation_c: 0.12 }, { deviation_c: -0.11 }, { deviation_c: 0.21 }]);
});

test("fetchOura: the legacy personal token works with a warning and skips OAuth", async () => {
  const root = repo();
  const warnings: string[] = [];
  const f = fakeFetch({ routes: { "/v2/usercollection/sleep": [{ data: [], next_token: null }], "/v2/usercollection/daily_readiness": [{ data: [], next_token: null }] } });
  const s = new MemoryStore();
  const r = await fetchOura({ root, days: 1, tz: "America/Los_Angeles", personalToken: "dummy-personal", warn: (m) => warnings.push(m), deps: { store: s, fetch: f.fn, now: () => T0 } });
  assert.equal(r.auth, "personal-token");
  assert.match(warnings[0], /deprecated/);
  assert.deepEqual(s.log, [], "the Keychain is not touched");
  assert.equal((f.calls[0].init?.headers as Record<string, string>).Authorization, "Bearer dummy-personal");
  assert.deepEqual(JSON.parse(readFileSync(join(root, CACHE_RELATIVE), "utf8")), []);
});

test("fetchOura: 401 asks for auth; bad --days is a usage error", async () => {
  const f: FetchFn = async () => new Response("", { status: 401 });
  await assert.rejects(
    fetchOura({ root: repo(), days: 1, tz: "UTC", personalToken: "dummy", deps: { store: new MemoryStore(), fetch: f, now: () => T0 } }),
    (e: unknown) => e instanceof CoachError && e.code === "OURA_UNAUTHORIZED",
  );
  await assert.rejects(
    fetchOura({ root: repo(), days: 0, tz: "UTC", personalToken: "dummy", deps: { store: new MemoryStore(), fetch: f } }),
    (e: unknown) => e instanceof CoachError && e.code === "USAGE",
  );
});
