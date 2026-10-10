// launch review finding 3: an urgent warning sign is its own state.
// The guard denies every exercise prescription, trims and recovery workouts included; only
// notes, rest days and skips pass. An ordinary hold still allows a trim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHold, setHold } from "../../engine/hold.ts";
import { guard, urgentEvent, type GuardInput } from "../../engine/validate.ts";
import type { Snapshot } from "../../engine/types.ts";
import { emptyDay, guardInput, NOW, snapDay, snapshot, v } from "./fixtures.ts";

const D = "2026-10-15";
const V = v(`r-${D}`, "t0");
const day = (over: Record<string, unknown> = {}) => ({ "2026-10-12": emptyDay(), "2026-10-13": emptyDay(), [D]: snapDay(D, over) });
const upd = (operations: unknown[], extra: Record<string, unknown> = {}) => ({ date: D, expectedVersion: V, operations, ...extra });
const run = (over: Partial<GuardInput> & { snapshot?: Snapshot | null }) =>
  guard(guardInput({ tool: "update_planned_workout", args: upd([]), snapshot: snapshot(day()), ...over }));

const ordinary = { active: true, set_at: NOW, reason: "left knee pain 5/10 reported 2026-10-14", regions: ["left-knee"], set_by: "safety-agent" };
const urgentHold = { ...ordinary, reason: "urgent warning sign reported 2026-10-14", regions: [], urgent: true };
const chestPain = { at: NOW, terms: ["chest pain"], source: "prompt" as const };

// The reviewer's probe: keep the loaded squat with fewer sets (a trim).
const trimSquat = upd([{ op: "modify", target: { exerciseId: "Barbell_Squat" }, fields: { suggestedSets: 2 } }]);
const z2 = { exerciseId: "zone2_bike", name: "Zone 2 Bike", suggestedSets: 1, suggestedDuration: 2400 };
const mob = { exerciseId: "mobility_flow", name: "Mobility Flow", suggestedSets: 1, suggestedDuration: 600 };
const recovery = upd([
  { op: "replace", target: { exerciseId: "Barbell_Bench_Press" }, exercise: z2 },
  { op: "replace", target: { exerciseId: "Barbell_Squat" }, exercise: mob },
  { op: "remove", target: { exerciseId: "Cable_Row" } },
]);

test("launch review finding 3: the reviewer's probe (urgent hold plus pending chest pain, a trimmed loaded squat) is denied", () => {
  for (const mode of ["unattended", "interactive"] as const) {
    const r = run({ hold: urgentHold, pending: chestPain, args: trimSquat, mode });
    assert.equal(r.decision, "deny", `${mode}: ${r.reasons.join("; ")}`);
    assert.ok(r.reasons.some((x) => /urgent/.test(x) && /only a note, a rest day or a skip/.test(x)), r.reasons.join("; "));
  }
});

test("launch review finding 3: each urgent source alone denies trims and recovery workouts", () => {
  const sources: Partial<GuardInput>[] = [
    { pending: chestPain },
    { hold: urgentHold },
    { hold: { ...ordinary, reason: "urgent warning sign reported 2026-10-14", regions: [] } }, // the safety agent's reason, no flag
    { hold: { ...ordinary, reason: "pending safety check 2026-10-14: chest pain", regions: [] } }, // the unattended reason
    { hold: { ...ordinary, reason: "pending safety check 2026-10-14: fainting", regions: [] } },
  ];
  for (const s of sources) {
    for (const args of [trimSquat, recovery]) {
      const r = run({ ...s, args });
      assert.equal(r.decision, "deny", `${JSON.stringify(s)}: ${r.reasons.join("; ")}`);
    }
  }
});

test("launch review finding 3: under an urgent event, a note on an unchanged day and a skip pass", () => {
  for (const s of [{ pending: chestPain }, { hold: urgentHold }] as Partial<GuardInput>[]) {
    const note = run({ ...s, args: upd([{ op: "modify", target: { exerciseId: "Cable_Row" }, fields: { suggestedSets: 3 } }], { notes: "[coach] Rest day: see your coach repo." }) });
    assert.equal(note.decision, "allow", note.reasons.join("; "));
    const skip = run({ ...s, tool: "skip_planned_workout", args: { date: D } });
    assert.equal(skip.decision, "allow", skip.reasons.join("; "));
    const skipUnattended = run({ ...s, mode: "unattended", tool: "skip_planned_workout", args: { date: D } });
    assert.equal(skipUnattended.decision, "allow", skipUnattended.reasons.join("; "));
  }
});

test("launch review finding 3: an ordinary hold or a pain-only pending file still allows a trim and a recovery day", () => {
  for (const s of [{ hold: ordinary }, { pending: { at: NOW, terms: ["pain", "region:left-knee"], source: "prompt" as const } }] as Partial<GuardInput>[]) {
    for (const args of [trimSquat, recovery]) {
      const r = run({ ...s, args });
      assert.equal(r.decision, "allow", `${JSON.stringify(s)}: ${r.reasons.join("; ")}`);
    }
  }
  assert.equal(urgentEvent(ordinary, null), null);
  assert.equal(urgentEvent(null, null), null);
  assert.equal(urgentEvent({ ...urgentHold, active: false }, null), null, "a cleared hold is not urgent");
});

test("launch review finding 3: hold set records urgent (--urgent, the word urgent), and extending never drops it", () => {
  const root = mkdtempSync(join(tmpdir(), "coach-urgent-"));
  mkdirSync(join(root, "athlete"));
  assert.equal(setHold(root, { reason: "left knee pain 5/10", regions: ["left-knee"], now: NOW }).urgent, undefined);
  assert.equal(setHold(root, { reason: "chest symptoms", urgent: true, now: NOW }).urgent, true);
  const extended = setHold(root, { reason: "left knee pain 5/10", regions: ["left-knee"], now: NOW });
  assert.equal(extended.urgent, true, "an extension keeps the urgent state");
  assert.equal(readHold(root)?.urgent, true);
  assert.match(readFileSync(join(root, "athlete/hold.yaml"), "utf8"), /urgent: true/);
  const fresh = mkdtempSync(join(tmpdir(), "coach-urgent-"));
  mkdirSync(join(fresh, "athlete"));
  assert.equal(setHold(fresh, { reason: "urgent warning sign reported 2026-10-14", now: NOW }).urgent, true);
});

test("launch review finding 3: hold status reports the urgent state", async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "coach-urgent-"));
  mkdirSync(join(root, "athlete"));
  const status = () => JSON.parse(spawnSync(process.execPath, [new URL("../../engine/cli.ts", import.meta.url).pathname, "hold", "status", "--root", root], { encoding: "utf8" }).stdout);
  assert.equal(status().urgent, false);
  setHold(root, { reason: "left knee pain 5/10", regions: ["left-knee"], now: NOW });
  assert.equal(status().urgent, false);
  writeFileSync(join(root, "athlete/.safety-pending"), JSON.stringify(chestPain));
  assert.equal(status().urgent, true);
  assert.match(status().urgent_reason, /chest pain/);
});
