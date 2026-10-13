// The per-exercise session maximum (contracts §22.6 rule 3a, 0.2.4): a pack check
// `{type: max_sets_per_exercise_session, value: n, adaptations: [...]}`. It is a drafting default
// and an audit finding, never a refusal: a week the coach or the athlete writes with more sets
// stays valid and writable. A pack without the check has no maximum.
import { clusterOf, type ClusterEntry } from "./clusters.ts";
import { classify, normalizeName } from "./taxonomy.ts";
import { hardSets } from "./volume.ts";
import type { DayPlan, ExerciseEntry, Rules, Taxonomy } from "./types.ts";

export const SESSION_MAX_CHECK = "max_sets_per_exercise_session";

export type SessionMaxCheck = { id: string; max: number; adaptations: string[] };

/** The pack's check, or null (no maximum). */
export function sessionMaxCheck(rules: Rules | null | undefined): SessionMaxCheck | null {
  const r = rules?.rules.find((x) => x.check?.type === SESSION_MAX_CHECK);
  if (!r || !Number.isInteger(r.check!.value) || (r.check!.value as number) < 1) return null;
  return { id: r.id, max: r.check!.value as number, adaptations: Array.isArray(r.check!.adaptations) ? r.check!.adaptations : [] };
}

export type SessionMaxFinding = { date: string; exercise: string; sets: number; max: number; rule_id: string; text: string };

type Drafted = ExerciseEntry & { adaptation?: string };

/**
 * Straight exercises above the maximum in one session (advisory). An exercise is limited when it
 * is not a cluster on that date and either its drafted `adaptation` is one the check lists, or it
 * has none and its classification trains a muscle (conditioning and recovery patterns train none).
 * The same exercise twice on a day counts once, with both entries' sets.
 */
export function sessionMaxFindings(days: DayPlan[], check: SessionMaxCheck, tax: Taxonomy, clusters: readonly ClusterEntry[] = []): SessionMaxFinding[] {
  const out: SessionMaxFinding[] = [];
  for (const d of days) {
    if (d.status === "skipped") continue;
    const byExercise = new Map<string, { name: string; sets: number }>();
    for (const ex of d.exercises as Drafted[]) {
      if (clusterOf(ex, d.date, clusters)) continue;
      const limited = typeof ex.adaptation === "string" ? check.adaptations.includes(ex.adaptation) : classify(ex, tax).muscles.length > 0;
      if (!limited) continue;
      const k = ex.exerciseId ? `id:${ex.exerciseId}` : `name:${normalizeName(ex.name)}`;
      const cur = byExercise.get(k) ?? { name: ex.name, sets: 0 };
      cur.sets += hardSets(ex);
      byExercise.set(k, cur);
    }
    for (const { name, sets } of byExercise.values()) {
      if (sets <= check.max) continue;
      out.push({ date: d.date, exercise: name, sets, max: check.max, rule_id: check.id, text: `${name} on ${d.date}: ${sets} sets in one session, above the drafting default of ${check.max} (advisory: the athlete may choose more)` });
    }
  }
  return out;
}
