// V5 (0.2.4) upgrade: a legacy athlete folder (no clusters key, no slot style, a 6-set exercise,
// a plans CSV with notes and a logged row, a brief with preferences) still works. The per-exercise
// maximum is a drafting default and an audit finding, never a refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { cli, REPO, writeJson } from "./e3/helpers.ts";

const SQUAT6 = { name: "Barbell Back Squat", unit: "lbs", sets: Array.from({ length: 6 }, () => ({ weight: 225, reps: 5 })) };
const LEGACY_BLOCK = {
  version: 1,
  id: "B-001",
  method: "nine-adaptations",
  template: { days: 3, emphasis: "strength" },
  start: "2026-10-12",
  weeks: [
    { week: 1, kind: "build", sessions: 3, targets: { quads: 6, glutes: 6 } },
    { week: 2, kind: "build", sessions: 3, targets: { quads: 6, glutes: 6 } },
  ],
  days: [{ day: "mon", focus: "Legs", slots: [{ pattern: "squat", adaptation: "strength", sets: 6, reps: 5, rest_s: 180, exercise: "Barbell Back Squat" }] }],
};
const CSV = [
  "date,day,exercise,sets,reps,load,unit,notes,done_sets,done_reps,done_load,felt",
  '2026-10-12,Legs,Barbell Back Squat,6,5,225,lbs,"Belt on, slow down",6,5,225,RPE 8',
  "2026-10-14,Upper,Bench Press,4,6-8,185,lbs,Paused reps,,,,",
].join("\n") + "\n";

test("V5 upgrade: a legacy athlete folder reads in every command; the 6-set exercise stays writable; the audit gives only advisory findings", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "coach-v5u-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "athlete/log"), { recursive: true });
  mkdirSync(join(dir, "plans"), { recursive: true });
  symlinkSync(join(REPO, "methods"), join(dir, "methods"));
  writeFileSync(join(dir, "coach.yaml"), readFileSync(join(REPO, "coach.example.yaml"), "utf8").replace("logger: tally", "logger: files"));
  writeFileSync(join(dir, "athlete/limits.yaml"), readFileSync(join(REPO, "templates/athlete/limits.yaml"), "utf8"));
  writeFileSync(join(dir, "athlete/block.yaml"), `# The current training block.\n${stringify(LEGACY_BLOCK)}`);
  writeFileSync(join(dir, "athlete/brief.md"), "# Brief\n\n## Preferences\n\n- Six sets of back squats on Monday (athlete chose).\n");
  writeFileSync(join(dir, "plans/2026-W42.csv"), CSV);

  assert.equal(cli(["config-check", "--root", dir]).json.problems.filter((p: string) => !p.includes("settings")).length, 0);
  const read = cli(["plans", "read", "--week", "2026-10-12", "--root", dir]);
  assert.equal(read.code, 0, read.stderr);
  assert.equal(read.json.days[0].exercises[0].sets.length, 6);
  const weeks = cli(["weeks", "--from", "2026-10-12", "--to", "2026-10-18", "--root", dir]);
  assert.equal(weeks.code, 0, weeks.stderr);
  assert.deepEqual(weeks.json.logs[0].sets_by_muscle, { glutes: 6, quads: 6 });
  const targets = cli(["targets", "--input", writeJson(dir, "t.json", { block: LEGACY_BLOCK, logs: weeks.json.logs, today: "2026-10-19", target_week: 2 }), "--root", dir]);
  assert.equal(targets.code, 0, targets.stderr);
  assert.deepEqual([targets.json.targets.clusters, targets.json.targets.cluster_above_target], [[], []]);

  // The 6-set week: the audit lists it as advisory; limits pass; it classifies as the block's session; it writes.
  const week = { week: { week_start: "2026-10-19", kind: "build", load_factor: 1, days: [{ date: "2026-10-19", dayName: "Legs", notes: "Belt on", exercises: [SQUAT6] }] } };
  const wf = writeJson(dir, ".tmp/coach/week.json", week);
  const vol = cli(["volume", "--input", wf, "--root", dir]);
  assert.equal(vol.code, 0, vol.stderr);
  assert.deepEqual(vol.json.sets_by_muscle, { glutes: 6, quads: 6 });
  assert.equal(vol.json.session_max.length, 1);
  assert.match(vol.json.session_max[0].text, /advisory: the athlete may choose more/);
  const lim = cli(["limits", "check", "--input", wf, "--root", dir]);
  assert.deepEqual([lim.code, lim.json.ok], [0, true]);
  const cls = cli(["classify", "--input", writeJson(dir, "c.json", { before: null, after: week.week.days[0], tool: "plan_workout_day", today: "2026-10-14" }), "--root", dir]);
  assert.equal(cls.code, 0, cls.stderr);
  assert.ok(cls.json.kinds.includes("block_session"), JSON.stringify(cls.json));
  const pw = cli(["plans", "write", "--input", wf, "--root", dir]);
  assert.equal(pw.code, 0, pw.stderr);
  assert.match(readFileSync(join(dir, "plans/2026-W43.csv"), "utf8"), /2026-10-19,Legs,Barbell Back Squat,6,5,225,lbs,Belt on,/);
  // The old week file is unchanged by a rewrite of another week; its logged row and notes stay.
  assert.equal(readFileSync(join(dir, "plans/2026-W42.csv"), "utf8"), CSV);
  // Rewriting a logged legacy day keeps its done columns and its notes.
  const again = writeJson(dir, ".tmp/coach/again.json", { days: read.json.days.filter((d: any) => d.date === "2026-10-12") });
  assert.equal(cli(["plans", "write", "--input", again, "--root", dir]).code, 0);
  assert.match(readFileSync(join(dir, "plans/2026-W42.csv"), "utf8"), /Barbell Back Squat,6,5,225,lbs,"Belt on, slow down",6,5,225,RPE 8/);
  // The legacy block, unchanged, still writes (no style or rm needed; 6 sets is valid).
  const bw = cli(["block", "write", "--input", writeJson(dir, "b.json", LEGACY_BLOCK), "--root", dir]);
  assert.equal(bw.code, 0, bw.stderr);
});
