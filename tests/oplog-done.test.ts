// `oplog done --date --kind` says "done" only for a confirmed
// successful outcome of that kind on that date. A conflict, skip, refusal or uncertain
// result is not done; uncertain also names what to read again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opDone } from "../engine/oplog.ts";

const REPO = new URL("..", import.meta.url).pathname;
const T = "2026-10-15";

function entry(op: string, change: string, result: string, approval = "auto (trim_session)"): string {
  return [`## ${T} 07:07 · ${op}`, "- trigger: daily run (cloud)", "- rules: NA-REC-009", `- change: ${change}`, `- approval: ${approval}`, `- result: ${result}`, ""].join("\n");
}

function root(...entries: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-oplog-"));
  mkdirSync(join(dir, "athlete/log"), { recursive: true });
  writeFileSync(join(dir, "athlete/log/2026-10.md"), ["# Operation log 2026-10", "", ...entries].join("\n"));
  return dir;
}

const TRIM = `op-${T}-trim_session-3fa1c2d9e0b4`;

test("the reviewer's case: a conflict leaves a heading and a change line for today, and today is not done", () => {
  const dir = root(entry(TRIM, `update_planned_workout on ${T} (trim_session)`, "conflict: version conflict: the day changed since the read"));
  const r = opDone(dir, T, "trim_session");
  assert.equal(r.done, false);
  assert.equal(r.status, "not_done");
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].outcome, "conflict");
});

test("a written trim on the date is done; another kind or date is not", () => {
  const dir = root(entry(TRIM, `update_planned_workout on ${T} (trim_session)`, "written: written (version abc)"));
  assert.equal(opDone(dir, T, "trim_session").done, true);
  assert.equal(opDone(dir, T, "swap_to_recovery").done, false);
  assert.equal(opDone(dir, "2026-10-16", "trim_session").done, false);
  // The format the scheduled run writes by hand (evals/scenarios/09): a free-text change and a bare result.
  const hand = root(entry(TRIM, "Lower A, sets trimmed by 30%", "written"));
  assert.equal(opDone(hand, T, "trim_session").done, true);
});

test("skipped, refused, not_found and an earlier failure followed by success", () => {
  for (const result of ["skipped: skipped (protected)", `refused: refused by Tally: limit L-001 "Knee" (ban) on ${T}: Back Squat. Not retried`, "not_found: nothing planned on the date"]) {
    assert.equal(opDone(root(entry(TRIM, `update_planned_workout on ${T} (trim_session)`, result)), T, "trim_session").done, false, result);
  }
  const retry = root(
    entry(TRIM, `update_planned_workout on ${T} (trim_session)`, "conflict: version conflict: the day changed since the read"),
    entry(`op-${T}-trim_session-aaaaaaaaaaaa`, `update_planned_workout on ${T} (trim_session)`, "written: written (version def)"),
  );
  assert.equal(opDone(retry, T, "trim_session").done, true);
});

test("uncertain is not done and names the dates to read again", () => {
  const r = opDone(root(entry(TRIM, `update_planned_workout on ${T} (trim_session)`, "uncertain: no parsable result: read the day again before any retry")), T, "trim_session");
  assert.equal(r.done, false);
  assert.equal(r.status, "uncertain");
  assert.deepEqual(r.reread, [T]);
  assert.match(r.reason, /get_planned_workout/);
});

test("replays: done only when the stored outcome for the date succeeded", () => {
  const ok = `replayed: replay of ${TRIM} recorded 2026-10-15T14:07:00Z: nothing new was written; the stored outcome: ${T} updated`;
  assert.equal(opDone(root(entry(TRIM, `update_planned_workout on ${T} (trim_session)`, ok)), T, "trim_session").done, true);
  const skipped = `replayed: replay of ${TRIM} recorded 2026-10-15T14:07:00Z: nothing new was written; the stored outcome: ${T} skipped (version_conflict)`;
  assert.equal(opDone(root(entry(TRIM, `update_planned_workout on ${T} (trim_session)`, skipped)), T, "trim_session").done, false);
  const moved = `replayed: replay of x recorded y: nothing new was written; the stored outcome: 2026-10-14→${T} moved`;
  assert.equal(opDone(root(entry(`op-${T}-reschedule_within_week-bbbbbbbbbbbb`, `move_planned_workout on 2026-10-14, ${T} (reschedule_within_week)`, moved, "auto (reschedule_within_week)")), T, "reschedule_within_week").done, true);
});

test("a mixed range: the written date is done, the refused and conflicting dates are not", () => {
  const detail = `written: 2026-10-14; version conflict on 2026-10-16; refused by Tally: limit L-001 "Knee" (ban) on ${T}: Back Squat; week of 2026-10-12: 4 sets, limit 0. Not retried: only the user can change a Tally limit`;
  const dir = root(entry(`op-2026-10-14-week-cccccccccccc`, `plan_workout_range on 2026-10-14, ${T}, 2026-10-16 (block_session)`, `written: ${detail}`, "auto (block_session)"));
  assert.equal(opDone(dir, "2026-10-14", "block_session").done, true);
  assert.equal(opDone(dir, T, "block_session").done, false);
  assert.equal(opDone(dir, "2026-10-16", "block_session").done, false);
  assert.equal(opDone(dir, "2026-10-14", "week").done, true, "the opId's kind counts too");
});

test("CLI: oplog done prints JSON; no log is not done; bad input is a usage error", () => {
  const dir = root(entry(TRIM, `update_planned_workout on ${T} (trim_session)`, "written: written (version abc)"));
  const run = (...a: string[]) => spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), "oplog", "done", ...a], { encoding: "utf8" });
  const r = run("--date", T, "--kind", "trim_session", "--root", dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).done, true);
  const empty = run("--date", T, "--kind", "trim_session", "--root", mkdtempSync(join(tmpdir(), "coach-oplog-none-")));
  assert.equal(JSON.parse(empty.stdout).done, false);
  assert.equal(run("--date", "today", "--kind", "trim_session", "--root", dir).status, 2);
  assert.equal(run("--date", T, "--kind", "nope", "--root", dir).status, 2);
});
