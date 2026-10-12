// P1 fix 1: a hold with regions is regional. It denies an exercise that loads a held region
// (the check-in pain test: classify + regionMatches) and any unclassified exercise; every
// other exercise and day follows the normal rules. A hold without regions stays global, an
// urgent hold allows no exercise, and the pending file stays global.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guard, type GuardInput } from "../../engine/validate.ts";
import type { Snapshot } from "../../engine/types.ts";
import { block, emptyDay, guardInput, limits, NOW, snapDay, snapshot, v } from "./fixtures.ts";

const D = "2026-10-15";
const V = v(`r-${D}`, "t0");

const squat = { exerciseId: "Barbell_Squat", name: "Squat", suggestedSets: 3, suggestedReps: 5, suggestedWeight: 225 };
const rdl = { exerciseId: "Romanian_Deadlift", name: "Romanian Deadlift", suggestedSets: 3, suggestedReps: 8, suggestedWeight: 185 };
const legPress = { exerciseId: "Leg_Press", name: "Leg Press", suggestedSets: 3, suggestedReps: 10, suggestedWeight: 270 };
const bench = { exerciseId: "Barbell_Bench_Press", name: "Bench Press", suggestedSets: 3, suggestedReps: 8, suggestedWeight: 135 };
const ohp = { exerciseId: "Overhead_Press", name: "Overhead Press", suggestedSets: 3, suggestedReps: 8, suggestedWeight: 95 };
const odd = { exerciseId: "qwerty_blorp", name: "Qwerty Blorp", suggestedSets: 3, suggestedReps: 8 };

// Wednesday holds a leg day; Monday and Tuesday were read and are empty.
const legDay = () => ({ "2026-10-12": emptyDay(), "2026-10-13": emptyDay(), [D]: snapDay(D, { dayType: "legs", dayName: "Legs", exercises: [squat, rdl, legPress] }) });
// Room in the block, so the volume rule does not decide these cases.
const roomy = block({ weeks: block().weeks.map((w) => ({ ...w, targets: { chest: 20, triceps: 20, shoulders: 20, quads: 20, glutes: 20, hamstrings: 20, "upper-back": 20, lats: 20 } })) });
const run = (over: Partial<GuardInput> & { snapshot?: Snapshot | null }) => guard(guardInput({ tool: "update_planned_workout", args: {}, snapshot: snapshot(legDay()), block: roomy, ...over }));
const upd = (operations: unknown[]) => ({ date: D, expectedVersion: V, operations });

// Not a trim and not a recovery day: the leg day gains one squat set (3 → 4).
const moreSquat = upd([{ op: "modify", target: { exerciseId: "Barbell_Squat" }, fields: { suggestedSets: 4 } }]);
// Add a pressing exercise to the leg day.
const add = (exercise: Record<string, unknown>) => upd([{ op: "add", exercise }]);

const shoulders = { active: true, set_at: NOW, reason: "left-shoulder right-shoulder 4/10 reported 2026-10-14", regions: ["left-shoulder", "right-shoulder"], set_by: "safety-agent" };
const systemic = { ...shoulders, reason: "dizziness reported 2026-10-14", regions: [] };
const urgent = { ...shoulders, reason: "urgent warning sign reported 2026-10-14", urgent: true };
const has = (reasons: string[], re: RegExp) => assert.ok(reasons.some((r) => re.test(r)), `no reason matches ${re}:\n${reasons.join("\n")}`);

test("P1 fix 1: under a shoulder hold, a leg day (squat, Romanian deadlift, leg press) follows the normal rules", () => {
  for (const mode of ["interactive", "unattended"] as const) {
    // Interactive: allowed (it asks for the extra set). Unattended: the same consent deny as without a hold.
    const free = run({ mode, args: moreSquat });
    if (mode === "interactive") assert.notEqual(free.decision, "deny", `${mode} without a hold: ${free.reasons.join("; ")}`);
    const held = run({ mode, args: moreSquat, hold: shoulders });
    assert.deepEqual(held, free, `${mode}: the shoulder hold changes nothing on a leg day`);
  }
});

test("P1 fix 1: under a shoulder hold, a bench press, an overhead press and an unclassified exercise deny", () => {
  for (const mode of ["interactive", "unattended"] as const) {
    for (const ex of [bench, ohp]) {
      const r = run({ mode, args: add(ex), hold: shoulders });
      assert.equal(r.decision, "deny", `${mode} ${ex.name}: ${r.reasons.join("; ")}`);
      has(r.reasons, new RegExp(`${ex.name} \\(${D}\\) loads a held region \\((left|right)-shoulder\\)`));
    }
    const u = run({ mode, args: add(odd), hold: shoulders });
    assert.equal(u.decision, "deny", `${mode} unclassified: ${u.reasons.join("; ")}`);
    has(u.reasons, /Qwerty Blorp \(2026-10-15\) is unclassified under a regional hold; classify it first/);
  }
  // A pressing day planned fresh on an empty date denies too.
  const fresh = snapshot({ ...legDay(), "2026-10-16": emptyDay() });
  const r = run({ snapshot: fresh, tool: "plan_workout_day", args: { date: "2026-10-16", dayType: "push", dayName: "Push", exercises: [bench], ifAbsent: true }, hold: shoulders });
  assert.equal(r.decision, "deny", r.reasons.join("; "));
});

test("P1 fix 1: a parent region in the hold covers both sides; a trim, a note and a skip still pass", () => {
  const parent = { ...shoulders, regions: ["shoulder"] };
  const pressDay = snapshot({ "2026-10-12": emptyDay(), "2026-10-13": emptyDay(), [D]: snapDay(D, { exercises: [bench, squat] }) });
  const more = run({ snapshot: pressDay, hold: parent, args: upd([{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 4 } }]) });
  assert.equal(more.decision, "deny", more.reasons.join("; "));
  has(more.reasons, /Bench Press \(2026-10-15\) loads a held region \(shoulder\)/);
  for (const mode of ["interactive", "unattended"] as const) {
    const trim = run({ mode, snapshot: pressDay, hold: shoulders, args: upd([{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 2 } }]) });
    assert.equal(trim.decision, "allow", `${mode} trim: ${trim.reasons.join("; ")}`);
    const skip = run({ mode, snapshot: pressDay, hold: shoulders, tool: "skip_planned_workout", args: { date: D, expectedVersion: V } });
    assert.equal(skip.decision, "allow", `${mode} skip: ${skip.reasons.join("; ")}`);
  }
});

test("P1 fix 1: limits still apply under a regional hold", () => {
  const ban = { id: "L-001", region: "knee", rule: "ban", patterns: ["squat"], exercises: [], allow: [], source: "athlete", since: "2026-10-01" };
  const r = run({ args: moreSquat, hold: shoulders, limits: limits([ban]) });
  assert.equal(r.decision, "deny", r.reasons.join("; "));
  has(r.reasons, /banned by L-001/);
});

test("P1 fix 1: a hold with no regions stays global; an urgent hold allows no exercise; the pending file stays global", () => {
  for (const mode of ["interactive", "unattended"] as const) {
    const r = run({ mode, args: moreSquat, hold: systemic });
    assert.equal(r.decision, "deny", `${mode} systemic: ${r.reasons.join("; ")}`);
    has(r.reasons, /must be a recovery or rest day/);
    const u = run({ mode, args: moreSquat, hold: urgent });
    assert.equal(u.decision, "deny", `${mode} urgent: ${u.reasons.join("; ")}`);
    has(u.reasons, /only a note, a rest day or a skip/);
    const uTrim = run({ mode, args: upd([{ op: "modify", target: { exerciseId: "Barbell_Squat" }, fields: { suggestedSets: 2 } }]), hold: urgent });
    assert.equal(uTrim.decision, "deny", `${mode} urgent trim: ${uTrim.reasons.join("; ")}`);
    // The pending file: the regions are not known yet, so it blocks the leg day too.
    const pending = { at: NOW, terms: ["pain", "region:left-shoulder"], source: "prompt" as const };
    for (const s of [{ pending }, { pending, hold: shoulders }]) {
      const p = run({ mode, args: moreSquat, ...s });
      assert.equal(p.decision, "deny", `${mode} pending: ${p.reasons.join("; ")}`);
      has(p.reasons, /a safety check is pending/);
    }
  }
});

test("P1 fix 2: once the hold is cleared, the leg day passes and the shoulder limits still deny the capped patterns", () => {
  const press = ["horizontal_push", "incline_push", "vertical_push", "overhead_press"];
  const caps = limits([
    { id: "L-001", region: "left-shoulder", rule: "cap", patterns: press, exercises: [], allow: [], max_sets_per_week: 3, note: "pressing capped", source: "athlete", since: "2026-10-14" },
    { id: "L-002", region: "right-shoulder", rule: "cap", patterns: press, exercises: [], allow: [], max_load: { value: 95, unit: "lbs" }, source: "athlete", since: "2026-10-14" },
    { id: "L-003", region: "shoulder", rule: "ban", patterns: ["overhead_press"], exercises: [], allow: [], source: "athlete", since: "2026-10-14" },
  ]);
  const cleared = { ...shoulders, active: false, cleared_at: NOW, cleared_by: "user" };
  for (const mode of ["interactive", "unattended"] as const) {
    const free = run({ mode, args: moreSquat, limits: caps });
    if (mode === "interactive") assert.notEqual(free.decision, "deny", `${mode}: ${free.reasons.join("; ")}`);
    assert.deepEqual(run({ mode, args: moreSquat, limits: caps, hold: cleared }), free);
    // The max_load cap: bench at 135 lbs is over 95.
    const heavy = run({ mode, args: add(bench), limits: caps, hold: cleared });
    assert.equal(heavy.decision, "deny");
    has(heavy.reasons, /over the L-002 cap of 95 lbs/);
    // The weekly set cap: 4 bench sets in the week is over 3.
    const many = run({ mode, args: add({ ...bench, suggestedSets: 4, suggestedWeight: 65 }), limits: caps, hold: cleared });
    assert.equal(many.decision, "deny");
    has(many.reasons, /4 sets in the week of 2026-10-12 for L-001/);
    // The ban.
    const banned = run({ mode, args: add({ ...ohp, suggestedWeight: 45 }), limits: caps, hold: cleared });
    assert.equal(banned.decision, "deny");
    has(banned.reasons, /banned by L-003/);
  }
});

test("P1 fix 1: under a regional hold, conditioning that loads no named region passes only as recovery work that adds none", () => {
  const knee = { ...shoulders, reason: "left-knee 5/10 reported 2026-10-14", regions: ["left-knee"] };
  const pressDay = snapshot({ "2026-10-12": emptyDay(), "2026-10-13": emptyDay(), [D]: snapDay(D, { exercises: [bench] }) });
  const z2 = { exerciseId: "zone2_bike", name: "Zone 2 Bike", suggestedSets: 1, suggestedDuration: 1200 };
  const intervals = { exerciseId: "assault_bike_intervals", name: "Assault Bike Intervals", suggestedSets: 6, suggestedDuration: 30 };
  // A new zone 2 bike on a pressing day: a recovery exercise, so the knee hold lets it through.
  const easy = run({ snapshot: pressDay, hold: knee, args: add(z2) });
  assert.deepEqual(easy, run({ snapshot: pressDay, args: add(z2) }));
  // Intervals load no named region, but they are not recovery work: denied.
  const hard = run({ snapshot: pressDay, hold: knee, args: add(intervals) });
  assert.equal(hard.decision, "deny", hard.reasons.join("; "));
  has(hard.reasons, /Assault Bike Intervals \(2026-10-15\) loads no named region/);
  // A longer zone 2 ride on a day that keeps the bench press adds work: denied.
  const bikeDay = snapshot({ "2026-10-12": emptyDay(), "2026-10-13": emptyDay(), [D]: snapDay(D, { exercises: [bench, z2] }) });
  const longer = run({ snapshot: bikeDay, hold: knee, args: upd([{ op: "modify", target: { exerciseId: "zone2_bike" }, fields: { suggestedDuration: 3600 } }]) });
  assert.equal(longer.decision, "deny", longer.reasons.join("; "));
  has(longer.reasons, /Zone 2 Bike \(2026-10-15\) loads no named region/);
});
