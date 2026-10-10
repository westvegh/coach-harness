import { test } from "node:test";
import assert from "node:assert/strict";
import { compileServerRules } from "./limits-compile.ts";
import { norm, ruleMatches } from "./server-match.ts";
import type { ServerRule } from "./server-match.ts";
import type { Limit, Limits, Taxonomy } from "./types.ts";

const tax: Taxonomy = {
  version: 1,
  regions: ["knee", "left-knee", "low-back", "shoulder"],
  patterns: {
    squat: { loads: ["knee"], muscles: ["quads"], recovery: false },
    loaded_deep_knee_flexion: { loads: ["knee"], muscles: [], recovery: false },
    lunge: { loads: ["knee"], muscles: ["quads"], recovery: false },
    hinge: { loads: ["low-back"], muscles: ["hamstrings"], recovery: false },
    horizontal_pull: { loads: ["shoulder"], muscles: ["lats"], recovery: false },
    rowing_erg: { loads: ["low-back"], muscles: [], recovery: false },
  },
  keywords: {
    squat: ["squat", "loaded_deep_knee_flexion"],
    "back squat": ["squat", "loaded_deep_knee_flexion"],
    "box squat": ["squat"],
    "split squat": ["lunge", "loaded_deep_knee_flexion"],
    "bulgarian split squat": ["lunge", "loaded_deep_knee_flexion"],
    deadlift: ["hinge"],
    "romanian deadlift": ["hinge"],
    row: ["horizontal_pull"],
    rowing: ["rowing_erg"],
  },
  exercises: { barbell_squat: ["squat", "loaded_deep_knee_flexion"], conventional_deadlift: ["hinge"] },
};

function limit(over: Partial<Limit>): Limit {
  return { id: "L-001", region: "left-knee", rule: "ban", patterns: [], exercises: [], allow: [], source: "athlete", since: "2026-10-09", ...over };
}
const doc = (...limits: Limit[]): Limits => ({ version: 1, pain_threshold: 4, limits });

test("a ban by pattern: keywords and exerciseIds from the taxonomy, kind ban, no cap", () => {
  const r = compileServerRules(doc(limit({ patterns: ["squat"], note: "No squats" })), tax);
  assert.deepEqual(r.skipped, []);
  const rule = r.rules[0];
  assert.equal(rule.id, "L-001");
  assert.equal(rule.kind, "ban");
  assert.equal(rule.label, "Left knee: No squats");
  assert.equal(rule.region, "left-knee");
  assert.ok(!("maxSetsPerWeek" in rule));
  assert.deepEqual(rule.keywords, ["back squat", "box squat", "squat"]);
  assert.deepEqual(rule.exerciseIds, ["barbell_squat"]);
  assert.ok(ruleMatches(rule, { exerciseId: "x", name: "Front Squat" }));
  assert.ok(!ruleMatches(rule, { exerciseId: "x", name: "Romanian Deadlift" }));
});

test("except-keywords come from longer taxonomy keywords that map to none of the limit's patterns", () => {
  const rule = compileServerRules(doc(limit({ patterns: ["squat"] })), tax).rules[0];
  assert.deepEqual(rule.exceptKeywords, ["bulgarian split squat", "split squat"]);
  assert.ok(!ruleMatches(rule, { exerciseId: "bulgarian_split_squat", name: "Bulgarian Split Squat" }));
  assert.ok(ruleMatches(rule, { exerciseId: "back_squat", name: "Back Squat" }));
  // The local deep-flexion pattern covers split squats: no except-keyword then.
  const deep = compileServerRules(doc(limit({ patterns: ["loaded_deep_knee_flexion"] })), tax).rules[0];
  assert.ok(deep.keywords.includes("split squat"));
  assert.deepEqual(deep.exceptKeywords, ["box squat"]);
  // Whole-word matching (spec v3.2): "row" does not occur in "rowing", so no except-keyword.
  const pull = compileServerRules(doc(limit({ patterns: ["horizontal_pull"] })), tax).rules[0];
  assert.deepEqual(pull.keywords, ["row"]);
  assert.deepEqual(pull.exceptKeywords, []);
  assert.ok(!ruleMatches(pull, { exerciseId: "rowing", name: "Rowing" }));
  assert.ok(ruleMatches(pull, { exerciseId: "cable_row", name: "Seated Cable Rows" }));
});

test("a cap with sets compiles to kind cap; its load cap stays local and is reported", () => {
  const r = compileServerRules(doc(limit({ id: "L-002", region: "low-back", rule: "cap", patterns: ["hinge"], max_sets_per_week: 6, max_load: { value: 135, unit: "lbs" } })), tax);
  assert.equal(r.rules.length, 1);
  assert.equal(r.rules[0].kind, "cap");
  assert.equal(r.rules[0].maxSetsPerWeek, 6);
  assert.deepEqual(r.rules[0].keywords, ["deadlift", "romanian deadlift"]);
  assert.deepEqual(r.rules[0].exerciseIds, ["conventional_deadlift"]);
  assert.equal(r.localOnly.length, 1);
  assert.match(r.localOnly[0].reason, /max_load/);
});

test("a cap with only max_load is skipped and reported", () => {
  const r = compileServerRules(doc(limit({ id: "L-003", rule: "cap", patterns: ["hinge"], max_load: { value: 100, unit: "kg" } })), tax);
  assert.deepEqual(r.rules, []);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].id, "L-003");
  assert.match(r.skipped[0].reason, /load/);
});

test("allow entries resolve to {exerciseId, name}; the limit's exercises add their resolved ids", () => {
  const resolved = {
    "Barbell Back Squat": { exerciseId: "barbell_back_squat", name: "Barbell Back Squat" },
    "box squat": { exerciseId: "box_squat", name: "Box Squat" },
  };
  const r = compileServerRules(doc(limit({ patterns: ["squat"], exercises: ["Barbell Back Squat"], allow: ["Box Squat"] })), tax, resolved);
  const rule = r.rules[0];
  assert.deepEqual(rule.allow, [{ exerciseId: "box_squat", name: "Box Squat" }]);
  assert.ok(rule.exerciseIds.includes("barbell_back_squat"));
  assert.deepEqual(r.unresolved, []);
  assert.ok(!ruleMatches(rule, { exerciseId: "box_squat", name: "Box Squat" }), "id and name allowed");
  assert.ok(ruleMatches(rule, { exerciseId: "box_squat", name: "Back Squat" }), "the allowed id with another name is not allowed");
});

test("an unresolved allow entry skips the limit, because Tally would refuse what the guard allows", () => {
  const r = compileServerRules(doc(limit({ patterns: ["squat"], allow: ["Box Squat"] })), tax, {});
  assert.deepEqual(r.rules, []);
  assert.deepEqual(r.unresolved, ["Box Squat"]);
  assert.match(r.skipped[0].reason, /resolve the allowed exercise "Box Squat"/);
});

test("an allow entry that is also one of the limit's exercises is dropped (the exercise list wins locally)", () => {
  const resolved = { "Box Squat": { exerciseId: "box_squat", name: "Box Squat" } };
  const r = compileServerRules(doc(limit({ patterns: ["hinge"], exercises: ["Box Squat"], allow: ["box squat"] })), tax, resolved);
  assert.deepEqual(r.rules[0].allow, []);
  assert.ok(ruleMatches(r.rules[0], { exerciseId: "box_squat", name: "Box Squat" }));
});

test("keywords and except-keywords are in norm() form and fit the spec's bounds", () => {
  const big: Taxonomy = { ...tax, keywords: { ...tax.keywords, "push up": ["squat"], "front squat": ["squat"] } };
  const rules: ServerRule[] = compileServerRules(doc(limit({ patterns: ["squat"] }), limit({ id: "L-002", patterns: ["lunge"] })), big).rules;
  for (const r of rules) {
    for (const k of [...r.keywords, ...r.exceptKeywords]) {
      assert.equal(k, norm(k), `${k} is in norm() form`);
      assert.ok(k.length >= 2 && k.length <= 60, k);
      assert.match(k, /^[\p{L}\p{N}]+( [\p{L}\p{N}]+)*$/u);
    }
    assert.match(r.id, /^[A-Za-z0-9_-]{1,40}$/);
    assert.ok(r.label.length >= 1 && r.label.length <= 80);
  }
});

test("norm(): NFKC, lowercase, punctuation and spaces fold to one space", () => {
  assert.equal(norm("Back-Squat"), "back squat");
  assert.equal(norm("ＢＡＣＫ　Ｓｑｕａｔ"), "back squat");
  assert.equal(norm("Back Squat (Barbell)"), "back squat barbell");
  assert.equal(norm("  __Pull_Up__ "), "pull up");
  assert.equal(norm(null), "");
  assert.equal(norm(undefined), "");
});

test("a limit with too many keywords for Tally is skipped and reported", () => {
  const keywords: Record<string, string[]> = {};
  for (let i = 0; i < 101; i++) keywords[`move${i}`] = ["hinge"];
  const r = compileServerRules(doc(limit({ patterns: ["hinge"] })), { ...tax, keywords });
  assert.deepEqual(r.rules, []);
  assert.match(r.skipped[0].reason, /101 keywords \(at most 100\)/);
});
