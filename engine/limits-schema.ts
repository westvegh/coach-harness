// Facts the coach needs without reading the engine: the limits.yaml entry shape with one
// example per rule kind, and the regions with what each pattern loads.
//
//   node engine/cli.ts limits schema
//   node engine/cli.ts limits regions
import type { Limit, Taxonomy } from "./types.ts";

/** The entry shape and one example per rule kind. Each example passes validateLimits. */
export function limitsSchema(): Record<string, unknown> {
  const examples: Limit[] = [
    { id: "L-001", region: "left-knee", rule: "ban", patterns: ["loaded_deep_knee_flexion"], exercises: [], allow: ["Box Squat"], note: "no deep knee flexion under load", source: "athlete", since: "2026-10-11" },
    { id: "L-002", region: "left-shoulder", rule: "cap", patterns: ["horizontal_push", "incline_push", "overhead_press"], exercises: [], allow: [], max_sets_per_week: 6, build_back: true, note: "pressing at most 6 hard sets a week, building back", source: "athlete", since: "2026-10-11" },
    { id: "L-003", region: "low-back", rule: "cap", patterns: ["hinge"], exercises: [], allow: [], max_load: { value: 60, unit: "kg" }, note: "hinge at most 60 kg", source: "clinician-reported", since: "2026-10-11" },
  ];
  return {
    file: "athlete/limits.yaml",
    top_level: { version: 1, pain_threshold: "0-10, default 4", limits: "a list of entries" },
    entry: {
      id: "required. L-NNN; get the next one with `node engine/cli.ts ids next --kind limit`",
      region: "required. A region id from `node engine/cli.ts limits regions` (left-knee, shoulder, low-back, …)",
      rule: "required. ban (no exercise that matches) | cap (needs max_sets_per_week, max_load, or both)",
      patterns: "patterns that load the region (from `limits regions`); patterns or exercises is required",
      exercises: "exact exercise names or exerciseIds, matched as well as the patterns",
      allow: "names or exerciseIds that the patterns would match but that stay allowed",
      max_sets_per_week: "cap only: a whole number of hard sets a week over every matching exercise",
      max_load: "cap only: { value: <positive number>, unit: lbs | kg }, checked on every set",
      build_back: "cap only, optional: true when the athlete chose 'go light and build back'. The week skill asks once a week how the region felt and raises the cap by one set or about 10% load when it felt fine",
      note: "a short constraint, not the athlete's story",
      source: "required. athlete | clinician-reported",
      since: "required. YYYY-MM-DD (today)",
    },
    examples,
  };
}

/** Region ids, and for each pattern the regions it loads (recovery patterns load none). */
export function regionsReport(tax: Taxonomy): Record<string, unknown> {
  const patterns: Record<string, { loads: string[]; recovery?: true }> = {};
  for (const [name, p] of Object.entries(tax.patterns)) patterns[name] = { loads: [...p.loads], ...(p.recovery ? { recovery: true as const } : {}) };
  return {
    regions: [...tax.regions],
    side_rule: "a side region (left-knee) also matches its parent (knee), in both directions",
    patterns,
  };
}
