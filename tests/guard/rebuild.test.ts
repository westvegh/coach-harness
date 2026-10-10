// Parity tests: the Tally rebuild against the stored results Tally's own tests assert
// (workout-api/lib/mcp/tools/*.test.ts). Each case cites the Tally test it mirrors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import * as R from "../../adapters/loggers/tally/rebuild.ts";
import { loadAdapterConfig } from "../../engine/logger.ts";
import { bench, curl, REPO, row3, snapDay, snapshot, squat, v, emptyDay } from "./fixtures.ts";

const D = "2099-06-20";
const snap = (over: Record<string, unknown> = {}) => snapshot({ [D]: snapDay(D, over) });
const v0 = v(`r-${D}`, "t0");
const update = (args: Record<string, unknown>, s = snap()) => R.updatePlannedWorkout({ date: D, ...args }, s)[0];

test("adapter.yaml: the T2 capabilities are true; protectsUserDays is true; server_limits needs the T3 tool", () => {
  const cfg = loadAdapterConfig("tally");
  assert.deepEqual(cfg.capabilities, { rangeCreateIfAbsent: true, versionedSkipDelete: true, opId: true, protectsUserDays: true, server_limits: { when_tool: "update_training_limits" } });
  const raw = parse(readFileSync(`${REPO}/adapters/loggers/tally/adapter.yaml`, "utf8"));
  assert.equal(raw.name, "tally");
});

// updatePlannedWorkout.test.ts "replace by exerciseId swaps one exercise; the rest pass through untouched"
test("update: replace by exerciseId swaps one exercise; the rest stay exactly as stored", () => {
  const dbBench = { exerciseId: "Dumbbell_Bench_Press", name: "Dumbbell Bench Press", suggestedSets: 3, suggestedReps: 10 };
  const c = update({ operations: [{ op: "replace", target: { exerciseId: "Barbell_Bench_Press" }, exercise: dbBench }] });
  assert.deepEqual(c.after!.exercises, [dbBench, squat, row3]);
  assert.equal(c.after!.exercises[1], c.before!.exercises[1], "an unnamed exercise is the stored object itself");
});

// "exerciseId targets and an end-append add need no version"
test("update: remove by exerciseId and an end-append add", () => {
  const c = update({ operations: [{ op: "remove", target: { exerciseId: "Barbell_Squat" } }, { op: "add", exercise: curl }] });
  assert.deepEqual(c.after!.exercises, [bench, row3, curl]);
});

// "modify merges fields onto the stored exercise (stored keys kept)"
test("update: modify by index merges fields onto the stored exercise", () => {
  const legacy = { ...squat, notes: "belt", alternatives: ["Front Squat"] };
  const s = snapshot({ [D]: snapDay(D, { exercises: [bench, legacy] }) });
  const c = update({ expectedVersion: v0, operations: [{ op: "modify", target: { index: 1 }, fields: { suggestedSets: 5, rpe: 8 } }] }, s);
  assert.deepEqual(c.after!.exercises, [bench, { ...legacy, suggestedSets: 5, rpe: 8 }]);
});

// "add with afterIndex -1 inserts first; afterIndex k inserts after k; several adds keep op order"
test("update: adds with afterIndex keep op order", () => {
  const a = { ...curl, exerciseId: "a" };
  const b = { ...curl, exerciseId: "b" };
  const c = update({
    expectedVersion: v0,
    operations: [
      { op: "add", exercise: a, afterIndex: 0 },
      { op: "add", exercise: curl, afterIndex: -1 },
      { op: "add", exercise: b, afterIndex: 0 },
    ],
  });
  assert.deepEqual(c.after!.exercises, [curl, bench, a, b, squat, row3]);
});

// "targets resolve against the ORIGINAL list (a remove does not shift a later index)"
test("update: index targets resolve against the list as read", () => {
  const c = update({ expectedVersion: v0, operations: [{ op: "remove", target: { index: 0 } }, { op: "modify", target: { index: 2 }, fields: { suggestedSets: 5 } }] });
  assert.deepEqual(c.after!.exercises, [squat, { ...row3, suggestedSets: 5 }]);
});

// "an add after a removed slot lands where that slot was"
test("update: an add after a removed slot lands where that slot was", () => {
  const c = update({ expectedVersion: v0, operations: [{ op: "remove", target: { index: 1 } }, { op: "add", exercise: curl, afterIndex: 1 }] });
  assert.deepEqual(c.after!.exercises, [bench, curl, row3]);
});

// "day-level edits: dayName sets day_name; notes null clears; omitted leaves them unwritten"
test("update: dayName sets the name; notes null clears; omitted keeps both", () => {
  const a = update({ dayName: "Push B", notes: null, operations: [{ op: "remove", target: { exerciseId: "Cable_Row" } }] });
  assert.equal(a.after!.dayName, "Push B");
  assert.equal(a.after!.notes, undefined);
  const b = update({ operations: [{ op: "remove", target: { exerciseId: "Cable_Row" } }] });
  assert.equal(b.after!.dayName, "Push");
  assert.equal(b.after!.notes, "keep");
});

// "skip status is preserved"; "an edit keeps client_id, source, status, user_modified"
test("update: skip status, source and userModified are kept", () => {
  const s = snapshot({ [D]: snapDay(D, { skipped: true, userModified: true }) });
  const c = update({ overrideUserModified: true, operations: [{ op: "remove", target: { exerciseId: "Cable_Row" } }] }, s);
  assert.equal(c.after!.skipped, true);
  assert.equal(c.after!.userModified, true);
  assert.equal(c.after!.source, "mcp");
});

// "index targets without expectedVersion → tool error"
test("update: Tally refusals throw (index without version, ambiguous id, not found, unknown key)", () => {
  assert.throws(() => update({ operations: [{ op: "remove", target: { index: 1 } }] }), /index targets need expectedVersion/);
  assert.throws(() => update({ operations: [{ op: "add", exercise: curl, afterIndex: 0 }] }), /index targets need expectedVersion/);
  const dup = snapshot({ [D]: snapDay(D, { exercises: [bench, bench] }) });
  assert.throws(() => update({ operations: [{ op: "remove", target: { exerciseId: "Barbell_Bench_Press" } }] }, dup), /matches 2 exercises/);
  assert.throws(() => update({ operations: [{ op: "remove", target: { exerciseId: "nope" } }] }), /matches 0 exercises/);
  assert.throws(() => R.updatePlannedWorkout({ date: "2099-06-21", operations: [{ op: "remove", target: { exerciseId: "x" } }] }, snap()), /not_found/);
  assert.throws(() => update({ bogus: 1, operations: [{ op: "remove", target: { exerciseId: "Cable_Row" } }] }), /unknown key/);
  assert.throws(() => update({ operations: [{ op: "modify", target: { exerciseId: "Cable_Row" }, fields: { name: "x" } }] }), /unknown key/);
});

// "weight units (G1 on op values only)": a kg user, a call in lbs.
test("update: op weights convert to a known user unit; untouched weights stay as stored", () => {
  const s = snapshot({ [D]: snapDay(D, { weightUnit: "kg", weightUnitSource: "settings" }) });
  const c = update(
    {
      weightUnit: "lbs",
      operations: [
        { op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedWeight: 225 } },
        { op: "add", exercise: { ...curl, suggestedWeight: 30 } },
      ],
    },
    s,
  );
  assert.equal(c.after!.exercises[0].suggestedWeight, 102); // 225 lbs → 102.06 kg → 102
  assert.equal(c.after!.exercises[1], s.days[D].exercises[1]); // 225 stays as stored
  assert.equal(c.after!.exercises[3].suggestedWeight, 13.5); // 30 lbs → 13.6 kg → 13.5
});

test("update: an unknown user unit stores the call's weights as given", () => {
  const s = snapshot({ [D]: snapDay(D, { weightUnit: "lbs", weightUnitSource: "default" }) }, { weightUnit: undefined, weightUnitSource: "default" });
  const c = update({ weightUnit: "kg", operations: [{ op: "modify", target: { exerciseId: "Barbell_Squat" }, fields: { suggestedWeight: 100 } }] }, s);
  assert.equal(c.after!.exercises[1].suggestedWeight, 100);
  assert.equal(c.after!.weightUnit, "kg");
});

// movePlannedWorkout.ts: the copy keeps source, notes, user_modified; status 'planned'.
test("move: the day moves with its content; status resets to planned; the source date is empty", () => {
  const s = snapshot({ "2026-10-07": snapDay("2026-10-07", { skipped: true, userModified: true, source: "builder" }), "2026-10-09": emptyDay() });
  const [from, to] = R.movePlannedWorkout({ fromDate: "2026-10-07", toDate: "2026-10-09" }, s);
  assert.equal(from.after, null);
  assert.equal(to.before, null);
  assert.equal(to.after!.skipped, false);
  assert.equal(to.after!.userModified, true);
  assert.equal(to.after!.source, "builder");
  assert.equal(to.after!.notes, "keep");
  assert.deepEqual(to.after!.exercises, s.days["2026-10-07"].exercises);
  assert.equal(to.after!.version, null);
});

test("move: an occupied destination or a missing source throws", () => {
  const s = snapshot({ "2026-10-07": snapDay("2026-10-07"), "2026-10-09": snapDay("2026-10-09") });
  assert.throws(() => R.movePlannedWorkout({ fromDate: "2026-10-07", toDate: "2026-10-09" }, s), /destination_occupied/);
  assert.throws(() => R.movePlannedWorkout({ fromDate: "2026-10-08", toDate: "2026-10-10" }, s), /not_found/);
  assert.throws(() => R.movePlannedWorkout({ fromDate: "2026-10-07", toDate: "2026-10-07" }, s), /must differ/);
});

// skipPlannedWorkout.ts: only status changes; skip: false restores; same status is unchanged.
test("skip: status only; skip false restores; an unchanged skip changes nothing", () => {
  const s = snap();
  const [c] = R.skipPlannedWorkout({ date: D }, s);
  assert.equal(c.after!.skipped, true);
  assert.deepEqual(c.after!.exercises, c.before!.exercises);
  const sk = snapshot({ [D]: snapDay(D, { skipped: true }) });
  assert.equal(R.skipPlannedWorkout({ date: D, skip: false }, sk)[0].after!.skipped, false);
  const same = R.skipPlannedWorkout({ date: D, skip: true }, sk)[0];
  assert.equal(same.after, same.before);
});

// deletePlannedWorkout.ts: the day is gone.
test("delete: the day is gone; nothing to delete throws not_found", () => {
  const [c] = R.deletePlannedWorkout({ date: D }, snap());
  assert.equal(c.after, null);
  assert.throws(() => R.deletePlannedWorkout({ date: "2099-06-21" }, snap()), /not_found/);
});

// upsertPlannedDay.ts: source 'mcp', status 'planned', notes absent → null.
test("plan day: the full day replaces the stored one; notes absent are cleared; the skip is cleared", () => {
  const s = snapshot({ [D]: snapDay(D, { skipped: true }) });
  const [c] = R.planWorkoutDay({ date: D, dayType: "legs", dayName: "Legs", exercises: [squat], expectedVersion: v0 }, s);
  assert.deepEqual(c.after!.exercises, [squat]);
  assert.equal(c.after!.notes, undefined);
  assert.equal(c.after!.skipped, false);
  assert.equal(c.after!.source, "mcp");
  assert.equal(c.after!.dayName, "Legs");
});

test("plan day: weights in kg convert to a known lbs user unit (Tally rounding)", () => {
  const [c] = R.planWorkoutDay({ date: D, dayType: "legs", dayName: "Legs", weightUnit: "kg", exercises: [{ ...squat, suggestedWeight: 100 }] }, snap());
  assert.equal(c.after!.exercises[0].suggestedWeight, 220); // 100 kg → 220.46 lbs → 220
});

// planWorkout.ts planWorkoutRange: upsertPlannedDay(..., { keepSkipped: true }).
test("plan range: a skipped day is left alone; other days are written", () => {
  const s = snapshot({ "2099-06-20": snapDay("2099-06-20", { skipped: true }), "2099-06-21": emptyDay() });
  const changes = R.planWorkoutRange(
    {
      days: [
        { date: "2099-06-20", dayType: "legs", dayName: "Legs", exercises: [squat] },
        { date: "2099-06-21", dayType: "push", dayName: "Push", exercises: [bench] },
      ],
    },
    s,
  );
  assert.equal(changes[0].after, changes[0].before);
  assert.deepEqual(changes[1].after!.exercises, [bench]);
});

test("toDayPlan: suggestedSets become sets; weight and reps carry over; the unit is the day's", () => {
  const plan = R.toDayPlan(D, snapDay(D), "kg");
  assert.equal(plan.exercises[0].sets.length, 3);
  assert.deepEqual(plan.exercises[0].sets[0], { weight: 135, reps: 8, duration_s: null, rpe: null });
  assert.equal(plan.exercises[0].unit, "lbs");
  assert.equal(R.toDayPlan(D, { ...snapDay(D), weightUnit: undefined }, "kg").exercises[0].unit, "kg");
  // A stored exercise without a set count still counts as one set (fail closed).
  assert.equal(R.toDayPlan(D, snapDay(D, { exercises: [{ exerciseId: "x", name: "X" }] }), "lbs").exercises[0].sets.length, 1);
});

test("affectedDates per tool", () => {
  assert.deepEqual(R.affectedDates("move_planned_workout", { fromDate: "2026-10-07", toDate: "2026-10-09" }), ["2026-10-07", "2026-10-09"]);
  assert.deepEqual(R.affectedDates("plan_workout_range", { days: [{ date: "2026-10-07" }, { date: "2026-10-08" }] }), ["2026-10-07", "2026-10-08"]);
  assert.deepEqual(R.affectedDates("update_user_profile", { goals: "x" }), []);
  assert.throws(() => R.affectedDates("skip_planned_workout", { date: "10/7" }), /YYYY-MM-DD/);
});
