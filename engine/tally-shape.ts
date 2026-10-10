// Tally day ↔ engine DayPlan. A Tally day holds one
// prescription per exercise (suggestedSets, suggestedReps, repsMax, suggestedWeight,
// suggestedDuration, rpe, perSide, …). adjust and loads take a DayPlan with one entry per
// set. The skills never reshape data themselves: they pass a Tally day to the CLI, and
// the CLI converts it both ways here.
//
// Forward (toPlan): `suggestedSets` copies of {weight, reps, duration_s, rpe}. reps is the
// top of a rep range (repsMax, else suggestedReps), as in the guard's toDayPlan. Every
// exercise keeps its Tally fields in `tally`, so the way back loses nothing.
//
// Back (toTallyDay): an exercise whose sets still equal its forward sets comes back exactly
// as it was. Otherwise only the changed prescription fields are rewritten from the hard
// sets: suggestedSets is their count; weight, reps, duration and RPE come from the top set
// (the heaviest, the first on a tie). A changed rep target drops repsMax (one target).
// An exercise with no `tally` (a recovery exercise from adjust) gets a snake_case
// exerciseId from its name and a warning: resolve it with search_exercises first.
import { CoachError } from "./errors.ts";
import { responsePayload } from "./snapshot.ts";
import { isCalendarDate } from "./dates.ts";
import { isPlainObject } from "./yaml-file.ts";
import type { CalendarDate, DayPlan, ExerciseEntry, LoggerExercise, SetEntry, SnapshotDay, Units } from "./types.ts";

/** An engine exercise that remembers its Tally fields. */
export type TallyExerciseEntry = ExerciseEntry & { tally?: LoggerExercise };
export type TallyDayPlan = Omit<DayPlan, "exercises"> & { exercises: TallyExerciseEntry[] };

/** The day fields of a plan_workout_day call (no timezone, version or flags). */
export type TallyDayWrite = { date: CalendarDate; dayType: string; dayName: string; notes?: string; exercises: LoggerExercise[]; weightUnit?: Units };

/** Units Tally knows for the athlete (contracts §20 item 9). */
const KNOWN_UNIT_SOURCES = ["settings", "history"];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The unit a Tally day's weights are in (contracts §20 item 9):
 * - a read (it has `found`, `version` or `weightUnitSource`): Tally's known unit
 *   (weightUnitSource settings or history), else the fallback; a read's weightUnit without
 *   a known source is Tally's default, not the athlete's unit;
 * - write input (plan_workout_day arguments: none of those keys): the call's weightUnit,
 *   else the fallback.
 */
export function tallyDayUnit(day: { weightUnit?: unknown; weightUnitSource?: unknown; found?: unknown; version?: unknown }, fallback: Units): Units {
  const u = day.weightUnit === "lbs" || day.weightUnit === "kg" ? day.weightUnit : null;
  const isRead = "found" in day || "version" in day || "weightUnitSource" in day;
  if (isRead) return u && KNOWN_UNIT_SOURCES.includes(String(day.weightUnitSource ?? "")) ? u : fallback;
  return u ?? fallback;
}

/** The sets a Tally exercise prescribes. A missing or bad set count counts as 1 (fail closed, as toDayPlan). */
export function tallySets(e: LoggerExercise): SetEntry[] {
  const n = Number.isInteger(e.suggestedSets) && (e.suggestedSets as number) > 0 ? (e.suggestedSets as number) : 1;
  const set: SetEntry = { weight: num(e.suggestedWeight), reps: num(e.repsMax) ?? num(e.suggestedReps), duration_s: num(e.suggestedDuration), rpe: num(e.rpe) };
  return Array.from({ length: n }, () => ({ ...set }));
}

export function tallyExerciseToEntry(e: LoggerExercise, unit: Units): TallyExerciseEntry {
  if (!isPlainObject(e) || typeof e.name !== "string" || e.name === "") throw new CoachError("TALLY_SHAPE", "a Tally exercise needs a name");
  return {
    exerciseId: typeof e.exerciseId === "string" ? e.exerciseId : null,
    name: e.name,
    muscle: typeof e.muscle === "string" ? e.muscle : null,
    unit,
    sets: tallySets(e),
    tally: structuredClone(e),
  };
}

/**
 * A Tally day (a get_planned_workout result, a snapshot day, or a plan_workout_day input)
 * as a DayPlan. `units` is the fallback unit when Tally does not know the athlete's unit.
 */
export function tallyDayToPlan(day: Record<string, unknown>, opts: { date?: CalendarDate; units: Units }): TallyDayPlan {
  if (!isPlainObject(day) || !Array.isArray(day.exercises)) throw new CoachError("TALLY_SHAPE", "a Tally day needs an exercises list");
  if (day.found === false) throw new CoachError("TALLY_SHAPE", "the Tally day was not found (nothing is planned on that date)");
  const date = opts.date ?? day.date;
  if (!isCalendarDate(date)) throw new CoachError("TALLY_SHAPE", "the Tally day needs a date YYYY-MM-DD");
  const unit = tallyDayUnit(day, opts.units);
  const str = (k: string) => (typeof day[k] === "string" ? { [k]: day[k] as string } : {});
  return {
    date,
    ...str("dayName"),
    ...str("dayType"),
    ...str("notes"),
    ...(typeof day.skipped === "boolean" ? { status: day.skipped ? ("skipped" as const) : ("planned" as const) } : {}),
    ...str("source"),
    ...(typeof day.userModified === "boolean" ? { userModified: day.userModified } : {}),
    exercises: day.exercises.map((e, i) => {
      if (!isPlainObject(e)) throw new CoachError("TALLY_SHAPE", `exercises[${i}] must be an object`);
      return tallyExerciseToEntry(e, unit);
    }),
  };
}

/** A snapshot day as a DayPlan (it must have been found). */
export function snapshotDayToPlan(date: CalendarDate, day: SnapshotDay, units: Units): TallyDayPlan {
  if (!day.found) throw new CoachError("TALLY_SHAPE", `nothing is planned on ${date} (the snapshot read found no day)`);
  return tallyDayToPlan(day as unknown as Record<string, unknown>, { date, units });
}

const sameSets = (a: SetEntry[], b: SetEntry[]) =>
  a.length === b.length &&
  a.every((s, i) => (s.weight ?? null) === (b[i].weight ?? null) && (s.reps ?? null) === (b[i].reps ?? null) && (s.duration_s ?? null) === (b[i].duration_s ?? null) && (s.rpe ?? null) === (b[i].rpe ?? null) && (s.warmup ?? false) === (b[i].warmup ?? false));

/** The top set: the heaviest hard set, the first on a tie. */
function topSet(sets: SetEntry[]): SetEntry | null {
  const hard = sets.filter((s) => s.warmup !== true);
  if (hard.length === 0) return null;
  return hard.reduce((a, s) => ((s.weight ?? -Infinity) > (a.weight ?? -Infinity) ? s : a));
}

/** "Zone 2 Cardio" → "zone_2_cardio" (Tally's custom exercise id). */
export function snakeId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function setField(out: LoggerExercise, key: string, value: number | null): void {
  if (value === null) delete out[key];
  else out[key] = value;
}

export function entryToTallyExercise(ex: TallyExerciseEntry, warnings: string[]): LoggerExercise {
  const orig = ex.tally && isPlainObject(ex.tally) ? ex.tally : null;
  if (orig && sameSets(ex.sets, tallySets(orig))) return structuredClone(orig);
  const hard = ex.sets.filter((s) => s.warmup !== true);
  const top = topSet(ex.sets);
  const out: LoggerExercise = orig ? structuredClone(orig) : {};
  if (!orig) {
    out.exerciseId = ex.exerciseId || snakeId(ex.name);
    out.name = ex.name;
    if (ex.muscle) out.muscle = ex.muscle;
    warnings.push(`${ex.name}: no Tally record; exerciseId ${out.exerciseId} is a guess, resolve it with search_exercises first`);
  } else {
    if (ex.name && ex.name !== orig.name) out.name = ex.name;
    if (ex.exerciseId && ex.exerciseId !== orig.exerciseId) out.exerciseId = ex.exerciseId;
  }
  out.suggestedSets = Math.max(1, hard.length);
  if (hard.length === 0) warnings.push(`${ex.name}: no hard sets left; Tally keeps 1 set`);
  const was = orig ? tallySets(orig)[0] : { weight: null, reps: null, duration_s: null, rpe: null };
  const now = top ?? { weight: null, reps: null, duration_s: null, rpe: null };
  if ((now.weight ?? null) !== (was.weight ?? null)) setField(out, "suggestedWeight", now.weight ?? null);
  if ((now.reps ?? null) !== (was.reps ?? null)) {
    setField(out, "suggestedReps", now.reps ?? null);
    delete out.repsMax;
  }
  if ((now.duration_s ?? null) !== (was.duration_s ?? null)) setField(out, "suggestedDuration", now.duration_s ?? null);
  if ((now.rpe ?? null) !== (was.rpe ?? null)) setField(out, "rpe", now.rpe ?? null);
  return out;
}

/**
 * A DayPlan as plan_workout_day day fields. dayType falls back to "recovery" for a recovery
 * day (adjust drops it) and to "training" otherwise; weightUnit is the exercises' unit.
 */
export function planToTallyDay(plan: TallyDayPlan | DayPlan): { day: TallyDayWrite; warnings: string[] } {
  if (!plan || !Array.isArray(plan.exercises) || !isCalendarDate(plan.date)) throw new CoachError("TALLY_SHAPE", "planToTallyDay needs a DayPlan with a date and exercises");
  const warnings: string[] = [];
  const exercises = (plan.exercises as TallyExerciseEntry[]).map((e) => entryToTallyExercise(e, warnings));
  const units = [...new Set(plan.exercises.map((e) => e.unit).filter((u): u is Units => u === "lbs" || u === "kg"))];
  if (units.length > 1) warnings.push(`the exercises mix units (${units.join(", ")}); weightUnit is ${units[0]}`);
  const dayType = plan.dayType ?? (plan.dayName === "Recovery" || plan.dayName === "Rest" ? "recovery" : "training");
  if (plan.dayType === undefined) warnings.push(`dayType was missing; set to ${dayType}`);
  const day: TallyDayWrite = {
    date: plan.date,
    dayType,
    dayName: plan.dayName ?? dayType,
    ...(plan.notes !== undefined ? { notes: plan.notes } : {}),
    exercises,
    ...(units[0] ? { weightUnit: units[0] } : {}),
  };
  return { day, warnings };
}

/**
 * A Tally day from CLI input: a raw get_planned_workout result, a hook-style tool response
 * ([{type: "text", text}]), or {day: <Tally day>}. Null when the value is not a Tally day
 * (an engine DayPlan has `sets` on every exercise).
 */
export function asTallyDay(raw: unknown): Record<string, unknown> | null {
  let v: unknown = raw;
  if (Array.isArray(v) || (isPlainObject(v) && Array.isArray(v.content))) v = responsePayload(v);
  if (isPlainObject(v) && isPlainObject(v.day) && !Array.isArray(v.exercises)) v = v.day;
  if (!isPlainObject(v) || !Array.isArray(v.exercises)) return null;
  if (v.exercises.length > 0 && v.exercises.every((e) => isPlainObject(e) && Array.isArray(e.sets))) return null;
  return v;
}
