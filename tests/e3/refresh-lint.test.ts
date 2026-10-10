// signals refresh and the lint-methods subcommand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoachError } from "../../engine/errors.ts";
import { refreshSignals } from "../../engine/signals-refresh.ts";
import { config } from "../guard/fixtures.ts";
import type { SecretStore } from "../../adapters/signals/oura/secrets.ts";
import { cli, instance, REPO } from "./helpers.ts";

const TOKEN = "secret-access-token-123";
const oura = () => config({ signals: { wearable: "oura", checkin: "chat" } });

class MemStore implements SecretStore {
  values = new Map<string, string>();
  throws = false;
  get(account: string): string | null {
    if (this.throws) throw new CoachError("OURA_KEYCHAIN", "cannot read Keychain item");
    return this.values.get(account) ?? null;
  }
  set(account: string, value: string): void {
    this.values.set(account, value);
  }
}

const signedIn = () => {
  const s = new MemStore();
  s.set("tokens", JSON.stringify({ access_token: TOKEN, refresh_token: "r", expires_at: 0, token_type: "Bearer", saved_at: "x" }));
  return s;
};

test("not configured, not macOS, no Keychain access, no sign-in: nothing fetched, one note why", async () => {
  const never = async () => {
    throw new Error("must not fetch");
  };
  const cases: [Parameters<typeof refreshSignals>[1], Parameters<typeof refreshSignals>[2], RegExp][] = [
    [null, {}, /no coach\.yaml/],
    [config(), { fetchOura: never }, /not configured \(signals\.wearable is apple-health-shortcut\)/],
    [oura(), { platform: "linux", fetchOura: never }, /not macOS \(linux\)/],
    [oura(), { platform: "darwin", store: Object.assign(new MemStore(), { throws: true }), fetchOura: never }, /no Keychain access/],
    [oura(), { platform: "darwin", store: new MemStore(), fetchOura: never }, /no Oura sign-in/],
  ];
  for (const [cfg, deps, note] of cases) {
    const r = await refreshSignals("/nonexistent", cfg, deps);
    assert.equal(r.refreshed, false);
    assert.match(r.note, note);
  }
});

test("configured on a Mac with a sign-in: fetches the last 3 days into the cache", async () => {
  const calls: { days: number; tz: string; root: string }[] = [];
  const r = await refreshSignals("/repo", oura(), {
    platform: "darwin",
    store: signedIn(),
    fetchOura: async (o) => {
      calls.push({ days: o.days, tz: o.tz, root: o.root });
      return { path: "/repo/athlete/.cache/signals/oura.json", from: "2026-10-12", to: "2026-10-14", records: 3, kept: 20, auth: "oauth", warnings: [] };
    },
  });
  assert.deepEqual(calls, [{ days: 3, tz: "America/Los_Angeles", root: "/repo" }]);
  assert.equal(r.refreshed, true);
  assert.match(r.note, /2026-10-12 to 2026-10-14 \(3 records\)/);
});

test("a fetch failure keeps the cache, exits cleanly and never prints a token", async () => {
  const r = await refreshSignals("/repo", oura(), {
    platform: "darwin",
    store: signedIn(),
    fetchOura: async () => {
      throw new Error(`401 for Bearer ${TOKEN}`);
    },
  });
  assert.equal(r.refreshed, false);
  assert.equal(r.error?.code, "INTERNAL");
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test("the real fetch path with a fake HTTP fetch writes the cache (no network)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coach-e3-oura-"));
  const store = new MemStore();
  store.set("tokens", JSON.stringify({ access_token: TOKEN, refresh_token: "r", expires_at: Date.parse("2026-10-14T20:00:00Z"), token_type: "Bearer", saved_at: "2026-10-14T00:00:00Z" }));
  const seen: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    seen.push(String(url));
    const path = new URL(String(url)).pathname;
    const data =
      path.endsWith("/sleep")
        ? [{ id: "s1", day: "2026-10-14", type: "long_sleep", bedtime_start: "2026-10-13T22:30:00-07:00", bedtime_end: "2026-10-14T06:30:00-07:00", total_sleep_duration: 27000, average_hrv: 45, lowest_heart_rate: 52 }]
        : [{ id: "r1", day: "2026-10-14", score: 80, timestamp: "2026-10-14T07:00:00-07:00" }];
    return new Response(JSON.stringify({ data, next_token: null }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const lock = { dir: mkdtempSync(join(tmpdir(), "coach-e3-lock-")) };
  const r = await refreshSignals(dir, oura(), { platform: "darwin", store, fetch: fakeFetch, now: () => Date.parse("2026-10-14T15:00:00Z"), lock });
  assert.equal(r.refreshed, true, r.note);
  assert.ok(seen.every((u) => u.startsWith("https://api.ouraring.com/")));
  const cache = JSON.parse(readFileSync(join(dir, "athlete/.cache/signals/oura.json"), "utf8"));
  assert.equal(cache[0].source, "oura");
  assert.equal(cache[0].hrv.method, "rmssd");
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test("CLI signals refresh: exit 0 with a note when Oura is not configured; plain signals unchanged", () => {
  const dir = instance();
  const r = cli(["signals", "refresh", "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.refreshed, false);
  assert.match(r.json.note, /not configured/);
  const s = cli(["signals", "--from", "2026-10-01", "--to", "2026-10-02", "--root", dir]);
  assert.equal(s.code, 0, s.stderr);
  assert.deepEqual(s.json.records, []);
});

test("CLI lint-methods: the coach.yaml pack passes; a broken pack exits 1 with the errors", () => {
  const dir = instance();
  const ok = cli(["lint-methods", "--root", dir]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json.pack, "nine-adaptations");
  assert.equal(ok.json.ok, true);
  const vol = cli(["lint-methods", "--volume", "--root", dir]);
  assert.ok(Array.isArray(vol.json.volume));

  const bad = mkdtempSync(join(tmpdir(), "coach-e3-lint-"));
  cpSync(join(REPO, "methods"), join(bad, "methods"), { recursive: true });
  const rulesPath = join(bad, "methods/nine-adaptations/rules.yaml");
  writeFileSync(rulesPath, readFileSync(rulesPath, "utf8").replace("type: top_set_jump_max", "type: made_up_check"));
  const r = cli(["lint-methods", "--pack", "nine-adaptations", "--root", bad]);
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.errors.some((e: string) => /made_up_check/.test(e)));
  assert.equal(cli(["lint-methods", "--pack", "../etc", "--root", bad]).code, 2);
  assert.equal(cli(["lint-methods", "--pack", "nope", "--root", bad]).code, 2);
  rmSync(bad, { recursive: true });
});

test("every E3 command has a --help line", () => {
  for (const cmd of [["hold", "init"], ["adjust"], ["loads"], ["proposals"], ["readiness"], ["weeks"], ["block", "draft"], ["ids", "next"], ["signals", "refresh"], ["lint-methods"]]) {
    const r = cli([...cmd, "--help"]);
    assert.equal(r.code, 0, `${cmd.join(" ")}: ${r.stderr}`);
    assert.match(r.json.usage, /§22/, cmd.join(" "));
  }
});

test("the CLI dispatch files import only node builtins and tiny modules at startup", async () => {
  const { readFileSync: read } = await import("node:fs");
  const allowed = new Set(["./errors.ts", "./cli-help.ts"]);
  for (const f of ["engine/cli.ts", "engine/cli-help.ts", "engine/cli-helpers.ts", "engine/cli-helpers2.ts", "engine/cli-core.ts"]) {
    const src = read(join(REPO, f), "utf8");
    for (const m of src.matchAll(/^(?:import|export) (?!type )[^;]*? from "([^"]+)";/gm)) {
      assert.ok(m[1].startsWith("node:") || allowed.has(m[1]), `${f} imports ${m[1]} at startup; import it inside the command`);
    }
  }
  const top = cli(["--help"]);
  assert.equal(top.code, 0);
  assert.match(top.json.usage, /^usage: cli\.ts/);
  assert.ok(top.json.commands["block"]);
});

test("cli-helpers' Tally connector URL equals automation.ts TALLY_CONNECTOR_URL", async () => {
  const { TALLY_URL } = await import("../../engine/cli-helpers.ts");
  const { TALLY_CONNECTOR_URL } = await import("../../engine/automation.ts");
  assert.equal(TALLY_URL, TALLY_CONNECTOR_URL);
});
