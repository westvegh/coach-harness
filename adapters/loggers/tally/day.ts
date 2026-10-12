// Tally day helpers (contracts §12): the tool names, Tally's weight conversion and a
// snapshot day as an engine DayPlan. Exercises stay in Tally's shape (suggestedSets,
// suggestedWeight, …) in the snapshot; toDayPlan converts a day to the engine's DayPlan.
import type { CalendarDate, DayPlan, ExerciseEntry, LoggerExercise, SetEntry, SnapshotDay, Units } from "../../../engine/types.ts";

export const MUTATIONS = [
  "plan_workout_day",
  "plan_workout_range",
  "update_planned_workout",
  "move_planned_workout",
  "skip_planned_workout",
  "delete_planned_workout",
  "update_user_profile",
  "update_training_limits",
] as const;
export type TallyMutation = (typeof MUTATIONS)[number];

export const READS = ["get_planned_workout", "get_training_context", "get_workout_history"] as const;
export type TallyRead = (typeof READS)[number];

const KG_PER_LB = 0.45359237;

export function isTallyMutation(s: string): s is TallyMutation {
  return (MUTATIONS as readonly string[]).includes(s);
}

/** Tally's conversion (weightUnit.ts): lbs→kg to the nearest 0.5 kg; kg→lbs to the nearest 1 lb. */
export function convertWeight(value: number, from: Units, to: Units): number {
  if (from === to) return value;
  if (to === "kg") return Math.round(value * KG_PER_LB * 2) / 2;
  return Math.round(value / KG_PER_LB);
}

function setsOf(e: LoggerExercise): SetEntry[] {
  // Fail closed: a stored exercise without a valid set count still counts as 1 set.
  const n = Number.isInteger(e.suggestedSets) && (e.suggestedSets as number) > 0 ? (e.suggestedSets as number) : 1;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // The top of a rep range is the heavier prescription.
  const reps = num(e.repsMax) ?? num(e.suggestedReps);
  const set: SetEntry = { weight: num(e.suggestedWeight), reps, duration_s: num(e.suggestedDuration), rpe: num(e.rpe) };
  // Distance is part of the prescription: a longer ride is more training, not a note.
  const distance = num(e.distanceMeters);
  if (distance !== null) set.distance_m = distance;
  return Array.from({ length: n }, () => ({ ...set }));
}

/**
 * A snapshot day as an engine DayPlan. Weights are in the day's unit when Tally knows
 * it, else in `fallbackUnit` (the call's unit or the athlete's unit).
 */
export function toDayPlan(date: CalendarDate, day: SnapshotDay, fallbackUnit: Units): DayPlan {
  const unit = day.weightUnit ?? fallbackUnit;
  const exercises: ExerciseEntry[] = day.exercises.map((e) => ({
    exerciseId: typeof e.exerciseId === "string" ? e.exerciseId : null,
    name: typeof e.name === "string" ? e.name : "",
    muscle: typeof e.muscle === "string" ? e.muscle : null,
    unit,
    ...(e.perSide === true ? { perSide: true } : {}),
    sets: setsOf(e),
  }));
  return {
    date,
    ...(day.dayName !== undefined ? { dayName: day.dayName } : {}),
    ...(day.dayType !== undefined ? { dayType: day.dayType } : {}),
    ...(day.notes !== undefined ? { notes: day.notes } : {}),
    status: day.skipped ? "skipped" : "planned",
    source: day.source,
    userModified: day.userModified,
    exercises,
  };
}
