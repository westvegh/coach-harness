// block draft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { draftBlock } from "../../engine/block-draft.ts";
import { blockSessionProblem } from "../../engine/classify.ts";
import { loadTemplates, scaledSets } from "../../engine/methods.ts";
import { allowedSets } from "../../engine/progression.ts";
import { saveSnapshot } from "../../engine/snapshot.ts";
import { planToTallyDay } from "../../engine/tally-shape.ts";
import { guard, historyWeeks } from "../../engine/validate.ts";
import { weeklySetsByMuscle } from "../../engine/volume.ts";
import { emptyDay, guardInput, NOW, rules, session, snapshot, tax, TODAY } from "../guard/fixtures.ts";
import { cli, instance, REPO, writeJson } from "./helpers.ts";
import type { Rules } from "../../engine/types.ts";

const T = loadTemplates(join(REPO, "methods/nine-adaptations"));
const CTX = { tax: tax(), rules: rules(), units: "lbs" as const, method: "nine-adaptations", today: "2026-10-14", emphasis: "all-around" as const, templateId: "4-day" };

/** Named exercises for every 4-day slot, so the guard can classify them. */
const EXERCISES = {
  plyometric: { name: "Box Jump", exerciseId: "Box_Jump" },
  squat: { name: "Barbell Back Squat", exerciseId: "Barbell_Squat" },
  horizontal_push: { name: "Bench Press", exerciseId: "Barbell_Bench_Press" },
  hinge: { name: "Romanian Deadlift", exerciseId: "Romanian_Deadlift" },
  vertical_pull: { name: "Pull-Up", exerciseId: "Pull_Up" },
  overhead_press: { name: "Overhead Press", exerciseId: "Overhead_Press" },
  horizontal_pull: { name: "Cable Row", exerciseId: "Cable_Row" },
  zone2_cardio: { name: "Zone 2 Bike", exerciseId: "zone2_bike" },
  mobility: { name: "Mobility Flow", exerciseId: "mobility_flow" },
  lunge: { name: "Walking Lunge", exerciseId: "Walking_Lunge" },
  knee_flexion: { name: "Lying Leg Curl", exerciseId: "Lying_Leg_Curl" },
  knee_extension: { name: "Leg Extension", exerciseId: "Leg_Extension" },
  lateral_raise: { name: "Lateral Raise", exerciseId: "Lateral_Raise" },
  elbow_flexion: { name: "Dumbbell Curl", exerciseId: "Dumbbell_Curl" },
  rear_delt: { name: "Reverse Fly", exerciseId: "Reverse_Fly" },
  intervals: { name: "Bike Intervals", exerciseId: "Bike_Intervals" },
  breathing: { name: "Box Breathing", exerciseId: "box_breathing" },
};

test("with no targets, week 1 is the template under the emphasis multiplier, day by day", () => {
  const d = draftBlock(T["4-day"], 6, { ...CTX, emphasis: "strength" }, { start: "2026-10-19", id: "B-001", exercises: EXERCISES });
  const w1 = d.weeks[0];
  assert.equal(w1.week_start, "2026-10-19");
  assert.deepEqual(w1.days.map((x) => x.date), ["2026-10-19", "2026-10-20", "2026-10-22", "2026-10-23"]);
  const tpl = T["4-day"];
  const got = w1.days.flatMap((day) => day.exercises.map((e) => e.sets.length));
  const want = tpl.week.flatMap((day) => day.slots.map((s) => scaledSets(s, tpl, "strength"))).filter((n) => n > 0);
  assert.deepEqual(got, want);
  // Reps: the top of a range; duration: the top of a range.
  const hinge = w1.days[0].exercises.find((e) => (e as { pattern?: string }).pattern === "hinge")!;
  assert.equal(hinge.sets[0].reps, 10);
  assert.equal(d.block.template.emphasis, "strength");
});

test("targets are allocated across slots: never above a target, at least 1 set a slot", () => {
  const d = draftBlock(T["4-day"], 1, CTX, { start: "2026-10-19", targets: { chest: 6, quads: 4, hamstrings: 3 }, exercises: EXERCISES });
  const w = d.weeks[0];
  // quads: squat (3), lunge (3), knee_extension (2) → 4 splits 2/1/1 (largest remainder).
  assert.deepEqual([w.sets_by_muscle.chest, w.sets_by_muscle.quads, w.sets_by_muscle.hamstrings], [6, 4, 3]);
  const kneeExt = w.days.flatMap((x) => x.exercises).find((e) => (e as { pattern?: string }).pattern === "knee_extension")!;
  assert.equal(kneeExt.sets.length, 1);
  // Muscles without a target keep the base sets of slots that train no target muscle.
  const curl = w.days.flatMap((x) => x.exercises).find((e) => (e as { pattern?: string }).pattern === "elbow_flexion")!;
  assert.equal(curl.sets.length, 4);
  // A target below the slot count: the 1-set minimum wins, with a warning.
  const tiny = draftBlock(T["4-day"], 1, CTX, { start: "2026-10-19", targets: { quads: 1 }, exercises: EXERCISES });
  assert.equal(tiny.weeks[0].sets_by_muscle.quads, 3);
  assert.ok(tiny.warnings.some((x) => /1-set minimum per slot gives 3 sets, above the target 1/.test(x)));
});

test("build weeks step up within the volume cap; the deload keeps 70% of sets and loads, rounded", () => {
  const d = draftBlock(T["4-day"], 6, CTX, { start: "2026-10-19", id: "B-001", step: 0.07, exercises: EXERCISES, loads: { Barbell_Squat: 225, "Bench Press": 135 } });
  assert.deepEqual(d.weeks.map((w) => w.kind), ["build", "build", "build", "build", "build", "deload"], "deload_every_weeks 6");
  for (let i = 1; i < 5; i++) {
    for (const [m, n] of Object.entries(d.weeks[i].sets_by_muscle)) {
      const prev = d.weeks[i - 1].sets_by_muscle[m] ?? 0;
      assert.ok(n <= allowedSets(prev, 0.1), `week ${i + 1} ${m}: ${n} after ${prev}`);
    }
  }
  const w5 = d.weeks[4];
  const w6 = d.weeks[5];
  assert.equal(w6.load_factor, 0.7);
  const squat5 = w5.days[0].exercises.find((e) => e.exerciseId === "Barbell_Squat")!;
  const squat6 = w6.days[0].exercises.find((e) => e.exerciseId === "Barbell_Squat")!;
  assert.equal(squat6.sets.length, Math.max(1, Math.round(squat5.sets.length * 0.7)));
  assert.equal(squat5.sets[0].weight, 225);
  assert.equal(squat6.sets[0].weight, 160, "225 × 0.7 = 157.5, rounded to 5 lbs");
  const bench6 = w6.days[0].exercises.find((e) => e.exerciseId === "Barbell_Bench_Press")!;
  assert.equal(bench6.sets[0].weight, 95, "135 × 0.7 = 94.5, rounded to 5 lbs");
  // The block validates and says the same counts as its days.
  assert.equal(d.block.id, "B-001");
  assert.deepEqual(d.block.weeks.map((w) => w.kind), ["build", "build", "build", "build", "build", "deload"]);
  assert.deepEqual(d.block.weeks[5].targets, w6.sets_by_muscle);
  assert.ok(d.rule_ids.length >= 2);
});

test("every drafted day passes the guard's block_session check, deload included, and counts as the draft says", () => {
  const d = draftBlock(T["4-day"], 6, CTX, { start: "2026-10-19", id: "B-001", exercises: EXERCISES });
  for (const w of d.weeks) {
    for (const day of w.days) assert.equal(blockSessionProblem(day, { block: d.block, tax: tax(), rules: rules() }), null, `week ${w.week} ${day.date}`);
    const counted = weeklySetsByMuscle({ week_start: w.week_start, days: w.days }, tax());
    assert.deepEqual(counted, w.sets_by_muscle, `week ${w.week}`);
  }
});

test("explicit deload weeks, and a warning when the cycle runs past the pack's deload rule", () => {
  const d = draftBlock(T["3-day"], 8, { ...CTX, templateId: "3-day" }, { start: "2026-10-19", deload_weeks: [4] });
  assert.deepEqual(d.weeks.map((w) => w.kind), ["build", "build", "build", "deload", "build", "build", "build", "build"]);
  const none = draftBlock(T["3-day"], 8, { ...CTX, templateId: "3-day" }, { start: "2026-10-19", deload_weeks: [] as number[] });
  assert.ok(none.warnings.some((w) => /deloads every 6 weeks/.test(w)));
  const noRules: Rules = { pack: "x", version: 1, rules: [] };
  const plain = draftBlock(T["3-day"], 2, { ...CTX, templateId: "3-day", rules: noRules }, { start: "2026-10-19" });
  assert.ok(plain.warnings.some((w) => /no weekly_volume_increase_max/.test(w)));
});

test("bad input is refused", () => {
  assert.throws(() => draftBlock(T["4-day"], 6, CTX, { start: "2026-10-20" }), /Monday/);
  assert.throws(() => draftBlock(T["4-day"], 0, CTX), /--weeks/);
  assert.throws(() => draftBlock(T["4-day"], 6, CTX, { weekdays: ["mon", "tue", "wed"] }), /weekdays/);
  assert.throws(() => draftBlock(T["4-day"], 6, CTX, { targets: { quads: 2.5 } }), /targets.quads/);
});

test("CLI block draft: the coach.yaml template, the next Monday, and an --input file", () => {
  const dir = instance();
  const r = cli(["block", "draft", "--weeks", "6", "--now", "2026-10-14T07:00:00-07:00", "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.template, "4-day");
  assert.equal(r.json.block.start, "2026-10-19");
  assert.equal(r.json.weeks.length, 6);
  const inp = writeJson(dir, "d.json", { id: "B-002", targets: { chest: 8 }, start: "2026-11-02" });
  const r2 = cli(["block", "draft", "--template", "3-day", "--weeks", "4", "--input", inp, "--root", dir]);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(r2.json.block.id, "B-002");
  assert.equal(r2.json.block.template.days, 3);
  assert.equal(cli(["block", "draft", "--template", "9-day", "--weeks", "4", "--root", dir]).code, 2);
  assert.equal(cli(["block", "draft", "--root", dir]).code, 2);
});

test("without exercises the draft returns no usable days; its counts equal weeklySetsByMuscle", () => {
  const d = draftBlock(T["4-day"], 6, CTX, { start: "2026-10-19", id: "B-001" });
  assert.equal(d.ready, false);
  assert.equal(d.unresolved.length, T["4-day"].week.reduce((a, x) => a + x.slots.length, 0));
  assert.deepEqual(d.unresolved[1], { slot: "1.2", day: "mon", pattern: "squat", adaptation: "strength", sets: 4, reason: "no exercise given (input.exercises)" });
  for (const w of d.weeks) {
    assert.deepEqual(w.days.flatMap((x) => x.exercises), []);
    assert.deepEqual(w.sets_by_muscle, weeklySetsByMuscle({ week_start: w.week_start, days: w.days }, tax()));
  }
  // The plan itself still counts every slot (the block week's targets).
  assert.equal(d.weeks[0].planned_by_muscle.chest, 9);
  assert.deepEqual(d.block.weeks[0].targets, d.weeks[0].planned_by_muscle);
  assert.ok(d.warnings.some((x) => x.startsWith(`${d.unresolved.length} slots have no resolved exercise`)));
});

test("a partly mapped draft returns only the resolved exercises, and an unclassified name stays unresolved", () => {
  const d = draftBlock(T["4-day"], 1, CTX, { start: "2026-10-19", exercises: { squat: EXERCISES.squat, hinge: { name: "Zorblax Machine" } } });
  const names = d.weeks[0].days.flatMap((x) => x.exercises.map((e) => e.name));
  assert.deepEqual(names, ["Barbell Back Squat"]);
  assert.equal(d.unresolved.find((u) => u.pattern === "hinge")?.reason, "Zorblax Machine is unclassified");
  assert.deepEqual(d.weeks[0].sets_by_muscle, { glutes: 3, quads: 3 });
  for (const day of d.weeks[0].days) assert.equal(blockSessionProblem(day, { block: { ...d.block, id: "B-001" }, tax: tax(), rules: rules() }) === null || day.exercises.length === 0, true);
});

// ---------- week 1 against recent history ----------

/** A logged week 2026-10-05: chest 7, triceps 7, shoulders 6, the other muscles at or above the template. */
const HISTORY = [
  session("2026-10-06", [{ name: "Bench Press", exerciseId: "Barbell_Bench_Press", sets: 4, weight: 135, reps: 8 }, { name: "Lateral Raise", sets: 3 }, { name: "Barbell Back Squat", sets: 5 }, { name: "Cable Row", sets: 5 }, { name: "Dumbbell Curl", sets: 4 }, { name: "Romanian Deadlift", sets: 5 }]),
  session("2026-10-08", [{ name: "Bench Press", exerciseId: "Barbell_Bench_Press", sets: 3, weight: 135, reps: 8 }, { name: "Lateral Raise", sets: 3 }, { name: "Barbell Back Squat", sets: 5 }, { name: "Pull-Up", sets: 5 }, { name: "Dumbbell Curl", sets: 4 }, { name: "Lying Leg Curl", sets: 5 }]),
];
const histSnap = (days: Record<string, ReturnType<typeof emptyDay>> = {}) =>
  snapshot(days, { history: HISTORY, planned: { captured_at: NOW, from: TODAY, dates: {} } });
const LOGS = historyWeeks(histSnap(), "lbs");

/** Week 1 of a draft as one plan_workout_range call (T2: ifAbsent on every day). */
const weekOneRange = (d: ReturnType<typeof draftBlock>) => ({
  days: d.weeks[0].days.map((day) => {
    const { weightUnit: _unit, ...tally } = planToTallyDay(day).day;
    return { ...tally, ifAbsent: true };
  }),
});

function validateWeekOne(d: ReturnType<typeof draftBlock>) {
  const days = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`2026-10-${19 + i}`, emptyDay()]));
  return guard(guardInput({ tool: "plan_workout_range", args: weekOneRange(d), snapshot: histSnap(days), block: d.block }));
}

test("week 1 of a new block is capped against the reference week (the scenario numbers: chest 9 vs 7, triceps 13 vs 7, shoulders 10 vs 6)", () => {
  const input = { start: "2026-10-19", id: "B-002", exercises: EXERCISES };
  const free = draftBlock(T["4-day"], 6, CTX, input);
  assert.deepEqual([free.weeks[0].planned_by_muscle.chest, free.weeks[0].planned_by_muscle.triceps, free.weeks[0].planned_by_muscle.shoulders], [9, 13, 10]);
  const ref = weeklySetsByMuscle(LOGS[0], tax());
  assert.deepEqual([ref.chest, ref.triceps, ref.shoulders], [7, 7, 6]);

  const d = draftBlock(T["4-day"], 6, { ...CTX, history: LOGS }, input);
  assert.deepEqual(d.reference, { week_start: "2026-10-05", sets_by_muscle: ref });
  const capped = Object.fromEntries(d.capped.map((c) => [c.muscle, c]));
  assert.deepEqual(capped.chest, { muscle: "chest", base: 7, planned: 9, allowed: 8 });
  assert.deepEqual(capped.triceps, { muscle: "triceps", base: 7, planned: 13, allowed: 8 });
  assert.deepEqual(capped.shoulders, { muscle: "shoulders", base: 6, planned: 10, allowed: 7 });
  for (const [m, n] of Object.entries(d.weeks[0].sets_by_muscle)) assert.ok(n <= allowedSets(ref[m] ?? 0, 0.1), `${m}: ${n} against ${ref[m] ?? 0}`);
  assert.ok(d.warnings.some((w) => /chest: week-1 target 9 capped at 8 against 7 sets in the reference week 2026-10-05 \[NA-PROG-001\]/.test(w)), d.warnings.join("\n"));
  // Later build weeks still step up within the cap.
  for (let i = 1; i < 5; i++) {
    for (const [m, n] of Object.entries(d.weeks[i].sets_by_muscle)) assert.ok(n <= allowedSets(d.weeks[i - 1].sets_by_muscle[m] ?? 0, 0.1), `week ${i + 1} ${m}`);
  }

  // The guard: the uncapped week 1 is denied by NA-PROG-001; the capped week 1 is not.
  const before = validateWeekOne(free);
  assert.equal(before.decision, "deny");
  assert.ok(before.reasons.some((r) => /chest: 9 sets .* against 7 in the reference week 2026-10-05/.test(r)), before.reasons.join("\n"));
  const after = validateWeekOne(d);
  assert.equal(after.decision, "allow", after.reasons.join("\n"));
  assert.ok(!after.reasons.some((r) => /NA-PROG-001/.test(r)), after.reasons.join("\n"));
});

test("week 1 with no history, or no completed week, keeps the targets as given", () => {
  const input = { start: "2026-10-19", id: "B-002", exercises: EXERCISES };
  const free = draftBlock(T["4-day"], 6, CTX, input);
  for (const history of [[], LOGS.map((l) => ({ ...l, days: l.days.slice(0, 1) }))]) {
    const d = draftBlock(T["4-day"], 6, { ...CTX, history }, input);
    assert.equal(d.reference, null);
    assert.deepEqual(d.capped, []);
    assert.deepEqual(d.weeks, free.weeks);
  }
});

test("CLI block draft caps week 1 against the snapshot history", () => {
  const dir = instance();
  saveSnapshot(dir, histSnap());
  const inputPath = writeJson(dir, ".tmp/coach/d.json", { start: "2026-10-19", id: "B-002" });
  const r = cli(["block", "draft", "--weeks", "6", "--input", inputPath, "--root", dir, "--now", NOW]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.reference.week_start, "2026-10-05");
  assert.deepEqual(r.json.capped.find((c: { muscle: string }) => c.muscle === "triceps"), { muscle: "triceps", base: 7, planned: 13, allowed: 8 });
  assert.equal(r.json.weeks[0].planned_by_muscle.triceps <= 8, true);
});
