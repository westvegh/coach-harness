// P3 (the P2 confirmation review, items 9 and 10): a trim keeps its safety classification
// (fix 1), and regionless conditioning in a combined exercise is checked (fix 2). The
// reviewer's inputs fail on 3ad41ce; the normal-rules cases keep their verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guard, type GuardInput } from "../../engine/validate.ts";
import type { Hold, Snapshot } from "../../engine/types.ts";
import { block, emptyDay, guardInput, NOW, snapDay, snapshot, v } from "./fixtures.ts";

const D = "2026-10-15";
const V = v(`r-${D}`, "t0");
const MODES = ["interactive", "unattended"] as const;

const squat = { exerciseId: "Barbell_Squat", name: "Squat", suggestedSets: 4, suggestedReps: 5, suggestedWeight: 225 };
const bench = { exerciseId: "Barbell_Bench_Press", name: "Bench Press", suggestedSets: 3, suggestedReps: 8, suggestedWeight: 135 };
const bikeBench = { exerciseId: "bike_bench", name: "Bike and Bench Press", suggestedSets: 3, suggestedReps: 8, suggestedWeight: 135, suggestedDuration: 30 };
const z2 = { exerciseId: "zone2_bike", name: "Zone 2 Bike", suggestedSets: 1, suggestedDuration: 1200 };
const easyRun = { exerciseId: "easy_run", name: "Easy Run", suggestedSets: 1, suggestedDuration: 1800 };
const ruck = { exerciseId: "ruck", name: "Ruck", suggestedSets: 1, suggestedDuration: 1800, suggestedWeight: 30 };

const roomy = block({ weeks: block().weeks.map((w) => ({ ...w, targets: { chest: 20, triceps: 20, shoulders: 20, quads: 20, glutes: 20, hamstrings: 20, "upper-back": 20, lats: 20 } })) });
const day = (...exercises: Record<string, unknown>[]) => snapshot({ "2026-10-12": emptyDay(), "2026-10-13": emptyDay(), [D]: snapDay(D, { exercises }) });
const run = (over: Partial<GuardInput> & { snapshot: Snapshot | null }) => guard(guardInput({ tool: "update_planned_workout", args: {}, block: roomy, ...over }));
const upd = (operations: unknown[]) => ({ date: D, expectedVersion: V, operations });
const modify = (exerciseId: string, fields: Record<string, unknown>) => upd([{ op: "modify", target: { exerciseId }, fields }]);
const has = (reasons: string[], re: RegExp) => assert.ok(reasons.some((r) => re.test(r)), `no reason matches ${re}:\n${reasons.join("\n")}`);

const shoulders: Hold = { active: true, set_at: NOW, reason: "left-shoulder right-shoulder 4/10 reported 2026-10-14", regions: ["left-shoulder", "right-shoulder"], set_by: "safety-agent" };
const knee: Hold = { ...shoulders, reason: "left-knee 5/10 reported 2026-10-14", regions: ["left-knee"] };
const systemic: Hold = { ...shoulders, reason: "dizziness reported 2026-10-14", regions: [] };

test("P3 fix 1: a trim that renames the squat to a bench press goes through the hold checks; a real squat trim passes", () => {
  // The reviewer's input: same exerciseId, a lower load, and a name that adds horizontal_push.
  const renamed = upd([{ op: "replace", target: { exerciseId: "Barbell_Squat" }, exercise: { ...squat, name: "Bench Press", suggestedWeight: 220 } }]);
  const trim = modify("Barbell_Squat", { suggestedWeight: 220 });
  for (const mode of MODES) {
    const r = run({ mode, snapshot: day(squat), args: renamed, hold: shoulders });
    assert.equal(r.decision, "deny", `${mode}: ${r.reasons.join("; ")}`);
    has(r.reasons, /Bench Press \(2026-10-15\) loads a held region \((left|right)-shoulder\)/);
    // Under a systemic hold the renamed day is no trim either.
    const s = run({ mode, snapshot: day(squat), args: renamed, hold: systemic });
    assert.equal(s.decision, "deny", `${mode} systemic: ${s.reasons.join("; ")}`);
    has(s.reasons, /must be a recovery or rest day/);
    // A real squat trim keeps its classification: allowed under the shoulder and the systemic hold.
    for (const hold of [shoulders, systemic]) {
      const t = run({ mode, snapshot: day(squat), args: trim, hold });
      assert.equal(t.decision, "allow", `${mode} trim: ${t.reasons.join("; ")}`);
      assert.deepEqual(t.kinds, ["trim_session"]);
    }
  }
  // An exercise that keeps its classification stays a trim next to the renamed one: only the
  // renamed exercise is checked.
  const ohp = { exerciseId: "Overhead_Press", name: "Overhead Press", suggestedSets: 3, suggestedReps: 8, suggestedWeight: 95 };
  const both = upd([
    { op: "modify", target: { exerciseId: "Overhead_Press" }, fields: { suggestedSets: 2 } },
    { op: "replace", target: { exerciseId: "Barbell_Squat" }, exercise: { ...squat, name: "Bench Press", suggestedWeight: 220 } },
  ]);
  const r = run({ snapshot: day(squat, ohp), args: both, hold: shoulders });
  assert.equal(r.decision, "deny", r.reasons.join("; "));
  has(r.reasons, /Bench Press \(2026-10-15\) loads a held region/);
  assert.ok(r.reasons.every((x) => !/Overhead Press/.test(x)), r.reasons.join("; "));
  // The overhead press trim alone still passes under the shoulder hold.
  const alone = run({ snapshot: day(squat, ohp), args: modify("Overhead_Press", { suggestedSets: 2 }), hold: shoulders });
  assert.equal(alone.decision, "allow", alone.reasons.join("; "));
});

test("P3 fix 2: under a knee hold, the bike in 'Bike and Bench Press' needs the recovery test; a plain zone 2 bike still passes", () => {
  for (const mode of MODES) {
    // The reviewer's load step, and a longer ride.
    for (const fields of [{ suggestedWeight: 140 }, { suggestedDuration: 60 }]) {
      const r = run({ mode, snapshot: day(bikeBench), args: modify("bike_bench", fields), hold: knee });
      assert.equal(r.decision, "deny", `${mode} ${JSON.stringify(fields)}: ${r.reasons.join("; ")}`);
      has(r.reasons, /Bike and Bench Press \(2026-10-15\) loads no named region in zone2_cardio, so under a regional hold it must be a recovery exercise that adds no work/);
    }
    // A plain zone 2 bike added to a pressing day: recovery work, the same verdict as with no hold.
    const add = upd([{ op: "add", exercise: z2 }]);
    assert.deepEqual(run({ mode, snapshot: day(bench), args: add, hold: knee }), run({ mode, snapshot: day(bench), args: add }));
  }
});

test("P3 fix 2: one keyword that gives zone 2 and a loaded pattern follows the normal rules ('Easy Run' under a shoulder hold)", () => {
  const longer = modify("easy_run", { suggestedDuration: 2400 });
  for (const mode of MODES) {
    const r = run({ mode, snapshot: day(easyRun), args: longer, hold: shoulders });
    assert.deepEqual(r, run({ mode, snapshot: day(easyRun), args: longer }), `${mode}: ${r.reasons.join("; ")}`);
    assert.ok(r.reasons.every((x) => !/training hold/.test(x)), r.reasons.join("; "));
    // Under a knee hold, running loads the held knee.
    const k = run({ mode, snapshot: day(easyRun), args: longer, hold: knee });
    assert.equal(k.decision, "deny", k.reasons.join("; "));
    has(k.reasons, /Easy Run \(2026-10-15\) loads a held region \(left-knee\)/);
  }
});

test("P3: a ruck loads the knee and the shoulder (carry plus loaded_walk): it denies under both holds", () => {
  const longer = modify("ruck", { suggestedDuration: 2400 });
  for (const mode of MODES) {
    const k = run({ mode, snapshot: day(ruck), args: longer, hold: knee });
    assert.equal(k.decision, "deny", `${mode} knee: ${k.reasons.join("; ")}`);
    has(k.reasons, /Ruck \(2026-10-15\) loads a held region \(left-knee\)/);
    const s = run({ mode, snapshot: day(ruck), args: longer, hold: shoulders });
    assert.equal(s.decision, "deny", `${mode} shoulder: ${s.reasons.join("; ")}`);
    has(s.reasons, /Ruck \(2026-10-15\) loads a held region \((left|right)-shoulder\)/);
  }
});
