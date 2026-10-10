import { test } from "node:test";
import assert from "node:assert/strict";
import { CoachError } from "./errors.ts";
import { suggestLoads, type SessionHistory } from "./loads.ts";
import { loadTaxonomy } from "./taxonomy.ts";
import type { ExerciseEntry, HistorySet, Rules } from "./types.ts";

const tax = loadTaxonomy({ localPath: null });
const rules: Rules = { pack: "t", version: 1, rules: [{ id: "NA-PROG-003", text: "cap", kind: "policy", severity: "hard", check: { type: "top_set_jump_max", value: 0.1 } }] };
const noRules: Rules = { pack: "t", version: 1, rules: [] };

const plan = (name: string, reps = 5, rpe?: number, exerciseId?: string): ExerciseEntry => ({
  name,
  ...(exerciseId ? { exerciseId } : {}),
  sets: Array.from({ length: 3 }, () => ({ reps, ...(rpe === undefined ? {} : { rpe }) })),
});
const logged = (weight: number, reps: number[], rpe: number | null = 8): HistorySet[] => reps.map((r) => ({ weight, reps: r, rpe }));
const hist = (name: string, entries: [string, HistorySet[]][], exerciseId = name.toLowerCase().replace(/ /g, "_"), muscle = ""): SessionHistory =>
  entries.map(([date, sets]) => ({ date, exercises: [{ exerciseId, name, muscle, sets }] }));

test("hit: +5% for lower body, rounded to 5 lbs", () => {
  const [s] = suggestLoads([plan("Back Squat")], hist("Back Squat", [["2026-10-05", logged(200, [5, 5, 5])]]), rules, "lbs", { tax });
  assert.equal(s.suggestedWeight, 210);
  assert.deepEqual(s.rule_ids, ["NA-PROG-003"]);
  assert.match(s.reason, /^hit 5 reps/);
});

test("hit: +2.5% for upper body; at least one plate step", () => {
  const [a] = suggestLoads([plan("Bench Press")], hist("Bench Press", [["2026-10-05", logged(200, [5, 5, 5])]]), rules, "lbs", { tax });
  assert.equal(a.suggestedWeight, 205);
  const [b] = suggestLoads([plan("Bench Press")], hist("Bench Press", [["2026-10-05", logged(100, [5, 5, 5])]]), rules, "lbs", { tax });
  assert.equal(b.suggestedWeight, 105); // 102.5 rounds to 105
  const [c] = suggestLoads([plan("Bench Press")], hist("Bench Press", [["2026-10-05", logged(60, [5, 5, 5])]]), rules, "lbs", { tax });
  assert.equal(c.suggestedWeight, 65); // 61.5 rounds to 60 → one plate step
});

test("plate rounding in kg: 2.5 kg steps", () => {
  const [a] = suggestLoads([plan("Back Squat")], hist("Back Squat", [["2026-10-05", logged(100, [5, 5, 5])]]), rules, "kg", { tax });
  assert.equal(a.suggestedWeight, 105);
  const [b] = suggestLoads([plan("Bench Press")], hist("Bench Press", [["2026-10-05", logged(80, [5, 5, 5])]]), rules, "kg", { tax });
  assert.equal(b.suggestedWeight, 82.5);
  const [c] = suggestLoads([plan("Back Squat")], hist("Back Squat", [["2026-10-05", logged(105, [5, 5, 5])]]), rules, "kg", { tax });
  assert.equal(c.suggestedWeight, 110); // 110.25 → 110
});

test("RPE above the target counts as a miss: repeat", () => {
  const [s] = suggestLoads([plan("Back Squat", 5, 8)], hist("Back Squat", [["2026-10-05", logged(200, [5, 5, 5], 9.5)]]), rules, "lbs", { tax });
  assert.equal(s.suggestedWeight, 200);
  assert.match(s.reason, /repeat/);
});

test("missed once: repeat", () => {
  const h = hist("Back Squat", [["2026-10-05", logged(200, [5, 5, 3])], ["2026-09-28", logged(195, [5, 5, 5])]]);
  const [s] = suggestLoads([plan("Back Squat")], h, rules, "lbs", { tax });
  assert.equal(s.suggestedWeight, 200);
  assert.deepEqual(s.rule_ids, []);
});

test("missed twice: −5%, rounded down to the plate step", () => {
  const h = hist("Back Squat", [["2026-10-05", logged(200, [5, 4, 3])], ["2026-09-28", logged(200, [5, 5, 4])]]);
  const [s] = suggestLoads([plan("Back Squat")], h, rules, "lbs", { tax });
  assert.equal(s.suggestedWeight, 190);
  assert.match(s.reason, /twice/);
  const hk = hist("Back Squat", [["2026-10-05", logged(102.5, [5, 4, 3])], ["2026-09-28", logged(102.5, [4, 4, 4])]]);
  assert.equal(suggestLoads([plan("Back Squat")], hk, rules, "kg", { tax })[0].suggestedWeight, 95); // 97.375 → 95
});

test("the order of history does not matter: the latest session is the last one", () => {
  const h = hist("Back Squat", [["2026-09-28", logged(200, [5, 5, 3])], ["2026-10-05", logged(200, [5, 5, 5])]]);
  assert.equal(suggestLoads([plan("Back Squat")], h, rules, "lbs", { tax })[0].suggestedWeight, 210);
});

test("top_set_jump_max caps the jump; a cap below one plate step repeats", () => {
  const capRules: Rules = { ...rules, rules: [{ ...rules.rules[0], check: { type: "top_set_jump_max", value: 0.03 } }] };
  const [a] = suggestLoads([plan("Back Squat")], hist("Back Squat", [["2026-10-05", logged(400, [5, 5, 5])]]), capRules, "lbs", { tax });
  assert.equal(a.suggestedWeight, 410); // +5% = 420 > 412 cap → 410
  assert.match(a.reason, /capped/);
  const [b] = suggestLoads([plan("Curl")], hist("Curl", [["2026-10-05", logged(20, [5, 5, 5])]]), rules, "lbs", { tax });
  assert.equal(b.suggestedWeight, 20); // +5 lbs is 25% > 10%
  assert.match(b.reason, /top_set_jump_max/);
  assert.deepEqual(b.rule_ids, ["NA-PROG-003"]);
  const [c] = suggestLoads([plan("Curl")], hist("Curl", [["2026-10-05", logged(20, [5, 5, 5])]]), noRules, "lbs", { tax });
  assert.equal(c.suggestedWeight, 25); // no cap rule
});

test("no history means no suggestion; matching is by exerciseId, then by name", () => {
  const h = hist("Back Squat", [["2026-10-05", logged(200, [5, 5, 5])]], "bb_squat");
  const out = suggestLoads([plan("Front Squat"), plan("Squat", 5, undefined, "bb_squat"), plan("back squat"), plan("Back Squat", 5, undefined, "other_id")], h, rules, "lbs", { tax });
  assert.equal(out[0].suggestedWeight, undefined);
  assert.match(out[0].reason, /no logged history/);
  assert.equal(out[1].suggestedWeight, 210);
  assert.equal(out[1].exerciseId, "bb_squat");
  assert.equal(out[2].suggestedWeight, 210);
  assert.equal(out[3].suggestedWeight, undefined); // both have IDs and they differ
  assert.deepEqual(suggestLoads([plan("Back Squat")], [], rules, "lbs")[0].suggestedWeight, undefined);
});

test("without a taxonomy the muscle decides upper or lower", () => {
  const h = hist("Thing", [["2026-10-05", logged(200, [5, 5, 5])]]);
  assert.equal(suggestLoads([{ ...plan("Thing"), muscle: "Quads" }], h, rules, "lbs")[0].suggestedWeight, 210);
  assert.equal(suggestLoads([{ ...plan("Thing"), muscle: "Chest" }], h, rules, "lbs")[0].suggestedWeight, 205);
});

test("bad units throw", () => {
  assert.throws(() => suggestLoads([], [], rules, "stone" as never), CoachError);
});

test("missed twice at the smallest plate weight never goes up and never passes the cap", () => {
  // Review input: target 10 reps; two sessions at 2.5 lb with 5 reps; top_set_jump_max 0.1.
  const h = hist("Lateral Raise", [["2026-10-05", logged(2.5, [5, 5])], ["2026-09-28", logged(2.5, [5, 5])]]);
  const [s] = suggestLoads([plan("Lateral Raise", 10)], h, rules, "lbs", { tax });
  assert.ok(s.suggestedWeight === undefined || s.suggestedWeight <= 2.5, `got ${s.suggestedWeight}`);
  assert.equal(s.suggestedWeight, 2.5);
  assert.match(s.reason, /no lighter plate weight/);
});

test("every suggestion stays within the last top set × (1 + top_set_jump_max)", () => {
  const cases: [number, number[], number[]][] = [
    [2.5, [5, 5], [5, 5]],
    [7.5, [10, 10], [10, 10]],
    [20, [10, 10], [10, 10]],
    [3, [4, 4], [4, 4]],
  ];
  for (const [w, a, b] of cases) {
    for (const units of ["lbs", "kg"] as const) {
      const h = hist("Curl", [["2026-10-05", logged(w, a)], ["2026-09-28", logged(w, b)]]);
      const [s] = suggestLoads([plan("Curl", 10)], h, rules, units, { tax });
      if (s.suggestedWeight !== undefined) assert.ok(s.suggestedWeight <= w * 1.1 + 1e-9, `${w} ${units} → ${s.suggestedWeight}`);
    }
  }
});
