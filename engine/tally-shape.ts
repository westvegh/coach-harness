// Tally day ↔ engine DayPlan. A Tally day holds one
// prescription per exercise (suggestedSets, suggestedReps, repsMax, suggestedWeight,
// suggestedDuration, rpe, perSide, …). adjust and loads take a DayPlan with one entry per
// set. The skills never reshape data themselves: they pass a Tally day to the CLI, and
// the CLI converts it both ways here.
//
// Forward (toPlan): `suggestedSets` copies of {weight, reps, duration_s, rpe, distance_m}, and
// `perSide` on the exercise. reps is the top of a rep range (repsMax, else suggestedReps), as in
// the guard's toDayPlan. Every value is checked first (engine/input-values.ts, W1). Every
// exercise keeps its Tally fields in `tally`, so the way back loses nothing.
//
// Back (toTallyDay): an exercise whose sets still equal its forward sets comes back exactly
// as it was. Otherwise only the changed prescription fields are rewritten from the hard
// sets: suggestedSets is their count; weight, reps, duration and RPE come from the top set
// (the heaviest, the first on a tie). A changed rep target drops repsMax (one target).
// An exercise with no `tally` (a recovery exercise from adjust) gets a snake_case
// exerciseId from its name and a warning: resolve it with search_exercises first.
import { CoachError } from "./errors.ts";
import { checkTallyExercise, checkUnit, describe, inputError, MAX_SET_COUNT, type PrescriptionOptions, type Where } from "./input-values.ts";
import { responsePayload } from "./tool-response.ts";
import { isCalendarDate } from "./dates.ts";
import type { CalendarDate, DayPlan, ExerciseEntry, LoggerExercise, SetEntry, SnapshotDay, Units } from "./types.ts";

/** An engine exercise that remembers its Tally fields. */
export type TallyExerciseEntry = ExerciseEntry & { tally?: LoggerExercise };
export type TallyDayPlan = Omit<DayPlan, "exercises"> & { exercises: TallyExerciseEntry[] };

/** The day fields of a plan_workout_day call (no timezone, version or flags). */
export type TallyDayWrite = { date: CalendarDate; dayType: string; dayName: string; notes?: string; exercises: LoggerExercise[]; weightUnit?: Units };

/** Units Tally knows for the athlete (contracts §20 item 9). */
const KNOWN_UNIT_SOURCES = ["settings", "history"];

/** A plain object (the same test as yaml-file.ts, without loading yaml). */
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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

/**
 * The sets a Tally exercise prescribes: `suggestedSets` copies (missing: 1 set; a present count is
 * checked first, engine/input-values.ts), each with the distance when Tally gives one. A count of 0
 * passes the check only as the files logger's zero-work row (W1b): no sets, as `plans read` gives it.
 */
export function tallySets(e: LoggerExercise): SetEntry[] {
  if (e.suggestedSets === 0) return [];
  const n = Number.isInteger(e.suggestedSets) && (e.suggestedSets as number) > 0 ? Math.min(e.suggestedSets as number, MAX_SET_COUNT) : 1;
  const distance = num(e.distanceMeters);
  const set: SetEntry = { weight: num(e.suggestedWeight), reps: num(e.repsMax) ?? num(e.suggestedReps), duration_s: num(e.suggestedDuration), rpe: num(e.rpe), ...(distance !== null ? { distance_m: distance } : {}) };
  return Array.from({ length: n }, () => ({ ...set }));
}

/** Where a converted value came from, for the error (engine/input-values.ts), and what its prescription may hold. */
type Origin = { where?: Where; path?: string } & PrescriptionOptions;

/** A Tally exercise as an engine exercise, its values checked first; per side and distance are kept (classify reads both). */
export function tallyExerciseToEntry(e: LoggerExercise, unit: Units, o: Origin = {}): TallyExerciseEntry {
  checkTallyExercise(e, o.where ?? {}, o.path ?? "", o);
  return {
    exerciseId: typeof e.exerciseId === "string" ? e.exerciseId : null,
    name: e.name as string,
    muscle: typeof e.muscle === "string" ? e.muscle : null,
    unit,
    ...(e.perSide === true ? { perSide: true } : {}),
    sets: tallySets(e),
    tally: structuredClone(e),
  };
}

/**
 * A Tally day (a get_planned_workout result, a snapshot day, or a plan_workout_day input)
 * as a DayPlan. `units` is the fallback unit when Tally does not know the athlete's unit.
 * Each exercise's values are checked (INPUT_ERROR names `where` and the path).
 */
export function tallyDayToPlan(day: Record<string, unknown>, opts: { date?: CalendarDate; units: Units } & Origin): TallyDayPlan {
  const w = opts.where ?? {};
  const at = (k: string) => (opts.path ? `${opts.path}.${k}` : k);
  if (!isPlainObject(day) || !Array.isArray(day.exercises)) throw inputError(w, at("exercises"), "must be a list (a Tally day needs an exercises list)");
  if (day.found === false) throw new CoachError("TALLY_SHAPE", "the Tally day was not found (nothing is planned on that date)");
  const date = opts.date ?? day.date;
  if (!isCalendarDate(date)) throw inputError(w, at("date"), `must be a date YYYY-MM-DD, got ${describe(date)}`);
  checkUnit(day, "weightUnit", w, opts.path ?? "");
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
    exercises: day.exercises.map((e, i) => tallyExerciseToEntry(e as LoggerExercise, unit, { where: w, path: at(`exercises[${i}]`), zeroSets: opts.zeroSets })),
  };
}

/** The plans/ columns a files snapshot day keeps as text when the cell cannot be read (W1b). */
const FILE_CELLS: [string, string, string][] = [
  ["suggestedSets", "sets", `is not a whole number from 0 to ${MAX_SET_COUNT}`],
  ["suggestedWeight", "load", "is not a load (a number of 0 or more, or bw)"],
];

/**
 * A snapshot day as a DayPlan (it must have been found). W1b: a files logger day (`source: files`)
 * keeps a 0 in a sets cell as the zero-work row, and a cell it cannot read as its text: a check
 * that needs that value is refused with the date, the exercise and the column, never read as clean.
 */
export function snapshotDayToPlan(date: CalendarDate, day: SnapshotDay, units: Units): TallyDayPlan {
  if (!day.found) throw new CoachError("TALLY_SHAPE", `nothing is planned on ${date} (the snapshot read found no day)`);
  const where = { file: `the planned day ${date} (as read)` };
  const files = day.source === "files";
  if (files) {
    for (const e of day.exercises) {
      for (const [key, column, what] of FILE_CELLS) {
        if (typeof e[key] === "string") throw new CoachError("INPUT_ERROR", `${where.file}: ${String(e.name)}: the ${column} cell ${JSON.stringify(e[key])} ${what}; the check that needs it is unknown until the cell in plans/ is fixed`);
      }
    }
  }
  return tallyDayToPlan(day as unknown as Record<string, unknown>, { date, units, where, zeroSets: files });
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
