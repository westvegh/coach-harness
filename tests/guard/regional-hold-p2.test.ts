// P2 (the P1 review): the hold scope never narrows (fix 1), region ids are validated
// (fix 2), a rename cannot hide a held region (fix 3), and each pattern is checked on its
// own (fix 6). Each case is the reviewer's input; each fails on 54525a7.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHold, setHold } from "../../engine/hold.ts";
import { guard, type GuardInput } from "../../engine/validate.ts";
import type { Hold, Snapshot } from "../../engine/types.ts";
import { block, emptyDay, guardInput, NOW, snapDay, snapshot, v } from "./fixtures.ts";

const CLI = new URL("../../engine/cli.ts", import.meta.url).pathname;
const D = "2026-10-15";
const V = v(`r-${D}`, "t0");
const MODES = ["interactive", "unattended"] as const;

const squat = { exerciseId: "Barbell_Squat", name: "Squat", suggestedSets: 3, suggestedReps: 5, suggestedWeight: 225 };
const bench = { exerciseId: "Barbell_Bench_Press", name: "Bench Press", suggestedSets: 3, suggestedReps: 8, suggestedWeight: 135 };
const incline = { exerciseId: "Incline_Bench_Press", name: "Incline Bench Press", suggestedSets: 3, suggestedReps: 8, suggestedWeight: 135 };
const bikeBench = { exerciseId: "bike_bench", name: "Assault Bike Intervals and Bench Press", suggestedSets: 3, suggestedReps: 8, suggestedWeight: 135, suggestedDuration: 30 };

const roomy = block({ weeks: block().weeks.map((w) => ({ ...w, targets: { chest: 20, triceps: 20, shoulders: 20, quads: 20, glutes: 20, hamstrings: 20, "upper-back": 20, lats: 20 } })) });
const day = (...exercises: Record<string, unknown>[]) => snapshot({ "2026-10-12": emptyDay(), "2026-10-13": emptyDay(), [D]: snapDay(D, { exercises }) });
const run = (over: Partial<GuardInput> & { snapshot: Snapshot | null }) => guard(guardInput({ tool: "update_planned_workout", args: {}, block: roomy, ...over }));
const upd = (operations: unknown[]) => ({ date: D, expectedVersion: V, operations });
const has = (reasons: string[], re: RegExp) => assert.ok(reasons.some((r) => re.test(r)), `no reason matches ${re}:\n${reasons.join("\n")}`);

const shoulders: Hold = { active: true, set_at: NOW, reason: "left-shoulder right-shoulder 4/10 reported 2026-10-14", regions: ["left-shoulder", "right-shoulder"], set_by: "safety-agent" };

function athleteRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "coach-p2-"));
  mkdirSync(join(root, "athlete"));
  return root;
}

test("P2 fix 1: a regional event never narrows a systemic hold, and a systemic event widens a regional one", () => {
  // The reviewer's order: systemic first, then a shoulder event.
  const a = athleteRoot();
  setHold(a, { reason: "dizziness reported 2026-10-14", now: NOW });
  const narrowed = setHold(a, { reason: "left-shoulder check", regions: ["left-shoulder"], now: NOW });
  assert.deepEqual(narrowed.regions, [], "the systemic hold keeps no regions");
  const heavier = upd([{ op: "modify", target: { exerciseId: "Barbell_Squat" }, fields: { suggestedWeight: 230 } }]);
  for (const mode of MODES) {
    const r = run({ mode, snapshot: day(squat), args: heavier, hold: readHold(a)! });
    assert.equal(r.decision, "deny", `${mode}: ${r.reasons.join("; ")}`);
    has(r.reasons, /must be a recovery or rest day/);
  }
  // The reverse order: a shoulder hold, then a systemic event.
  const b = athleteRoot();
  setHold(b, { reason: "left-shoulder 4/10 reported 2026-10-14", regions: ["left-shoulder"], now: NOW });
  assert.deepEqual(setHold(b, { reason: "dizziness reported 2026-10-14", now: NOW }).regions, []);
  // Two regional events still combine.
  const c = athleteRoot();
  setHold(c, { reason: "left-shoulder 4/10 reported 2026-10-14", regions: ["left-shoulder"], now: NOW });
  assert.deepEqual(setHold(c, { reason: "left-knee 5/10 reported 2026-10-14", regions: ["left-knee"], now: NOW }).regions, ["left-shoulder", "left-knee"]);
});

test("P2 fix 2: hold set refuses an unknown region id; a hold file with one blocks like a systemic hold and is reported", () => {
  const root = athleteRoot();
  assert.throws(() => setHold(root, { reason: "review fixture", regions: ["shoulders"], now: NOW }), (e: Error & { code?: string }) => e.code === "HOLD_INVALID" && /unknown region id shoulders/.test(e.message));
  assert.equal(readHold(root), null, "nothing is written");
  // Sides are region ids too.
  assert.deepEqual(setHold(root, { reason: "left-shoulder 4/10 reported 2026-10-14", regions: ["left-shoulder"], now: NOW }).regions, ["left-shoulder"]);

  const bad: Hold = { ...shoulders, reason: "review fixture", regions: ["shoulders"] };
  const heavier = upd([{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedWeight: 140 } }]);
  const legs = upd([{ op: "modify", target: { exerciseId: "Barbell_Squat" }, fields: { suggestedSets: 4 } }]);
  for (const mode of MODES) {
    const r = run({ mode, snapshot: day(bench), args: heavier, hold: bad });
    assert.equal(r.decision, "deny", `${mode}: ${r.reasons.join("; ")}`);
    has(r.reasons, /unknown region id shoulders, so it holds like a hold with no regions/);
    // Systemic: a leg day is blocked too.
    const l = run({ mode, snapshot: day(squat), args: legs, hold: bad });
    assert.equal(l.decision, "deny", `${mode} legs: ${l.reasons.join("; ")}`);
    has(l.reasons, /must be a recovery or rest day/);
  }
  // hold status reports it.
  const file = athleteRoot();
  writeFileSync(join(file, "athlete/hold.yaml"), "active: true\nset_at: '2026-10-14T07:00:00-07:00'\nreason: review fixture\nregions: [shoulders]\nset_by: safety-agent\n");
  const status = JSON.parse(spawnSync(process.execPath, [CLI, "hold", "status", "--root", file], { encoding: "utf8" }).stdout);
  assert.equal(status.scope, "systemic");
  assert.deepEqual(status.unknown_regions, ["shoulders"]);
  // A later event on that hold stays systemic.
  assert.deepEqual(setHold(file, { reason: "left-knee 5/10 reported 2026-10-14", regions: ["left-knee"], now: NOW }).regions, []);
});

test("P2 fix 3: a new name cannot hide what the exerciseId loads; an exact id still resists", () => {
  const renamed = (target: string, from: Record<string, unknown>) =>
    upd([{ op: "replace", target: { exerciseId: target }, exercise: { ...from, name: "Squat", suggestedWeight: 140 } }]);
  for (const mode of MODES) {
    const r = run({ mode, snapshot: day(incline), args: renamed("Incline_Bench_Press", incline), hold: shoulders });
    assert.equal(r.decision, "deny", `${mode} keyword id: ${r.reasons.join("; ")}`);
    has(r.reasons, /Squat \(2026-10-15\) loads a held region \((left|right)-shoulder\)/);
    const exact = run({ mode, snapshot: day(bench), args: renamed("Barbell_Bench_Press", bench), hold: shoulders });
    assert.equal(exact.decision, "deny", `${mode} exact id: ${exact.reasons.join("; ")}`);
  }
  // A recovery name on a loaded exerciseId is not a recovery exercise under a systemic hold.
  const systemic: Hold = { ...shoulders, reason: "dizziness reported 2026-10-14", regions: [] };
  const fresh = snapshot({ "2026-10-12": emptyDay(), "2026-10-13": emptyDay(), [D]: emptyDay() });
  const disguised = { exerciseId: "Incline_Bench_Press", name: "Box Breathing", suggestedSets: 3, suggestedReps: 8, suggestedWeight: 135 };
  const r = run({ snapshot: fresh, tool: "plan_workout_day", args: { date: D, dayType: "recovery", dayName: "Recovery", exercises: [disguised], ifAbsent: true }, hold: systemic });
  assert.equal(r.decision, "deny", r.reasons.join("; "));
  has(r.reasons, /must be a recovery or rest day/);
});

test("P2 fix 6: under a knee hold, the interval part of a combined exercise needs the recovery test", () => {
  const knee: Hold = { ...shoulders, reason: "left-knee 5/10 reported 2026-10-14", regions: ["left-knee"] };
  const heavier = upd([{ op: "modify", target: { exerciseId: "bike_bench" }, fields: { suggestedWeight: 140 } }]);
  for (const mode of MODES) {
    const r = run({ mode, snapshot: day(bikeBench), args: heavier, hold: knee });
    assert.equal(r.decision, "deny", `${mode}: ${r.reasons.join("; ")}`);
    has(r.reasons, /Assault Bike Intervals and Bench Press \(2026-10-15\) loads no named region in intervals/);
  }
});
