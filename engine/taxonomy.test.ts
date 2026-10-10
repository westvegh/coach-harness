import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, loadTaxonomy, normalizeName, parentRegion, regionMatches } from "./taxonomy.ts";
import { CoachError } from "./errors.ts";
import { weeklySetsByMuscle } from "./volume.ts";

const tax = loadTaxonomy({ localPath: null });

test("shipped taxonomy meets the minimums", () => {
  assert.ok(tax.regions.length >= 20, `regions: ${tax.regions.length}`);
  for (const r of ["knee", "shoulder", "hip", "elbow", "wrist"]) {
    for (const side of ["left", "right"]) assert.ok(tax.regions.includes(`${side}-${r}`), `${side}-${r}`);
  }
  assert.ok(Object.keys(tax.patterns).length >= 30, `patterns: ${Object.keys(tax.patterns).length}`);
  for (const p of [
    "loaded_deep_knee_flexion", "hinge", "horizontal_push", "vertical_push", "horizontal_pull", "vertical_pull",
    "overhead_press", "loaded_spinal_flexion", "rotation", "carry", "lunge", "plyometric", "zone2_cardio", "intervals",
    "mobility", "breathing",
  ]) assert.ok(p in tax.patterns, p);
  for (const p of ["zone2_cardio", "mobility", "breathing"]) assert.equal(tax.patterns[p].recovery, true, p);
  assert.equal(tax.patterns.intervals.recovery, false);
  assert.ok(Object.keys(tax.keywords).length >= 150, `keywords: ${Object.keys(tax.keywords).length}`);
});

test("an exact exercise entry beats keywords", () => {
  const c = classify({ exerciseId: "Barbell_Squat", name: "Squat" }, tax);
  assert.equal(c.source, "exercise");
  assert.deepEqual(c.patterns, ["squat", "loaded_deep_knee_flexion"]);
  // By name, case-insensitive.
  assert.equal(classify({ name: "barbell back squat" }, tax).source, "exercise");
});

test("the longest keyword wins", () => {
  // "squat" and "box squat" both match; "box squat" is longer and has no deep flexion.
  assert.deepEqual(classify({ name: "Squat (Barbell)" }, tax).patterns, ["squat", "loaded_deep_knee_flexion"]);
  assert.deepEqual(classify({ name: "Barbell Box Squat" }, tax).patterns, ["squat"]);
  assert.deepEqual(classify({ name: "High Bar Back Squat" }, tax).patterns, ["squat", "loaded_deep_knee_flexion"]);
  assert.deepEqual(classify({ name: "Dumbbell Bulgarian Split Squat" }, tax).patterns, ["lunge", "loaded_deep_knee_flexion"]);
  assert.deepEqual(classify({ name: "Reverse Nordic Curl" }, tax).patterns, ["knee_extension", "loaded_deep_knee_flexion"]);
  assert.deepEqual(classify({ name: "Romanian Deadlift (Dumbbell)" }, tax).patterns, ["hinge"]);
  assert.deepEqual(classify({ name: "Seated Leg Curl" }, tax).patterns, ["knee_flexion"]);
});

test("keywords match whole words, with plurals", () => {
  // "row" must not match inside "throw"; "spin" must not match "spinal".
  assert.deepEqual(classify({ name: "Med Ball Throw" }, tax).patterns, ["plyometric"]);
  assert.deepEqual(classify({ name: "Spinal Twist" }, tax).patterns, ["mobility"]);
  assert.deepEqual(classify({ name: "Push-ups" }, tax).patterns, ["horizontal_push"]);
  assert.deepEqual(classify({ name: "Farmers Walk" }, tax).patterns, ["carry"]);
  assert.deepEqual(classify({ name: "Cable Crunches" }, tax).patterns, ["loaded_spinal_flexion"]);
});

test("the exerciseId is a keyword fallback when the name has no match", () => {
  assert.deepEqual(classify({ exerciseId: "dumbbell_lateral_raise", name: "DB LR" }, tax).patterns, ["lateral_raise"]);
});

test("regions and muscles come from the patterns, plus the exercise's own muscle", () => {
  const c = classify({ name: "Back Squat", muscle: "Lower Back" }, tax);
  assert.deepEqual(c.regions, ["knee", "hip", "low-back"]);
  assert.deepEqual(c.muscles, ["quads", "glutes", "lower-back"]);
  // The own muscle is not duplicated.
  assert.deepEqual(classify({ name: "Back Squat", muscle: "quads" }, tax).muscles, ["quads", "glutes"]);
});

test("an unknown exercise is unclassified", () => {
  const c = classify({ exerciseId: "x_9", name: "Zorbonian Wiggle", muscle: "Chest" }, tax);
  assert.equal(c.source, "none");
  assert.deepEqual(c.patterns, []);
  assert.deepEqual(c.regions, []);
  assert.deepEqual(c.muscles, ["chest"]);
});

test("side regions match their parents", () => {
  assert.equal(parentRegion("left-knee", tax), "knee");
  assert.equal(parentRegion("knee", tax), null);
  const squat = classify({ name: "Back Squat" }, tax);
  // A pattern that loads `knee` triggers a `left-knee` limit.
  assert.equal(regionMatches("left-knee", squat.regions, tax), true);
  assert.equal(regionMatches("knee", ["right-knee"], tax), true);
  assert.equal(regionMatches("left-knee", ["right-knee"], tax), false);
  assert.equal(regionMatches("left-shoulder", squat.regions, tax), false);
});

test("the local file overrides and extends the shipped taxonomy", () => {
  const root = mkdtempSync(join(tmpdir(), "coach-tax-"));
  mkdirSync(join(root, "athlete"));
  writeFileSync(
    join(root, "athlete/movements.local.yaml"),
    `version: 1
regions: [jaw]
keywords:
  "box squat": [squat, loaded_deep_knee_flexion]
exercises:
  Zorbonian Wiggle: [mobility]
`,
  );
  const local = loadTaxonomy({ root });
  assert.ok(local.regions.includes("jaw"));
  assert.deepEqual(classify({ name: "Box Squat" }, local).patterns, ["squat", "loaded_deep_knee_flexion"]);
  assert.equal(classify({ name: "Zorbonian Wiggle" }, local).source, "exercise");
  // The shipped taxonomy is unchanged.
  assert.deepEqual(classify({ name: "Box Squat" }, tax).patterns, ["squat"]);
});

test("a broken local file fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "coach-tax-"));
  mkdirSync(join(root, "athlete"));
  writeFileSync(join(root, "athlete/movements.local.yaml"), `version: 1\nkeywords:\n  "wiggle": [no_such_pattern]\n`);
  assert.throws(() => loadTaxonomy({ root }), (e: unknown) => e instanceof CoachError && /unknown pattern no_such_pattern/.test(e.message));
  writeFileSync(join(root, "athlete/movements.local.yaml"), `version: 1\nkeywords:\n  "Wiggle": [mobility]\n`);
  assert.throws(() => loadTaxonomy({ root }), /keywords must be lowercase words/);
  writeFileSync(join(root, "athlete/movements.local.yaml"), `version: 1\npatterns:\n  walk: { loads: [knee], recovery: true }\n`);
  assert.throws(() => loadTaxonomy({ root }), /a recovery pattern cannot load a region/);
});

test("normalizeName", () => {
  assert.equal(normalizeName("  Push-Up (DB)  "), "push up db");
  assert.equal(normalizeName("Farmer's Walk"), "farmer s walk");
});

test("A2: separate matches combine; a recovery phrase never erases a loaded pattern", () => {
  const c = classify({ name: "Back Squat + Box Breathing" }, tax);
  assert.deepEqual([...c.patterns].sort(), ["breathing", "loaded_deep_knee_flexion", "squat"]);
  assert.ok(c.regions.includes("knee"));
  // Overlapping phrases still use the longest match.
  assert.deepEqual(classify({ name: "Reverse Nordic Curl" }, tax).patterns, ["knee_extension", "loaded_deep_knee_flexion"]);
  assert.deepEqual(classify({ name: "Close Grip Bench Press" }, tax).patterns, ["horizontal_push", "elbow_extension"]);
  assert.deepEqual(classify({ name: "Rear Delt Fly" }, tax).patterns, ["rear_delt"]);
  assert.deepEqual(classify({ name: "Stretch then Deadlift" }, tax).patterns.sort(), ["hinge", "mobility"]);
});

test("a Tally muscle that is not a muscle adds nothing; a recovery pattern takes no Tally muscle", () => {
  for (const muscle of ["cardio", "Cardio", "conditioning", "mobility", "Stretching", "breathing", "full body", "Full-Body", " FULL  BODY ", "full_body", "other"]) {
    assert.deepEqual(classify({ name: "Zorbonian Wiggle", muscle }, tax).muscles, [], muscle);
  }
  assert.deepEqual(classify({ name: "Zone 2 Bike", muscle: "cardio" }, tax).muscles, []);
  assert.deepEqual(classify({ name: "Box Breathing", muscle: "Chest" }, tax).muscles, []);
  assert.ok(!classify({ name: "Bike Intervals", muscle: "cardio" }, tax).muscles.includes("cardio"));
  // A real muscle still counts.
  assert.deepEqual(classify({ name: "Zorbonian Wiggle", muscle: "Chest" }, tax).muscles, ["chest"]);
});

test("weekly volume: a recovery day and an intervals day add no 'cardio' sets", () => {
  const set = { reps: 1 };
  const week = {
    week_start: "2026-10-12",
    days: [
      { date: "2026-10-14", exercises: [{ name: "Zone 2 Bike", muscle: "cardio", sets: [set] }, { name: "Mobility Flow", muscle: "mobility", sets: [set] }] },
      { date: "2026-10-16", exercises: [{ name: "Bike Intervals", muscle: "cardio", sets: Array(13).fill(set) }] },
    ],
  };
  assert.deepEqual(weeklySetsByMuscle(week as never, tax), {});
});
