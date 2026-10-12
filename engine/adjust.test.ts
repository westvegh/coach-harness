import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { adjustDay, estimateMinutes } from "./adjust.ts";
import { CoachError } from "./errors.ts";
import { loadTemplates } from "./methods.ts";
import { classify, normalizeName, regionMatches } from "./taxonomy.ts";
import type { DayPlan, Limits, SetEntry, Taxonomy } from "./types.ts";
import { loadTaxonomy } from "./taxonomy.ts";

const tax = loadTaxonomy({ localPath: null });
const template = loadTemplates(join(import.meta.dirname, "../methods/nine-adaptations"))["4-day"];
const noLimits: Limits = { version: 1, pain_threshold: 4, limits: [] };
const sets = (n: number, extra: SetEntry = {}): SetEntry[] => Array.from({ length: n }, (_, i) => ({ weight: 100 + i, reps: 5, ...extra }));

const day: DayPlan = {
  date: "2026-10-12",
  dayName: "Lower A",
  dayType: "strength",
  notes: "keep",
  source: "mcp",
  exercises: [
    { exerciseId: "back_squat", name: "Back Squat", sets: [...sets(1, { warmup: true, weight: 45 }), ...sets(5)] },
    { name: "Romanian Deadlift", sets: sets(4) },
    { name: "Box Breathing", sets: [{ duration_s: 300 }] },
    { name: "Calf Raise", sets: sets(3) },
    { name: "Leg Extension", sets: sets(2) },
    { name: "Hip Thrust", sets: sets(1) },
    { name: "Mystery Move", sets: sets(10) },
  ],
};

/** Every limit rule a day breaks: bans by pattern or name (allow beats patterns), caps by load and weekly sets. */
function limitViolations(d: DayPlan, limits: Limits, t: Taxonomy): string[] {
  const out: string[] = [];
  for (const ex of d.exercises) {
    const c = classify(ex, t);
    const n = normalizeName(ex.name);
    for (const l of limits.limits) {
      const named = l.exercises.some((e) => normalizeName(e) === n);
      const allowed = l.allow.some((a) => normalizeName(a) === n);
      const hitsPattern = c.patterns.some((p) => l.patterns.includes(p)) || regionMatches(l.region, c.regions, t);
      if (l.rule === "ban" && (named || (hitsPattern && !allowed))) out.push(`${ex.name}: ${l.id}`);
      if (l.rule === "cap" && hitsPattern) {
        if (l.max_load && ex.sets.some((s) => (s.weight ?? 0) > l.max_load!.value)) out.push(`${ex.name}: ${l.id} load`);
        if (l.max_sets_per_week !== undefined && ex.sets.length > l.max_sets_per_week) out.push(`${ex.name}: ${l.id} sets`);
      }
    }
    if (c.source === "none" && limits.limits.length > 0) out.push(`${ex.name}: unclassified`);
  }
  return out;
}

test("trim: round(sets × trim_fraction) off (0.3 here), minimum 1, warm-ups and loads kept, order kept", () => {
  const { day: out, changes } = adjustDay(day, "trim", { tax, thresholds: { trim_fraction: 0.3 }, limits: noLimits });
  assert.deepEqual(out.exercises.map((e) => e.name), day.exercises.map((e) => e.name));
  const hard = (i: number) => out.exercises[i].sets.filter((s) => !s.warmup).length;
  assert.equal(hard(0), 3); // 5 - round(1.5) = 3
  assert.equal(out.exercises[0].sets[0].warmup, true);
  assert.deepEqual(out.exercises[0].sets.slice(1).map((s) => s.weight), [100, 101, 102]); // the last sets go
  assert.equal(hard(1), 3); // 4 - round(1.2)
  assert.equal(hard(3), 2); // 3 - round(0.9)
  assert.equal(hard(4), 1); // 2 - round(0.6)
  assert.equal(hard(5), 1); // minimum 1
  assert.equal(hard(6), 7); // unclassified counts as loaded: 10 - 3
  assert.deepEqual(out.exercises[2], day.exercises[2]); // recovery untouched
  assert.equal(out.notes, "keep");
  assert.equal(out.dayType, "strength");
  assert.ok(changes.includes("Back Squat: 5 → 3 sets"));
  assert.equal(changes.length, 5); // Hip Thrust stays at 1
  assert.equal(day.exercises[0].sets.length, 6, "input not mutated");
});

test("trim: the default trim is about 20% of the hard sets (NA-REC-010)", () => {
  const { day: out } = adjustDay(day, "trim", { tax, thresholds: {}, limits: noLimits });
  assert.equal(out.exercises[0].sets.filter((s) => !s.warmup).length, 4); // 5 - round(1.0)
  assert.equal(out.exercises[6].sets.length, 8); // 10 - 2
});

test("trim: trim_fraction comes from thresholds", () => {
  const { day: out } = adjustDay(day, "trim", { tax, thresholds: { trim_fraction: 0.5 }, limits: noLimits });
  assert.equal(out.exercises[1].sets.length, 2);
  assert.throws(() => adjustDay(day, "trim", { tax, thresholds: { trim_fraction: 1.5 }, limits: noLimits }), CoachError);
});

test("recovery: built from the template's recovery slots, duration matched", () => {
  const planned = estimateMinutes(day);
  const { day: out, changes } = adjustDay(day, "recovery", { tax, thresholds: {}, template, limits: noLimits });
  assert.deepEqual(out.exercises.map((e) => e.name), ["Zone 2 Cardio", "Mobility Flow", "Box Breathing"]);
  const seconds = out.exercises.reduce((a, e) => a + (e.sets[0].duration_s ?? 0), 0);
  assert.equal(seconds, Math.round(planned * 60));
  assert.equal(out.exercises[1].sets[0].duration_s, 600);
  assert.equal(out.exercises[2].sets[0].duration_s, 300);
  for (const e of out.exercises) {
    const c = classify(e, tax);
    assert.ok(c.patterns.length > 0 && c.patterns.every((p) => tax.patterns[p].recovery), e.name);
    assert.deepEqual(c.regions, []);
  }
  assert.equal(out.date, day.date);
  assert.equal(out.dayName, "Recovery");
  assert.equal(out.dayType, undefined);
  assert.match(changes[0], /Lower A → recovery day/);
});

test("recovery: planned_minutes overrides the estimate; 0 gives a rest day", () => {
  const mins = (d: DayPlan) => d.exercises.reduce((a, e) => a + (e.sets[0].duration_s ?? 0), 0) / 60;
  assert.equal(mins(adjustDay(day, "recovery", { tax, thresholds: {}, template, limits: noLimits, planned_minutes: 45 }).day), 45);
  assert.equal(mins(adjustDay(day, "recovery", { tax, thresholds: {}, template, limits: noLimits, planned_minutes: 300 }).day), 300);
  const rest = adjustDay(day, "recovery", { tax, thresholds: {}, limits: noLimits, planned_minutes: 0 }).day;
  assert.deepEqual(rest.exercises, []);
  assert.equal(rest.dayName, "Rest");
});

test("recovery: a limited region is never loaded; a limit-named exercise is left out", () => {
  const limits: Limits = {
    version: 1,
    pain_threshold: 4,
    limits: [
      { id: "L-001", region: "left-knee", rule: "ban", patterns: ["loaded_deep_knee_flexion"], exercises: ["Mobility Flow"], allow: [], source: "athlete", since: "2026-10-01" },
      { id: "L-002", region: "low-back", rule: "cap", patterns: ["hinge"], exercises: [], allow: [], max_sets_per_week: 6, source: "clinician-reported", since: "2026-10-01" },
      { id: "L-003", region: "shoulder", rule: "ban", patterns: ["overhead_press"], exercises: [], allow: [], source: "athlete", since: "2026-10-01" },
      { id: "L-004", region: "knee", rule: "ban", patterns: ["loaded_deep_knee_flexion"], exercises: [], allow: [], source: "athlete", since: "2026-10-01" },
    ],
  };
  const { day: out } = adjustDay(day, "recovery", { tax, thresholds: {}, template, limits });
  assert.deepEqual(out.exercises.map((e) => e.name), ["Zone 2 Cardio", "Box Breathing"]);
  assert.deepEqual(limitViolations(out, limits, tax), []);
});

test("the output passes the limit checks for an unchanged-limits case", () => {
  const limits: Limits = {
    version: 1,
    pain_threshold: 4,
    limits: [{ id: "L-001", region: "shoulder", rule: "cap", patterns: ["overhead_press"], exercises: [], allow: [], max_load: { value: 95, unit: "lbs" }, max_sets_per_week: 6, source: "athlete", since: "2026-10-01" }],
  };
  const upper: DayPlan = { date: "2026-10-13", exercises: [{ name: "Overhead Press", sets: sets(4, { weight: 85 }) }, { name: "Goblet Squat", sets: sets(3) }, { name: "Easy Walk", sets: [{ duration_s: 1200 }] }] };
  assert.deepEqual(limitViolations(upper, limits, tax), []);
  for (const decision of ["trim", "recovery"] as const) {
    const { day: out } = adjustDay(upper, decision, { tax, thresholds: {}, template, limits });
    assert.deepEqual(limitViolations(out, limits, tax), [], decision);
  }
});

test("bad decision throws", () => {
  assert.throws(() => adjustDay(day, "skip" as never, { tax, thresholds: {}, limits: noLimits }), CoachError);
});

test("recovery honours a ban by movement pattern (and its allow list)", () => {
  // Review input: a valid ban with region knee, patterns [zone2_cardio], no exercises, no allow.
  const ban: Limits = { version: 1, pain_threshold: 4, limits: [{ id: "L-001", region: "knee", rule: "ban", patterns: ["zone2_cardio"], exercises: [], allow: [], source: "athlete", since: "2026-10-01" }] };
  const { day: out } = adjustDay(day, "recovery", { tax, thresholds: {}, template, limits: ban });
  assert.ok(!out.exercises.some((e) => classify(e, tax).patterns.includes("zone2_cardio")), JSON.stringify(out.exercises.map((e) => e.name)));
  assert.deepEqual(limitViolations(out, ban, tax), []);
  const allowed: Limits = { ...ban, limits: [{ ...ban.limits[0], allow: ["Zone 2 Cardio"] }] };
  assert.ok(adjustDay(day, "recovery", { tax, thresholds: {}, template, limits: allowed }).day.exercises.some((e) => e.name === "Zone 2 Cardio"));
});

test("recovery matches the planned duration exactly (no 15/90-minute clamp)", () => {
  const secs = (d: DayPlan) => d.exercises.reduce((a, e) => a + (e.sets[0].duration_s ?? 0), 0);
  // Review inputs: a 5-minute session and a 120-minute session.
  assert.equal(secs(adjustDay(day, "recovery", { tax, thresholds: {}, template, limits: noLimits, planned_minutes: 5 }).day), 300);
  assert.equal(secs(adjustDay(day, "recovery", { tax, thresholds: {}, template, limits: noLimits, planned_minutes: 120 }).day), 7200);
  assert.equal(secs(adjustDay(day, "recovery", { tax, thresholds: {}, template, limits: noLimits, planned_minutes: 37.3 }).day), 2238);
  const est = Math.round(estimateMinutes(day) * 60);
  assert.equal(secs(adjustDay(day, "recovery", { tax, thresholds: {}, template, limits: noLimits }).day), est);
});
