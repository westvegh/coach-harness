// Tally day ↔ DayPlan, and adjust/loads on Tally days.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustDay } from "../../engine/adjust.ts";
import { planToTallyDay, snapshotDayToPlan, tallyDayToPlan } from "../../engine/tally-shape.ts";
import { toDayPlan } from "../../adapters/loggers/tally/day.ts";
import { bench, curl, plannedDay, row3, snapDay, snapshot, squat, tax, NOW, SESSION } from "../guard/fixtures.ts";
import { cli, instance, writeJson } from "./helpers.ts";

const RANGE = { exerciseId: "Dumbbell_Lunge", name: "Dumbbell Lunge", suggestedSets: 3, suggestedReps: 8, repsMax: 12, suggestedWeight: 40, rpe: 8, perSide: true };
const TIMED = { exerciseId: "zone2_bike", name: "Zone 2 Bike", suggestedSets: 1, suggestedDuration: 2400 };

test("round trip: every fixture exercise comes back exactly as Tally stored it", () => {
  const day = plannedDay("2026-10-15", { exercises: [bench, squat, row3, curl, RANGE, TIMED] });
  const plan = tallyDayToPlan(day, { units: "kg" });
  assert.equal(plan.date, "2026-10-15");
  assert.equal(plan.exercises[0].unit, "lbs", "Tally's known unit wins over the fallback");
  assert.equal(plan.exercises[0].sets.length, 3);
  assert.deepEqual(plan.exercises[4].sets[0], { weight: 40, reps: 12, duration_s: null, rpe: 8 });
  const back = planToTallyDay(plan);
  assert.deepEqual(back.day.exercises, [bench, squat, row3, curl, RANGE, TIMED]);
  assert.deepEqual(back.warnings, []);
  assert.equal(back.day.dayType, "push");
  assert.equal(back.day.dayName, "Push");
  assert.equal(back.day.notes, "keep");
  assert.equal(back.day.weightUnit, "lbs");
});

test("the forward sets match the guard's toDayPlan (one conversion, two callers)", () => {
  const sd = snapDay("2026-10-15", { exercises: [bench, squat, row3, RANGE, TIMED] });
  const ours = snapshotDayToPlan("2026-10-15", sd, "lbs");
  const guard = toDayPlan("2026-10-15", sd, "lbs");
  assert.deepEqual(ours.exercises.map((e) => e.sets), guard.exercises.map((e) => e.sets));
  assert.deepEqual(ours.exercises.map((e) => [e.exerciseId, e.name, e.unit]), guard.exercises.map((e) => [e.exerciseId, e.name, e.unit]));
});

test("a trim comes back as fewer suggestedSets with every other field kept", () => {
  const plan = tallyDayToPlan(plannedDay("2026-10-15", { exercises: [squat, RANGE] }), { units: "lbs" });
  const trimmed = adjustDay(plan, "trim", { tax: tax(), thresholds: {} });
  const back = planToTallyDay(trimmed.day);
  assert.deepEqual(back.day.exercises, [
    { ...squat, suggestedSets: 3 },
    { ...RANGE, suggestedSets: 2 },
  ]);
});

test("a changed rep target drops repsMax; a changed weight rewrites suggestedWeight only", () => {
  const plan = tallyDayToPlan(plannedDay("2026-10-15", { exercises: [RANGE] }), { units: "lbs" });
  const ex = plan.exercises[0];
  ex.sets = ex.sets.map((s) => ({ ...s, weight: 45 }));
  assert.deepEqual(planToTallyDay(plan).day.exercises[0], { ...RANGE, suggestedWeight: 45 });
  ex.sets = ex.sets.map((s) => ({ ...s, reps: 10 }));
  const { repsMax: _drop, ...rest } = RANGE;
  assert.deepEqual(planToTallyDay(plan).day.exercises[0], { ...rest, suggestedWeight: 45, suggestedReps: 10 });
});

test("a recovery day comes back with custom exercise ids, durations and dayType recovery", () => {
  const plan = tallyDayToPlan(plannedDay("2026-10-15", { exercises: [squat, bench] }), { units: "lbs" });
  const rec = adjustDay(plan, "recovery", { tax: tax(), thresholds: {}, planned_minutes: 45 });
  const back = planToTallyDay(rec.day);
  assert.equal(back.day.dayType, "recovery");
  assert.equal(back.day.dayName, "Recovery");
  for (const e of back.day.exercises) {
    assert.match(String(e.exerciseId), /^[a-z0-9_]+$/);
    assert.equal(e.suggestedSets, 1);
    assert.equal(typeof e.suggestedDuration, "number");
  }
  assert.equal(back.day.exercises.reduce((a, e) => a + (e.suggestedDuration as number), 0), 45 * 60);
  assert.ok(back.warnings.some((w) => /search_exercises/.test(w)));
});

test("adjust before the fix: a raw Tally day crashed the engine; now it is converted", () => {
  const raw = plannedDay("2026-10-15", { exercises: [squat, bench] });
  assert.throws(() => adjustDay({ ...raw, exercises: raw.exercises } as never, "trim", { tax: tax(), thresholds: {} }), /Cannot read properties of undefined/);
  const dir = instance();
  const r = cli(["adjust", "--decision", "trim", "--root", dir], { input: JSON.stringify(raw) });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.tally_day.exercises, [{ ...squat, suggestedSets: 3 }, { ...bench, suggestedSets: 2 }]);
  assert.deepEqual(r.json.changes, ["Squat: 4 → 3 sets", "Bench Press: 3 → 2 sets"]);
});

test("adjust also takes a tool response ([{type, text}]) and {day, decision} on stdin", () => {
  const dir = instance();
  const raw = plannedDay("2026-10-15", { exercises: [squat] });
  const r1 = cli(["adjust", "--decision", "trim", "--root", dir], { input: JSON.stringify([{ type: "text", text: JSON.stringify(raw) }]) });
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(r1.json.tally_day.exercises[0].suggestedSets, 3);
  const r2 = cli(["adjust", "--root", dir], { input: JSON.stringify({ day: raw, decision: "trim" }) });
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(r2.json.tally_day.exercises[0].suggestedSets, 3);
});

test("adjust --from-snapshot reads the day from the snapshot", () => {
  const dir = instance();
  writeJson(dir, "athlete/.cache/snapshot.json", snapshot({ "2026-10-15": snapDay("2026-10-15", { exercises: [squat, RANGE] }) }));
  const r = cli(["adjust", "--from-snapshot", "2026-10-15", "--decision", "trim", "--now", NOW, "--root", dir], { env: { CLAUDE_CODE_SESSION_ID: SESSION } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.day.date, "2026-10-15");
  assert.deepEqual(r.json.tally_day.exercises, [{ ...squat, suggestedSets: 3 }, { ...RANGE, suggestedSets: 2 }]);
  const missing = cli(["adjust", "--from-snapshot", "2026-10-16", "--decision", "trim", "--now", NOW, "--session", SESSION, "--root", dir]);
  assert.equal(missing.code, 1);
  assert.equal(missing.json.error.code, "NOT_IN_SNAPSHOT");
});

test("the engine-shape input still works unchanged", () => {
  const dir = instance();
  const day = { date: "2026-10-15", dayName: "Lower", exercises: [{ name: "Back Squat", sets: [{ weight: 100, reps: 5 }, { weight: 100, reps: 5 }, { weight: 100, reps: 5 }] }] };
  const r = cli(["adjust", "--input", writeJson(dir, "a.json", { day, decision: "trim" }), "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.day.exercises[0].sets.length, 2);
  assert.equal(r.json.tally_day, undefined);
});

test("loads --from-snapshot and on stdin: suggestions plus update_planned_workout operations", () => {
  const dir = instance();
  const history = [
    { date: "2026-10-12", weightUnit: "lbs", exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", muscle: "Quads", sets: [{ weight: 225, reps: 5, rpe: 7 }, { weight: 225, reps: 5, rpe: 7 }] }] },
  ];
  writeJson(dir, "athlete/.cache/snapshot.json", snapshot({ "2026-10-15": snapDay("2026-10-15", { exercises: [squat, bench] }) }, { history: history as never }));
  const r = cli(["loads", "--from-snapshot", "2026-10-15", "--now", NOW, "--root", dir], { env: { CLAUDE_CODE_SESSION_ID: SESSION } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.units, "lbs");
  assert.equal(r.json.suggestions[0].suggestedWeight, 235);
  assert.deepEqual(r.json.update, { date: "2026-10-15", weightUnit: "lbs", operations: [{ op: "modify", target: { exerciseId: "Barbell_Squat" }, fields: { suggestedWeight: 235 } }], not_targeted: [] });
  const s = cli(["loads", "--root", dir], { input: JSON.stringify(plannedDay("2026-10-15", { exercises: [squat] })) });
  assert.equal(s.code, 0, s.stderr);
  assert.equal(s.json.update.operations.length, 1);
});

test("a day that was not found is refused, not converted to an empty plan", () => {
  assert.throws(() => tallyDayToPlan({ date: "2026-10-15", found: false, exercises: [] }, { units: "lbs" }), /not found/);
});

test("--from-snapshot refuses a snapshot from another session, a stale day, or no session id", () => {
  const dir = instance();
  writeJson(dir, "athlete/.cache/snapshot.json", snapshot({ "2026-10-15": snapDay("2026-10-15", { exercises: [squat] }) }));
  const args = ["adjust", "--from-snapshot", "2026-10-15", "--decision", "trim", "--root", dir];
  const foreign = cli([...args, "--now", NOW], { env: { CLAUDE_CODE_SESSION_ID: "another-session" } });
  assert.equal(foreign.code, 1);
  assert.equal(foreign.json.error.code, "SNAPSHOT_STALE");
  assert.match(foreign.json.error.message, /another session/);
  const stale = cli([...args, "--now", "2026-10-14T07:30:00-07:00", "--session", SESSION]);
  assert.equal(stale.code, 1);
  assert.match(stale.json.error.message, /2026-10-15 was read 30 minutes ago/);
  const none = cli([...args, "--now", NOW]);
  assert.equal(none.code, 1);
  assert.equal(none.json.error.code, "SESSION_UNKNOWN");
  const loads = cli(["loads", "--from-snapshot", "2026-10-15", "--now", "2026-10-14T07:30:00-07:00", "--session", SESSION, "--root", dir]);
  assert.equal(loads.json.error.code, "SNAPSHOT_STALE");
});

test("a 225 lb history with a kg plan suggests about 107.5 kg, never 237.5 kg", () => {
  const dir = instance();
  const history = [{ date: "2026-10-12", weightUnit: "lbs", exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", muscle: "Quads", sets: [{ weight: 225, reps: 5, rpe: 7 }] }] }];
  const kgDay = snapDay("2026-10-15", { exercises: [{ ...squat, suggestedWeight: 100 }], weightUnit: "kg", weightUnitSource: "settings" });
  writeJson(dir, "athlete/.cache/snapshot.json", snapshot({ "2026-10-15": kgDay }, { history: history as never, weightUnit: "kg" }));
  const r = cli(["loads", "--from-snapshot", "2026-10-15", "--now", NOW, "--session", SESSION, "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.units, "kg");
  // 225 lb = 102 kg (Tally's rounding); +5% (lower body) = 107.1 → 107.5 kg on the 2.5 kg step.
  assert.equal(r.json.suggestions[0].suggestedWeight, 107.5);
  assert.deepEqual(r.json.update.operations[0].fields, { suggestedWeight: 107.5 });
});

test("a session without a unit gives no suggestion (unknown, not a guess)", () => {
  const dir = instance();
  const history = [{ date: "2026-10-12", exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", muscle: "Quads", sets: [{ weight: 225, reps: 5, rpe: 7 }] }] }];
  writeJson(dir, "athlete/.cache/snapshot.json", snapshot({ "2026-10-15": snapDay("2026-10-15", { exercises: [squat] }) }, { history: history as never }));
  const r = cli(["loads", "--from-snapshot", "2026-10-15", "--now", NOW, "--session", SESSION, "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.suggestions[0].suggestedWeight, undefined);
  assert.match(r.json.suggestions[0].reason, /unit of the session on 2026-10-12 is unknown/);
  assert.deepEqual(r.json.update.operations, []);
});

test("an explicit write unit survives the round trip (kg stays kg)", () => {
  const write = { date: "2026-10-15", dayType: "legs", dayName: "Legs", weightUnit: "kg", exercises: [{ ...squat, suggestedWeight: 100 }] };
  const plan = tallyDayToPlan(write, { units: "lbs" });
  assert.equal(plan.exercises[0].unit, "kg");
  const back = planToTallyDay(plan);
  assert.equal(back.day.weightUnit, "kg");
  assert.equal(back.day.exercises[0].suggestedWeight, 100);
  // A read whose unit Tally does not know still uses the athlete's unit (§20 item 9).
  const read = { ...plannedDay("2026-10-15"), weightUnit: "kg", weightUnitSource: "default" };
  assert.equal(tallyDayToPlan(read, { units: "lbs" }).exercises[0].unit, "lbs");
});
