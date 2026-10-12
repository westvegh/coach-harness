// Smoke tests: each CLI subcommand runs as a real process and prints JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const CLI = join(REPO, "engine/cli.ts");

// An attended run: the unattended markers would change some commands.
const ATTENDED = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDE_CODE_REMOTE" && k !== "COACH_UNATTENDED"));

function cli(args: string[], cwd = REPO) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: ATTENDED });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-cli-"));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  return dir;
}

function writeJson(dir: string, name: string, value: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(value));
  return p;
}

test("readiness --input", () => {
  const dir = tempRoot();
  const input = writeJson(dir, "r.json", {
    today: "2026-10-12",
    now: "2026-10-12T07:00:00-07:00",
    tz: "America/Los_Angeles",
    records: [{ date: "2026-10-12", source: "checkin", observed_at: "2026-10-12T06:45:00-07:00", complete: true, subjective: { sleep_quality: 2, energy: 2, soreness: 4, stress: 4 } }],
    sessions: [{ date: "2026-10-11", planned_sets: 20, completed_sets: 14, reps_shortfall_ratio: 0, top_set_dropped: false }],
    sleep_target_min: 480,
  });
  const r = cli(["readiness", "--input", input]);
  assert.equal(r.code, 0, r.stderr);
  // Two categories off on one day, and no wearable pattern: a note (NA-REC-008).
  assert.equal(r.json.decision, "note");
  assert.equal(r.json.known, 2);
});

test("volume --input: sets per muscle and targets", () => {
  const dir = tempRoot();
  const week = { week_start: "2026-10-12", days: [{ date: "2026-10-12", exercises: [{ name: "Back Squat", sets: [{ weight: 100, reps: 5 }, { weight: 100, reps: 5 }] }] }] };
  const r1 = cli(["volume", "--input", writeJson(dir, "v1.json", { week }), "--root", dir]);
  assert.equal(r1.code, 0, r1.stderr);
  assert.deepEqual(r1.json.sets_by_muscle, { glutes: 2, quads: 2 });

  const block = {
    version: 1, id: "B-001", method: "x", template: { days: 4, emphasis: "all-around" }, start: "2026-09-07", days: [],
    weeks: [{ week: 1, kind: "build", sessions: 4, targets: { quads: 64 } }, { week: 2, kind: "build", sessions: 4, targets: { quads: 72 } }],
  };
  const rules = { pack: "x", version: 1, rules: [{ id: "NA-PROG-001", text: "", kind: "policy", severity: "hard", check: { type: "weekly_volume_increase_max", value: 0.1 } }] };
  const r2 = cli(["volume", "--input", writeJson(dir, "v2.json", { block, logs: [], today: "2026-09-14", target_week: 2, rules }), "--root", dir]);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(r2.json.reference_week, null);
  assert.deepEqual(r2.json.targets.sets, { quads: 70 });
});

test("limits-hash with --file and with the default path", () => {
  const dir = tempRoot();
  const tpl = join(REPO, "templates/athlete/limits.yaml");
  const a = cli(["limits-hash", "--file", tpl]);
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.json.hash, /^[0-9a-f]{64}$/);
  writeFileSync(join(dir, "athlete/limits.yaml"), readFileSync(tpl));
  const b = cli(["limits-hash", "--root", dir]);
  assert.equal(b.json.hash, a.json.hash);
  assert.equal(cli(["limits-hash", "--root", tempRoot()]).code, 1);
});

test("the removed v0.1 commands are gone: hold, validate, proposals, block write", () => {
  for (const args of [["hold", "status"], ["validate", "--tool", "x", "--args", "y"], ["proposals", "list"], ["block", "write", "--input", "x"]]) {
    const r = cli(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.json.error.code, "USAGE", args.join(" "));
  }
  assert.equal(existsSync(join(REPO, "engine/hold.ts")), false);
});

test("snapshot show: missing, then present", () => {
  const dir = tempRoot();
  const missing = cli(["snapshot", "show", "--root", dir]);
  assert.equal(missing.code, 0, missing.stderr);
  assert.equal(missing.json.exists, false);
  mkdirSync(join(dir, "athlete/.cache"));
  writeJson(dir, "athlete/.cache/snapshot.json", { version: 1, session_id: "s1", captured_at: "2026-10-12T07:00:00-07:00", timezone: "America/Los_Angeles", days: {}, history: [] });
  const r = cli(["snapshot", "show", "--root", dir, "--now", "2026-10-12T07:10:00-07:00"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.exists, true);
  assert.equal(r.json.age_minutes, 10);
  assert.equal(r.json.snapshot.session_id, "s1");
});

test("errors: unknown command exits 2, bad input exits 1, both print JSON", () => {
  const u = cli(["frobnicate"]);
  assert.equal(u.code, 2);
  assert.equal(u.json.error.code, "USAGE");
  const b = cli(["readiness", "--input", "/nonexistent.json"]);
  assert.equal(b.code, 1);
  assert.equal(b.json.error.code, "INPUT_ERROR");
});

test("A10: volume with a block needs target_week (no silent repeat of a deload week)", () => {
  const dir = tempRoot();
  const block = {
    version: 1, id: "B-001", method: "x", template: { days: 4, emphasis: "all-around" }, start: "2026-09-07", days: [],
    weeks: [{ week: 1, kind: "build", sessions: 1, targets: { quads: 10 } }, { week: 2, kind: "deload", sessions: 1 }, { week: 3, kind: "build", sessions: 1, targets: { quads: 11 } }],
  };
  const logs = [{ week_start: "2026-09-07", days: [{ date: "2026-09-07", exercises: [{ name: "Leg Extension", sets: Array(10).fill({ weight: 50, reps: 10 }) }] }] }];
  const r = cli(["volume", "--input", writeJson(dir, "v.json", { block, logs, today: "2026-09-22" }), "--root", dir]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.json.error.message, /target_week/);
  const ok = cli(["volume", "--input", writeJson(dir, "v2.json", { block, logs, today: "2026-09-22", target_week: 3 }), "--root", dir]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json.targets.week, 3);
});

test("V3b fix 2: `help <command>` prints the usage of <command>, as `<command> --help` does; bare `help` lists them all", () => {
  const run = (...a: string[]) => spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), ...a], { encoding: "utf8" });
  const viaHelp = JSON.parse(run("help", "loads").stdout);
  assert.deepEqual(viaHelp, JSON.parse(run("loads", "--help").stdout));
  assert.equal(JSON.parse(run("help", "block", "draft").stdout).command, "block");
  assert.ok(JSON.parse(run("help").stdout).commands.loads);
  const bad = run("help", "nope");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /no help for/);
});
