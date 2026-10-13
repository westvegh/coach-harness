// The week file (contracts §22.6a): {week: {week_start, kind, load_factor, days}}, as
// `block draft --out` writes it. One shape for every command: loads --fill, limits check,
// volume, plans write and tally-days.
//
// loads --fill: each exercise occurrence (by day and position) gets the base suggestion from the
// history, then the week's load_factor once, with block draft's rounding (the plate step, at
// least one step). Hard sets only; warm-ups and exercises with no suggestion keep their weight.
//
// tally-days: one plan_workout_day input per date, converted with entryToTallyExercise.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { convertWeight } from "../adapters/loggers/tally/day.ts";
import { exerciseClusterNote, stripClusterNotes, type ClusterEntry } from "./clusters.ts";
import { isCalendarDate } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { PLATE_STEP, suggestLoads, type SessionHistory } from "./loads.ts";
import { planToTallyDay, type TallyDayWrite } from "./tally-shape.ts";
import type { DayPlan, ExerciseEntry, Rules, Taxonomy, Units } from "./types.ts";
import { isPlainObject } from "./yaml-file.ts";

export type WeekFile = { week: { week_start?: string; kind?: string; load_factor?: number; days: DayPlan[]; [k: string]: unknown }; [k: string]: unknown };

/** Reads a week file. {days} alone is accepted too (load_factor 1). */
export function readWeekFile(path: string): WeekFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CoachError("INPUT_ERROR", `cannot read ${path}: ${(e as Error).message}`);
  }
  // {days} alone is a week too; its other top-level keys (clusters, 0.2.4) stay.
  if (isPlainObject(raw) && !isPlainObject(raw.week) && Array.isArray(raw.days)) {
    const { days, ...rest } = raw;
    raw = { ...rest, week: { days } };
  }
  if (!isPlainObject(raw) || !isPlainObject(raw.week) || !Array.isArray(raw.week.days)) {
    throw new CoachError("INPUT_ERROR", `${path} must be a week file {week: {week_start, kind, load_factor, days}} (block draft --out writes one per week)`);
  }
  raw.week.days.forEach((d: unknown, i: number) => {
    if (!isPlainObject(d) || !isCalendarDate(d.date) || !Array.isArray(d.exercises)) throw new CoachError("INPUT_ERROR", `${path}: days[${i}] needs a date (YYYY-MM-DD) and exercises`);
    d.exercises.forEach((e: unknown, j: number) => {
      if (!isPlainObject(e) || typeof e.name !== "string" || !Array.isArray(e.sets)) throw new CoachError("INPUT_ERROR", `${path}: days[${i}].exercises[${j}] needs a name and sets (the engine's day shape)`);
    });
  });
  const lf = raw.week.load_factor;
  if (lf !== undefined && !(typeof lf === "number" && lf > 0 && lf <= 1)) throw new CoachError("INPUT_ERROR", `${path}: load_factor must be a number above 0 and at most 1`);
  return raw as WeekFile;
}

/** Writes the week file in place (a temporary file, then a rename). */
export function saveWeekFile(path: string, wf: WeekFile): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(wf, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * A normalized history file, {units, sessions: [{date, exercises: [{name, sets: [{weight, reps}]}]}]},
 * which the coach writes from a training export (setup), as the snapshot's history. A set's
 * `warmup: true` (an export's warm-up marker: Strong "Set Order" W, Hevy set_type warmup) is kept.
 */
export function parseHistoryFile(raw: unknown, where = "--history"): SessionHistory {
  if (!isPlainObject(raw)) throw new CoachError("INPUT_ERROR", `${where} must be {units, sessions: [{date, exercises: [{name, sets: [{weight, reps}]}]}]}`);
  const units = raw.units;
  if (units !== "lbs" && units !== "kg") throw new CoachError("INPUT_ERROR", `${where}: units must be lbs or kg`);
  if (!Array.isArray(raw.sessions)) throw new CoachError("INPUT_ERROR", `${where}: sessions must be a list`);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return raw.sessions.map((s: unknown, i: number) => {
    if (!isPlainObject(s) || !isCalendarDate(s.date) || !Array.isArray(s.exercises)) throw new CoachError("INPUT_ERROR", `${where}: sessions[${i}] needs a date (YYYY-MM-DD) and exercises`);
    return {
      date: s.date,
      weightUnit: units,
      exercises: s.exercises.map((e: unknown, j: number) => {
        if (!isPlainObject(e) || typeof e.name !== "string" || e.name === "" || !Array.isArray(e.sets)) throw new CoachError("INPUT_ERROR", `${where}: sessions[${i}].exercises[${j}] needs a name and sets`);
        return {
          exerciseId: typeof e.exerciseId === "string" ? e.exerciseId : "",
          name: e.name,
          muscle: "",
          sets: e.sets.filter(isPlainObject).map((x) => ({ weight: num(x.weight), reps: num(x.reps), rpe: num(x.rpe), ...(x.warmup === true ? { warmup: true } : {}) })),
        };
      }),
    };
  });
}

const roundTo = (x: number, step: number) => Math.round(x / step) * step;

/** block draft's rule for a lighter week: × factor, rounded to the plate step, at least one step. */
export function applyLoadFactor(weight: number, factor: number, units: Units): number {
  if (factor === 1) return weight;
  const plate = PLATE_STEP[units];
  return Math.max(plate, roundTo(weight * factor, plate));
}

export type FillResult = {
  units: Units;
  load_factor: number;
  history: "file" | "logged weeks" | "none";
  filled: number;
  suggestions: { date: string; index: number; exercise: string; weight: number | null; reason: string }[];
};

/**
 * An exercise in `units` (V4b): every weight, warm-ups included, converted from the exercise's own
 * unit with Tally's rule. An exercise with no unit is taken as already in `units`. Changes `ex`.
 */
export function exerciseToUnits(ex: ExerciseEntry, units: Units): ExerciseEntry {
  const from = ex.unit === "lbs" || ex.unit === "kg" ? ex.unit : units;
  if (from !== units) for (const set of ex.sets) if (typeof set.weight === "number") set.weight = convertWeight(set.weight, from, units);
  ex.unit = units;
  return ex;
}

/**
 * The exercise as the suggestion sees it (V4b): its prescription only, no weights. A previous fill
 * wrote weights, and suggestLoads picks its rep target from the heaviest planned set, so a second
 * fill would otherwise read its own output and change the result.
 */
function prescription(ex: ExerciseEntry): ExerciseEntry {
  return { ...ex, sets: ex.sets.map((set) => ({ ...set, weight: null })) };
}

/** Fills the week's loads in place (the object is changed) and returns what it did. */
export function fillWeekLoads(wf: WeekFile, history: SessionHistory, rules: Rules, units: Units, opts: { tax?: Taxonomy; source: FillResult["history"]; clusters?: readonly ClusterEntry[] }): FillResult {
  const factor = typeof wf.week.load_factor === "number" ? wf.week.load_factor : 1;
  const out: FillResult = { units, load_factor: factor, history: opts.source, filled: 0, suggestions: [] };
  for (const day of wf.week.days) {
    day.exercises.forEach((ex: ExerciseEntry, i) => {
      const [s] = suggestLoads([prescription(ex)], history, rules, units, { tax: opts.tax, strictUnits: true, clusters: opts.clusters, date: day.date });
      if (s?.suggestedWeight === undefined) {
        out.suggestions.push({ date: day.date, index: i, exercise: ex.name, weight: null, reason: s?.reason ?? "no suggestion" });
        return;
      }
      const w = applyLoadFactor(s.suggestedWeight, factor, units);
      // A unit change converts every weight first, so a warm-up keeps its real load.
      exerciseToUnits(ex, units);
      for (const set of ex.sets) if (set.warmup !== true) set.weight = w;
      out.filled++;
      out.suggestions.push({ date: day.date, index: i, exercise: ex.name, weight: w, reason: factor === 1 ? s.reason : `${s.reason}; × ${factor} for the lighter week` });
    });
  }
  return out;
}

/** Tally day notes are at most 1,000 characters (workout-api `notes: z.string().max(1000)`, JavaScript length). */
export const TALLY_NOTES_MAX = 1000;

/**
 * The day notes with one line per cluster exercise (B.7): "Cluster: <name>: 6 × 6 at 12RM, 10 s
 * between mini-sets". Old "Cluster:" lines go first, so a repeat conversion has no duplicate or
 * stale line. A line that does not fit in TALLY_NOTES_MAX is left out with a warning; the coach's
 * own notes are never cut.
 */
export function tallyNotes(d: DayPlan, clusters: readonly ClusterEntry[], warnings: string[]): string | undefined {
  const own = stripClusterNotes(d.notes);
  let notes = own;
  for (const ex of d.exercises) {
    const note = exerciseClusterNote(ex, d.date, clusters);
    if (!note) continue;
    const line = `Cluster: ${ex.name}: ${note.replace(/^Cluster: /, "")}`;
    const next = notes === "" ? line : `${notes}\n${line}`;
    if (next.length > TALLY_NOTES_MAX) {
      warnings.push(`${d.date} ${ex.name}: the cluster line does not fit in Tally's ${TALLY_NOTES_MAX}-character day notes; it was left out`);
      continue;
    }
    notes = next;
  }
  return notes === "" && d.notes === undefined ? undefined : notes;
}

/**
 * One plan_workout_day input per date (date, dayType, dayName, notes, exercises, weightUnit,
 * and timezone when known). The coach adds only the read-dependent fields: ifAbsent,
 * expectedVersion, replace and opId. A cluster exercise (coach.yaml `clusters`) adds its line to
 * the day notes: Tally has no per-exercise notes.
 */
export function tallyDays(wf: WeekFile, units: Units, timezone?: string, clusters: readonly ClusterEntry[] = []): { days: (TallyDayWrite & { timezone?: string })[]; warnings: string[] } {
  const warnings: string[] = [];
  const days = wf.week.days.map((d) => {
    // V4b: one unit per day: every exercise converted to the athlete's units before the day is printed.
    const notes = tallyNotes(d, clusters, warnings);
    const plan = { ...d, ...(notes !== undefined ? { notes } : {}), dayType: d.dayType ?? "training", exercises: d.exercises.map((e) => exerciseToUnits(structuredClone(e), units)) };
    const { day, warnings: w } = planToTallyDay(plan);
    // An exercise with an exerciseId (from search_exercises) is not a guess: keep only the real warnings.
    warnings.push(...w.filter((x) => !d.exercises.some((e) => e.exerciseId && x.startsWith(`${e.name}: no Tally record`))));
    day.exercises = day.exercises.map((e, i) => {
      const src = d.exercises[i];
      const hard = src.sets.filter((s) => s.warmup !== true);
      // A custom timed exercise (no reps) is logged by duration.
      if (!src.exerciseId && hard.length > 0 && hard.every((s) => s.reps == null && typeof s.duration_s === "number")) return { ...e, trackingType: "duration" };
      return e;
    });
    return { ...day, weightUnit: day.weightUnit ?? units, ...(timezone ? { timezone } : {}) };
  });
  return { days, warnings: [...new Set(warnings)] };
}

