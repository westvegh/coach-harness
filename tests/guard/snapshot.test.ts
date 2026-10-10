// Snapshot load, merge and age checks (contracts §9). Hook responses are arrays of
// {type: "text", text} blocks whose text is the tool's JSON (spike #8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeTallyVersion } from "../../adapters/loggers/tally/version.ts";
import { loadSnapshot, mergeResponse, responsePayload, saveSnapshot, snapshotProblems, SNAPSHOT_RELATIVE } from "../../engine/snapshot.ts";
import { NOW, plannedDay, SESSION, snapshot, snapDay, squat, v } from "./fixtures.ts";

const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];
const TZ = "America/Los_Angeles";
const merge = (prev: ReturnType<typeof snapshot> | null, tool: string, input: unknown, result: unknown, now = NOW, session_id = SESSION) =>
  mergeResponse(prev, { tool, input, response: text(result), session_id, now, timezone: TZ });

test("responsePayload: text blocks, a content wrapper, an error, non-JSON", () => {
  assert.deepEqual(responsePayload(text({ a: 1 })), { a: 1 });
  assert.deepEqual(responsePayload({ content: text({ a: 2 }) }), { a: 2 });
  assert.equal(responsePayload({ content: text({ a: 2 }), isError: true }), null);
  assert.equal(responsePayload([{ type: "text", text: "MCP error: invalid input" }]), null);
});

test("get_planned_workout: a found day and an empty date", () => {
  let s = merge(null, "get_planned_workout", { date: "2026-10-14" }, plannedDay("2026-10-14"));
  assert.equal(s.days["2026-10-14"].found, true);
  assert.equal(s.days["2026-10-14"].version, v("r-2026-10-14", "t0"));
  assert.equal(s.days["2026-10-14"].weightUnit, "lbs");
  s = merge(s, "get_planned_workout", { date: "2026-10-15" }, { date: "2026-10-15", found: false, exercises: [], weightUnit: "lbs", weightUnitSource: "default" });
  assert.equal(s.days["2026-10-15"].found, false);
  assert.equal(s.days["2026-10-15"].weightUnit, undefined, "an unknown unit is not recorded as known");
  assert.equal(s.session_id, SESSION);
});

test("get_training_context: planned listing, unit and profile", () => {
  const s = merge(null, "get_training_context", {}, {
    timezone: TZ,
    today: "2026-10-14",
    futurePlanned: [{ date: "2026-10-15", dayName: "Legs", source: "mcp", userModified: false, exerciseCount: 4, skipped: false }],
    weightUnit: "kg",
    weightUnitSource: "history",
    profile: { limits: "left knee: no deep squats", updatedAt: null },
    notes: [],
  });
  assert.deepEqual(Object.keys(s.planned!.dates), ["2026-10-15"]);
  assert.equal(s.weightUnit, "kg");
  assert.equal(s.profile!.limits, "left knee: no deep squats");
});

test("get_workout_history: sessions replace the same dates and mark history as read", () => {
  const hist = {
    count: 1,
    sessions: [{ date: "2026-10-12", name: "Push", weightUnit: "lbs", exercises: [{ name: "Bench Press", muscle: "Chest", trackingType: "weight_reps", sets: [{ weight: 135, reps: 8 }] }] }],
  };
  let s = merge(null, "get_workout_history", {}, hist);
  s = merge(s, "get_workout_history", {}, hist);
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].exercises[0].sets[0].weight, 135);
  assert.deepEqual(s.history_coverage, { captured_at: NOW, complete: true });
});

test("a snapshot from another session is replaced", () => {
  const prev = snapshot({ "2026-10-14": snapDay("2026-10-14") }, { session_id: "old" });
  const s = merge(prev, "get_planned_workout", { date: "2026-10-15" }, plannedDay("2026-10-15"));
  assert.deepEqual(Object.keys(s.days), ["2026-10-15"]);
});

test("mutations: update takes the returned day; plan forgets the date; delete empties; move shifts; skip re-encodes the version", () => {
  const D = "2026-10-14";
  const base = snapshot({ [D]: snapDay(D), "2026-10-16": snapDay("2026-10-16") });
  const up = merge(base, "update_planned_workout", { date: D }, { date: D, status: "updated", day: plannedDay(D, { updatedAt: "t1", version: v(`r-${D}`, "t1"), exercises: [squat] }), warnings: [] });
  assert.equal(up.days[D].version, v(`r-${D}`, "t1"));
  assert.deepEqual(up.days[D].exercises, [squat]);
  const skipped = merge(base, "update_planned_workout", { date: D }, { date: D, status: "skipped", code: "version_conflict", reason: "x" });
  assert.equal(skipped.days[D], undefined, "a conflict forgets the date: read it again");

  const plan = merge(base, "plan_workout_day", { date: D }, { results: [{ date: D, status: "written" }], skippedDates: [], warnings: [], batchId: "b" });
  assert.equal(plan.days[D], undefined);

  const del = merge(base, "delete_planned_workout", { date: D }, { date: D, status: "deleted", deleted: {} });
  assert.equal(del.days[D].found, false);

  const mv = merge(base, "move_planned_workout", { fromDate: D, toDate: "2026-10-15" }, { fromDate: D, toDate: "2026-10-15", status: "moved", version: v("r9", null), warnings: [] });
  assert.equal(mv.days[D].found, false);
  assert.equal(mv.days["2026-10-15"].version, v("r9", null));

  const sk = merge(base, "skip_planned_workout", { date: D }, { date: D, status: "updated", skipped: true, dayName: "Push", updatedAt: "t2" });
  assert.equal(sk.days[D].skipped, true);
  assert.deepEqual(decodeTallyVersion(sk.days[D].version!), { id: `r-${D}`, updatedAt: "t2" });

  const err = mergeResponse(base, { tool: "plan_workout_day", input: { date: "2026-10-16" }, response: [{ type: "text", text: "timeout" }], session_id: SESSION, now: NOW, timezone: TZ });
  assert.equal(err.days["2026-10-16"], undefined, "an uncertain write forgets its date");
});

test("snapshotProblems: missing, foreign, stale, an unread date, a stale date", () => {
  const s = snapshot({ "2026-10-14": snapDay("2026-10-14") });
  assert.match(snapshotProblems(null, SESSION, NOW, [])[0], /no snapshot; refresh/);
  assert.match(snapshotProblems(s, "other", NOW, [])[0], /another session/);
  assert.match(snapshotProblems(s, SESSION, "2026-10-14T07:16:00-07:00", [])[0], /16 minutes old/);
  assert.deepEqual(snapshotProblems(s, SESSION, "2026-10-14T07:15:00-07:00", ["2026-10-14"]), []);
  assert.match(snapshotProblems(s, SESSION, NOW, ["2026-10-15"])[0], /2026-10-15 was not read/);
  const old = snapshot({ "2026-10-14": snapDay("2026-10-14", {}, "2026-10-14T06:30:00-07:00") });
  assert.match(snapshotProblems(old, SESSION, NOW, ["2026-10-14"])[0], /read 30 minutes ago/);
});

test("load and save; a malformed file throws", () => {
  const root = mkdtempSync(join(tmpdir(), "coach-snap-"));
  assert.equal(loadSnapshot(root), null);
  const s = snapshot({ "2026-10-14": snapDay("2026-10-14") });
  saveSnapshot(root, s);
  assert.deepEqual(loadSnapshot(root), s);
  mkdirSync(join(root, "athlete/.cache"), { recursive: true });
  writeFileSync(join(root, SNAPSHOT_RELATIVE), "{ not json");
  assert.throws(() => loadSnapshot(root), /SNAPSHOT_INVALID|cannot read/);
  writeFileSync(join(root, SNAPSHOT_RELATIVE), JSON.stringify({ ...s, session_id: "" }));
  assert.throws(() => loadSnapshot(root), /session_id/);
});
