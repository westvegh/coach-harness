// Limits against a planned week (contracts §2). A report, not a gate: the `audit` skill
// runs `limits check` and the coach fixes what it reports.
//
//   node engine/cli.ts limits check --input <file.json>    ({week: WeekPlan} or {days: DayPlan[]})
import { classify, normalizeName } from "./taxonomy.ts";
import { hardSets } from "./volume.ts";
import type { DayPlan, ExerciseEntry, Limit, Limits, Taxonomy, Units } from "./types.ts";

const LB_PER_KG = 2.2046226218;

function nameIs(n: string, ex: ExerciseEntry): boolean {
  const k = normalizeName(n);
  return k !== "" && (k === normalizeName(ex.name ?? "") || (!!ex.exerciseId && k === normalizeName(ex.exerciseId)));
}

function idIs(n: string, ex: ExerciseEntry): boolean {
  const k = normalizeName(n);
  return k !== "" && !!ex.exerciseId && k === normalizeName(ex.exerciseId);
}

export type LimitMatch = { matches: boolean; conflict: boolean };

/**
 * Whether a limit applies to the exercise: by name or exerciseId, or by pattern unless an
 * `allow` entry exempts it. An `allow` entry binds to the exerciseId first: when it
 * matches only the display name and the exerciseId by itself classifies to a limited
 * pattern, the exercise is an identity conflict and the limit applies.
 */
export function limitMatch(limit: Limit, ex: ExerciseEntry, tax: Taxonomy): LimitMatch {
  if (limit.exercises.some((n) => nameIs(n, ex))) return { matches: true, conflict: false };
  const pats = classify(ex, tax).patterns;
  const patternHit = pats.some((p) => limit.patterns.includes(p));
  if (limit.allow.some((n) => idIs(n, ex))) return { matches: false, conflict: false };
  if (limit.allow.some((n) => nameIs(n, ex))) {
    const byId = ex.exerciseId ? classify({ exerciseId: ex.exerciseId, name: "" }, tax).patterns : [];
    if (byId.some((p) => limit.patterns.includes(p))) return { matches: true, conflict: true };
    return { matches: false, conflict: false };
  }
  return { matches: patternHit, conflict: false };
}

function inUnit(weight: number, from: Units | undefined, to: Units): number {
  if (!from || from === to) return weight;
  return to === "lbs" ? weight * LB_PER_KG : weight / LB_PER_KG;
}

export type LimitFinding = {
  limit: string;
  region: string;
  rule: Limit["rule"];
  kind: "banned" | "over_sets" | "over_load" | "unclassified";
  date?: string;
  exercise?: string;
  detail: string;
};

/**
 * Every place a planned week breaks a limit: a banned exercise, a weekly hard-set count over
 * `max_sets_per_week` (warm-ups left out), a set over `max_load` (warm-ups included). An exercise the taxonomy cannot classify is
 * listed too: the coach decides whether it loads a limited region. Skipped days do not count.
 */
export function checkLimits(days: DayPlan[], limits: Limits, tax: Taxonomy): LimitFinding[] {
  const out: LimitFinding[] = [];
  const live = days.filter((d) => d.status !== "skipped");
  for (const l of limits.limits) {
    let sets = 0;
    for (const d of live) {
      for (const ex of d.exercises) {
        const m = limitMatch(l, ex, tax);
        if (!m.matches) continue;
        const why = m.conflict ? " (the allow entry matches the name only; the exerciseId loads a limited pattern)" : "";
        if (l.rule === "ban") {
          out.push({ limit: l.id, region: l.region, rule: l.rule, kind: "banned", date: d.date, exercise: ex.name, detail: `${ex.name} on ${d.date} matches ${l.id} (ban, ${l.region})${why}` });
          continue;
        }
        sets += hardSets(ex);
        if (l.max_load) {
          // Warm-ups do not count toward the weekly sets (hardSets), but their loads count: a
          // warm-up over the cap still loads the region past what the athlete chose.
          for (const s of ex.sets) {
            if (typeof s.weight !== "number") continue;
            const w = inUnit(s.weight, ex.unit, l.max_load.unit);
            if (w > l.max_load.value + 1e-9) {
              out.push({ limit: l.id, region: l.region, rule: l.rule, kind: "over_load", date: d.date, exercise: ex.name, detail: `${ex.name} on ${d.date}: ${s.weight} ${ex.unit ?? l.max_load.unit} is over the ${l.max_load.value} ${l.max_load.unit} cap of ${l.id}${why}` });
              break;
            }
          }
        }
      }
    }
    if (l.rule === "cap" && typeof l.max_sets_per_week === "number" && sets > l.max_sets_per_week) {
      out.push({ limit: l.id, region: l.region, rule: l.rule, kind: "over_sets", detail: `${sets} hard sets match ${l.id} this week; the cap is ${l.max_sets_per_week}` });
    }
  }
  if (limits.limits.length > 0) {
    for (const d of live) {
      for (const ex of d.exercises) {
        if (classify(ex, tax).source === "none") out.push({ limit: "-", region: "-", rule: "ban", kind: "unclassified", date: d.date, exercise: ex.name, detail: `${ex.name} on ${d.date} is not classified; check it against the limits yourself` });
      }
    }
  }
  return out;
}
