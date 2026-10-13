// V5 (0.2.4) part A: the draft spreads sets. The pack's per-exercise session maximum
// (NA-DES-009, 4 sets), the overflow order, the short list, and one exercise once a day.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftBlock } from "../engine/block-draft.ts";
import type { Template } from "../engine/methods.ts";
import { loadTemplates } from "../engine/methods.ts";
import { sessionMaxCheck } from "../engine/session-max.ts";
import type { DayPlan, Rules } from "../engine/types.ts";
import { rules, tax } from "./guard/fixtures.ts";
import { cli, REPO, writeJson } from "./e3/helpers.ts";

const RULES = rules();
const NO_MAX: Rules = { ...RULES, rules: RULES.rules.filter((r) => r.check?.type !== "max_sets_per_exercise_session") };
const CTX = { tax: tax(), rules: RULES, units: "lbs" as const, method: "nine-adaptations", today: "2026-10-14", emphasis: "all-around" as const, templateId: "3-day" };

/** The v4-engine EXERCISES map: plain names for every template slot pattern. */
const EXERCISES: Record<string, { name: string; exerciseId?: string }> = {
  plyometric: { name: "Box Jump" },
  squat: { name: "Barbell Back Squat" },
  horizontal_push: { name: "Bench Press" },
  hinge: { name: "Romanian Deadlift" },
  vertical_pull: { name: "Pull-Up" },
  overhead_press: { name: "Overhead Press" },
  horizontal_pull: { name: "Cable Row" },
  zone2_cardio: { name: "Zone 2 Bike" },
  mobility: { name: "Mobility Flow" },
  lunge: { name: "Walking Lunge" },
  knee_flexion: { name: "Lying Leg Curl" },
  knee_extension: { name: "Leg Extension" },
  lateral_raise: { name: "Lateral Raise" },
  elbow_flexion: { name: "Dumbbell Curl" },
  rear_delt: { name: "Reverse Fly" },
  intervals: { name: "Bike Intervals" },
  breathing: { name: "Box Breathing" },
  carry: { name: "Farmer Carry" },
  rotation: { name: "Cable Woodchop" },
  shrug: { name: "Dumbbell Shrug" },
};

/** A temp folder with methods/ linked and no coach.yaml (setup), removed after the test. */
function bare(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-v5-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  symlinkSync(join(REPO, "methods"), join(dir, "methods"));
  return dir;
}

const sets = (days: DayPlan[]) => days.map((d) => d.exercises.map((e) => `${e.name} ${e.sets.length}`));

// ---------- end to end: the 5-day hypertrophy draft ----------

test("V5 A e2e: the 5-day hypertrophy draft keeps every limited exercise at 4 sets or fewer, lists the short muscles, and its plan equals the week files' counted sets", (t) => {
  const dir = bare(t);
  const input = { method: "nine-adaptations", days: 5, emphasis: "hypertrophy", units: "lbs", timezone: "America/Los_Angeles", logger: "none", id: "B-001", start: "2026-10-19", exercises: EXERCISES };
  const p = writeJson(dir, ".tmp/coach/draft.json", input);
  const full = cli(["block", "draft", "--weeks", "6", "--input", p, "--root", dir]);
  assert.equal(full.code, 0, full.stderr);
  const d = full.json;
  assert.equal(d.ready, true);
  // The week's days, Monday to Saturday; only Friday's squat and Romanian deadlift change by week.
  const mon = (squat: number, rdl: number) => [
    ["Box Jump 2", "Barbell Back Squat 4", "Romanian Deadlift 4", "Walking Lunge 4", "Lying Leg Curl 4", "Farmer Carry 4", "Dumbbell Shrug 4"],
    ["Bench Press 4", "Cable Row 4", "Overhead Press 4", "Pull-Up 4", "Reverse Fly 4", "Bike Intervals 4"],
    ["Zone 2 Bike 1", "Mobility Flow 1", "Box Breathing 1"],
    ["Box Jump 2", `Barbell Back Squat ${squat}`, `Romanian Deadlift ${rdl}`, "Bench Press 4", "Pull-Up 4", "Lateral Raise 4", "Dumbbell Curl 4"],
    ["Bench Press 4", "Cable Row 4", "Leg Extension 4", "Cable Woodchop 4", "Farmer Carry 4", "Bike Intervals 1"],
  ];
  // Base (0.2.3): squat and leg curl 6 on Monday, overhead press 6, farmer carry 7 … (the brief's numbers).
  assert.deepEqual(sets(d.weeks[0].days), mon(3, 3));
  assert.deepEqual(sets(d.weeks[1].days), mon(4, 3));
  assert.deepEqual(sets(d.weeks[2].days), mon(4, 4));
  for (const w of d.weeks) for (const day of w.days) for (const e of day.exercises) if (e.adaptation !== "anaerobic_capacity" && e.adaptation !== "max_aerobic" && e.adaptation !== "long_duration" && e.adaptation !== "recovery") assert.ok(e.sets.length <= 4, `${w.week} ${e.name}`);
  const short = (w: number) => d.weeks[w - 1].short.map((x: any) => `${x.muscle} ${x.requested}>${x.planned} ${x.reason}`);
  assert.deepEqual(short(1), ["biceps 13>12 at_max", "chest 13>12 at_max", "core 15>12 at_max", "forearms 11>8 at_max", "hamstrings 12>11 other_target", "lats 17>16 at_max", "shoulders 17>12 at_max", "traps 14>12 at_max", "triceps 19>16 at_max"]);
  assert.deepEqual(short(2), ["biceps 13>12 at_max", "chest 13>12 at_max", "core 13>12 at_max", "forearms 9>8 at_max", "hamstrings 12>11 other_target", "lats 17>16 at_max", "shoulders 13>12 at_max", "traps 13>12 at_max", "triceps 17>16 at_max", "upper-back 13>12 at_max"]);
  assert.deepEqual(short(3), ["biceps 13>12 at_max", "chest 13>12 at_max", "core 13>12 at_max", "forearms 9>8 at_max", "lats 17>16 at_max", "quads 17>16 at_max", "shoulders 13>12 at_max", "traps 13>12 at_max", "triceps 17>16 at_max", "upper-back 13>12 at_max"]);
  assert.ok(d.warnings.includes("week 1: shoulders: 17 sets wanted, 12 planned: each shoulders exercise is at the session maximum of 4 sets; add an exercise or a day"), d.warnings.join("\n"));
  assert.ok(d.rule_ids.includes("NA-DES-009"));
  // The saved week files count the same sets as the plan.
  const out = cli(["block", "draft", "--weeks", "6", "--input", p, "--root", dir, "--out", join(dir, ".tmp/coach/b1")]);
  assert.equal(out.code, 0, out.stderr);
  assert.ok(Buffer.byteLength(out.stdout) < 8192, `summary is ${Buffer.byteLength(out.stdout)} bytes`);
  assert.equal(out.json.short.find((x: any) => x.muscle === "shoulders").weeks, "1: 17→12, 2: 13→12, 3: 13→12, 4: 13→12, 5: 13→12");
  assert.ok(out.json.why.short.some((l: string) => /shoulders \(12 of 17\)/.test(l)), JSON.stringify(out.json.why));
  for (const l of out.json.why.short) assert.doesNotMatch(l, /NA-|\.ts|\.yaml|\{|at_max/);
  for (const w of out.json.weeks) {
    const vol = cli(["volume", "--input", w.file, "--root", dir]);
    assert.equal(vol.code, 0, vol.stderr);
    assert.deepEqual(vol.json.sets_by_muscle, d.weeks[w.week - 1].planned_by_muscle, `week ${w.week}`);
    assert.equal(vol.json.session_max, undefined, "no coach.yaml: the audit's session check needs the pack");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(w.file, "utf8"))), ["week"], "no cluster list: the week file is as before");
  }
});

// ---------- allocation ----------

/** A 3-day template: day 1 squat 6 and leg press 2 (hypertrophy), day 2 intervals 8, day 3 mobility. */
function tpl(day1 = [{ pattern: "squat", sets: 6 }, { pattern: "leg_press", sets: 2 }]): Template {
  const slot = (pattern: string, n: number) => ({ pattern, adaptation: "hypertrophy" as const, sets: n, reps: 8, rest_s: 90 });
  return {
    pack: "nine-adaptations",
    version: 1,
    days: 3,
    name: "test",
    week: [
      { day: 1, focus: "Legs", slots: day1.map((s) => slot(s.pattern, s.sets)) },
      { day: 2, focus: "Intervals", slots: [{ pattern: "intervals", adaptation: "anaerobic_capacity", sets: 8, duration: 30, rest_s: 30 }] },
      { day: 3, focus: "Mobility", slots: [{ pattern: "mobility", adaptation: "recovery", sets: 1, duration: 600, rest_s: 0 }] },
    ],
    emphasis: { "all-around": {}, strength: {}, hypertrophy: {}, endurance: {}, "general-health": {} },
  };
}
const LEGS = { "1.1": { name: "Barbell Back Squat" }, "1.2": { name: "Leg Press" }, intervals: { name: "Bike Intervals" }, mobility: { name: "Mobility Flow" } };
const one = (d: ReturnType<typeof draftBlock>, w = 0) => Object.fromEntries(d.weeks[w].days.flatMap((x) => x.exercises.map((e) => [e.name, e.sets.length])));

test("V5 A: the maximum lowers a slot to 4 and the overflow moves to the named slot; conditioning keeps its sets", () => {
  const d = draftBlock(tpl(), 1, CTX, { start: "2026-10-19", exercises: LEGS });
  assert.deepEqual(one(d), { "Barbell Back Squat": 4, "Leg Press": 4, "Bike Intervals": 8, "Mobility Flow": 1 });
  assert.deepEqual(d.weeks[0].short, []);
  assert.deepEqual(d.weeks[0].planned_by_muscle, { glutes: 8, quads: 8 });
});

test("V5 A: an overflow that would put another muscle above its target stays short (other_target)", () => {
  const d = draftBlock(tpl(), 1, CTX, { start: "2026-10-19", targets: { quads: 8, glutes: 6 }, exercises: LEGS });
  assert.deepEqual(one(d), { "Barbell Back Squat": 4, "Leg Press": 2, "Bike Intervals": 8, "Mobility Flow": 1 });
  assert.deepEqual(d.weeks[0].short, [{ muscle: "quads", requested: 8, planned: 6, reason: "other_target" }]);
  assert.ok(d.warnings.includes("week 1: quads: 8 sets wanted, 6 planned: one more set on a quads exercise would put another muscle above its target"), d.warnings.join("\n"));
  // Target keys in another order give the same draft.
  const e = draftBlock(tpl(), 1, CTX, { start: "2026-10-19", targets: { glutes: 6, quads: 8 }, exercises: LEGS });
  assert.deepEqual(e.weeks, d.weeks);
});

test("V5 A: a muscle every slot of which is at the maximum is short (at_max); a muscle no limited slot trains is short (no_slot)", () => {
  const d = draftBlock(tpl([{ pattern: "squat", sets: 6 }]), 1, CTX, { start: "2026-10-19", targets: { quads: 6, glutes: 6, chest: 3 }, exercises: LEGS });
  assert.deepEqual(d.weeks[0].short, [
    { muscle: "chest", requested: 3, planned: 0, reason: "no_slot" },
    { muscle: "glutes", requested: 6, planned: 4, reason: "at_max" },
    { muscle: "quads", requested: 6, planned: 4, reason: "at_max" },
  ]);
});

test("V5 A: two limited slots with the same exercise on one day: the later one is unresolved and ready is false; two interval slots stay", () => {
  const d = draftBlock(tpl([{ pattern: "squat", sets: 6 }, { pattern: "squat", sets: 3 }]), 1, CTX, { start: "2026-10-19", exercises: { "1.1": { name: "Barbell Back Squat" }, "1.2": { name: "barbell back-squat" }, intervals: { name: "Bike Intervals" }, mobility: { name: "Mobility Flow" } } });
  assert.equal(d.ready, false);
  // The slot keeps its sets (with the overflow) for the exercise the coach picks instead.
  assert.deepEqual(d.unresolved, [{ slot: "1.2", day: "mon", pattern: "squat", adaptation: "hypertrophy", sets: 4, reason: "same exercise twice on Monday: choose another exercise for this slot" }]);
  // The exercise appears once on the day, at the maximum.
  assert.deepEqual(one(d), { "Barbell Back Squat": 4, "Bike Intervals": 8, "Mobility Flow": 1 });
  // The shipped 4-day template has two interval slots on day 4: the same exercise stays in both.
  const T4 = loadTemplates(join(REPO, "methods/nine-adaptations"))["4-day"];
  const four = draftBlock(T4, 1, { ...CTX, templateId: "4-day" }, { start: "2026-10-19", exercises: EXERCISES });
  assert.equal(four.ready, true);
  assert.deepEqual(four.weeks[0].days[3].exercises.map((e) => e.name), ["Bike Intervals", "Bike Intervals", "Box Breathing"]);
  // A pack without the check: no duplicate rule either (drafts unchanged).
  assert.equal(draftBlock(tpl([{ pattern: "squat", sets: 6 }, { pattern: "squat", sets: 3 }]), 1, { ...CTX, rules: NO_MAX }, { start: "2026-10-19", exercises: { "1.1": { name: "Barbell Back Squat" }, "1.2": { name: "Barbell Back Squat" }, intervals: { name: "Bike Intervals" }, mobility: { name: "Mobility Flow" } } }).ready, true);
});

test("V5 A: a pack without the check has no maximum: its drafts are rule 3 alone", () => {
  const d = draftBlock(tpl(), 2, { ...CTX, rules: NO_MAX }, { start: "2026-10-19", exercises: LEGS });
  assert.deepEqual(one(d), { "Barbell Back Squat": 6, "Leg Press": 2, "Bike Intervals": 8, "Mobility Flow": 1 });
  assert.deepEqual(d.weeks.map((w) => w.short), [[], []]);
  assert.equal(d.block.days[0].slots[0].sets, 6, "an above-default prescription stays valid");
  assert.equal(sessionMaxCheck(NO_MAX), null);
  assert.deepEqual(sessionMaxCheck(RULES), { id: "NA-DES-009", max: 4, adaptations: ["power", "strength", "hypertrophy", "muscular_endurance"] });
});

test("V5 A: a deload week after a capped build week scales the capped sets", () => {
  const d = draftBlock(tpl(), 2, CTX, { start: "2026-10-19", deload_weeks: [2], exercises: LEGS });
  assert.deepEqual(one(d, 0), { "Barbell Back Squat": 4, "Leg Press": 4, "Bike Intervals": 8, "Mobility Flow": 1 });
  assert.deepEqual(one(d, 1), { "Barbell Back Squat": 3, "Leg Press": 3, "Bike Intervals": 6, "Mobility Flow": 1 });
  assert.equal(d.weeks[1].kind, "deload");
  assert.deepEqual(d.block.days[0].slots.map((s) => s.sets), [4, 4], "the block's prescription is the most after the maximum");
});

test("V5 A: the audit reports a straight exercise above the maximum as advisory (volume session_max); the week stays valid", (t) => {
  const dir = bare(t);
  writeFileSync(join(dir, "coach.yaml"), readFileSync(join(REPO, "coach.example.yaml"), "utf8"));
  const week = { week: { week_start: "2026-10-19", days: [{ date: "2026-10-19", exercises: [{ name: "Bench Press", sets: Array.from({ length: 6 }, () => ({ reps: 8 })) }, { name: "Bike Intervals", sets: Array.from({ length: 8 }, () => ({ duration_s: 30 })) }] }] } };
  const p = writeJson(dir, "w.json", week);
  const vol = cli(["volume", "--input", p, "--root", dir]);
  assert.equal(vol.code, 0, vol.stderr);
  assert.deepEqual(vol.json.session_max, [{ date: "2026-10-19", exercise: "Bench Press", sets: 6, max: 4, rule_id: "NA-DES-009", text: "Bench Press on 2026-10-19: 6 sets in one session, above the drafting default of 4 (advisory: the athlete may choose more)" }]);
});
