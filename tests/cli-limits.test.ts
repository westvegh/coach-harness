// Smoke tests for the limits CLI (reports only): limits schema, regions and check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const CLI = join(REPO, "engine/cli.ts");

function cli(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: "utf8", input });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stderr: r.stderr };
}

const LIMITS = `version: 1
pain_threshold: 4
limits:
  - id: L-001
    region: left-knee
    rule: ban
    patterns: [loaded_deep_knee_flexion]
    exercises: ["Barbell Back Squat"]
    allow: ["Box Squat"]
    note: "No deep squats under load"
    source: athlete
    since: 2026-10-09
  - id: L-002
    region: low-back
    rule: cap
    patterns: [hinge]
    max_load: { value: 135, unit: lbs }
    max_sets_per_week: 6
    source: clinician-reported
    since: 2026-10-01
  - id: L-003
    region: shoulder
    rule: cap
    patterns: [overhead_press]
    max_load: { value: 50, unit: lbs }
    source: athlete
    since: 2026-10-01
`;

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-limits-cli-"));
  mkdirSync(join(dir, "athlete"));
  writeFileSync(join(dir, "athlete/limits.yaml"), LIMITS);
  return dir;
}

const sets = (n: number, weight?: number) => Array.from({ length: n }, () => ({ reps: 5, ...(weight === undefined ? {} : { weight }) }));

test("limits check reports a banned exercise, a weekly cap and a load cap, with the day; an allowed swap passes", () => {
  const dir = root();
  const week = {
    week_start: "2026-10-12",
    days: [
      { date: "2026-10-12", exercises: [{ name: "Barbell Back Squat", exerciseId: "Barbell_Squat", unit: "lbs", sets: sets(3, 185) }, { name: "Box Squat", unit: "lbs", sets: sets(3, 135) }] },
      { date: "2026-10-14", exercises: [{ name: "Romanian Deadlift", unit: "lbs", sets: sets(4, 155) }, { name: "Overhead Press", unit: "kg", sets: sets(3, 20) }] },
      { date: "2026-10-16", exercises: [{ name: "Romanian Deadlift", unit: "lbs", sets: sets(3, 125) }] },
    ],
  };
  writeFileSync(join(dir, "week.json"), JSON.stringify({ week }));
  const r = cli(["limits", "check", "--input", join(dir, "week.json"), "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, false);
  const kinds = r.json.findings.map((f: { limit: string; kind: string; date?: string }) => [f.limit, f.kind, f.date ?? null]);
  assert.deepEqual(kinds, [
    ["L-001", "banned", "2026-10-12"],
    ["L-002", "over_load", "2026-10-14"],
    ["L-002", "over_sets", null],
  ]);
  // 20 kg is about 44 lbs: under the 50 lbs shoulder cap.
  assert.ok(!r.json.findings.some((f: { limit: string }) => f.limit === "L-003"));

  // A compliant week: no findings, ok.
  writeFileSync(join(dir, "ok.json"), JSON.stringify({ days: [{ date: "2026-10-12", exercises: [{ name: "Box Squat", unit: "lbs", sets: sets(3, 135) }, { name: "Romanian Deadlift", unit: "lbs", sets: sets(3, 125) }] }] }));
  const ok = cli(["limits", "check", "--input", join(dir, "ok.json"), "--root", dir]);
  assert.deepEqual([ok.json.ok, ok.json.findings], [true, []]);
});

test("limits check lists an unclassified exercise for the coach to judge; skipped days do not count", () => {
  const dir = root();
  writeFileSync(join(dir, "w.json"), JSON.stringify({ days: [{ date: "2026-10-12", exercises: [{ name: "Mystery Move", sets: sets(3) }] }, { date: "2026-10-13", status: "skipped", exercises: [{ name: "Barbell Back Squat", sets: sets(3) }] }] }));
  const r = cli(["limits", "check", "--input", join(dir, "w.json"), "--root", dir]);
  assert.deepEqual(r.json.findings.map((f: { kind: string }) => f.kind), ["unclassified"]);
  assert.equal(r.json.ok, true, "unclassified alone is a note, not a conflict");
});

test("limits schema shows build_back; limits regions lists the regions; usage errors exit 2; the server commands are gone", () => {
  const s = cli(["limits", "schema"]);
  assert.equal(s.code, 0);
  assert.match(s.json.entry.build_back, /cap only/);
  assert.ok(s.json.examples.some((e: { build_back?: boolean }) => e.build_back === true));
  const g = cli(["limits", "regions"]);
  assert.ok(g.json.regions.includes("left-knee"));
  for (const args of [["limits"], ["limits", "check"], ["limits", "server-rules"], ["limits", "sync-ops"]]) assert.equal(cli(args).code, 2, args.join(" "));
});

test("V1b fix 9: warm-ups stay out of the weekly set count, but a warm-up over max_load is reported", () => {
  const dir = root();
  const warm = (n: number, weight: number) => Array.from({ length: n }, () => ({ reps: 5, weight, warmup: true }));
  // L-002 caps hinge at 6 hard sets and 135 lbs: 6 hard sets plus 3 light warm-ups is fine.
  writeFileSync(join(dir, "ok.json"), JSON.stringify({ days: [{ date: "2026-10-12", exercises: [{ name: "Romanian Deadlift", unit: "lbs", sets: [...warm(3, 95), ...sets(6, 125)] }] }] }));
  assert.deepEqual(cli(["limits", "check", "--input", join(dir, "ok.json"), "--root", dir]).json.findings, []);
  // A warm-up above the 135 lbs cap is a finding, even with the hard sets under it.
  writeFileSync(join(dir, "heavy.json"), JSON.stringify({ days: [{ date: "2026-10-12", exercises: [{ name: "Romanian Deadlift", unit: "lbs", sets: [...warm(1, 145), ...sets(3, 125)] }] }] }));
  const r = cli(["limits", "check", "--input", join(dir, "heavy.json"), "--root", dir]);
  assert.deepEqual(r.json.findings.map((f: { limit: string; kind: string }) => [f.limit, f.kind]), [["L-002", "over_load"]]);
});
