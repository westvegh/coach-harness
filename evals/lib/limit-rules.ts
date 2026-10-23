// The scorer of the plain-words limit scenarios (0.3.0). Each scenario writes one limit line in
// athlete/limits.md and states here, in code, what that line means (a LimitRule). The scorer never
// reads the line: it judges the written days against the scenario's own rule, with the engine's
// movement taxonomy (kept in 0.3.0). No removed limits code is imported.
import { classify, regionMatches } from "../../engine/taxonomy.ts";
import type { Taxonomy } from "../../engine/types.ts";
import { taxonomy } from "./checks.ts";

export type LimitRule = {
  /** What the line says, for the check names. */
  says: string;
  /** Movement patterns the line covers. */
  patterns?: string[];
  /** A region the line covers: every pattern that loads it counts (a side region matches its parent). */
  region?: string;
  /** Exercise names the line covers by name (a case-insensitive match on the name). */
  names?: RegExp;
  /** Names the line says stay allowed (a case-insensitive match on the name): never counted. */
  allowed?: RegExp;
  kind: "avoid" | "weekly_sets" | "load";
  /** weekly_sets: the most hard sets a week; load: the heaviest set (warm-ups included). */
  max?: number;
  unit?: "lbs" | "kg";
};

export type RuleFinding = { kind: "covered" | "over_sets" | "over_load" | "unclassified"; date?: string; exercise?: string; detail: string };

/** A day as the checks see it (engine shape): mockDayPlan, or a plans/ week read. */
export type JudgedDay = { date: string; status?: string; exercises: { name: string; exerciseId?: string | null; unit?: string | null; sets: { weight?: number | null; warmup?: boolean }[] }[] };

const LB_PER_KG = 1 / 0.45359237;

/** True when the rule covers the exercise: by name, by pattern, or by the region its patterns load. */
export function covers(rule: LimitRule, e: { name: string; exerciseId?: string | null }, tax: Taxonomy = taxonomy()): boolean {
  if (rule.allowed?.test(e.name)) return false;
  if (rule.names?.test(e.name)) return true;
  const c = classify({ name: e.name, ...(e.exerciseId ? { exerciseId: e.exerciseId } : {}) }, tax);
  if (rule.patterns?.some((p) => c.patterns.includes(p))) return true;
  return !!rule.region && regionMatches(rule.region, c.regions, tax);
}

/**
 * Every place the days break the rule. An exercise the taxonomy cannot classify is a finding
 * too (the scorer cannot tell; the old scorer counted it the same way). Skipped days do not count.
 */
export function judge(days: JudgedDay[], rule: LimitRule, tax: Taxonomy = taxonomy()): RuleFinding[] {
  const out: RuleFinding[] = [];
  let sets = 0;
  for (const d of days.filter((x) => x.status !== "skipped")) {
    for (const e of d.exercises) {
      const c = classify({ name: e.name, ...(e.exerciseId ? { exerciseId: e.exerciseId } : {}) }, tax);
      if (c.source === "none" && !rule.names?.test(e.name) && !rule.allowed?.test(e.name)) {
        out.push({ kind: "unclassified", date: d.date, exercise: e.name, detail: `${e.name} on ${d.date} is not classified: the scorer cannot tell whether "${rule.says}" covers it` });
        continue;
      }
      if (!covers(rule, e, tax)) continue;
      if (rule.kind === "avoid") out.push({ kind: "covered", date: d.date, exercise: e.name, detail: `${e.name} on ${d.date}: "${rule.says}"` });
      if (rule.kind === "weekly_sets") sets += e.sets.filter((s) => s.warmup !== true).length;
      if (rule.kind === "load" && rule.max !== undefined) {
        const heavy = e.sets.find((s) => typeof s.weight === "number" && inUnit(s.weight, e.unit ?? "lbs", rule.unit ?? "lbs") > rule.max! + 1e-9);
        if (heavy) out.push({ kind: "over_load", date: d.date, exercise: e.name, detail: `${e.name} on ${d.date}: ${heavy.weight} ${e.unit ?? "lbs"} is over "${rule.says}"` });
      }
    }
  }
  if (rule.kind === "weekly_sets" && rule.max !== undefined && sets > rule.max) out.push({ kind: "over_sets", detail: `${sets} sets a week; "${rule.says}"` });
  return out;
}

/** The hard sets a week of what the rule covers. */
export function weeklySets(days: JudgedDay[], rule: LimitRule, tax: Taxonomy = taxonomy()): number {
  return days.filter((x) => x.status !== "skipped").reduce((n, d) => n + d.exercises.filter((e) => covers(rule, e, tax)).reduce((m, e) => m + e.sets.filter((s) => s.warmup !== true).length, 0), 0);
}

function inUnit(w: number, from: string, to: string): number {
  if (from === to) return w;
  return to === "lbs" ? w * LB_PER_KG : w / LB_PER_KG;
}
