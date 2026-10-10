// `proposals check-applied --id <id>` reconciles each write's real
// result shape (written, updated, moved, deleted, per-day range results, replays) against
// a fresh read-back and returns applied, partial or not-applied. It never writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkApplied } from "../engine/proposal-check.ts";
import { createProposal, readProposal } from "../engine/proposals.ts";
import { saveSnapshot } from "../engine/snapshot.ts";
import type { Snapshot } from "../engine/types.ts";
import { bench, emptyDay, NOW, row3, snapDay, snapshot, squat, v } from "./guard/fixtures.ts";

const REPO = new URL("..", import.meta.url).pathname;
const D = "2026-10-15";
const E = "2026-10-16";
const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];
const trim = { date: D, expectedVersion: v(`r-${D}`, "t0"), operations: [{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 2 } }] };
const move = { fromDate: D, toDate: E, expectedVersion: v(`r-${D}`, "t0") };
const legs = { date: E, dayType: "legs", dayName: "Legs", exercises: [squat], ifAbsent: true };

function proposal(writes: { tool: string; input: unknown }[]): { root: string; id: string } {
  const root = mkdtempSync(join(tmpdir(), "coach-check-"));
  mkdirSync(join(root, "athlete"), { recursive: true });
  const { id } = createProposal({ kind: "reschedule_within_week", summary: "test", writes, base: { [D]: v(`r-${D}`, "t0") }, limits_hash: "0".repeat(64), rule_ids: [] }, { root, now: NOW, tz: "America/Los_Angeles" });
  return { root, id };
}

const check = (root: string, id: string, results: unknown[] | null, snap: Snapshot | null, now = NOW) => checkApplied(readProposal(id, root), results, snap, now);

test("the reviewer's case: a move that returned moved, with a matching read-back, is applied", () => {
  const { root, id } = proposal([{ tool: "move_planned_workout", input: move }]);
  const snap = snapshot({ [D]: emptyDay(), [E]: snapDay(E) });
  const r = check(root, id, [text({ status: "moved", version: "x" })], snap);
  assert.equal(r.status, "applied", JSON.stringify(r.missing));
  assert.deepEqual(r.missing, []);
  // The read-back still shows the day on the source date: not applied.
  const stale = check(root, id, [text({ status: "moved", version: "x" })], snapshot({ [D]: snapDay(D), [E]: emptyDay() }));
  assert.equal(stale.status, "not-applied");
  assert.match(stale.missing.join(" "), /2026-10-15: the read-back does not match/);
});

test("delete returns deleted; skip returns updated or unchanged", () => {
  const del = proposal([{ tool: "delete_planned_workout", input: { date: D, expectedVersion: v(`r-${D}`, "t0") } }]);
  assert.equal(check(del.root, del.id, [text({ date: D, status: "deleted" })], snapshot({ [D]: emptyDay() })).status, "applied");
  const skip = proposal([{ tool: "skip_planned_workout", input: { date: D, expectedVersion: v(`r-${D}`, "t0") } }]);
  const skipped = snapshot({ [D]: snapDay(D, { skipped: true }) });
  assert.equal(check(skip.root, skip.id, [text({ date: D, status: "updated", skipped: true })], skipped).status, "applied");
  assert.equal(check(skip.root, skip.id, [text({ date: D, status: "unchanged", skipped: true })], skipped).status, "applied");
  assert.equal(check(skip.root, skip.id, [text({ date: D, status: "conflict" })], skipped).status, "not-applied");
});

test("an update applies when the read-back carries the operation; a replay counts with a matching read-back", () => {
  const { root, id } = proposal([{ tool: "update_planned_workout", input: trim }]);
  const trimmed = snapshot({ [D]: snapDay(D, { exercises: [{ ...bench, suggestedSets: 2 }, squat, row3] }) });
  assert.equal(check(root, id, [text({ date: D, status: "updated" })], trimmed).status, "applied");
  const replay = text({ replayed: true, opId: "op-x", recordedAt: NOW, results: [{ date: D, status: "updated" }] });
  assert.equal(check(root, id, [replay], trimmed).status, "applied");
  const untouched = check(root, id, [replay], snapshot({ [D]: snapDay(D) }));
  assert.equal(untouched.status, "not-applied");
  assert.match(untouched.missing.join(" "), /Barbell_Bench_Press suggestedSets is 3, not 2/);
  // A replay whose stored outcome is a conflict is not applied.
  assert.equal(check(root, id, [text({ replayed: true, opId: "op-x", recordedAt: NOW, results: [{ date: D, status: "skipped", code: "version_conflict" }] })], trimmed).status, "not-applied");
});

test("a range is checked per day; two writes with one done are partial and name what is missing", () => {
  const range = { days: [{ date: D, dayType: "push", dayName: "Push", exercises: [bench], ifAbsent: true }, legs] };
  const { root, id } = proposal([{ tool: "plan_workout_range", input: range }, { tool: "update_planned_workout", input: trim }]);
  const snap = snapshot({ [D]: snapDay(D, { dayName: "Push", exercises: [bench] }), [E]: emptyDay() });
  const resp = text({ results: [{ date: D, status: "written" }], skippedDates: [{ date: E, code: "exists", reason: "x" }] });
  const r = check(root, id, [resp, text({ date: D, status: "conflict" })], snap);
  assert.equal(r.status, "not-applied");
  assert.match(r.missing.join(" "), /2026-10-16: the result is skipped/);
  const both = check(root, id, [text({ results: [{ date: D }, { date: E }], skippedDates: [] }), null], snapshot({ [D]: snapDay(D, { dayName: "Push", exercises: [bench] }), [E]: snapDay(E, { dayName: "Legs", exercises: [squat] }) }));
  assert.equal(both.status, "partial");
  assert.deepEqual(both.writes.map((w) => w.applied), [true, false]);
  assert.match(both.missing.join(" "), /write 2 .*no result/);
});

test("a read-back older than 15 minutes or missing does not count", () => {
  const { root, id } = proposal([{ tool: "delete_planned_workout", input: { date: D, expectedVersion: v(`r-${D}`, "t0") } }]);
  const r = check(root, id, [text({ date: D, status: "deleted" })], snapshot({ [D]: emptyDay() }), "2026-10-14T07:20:00-07:00");
  assert.equal(r.status, "not-applied");
  assert.match(r.missing.join(" "), /read 2026-10-15 with get_planned_workout/);
  assert.equal(check(root, id, [text({ date: D, status: "deleted" })], null).status, "not-applied");
});

test("CLI: proposals check-applied --id prints the status and never writes", () => {
  const { root, id } = proposal([{ tool: "move_planned_workout", input: move }]);
  saveSnapshot(root, snapshot({ [D]: emptyDay(), [E]: snapDay(E) }));
  const results = join(root, "results.json");
  writeFileSync(results, JSON.stringify([text({ status: "moved", version: "x" })]));
  const run = (...a: string[]) => spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), "proposals", "check-applied", ...a], { encoding: "utf8" });
  const r = run("--id", id, "--input", results, "--root", root, "--now", NOW);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, "applied");
  assert.equal(readProposal(id, root).status, "proposed", "check-applied writes nothing");
  assert.equal(run("--root", root).status, 2);
});
