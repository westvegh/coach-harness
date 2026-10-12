// Change classification (contracts §6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { toDayPlan } from "../../adapters/loggers/tally/day.ts";
import { classifyChange, isUserDay, type ClassifyContext } from "../../engine/classify.ts";
import type { DayPlan, LoggerExercise } from "../../engine/types.ts";
import { bench, block, config, row3, rules, session, snapDay, squat, tax, TODAY } from "./fixtures.ts";

const D = "2026-10-15";
const plan = (exercises: LoggerExercise[], over: Record<string, unknown> = {}, date = D): DayPlan => toDayPlan(date, snapDay(date, { exercises, ...over }), "lbs");

function ctx(over: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    block: block(),
    history: [],
    tool: "update_planned_workout",
    snapshotDay: snapDay(D),
    tax: tax(),
    rules: rules(),
    config: config(),
    today: TODAY,
    ...over,
  };
}

test("annotate: only the name or the notes change (small)", () => {
  const r = classifyChange(plan([bench, squat]), plan([bench, squat], { dayName: "Push B", notes: "new" }), ctx());
  assert.deepEqual(r.kinds, ["annotate"]);
  assert.equal(r.big, false);
});

test("trim_session: same exercises, fewer sets (small); removing one is a trim too", () => {
  const r = classifyChange(plan([bench, squat]), plan([bench, { ...squat, suggestedSets: 3 }]), ctx());
  assert.deepEqual(r.kinds, ["trim_session"]);
  assert.equal(r.big, false);
  assert.deepEqual(classifyChange(plan([bench, squat]), plan([bench]), ctx()).kinds, ["trim_session"]);
});

test("load_progression: same exercises, load up inside top_set_jump_max (small); beyond it fits no small kind (big)", () => {
  const ok = classifyChange(plan([bench, squat]), plan([bench, { ...squat, suggestedWeight: 235 }]), ctx());
  assert.deepEqual(ok.kinds, ["load_progression"]);
  assert.equal(ok.big, false);
  const far = classifyChange(plan([bench, squat]), plan([bench, { ...squat, suggestedWeight: 275 }]), ctx());
  assert.deepEqual(far.kinds, []);
  assert.equal(far.big, true);
});

test("swap_to_recovery: only recovery patterns (small)", () => {
  const z2 = { exerciseId: "zone2_bike", name: "Zone 2 Bike", suggestedSets: 1, suggestedDuration: 2400 };
  const mob = { exerciseId: "mobility_flow", name: "Mobility Flow", suggestedSets: 1, suggestedDuration: 600 };
  const r = classifyChange(plan([bench, squat]), plan([z2, mob]), ctx());
  assert.deepEqual(r.kinds, ["swap_to_recovery"]);
  assert.equal(r.big, false);
});

test("reschedule_within_week: a move inside Monday to Sunday (small); across weeks fits no small kind", () => {
  const within = classifyChange(plan([bench], {}, "2026-10-15"), plan([bench], {}, "2026-10-17"), ctx({ tool: "move_planned_workout" }));
  assert.deepEqual(within.kinds, ["reschedule_within_week"]);
  assert.equal(within.big, false);
  const across = classifyChange(plan([bench], {}, "2026-10-15"), plan([bench], {}, "2026-10-20"), ctx({ tool: "move_planned_workout" }));
  assert.equal(across.big, true);
});

test("new_exercise: in neither the block nor the last 8 weeks of history (big)", () => {
  const press = { exerciseId: "Overhead_Press", name: "Overhead Press", suggestedSets: 3, suggestedReps: 5, suggestedWeight: 95 };
  const r = classifyChange(plan([bench]), plan([bench, press]), ctx());
  assert.ok(r.kinds.includes("new_exercise"));
  assert.equal(r.big, true);
  // Logged 3 weeks ago: not new.
  const h = [session("2026-09-23", [{ name: "Overhead Press", sets: 3, weight: 90 }])];
  assert.ok(!classifyChange(plan([bench]), plan([bench, press]), ctx({ history: h })).kinds.includes("new_exercise"));
  // Logged 9 weeks ago: new again.
  const old = [session("2026-08-10", [{ name: "Overhead Press", sets: 3, weight: 90 }])];
  assert.ok(classifyChange(plan([bench]), plan([bench, press]), ctx({ history: old })).kinds.includes("new_exercise"));
  // A block slot pattern covers it (the block plans horizontal_pull): a row is not new.
  assert.ok(!classifyChange(plan([bench]), plan([bench, row3]), ctx()).kinds.includes("new_exercise"));
});

test("volume_above_plan: the week's sets for a muscle exceed the block target by more than 1 (big)", () => {
  const volume = { week_start: "2026-10-12", before: { chest: 6 }, after: { chest: 8 } };
  const r = classifyChange(plan([bench]), plan([{ ...bench, suggestedSets: 5 }]), ctx({ volume }));
  assert.ok(r.kinds.includes("volume_above_plan"));
  assert.equal(r.big, true);
  // 7 is target + 1: not above plan.
  assert.ok(!classifyChange(plan([bench]), plan([{ ...bench, suggestedSets: 4 }]), ctx({ volume: { ...volume, after: { chest: 7 } } })).kinds.includes("volume_above_plan"));
  // No target for the muscle: any rise is above plan (fail closed).
  assert.ok(classifyChange(plan([bench]), plan([bench]), ctx({ volume: { week_start: "2026-10-12", before: { biceps: 0 }, after: { biceps: 2 } } })).kinds.includes("volume_above_plan"));
});

test("user days: isUserDay, override_user_day, skip_or_delete_user_day", () => {
  assert.equal(isUserDay(snapDay(D)), false);
  assert.equal(isUserDay(snapDay(D, { source: "builder" })), true);
  assert.equal(isUserDay(snapDay(D, { userModified: true })), true);
  const user = snapDay(D, { userModified: true });
  const o = classifyChange(plan([bench, squat]), plan([bench]), ctx({ snapshotDay: user }));
  assert.deepEqual(o.kinds.sort(), ["override_user_day", "trim_session"]);
  assert.equal(o.big, true);
  const s = classifyChange(plan([bench]), plan([bench], { skipped: true }), ctx({ tool: "skip_planned_workout", snapshotDay: user }));
  assert.deepEqual(s.kinds, ["skip_or_delete_user_day"]);
  assert.equal(s.big, true);
  const del = classifyChange(plan([bench]), null, ctx({ tool: "delete_planned_workout", snapshotDay: snapDay(D, { source: "builder" }) }));
  assert.deepEqual(del.kinds, ["skip_or_delete_user_day"]);
  // An MCP day: skip and delete are trims.
  assert.deepEqual(classifyChange(plan([bench]), null, ctx({ tool: "delete_planned_workout" })).kinds, ["trim_session"]);
});

test("several kinds at once: a trim plus a new exercise is big", () => {
  const press = { exerciseId: "Overhead_Press", name: "Overhead Press", suggestedSets: 3, suggestedReps: 5, suggestedWeight: 95 };
  const r = classifyChange(plan([bench, squat]), plan([{ ...bench, suggestedSets: 2 }, press]), ctx());
  assert.ok(r.kinds.includes("new_exercise"));
  assert.equal(r.big, true);
});

test("big vs small follows coach.yaml approval", () => {
  const strict = config({ approval: { auto: ["annotate", "swap_to_recovery", "load_progression", "reschedule_within_week"], ask: ["trim_session", "new_exercise", "volume_above_plan", "override_user_day", "skip_or_delete_user_day", "limit_change", "new_block", "method_change"] } });
  const r = classifyChange(plan([bench, squat]), plan([bench]), ctx({ config: strict }));
  assert.deepEqual(r.kinds, ["trim_session"]);
  assert.equal(r.big, true);
  // A kind listed nowhere is ask (config.ts fills it in): fail closed.
  const unlisted = config({ approval: { auto: ["annotate"], ask: [] } });
  assert.equal(classifyChange(plan([bench, squat]), plan([bench]), ctx({ config: unlisted })).big, true);
});

test("a new day on an empty date outside the block, not a recovery day, fits no small kind (big)", () => {
  // The fixture block has 7 weeks (to 2026-10-25).
  const r = classifyChange(null, plan([bench], {}, "2026-10-27"), ctx({ tool: "plan_workout_day", snapshotDay: null }));
  assert.deepEqual(r.kinds, []);
  assert.equal(r.big, true);
});

// ---------- contracts §6 block_session (ruling 2026-10-09) ----------

const planNew = (tool = "plan_workout_day") => ctx({ tool: tool as ClassifyContext["tool"], snapshotDay: null });

test("block_session: a template day on an empty date is small", () => {
  // The fixture block's slots: horizontal_push 3, squat 4, horizontal_pull 3.
  const r = classifyChange(null, plan([bench, squat, row3]), planNew());
  assert.deepEqual(r.kinds, ["block_session"]);
  assert.equal(r.big, false);
  // A slot that names its exercise matches by exerciseId, then by name.
  const named = block({ days: [{ day: "mon", focus: "x", slots: [{ pattern: "squat", adaptation: "strength", sets: 4, exercise: "Barbell_Squat" }] }] });
  assert.deepEqual(classifyChange(null, plan([squat]), { ...planNew(), block: named }).kinds, ["block_session"]);
  const goblet = { exerciseId: "Goblet_Squat", name: "Goblet Squat", suggestedSets: 3, suggestedReps: 10 };
  assert.notDeepEqual(classifyChange(null, plan([goblet]), { ...planNew(), block: named }).kinds, ["block_session"]);
});

test("block_session: one extra exercise outside the slots is new_exercise (big)", () => {
  const press = { exerciseId: "Overhead_Press", name: "Overhead Press", suggestedSets: 3, suggestedReps: 5, suggestedWeight: 95 };
  const r = classifyChange(null, plan([bench, squat, row3, press]), planNew());
  assert.ok(r.kinds.includes("new_exercise"));
  assert.ok(!r.kinds.includes("block_session"));
  assert.equal(r.big, true);
});

test("block_session: sets above the slot prescription are not a block session (big)", () => {
  const r = classifyChange(null, plan([bench, { ...squat, suggestedSets: 5 }, row3]), planNew());
  assert.ok(!r.kinds.includes("block_session"));
  assert.equal(r.big, true);
  assert.ok(r.reasons.some((x) => /Squat: 5 sets, above the slot's 4/.test(x)));
  // A deload week scales the prescription by deload_depth.volume (0.7): squat 4 → 3.
  const deload = block({ weeks: block().weeks.map((w) => (w.week === 6 ? { ...w, kind: "deload" as const } : w)) });
  assert.ok(!classifyChange(null, plan([squat]), { ...planNew(), block: deload }).kinds.includes("block_session"));
  assert.deepEqual(classifyChange(null, plan([{ ...squat, suggestedSets: 3 }]), { ...planNew(), block: deload }).kinds, ["block_session"]);
});
