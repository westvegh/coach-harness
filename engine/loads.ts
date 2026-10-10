// Load suggestions from the last logged top set (contracts §15).
import { convertWeight } from "../adapters/loggers/tally/rebuild.ts";
import { CoachError } from "./errors.ts";
import { classify, normalizeName } from "./taxonomy.ts";
import type { CalendarDate, ExerciseEntry, HistoryExercise, Rules, Snapshot, Taxonomy, Units } from "./types.ts";

/** A planned exercise. Planned sets carry the target reps and, optionally, the target RPE. */
export type PlannedExercise = ExerciseEntry;
/** Logged sessions, as in the snapshot (contracts §9). */
export type SessionHistory = Snapshot["history"];

export type LoadSuggestion = { exerciseId: string; suggestedWeight?: number; reason: string; rule_ids: string[] };

export const PLATE_STEP: Record<Units, number> = { lbs: 5, kg: 2.5 };
export const STEP_UPPER = 0.025;
export const STEP_LOWER = 0.05;
export const MISSED_TWICE_DROP = 0.05;
/** Used when the plan gives no RPE target. */
export const DEFAULT_TARGET_RPE = 8;

/** Regions and muscles that make an exercise "lower body" for the step size. */
const LOWER_REGIONS = new Set(["knee", "left-knee", "right-knee", "hip", "ankle", "foot", "low-back"]);
const LOWER_MUSCLES = new Set(["quads", "glutes", "hamstrings", "calves", "adductors"]);

type Session = { date: CalendarDate; ex: HistoryExercise };
type Outcome = { weight: number; hit: boolean; reps: number; rpe: number | null };

function sameExercise(planned: PlannedExercise, logged: HistoryExercise): boolean {
  if (planned.exerciseId && logged.exerciseId) return planned.exerciseId === logged.exerciseId;
  return normalizeName(planned.name) === normalizeName(logged.name ?? "");
}

function isLower(ex: PlannedExercise, tax?: Taxonomy): boolean {
  if (tax) {
    const c = classify(ex, tax);
    if (c.source !== "none") return c.regions.some((r) => LOWER_REGIONS.has(r));
  }
  return typeof ex.muscle === "string" && LOWER_MUSCLES.has(normalizeName(ex.muscle).replace(/ /g, "-"));
}

/** The planned target for the top set: the heaviest planned set's reps, else the most reps planned. */
function targets(ex: PlannedExercise): { reps: number | null; rpe: number } {
  const hard = ex.sets.filter((s) => s.warmup !== true);
  const withReps = hard.filter((s) => typeof s.reps === "number" && s.reps > 0);
  let reps: number | null = null;
  if (withReps.length > 0) {
    const top = withReps.reduce((a, s) => ((s.weight ?? 0) > (a.weight ?? 0) ? s : a));
    reps = top.weight ? (top.reps as number) : Math.max(...withReps.map((s) => s.reps as number));
  }
  const rpes = hard.map((s) => s.rpe).filter((r): r is number => typeof r === "number");
  return { reps, rpe: rpes.length > 0 ? Math.min(...rpes) : DEFAULT_TARGET_RPE };
}

/**
 * The top set of a session is its heaviest weight. Hit means every set at that weight
 * reached the target reps at an RPE at or under the target (a set with no RPE logged
 * counts on reps alone).
 */
function outcome(s: Session, target: { reps: number; rpe: number }): Outcome | null {
  const sets = s.ex.sets.filter((x) => typeof x.weight === "number" && x.weight > 0 && typeof x.reps === "number");
  if (sets.length === 0) return null;
  const weight = Math.max(...sets.map((x) => x.weight as number));
  const top = sets.filter((x) => x.weight === weight);
  const hit = top.every((x) => (x.reps as number) >= target.reps && (x.rpe == null || x.rpe <= target.rpe));
  const best = top.reduce((a, x) => ((x.reps as number) > (a.reps as number) ? x : a));
  return { weight, hit, reps: best.reps as number, rpe: best.rpe };
}

const roundTo = (x: number, step: number) => Math.round(x / step) * step;
const floorTo = (x: number, step: number) => Math.floor(x / step + 1e-9) * step;
const fmt = (n: number) => Number(n.toFixed(2));

/**
 * From the last logged top set: hit all reps at RPE ≤ target → one step up (2.5% upper body,
 * 5% lower body, rounded to the plate step: 5 lbs or 2.5 kg, and at least one plate step);
 * missed reps → repeat; missed in the last 2 sessions → −5%, rounded down (a repeat when no
 * lighter plate weight exists). No suggestion is ever above the last top set ×
 * (1 + top_set_jump_max); when the cap leaves no plate step, the weight repeats. No history
 * means no suggestion. Logged weights are in `units`.
 */
/**
 * A session's weights in `units`. A session that names its unit is converted
 * with Tally's rule (convertWeight); a session without a unit is returned as null.
 */
export function sessionInUnits(s: SessionHistory[number], units: Units): SessionHistory[number] | null {
  if (s.weightUnit !== "lbs" && s.weightUnit !== "kg") return null;
  if (s.weightUnit === units) return s;
  const from = s.weightUnit;
  return {
    ...s,
    weightUnit: units,
    exercises: s.exercises.map((e) => ({ ...e, sets: e.sets.map((x) => ({ ...x, weight: typeof x.weight === "number" ? convertWeight(x.weight, from, units) : x.weight })) })),
  };
}

export function suggestLoads(
  exercises: PlannedExercise[],
  history: SessionHistory,
  rules: Rules,
  units: Units,
  /**
   * strictUnits: every session's weights are converted to `units`, and an
   * exercise logged in a session without a unit gets no suggestion (unknown, never a guess).
   * Without it, a session with a unit is still converted; one without is taken as `units`.
   */
  opts: { tax?: Taxonomy; strictUnits?: boolean } = {},
): LoadSuggestion[] {
  if (units !== "lbs" && units !== "kg") throw new CoachError("BAD_INPUT", `units must be lbs or kg, got ${JSON.stringify(units)}`);
  const unknownUnit: SessionHistory = [];
  history = history.flatMap((s) => {
    const c = sessionInUnits(s, units);
    if (c) return [c];
    if (opts.strictUnits) {
      unknownUnit.push(s);
      return [];
    }
    return [s];
  });
  const plate = PLATE_STEP[units];
  const jumpRules = rules.rules.filter((r) => r.check?.type === "top_set_jump_max");
  const jumpMax = jumpRules.length > 0 ? Math.min(...jumpRules.map((r) => Number(r.check!.value))) : null;
  const jumpIds = jumpRules.map((r) => r.id);
  const sessionsDesc = [...history].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  /**
   * The last line of defence: no suggestion is above the last top set ×
   * (1 + top_set_jump_max), or above the last top set when the pack has no cap and the
   * branch is not an increase. A suggestion that breaks it becomes a repeat.
   */
  const capped = (s: LoadSuggestion, lastWeight: number): LoadSuggestion => {
    if (s.suggestedWeight === undefined) return s;
    const limit = jumpMax !== null ? lastWeight * (1 + jumpMax) : Infinity;
    if (s.suggestedWeight <= limit + 1e-9) return s;
    return { ...s, suggestedWeight: fmt(lastWeight), reason: `${s.reason}; above top_set_jump_max, so repeat`, rule_ids: jumpIds };
  };

  return exercises.map((ex): LoadSuggestion => {
    const id = ex.exerciseId || ex.name;
    const noUnit = unknownUnit.filter((d) => d.exercises.some((h) => sameExercise(ex, h))).map((d) => d.date);
    if (noUnit.length > 0) {
      return { exerciseId: id, reason: `the weight unit of the session on ${noUnit.sort().join(", ")} is unknown: no suggestion`, rule_ids: [] };
    }
    const sessions: Session[] = [];
    for (const day of sessionsDesc) for (const h of day.exercises) if (sameExercise(ex, h)) sessions.push({ date: day.date, ex: h });
    const target = targets(ex);
    const outcomes = target.reps === null ? [] : sessions.map((s) => outcome(s, { reps: target.reps!, rpe: target.rpe })).filter((o): o is Outcome => o !== null);
    if (sessions.length === 0 || outcomes.length === 0) {
      return { exerciseId: id, reason: sessions.length === 0 ? "no logged history: no suggestion" : target.reps === null ? "no rep target in the plan: no suggestion" : "no logged weighted set: no suggestion", rule_ids: [] };
    }
    const last = outcomes[0];
    const at = `${fmt(last.weight)} ${units} × ${last.reps}${last.rpe == null ? "" : ` @ RPE ${last.rpe}`}`;
    if (!last.hit) {
      const prev = outcomes[1];
      if (prev && !prev.hit) {
        const w = floorTo(last.weight * (1 - MISSED_TWICE_DROP), plate);
        if (!(w > 0)) {
          return capped({ exerciseId: id, suggestedWeight: fmt(last.weight), reason: `missed the target (${target.reps} reps) twice in a row, but there is no lighter plate weight than ${at.split(" ×")[0]} (step ${plate} ${units}) → repeat`, rule_ids: [] }, last.weight);
        }
        return capped({ exerciseId: id, suggestedWeight: fmt(w), reason: `missed the target (${target.reps} reps) twice in a row; last ${at} → −5%, rounded down to ${plate} ${units}`, rule_ids: [] }, last.weight);
      }
      return capped({ exerciseId: id, suggestedWeight: fmt(last.weight), reason: `missed the target (${target.reps} reps at RPE ≤ ${target.rpe}); last ${at} → repeat`, rule_ids: [] }, last.weight);
    }
    const step = isLower(ex, opts.tax) ? STEP_LOWER : STEP_UPPER;
    let next = roundTo(last.weight * (1 + step), plate);
    if (next <= last.weight) next = last.weight + plate;
    let reason = `hit ${target.reps} reps at RPE ≤ ${target.rpe}; last ${at} → +${step * 100}% rounded to ${plate} ${units}`;
    if (jumpMax !== null) {
      const cap = last.weight * (1 + jumpMax);
      if (next > cap + 1e-9) {
        next = floorTo(cap, plate);
        if (next <= last.weight) {
          return capped({ exerciseId: id, suggestedWeight: fmt(last.weight), reason: `hit the target, but one ${plate} ${units} step is above top_set_jump_max (${jumpMax * 100}%); last ${at} → repeat`, rule_ids: jumpIds }, last.weight);
        }
        reason += `, capped by top_set_jump_max (${jumpMax * 100}%)`;
      }
    }
    return capped({ exerciseId: id, suggestedWeight: fmt(next), reason, rule_ids: jumpIds }, last.weight);
  });
}
