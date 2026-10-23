// The engine's input checks (W1, 0.2.8; contracts §13a): no command reports a result from input it
// could not read. One module, one mode per kind of input:
//
// - plan days (volume, loads, adjust, classify): the engine's shape (every exercise
//   has a `sets` list) or Tally's shape (no exercise has `sets`; converted by engine/tally-shape.ts),
//   decided per day. A day that mixes them is refused. `sets: []` and `exercises: []` are valid.
// - history (loads --history, volume and targets `logs`): logged sets only. A Tally prescription is
//   never read as a logged set: that would invent completed work.
// - notes (safety scan-notes, the scan in today-brief --stage post): never refused. Every readable
//   note is kept (a string, or each string of a list); each problem is a coverage reason.
// - write inputs (today-write-prep, plans write, tally-days): each keeps its own contract; only
//   the value checks below run where a value is read.
//
// Values: a present value of the wrong type or range is refused; a missing optional value keeps its
// default. A refusal is INPUT_ERROR: "<file>: <path> <what is wrong>; see node engine/cli.ts help <command>".
// Unknown exercise names are not refused: they stay the `unclassified` finding.
import { isCalendarDate } from "./dates.ts";
import { tallyDayToPlan, tallyExerciseToEntry } from "./tally-shape.ts";
import type { DayPlan, ExerciseEntry, SnapshotSession, Units, WeekLog } from "./types.ts";
import { checkEngineExercise, checkName, checkObject, checkSet, checkUnit, describe, inputError, isObj, joinPath as join, sessionExerciseName, TALLY_PRESCRIPTION, type Where } from "./input-values.ts";

// The value and exercise checks, and the logged-value checks of a snapshot history, live in
// engine/input-values.ts; they are part of this module's API.
export * from "./input-values.ts";


// ---------- plan days ----------

/**
 * The exercises of one plan day as engine exercises: the engine's shape as given (checked), or
 * Tally's shape converted (a Tally exercise with a name and no prescription is one set, as
 * `tallySets` does). Mixed is refused. `empty` is the shape of an empty list.
 */
function shapeOf(list: unknown[], w: Where, path: string): "engine" | "tally" | "empty" {
  list.forEach((e, j) => checkObject(e, w, join(join(path, "exercises"), j), "an exercise"));
  const withSets = list.filter((e) => "sets" in (e as Record<string, unknown>)).length;
  if (list.length === 0) return "empty";
  if (withSets === list.length) return "engine";
  if (withSets === 0) return "tally";
  throw inputError(w, path || "the input", "mixes the engine's sets with Tally's suggestedSets; use one shape per day");
}

/**
 * A plan day (the engine's DayPlan or a Tally day) as a DayPlan, checked. `units` is the fallback
 * unit of a Tally day. `empty: "tally"` converts a day with no exercises as a Tally day (a raw
 * get_planned_workout result keeps Tally's checks, such as `found: false`).
 */
export function planDay(raw: unknown, w: Where, path: string, units: Units, opts: { empty?: "engine" | "tally" } = {}): { day: DayPlan; tally: boolean } {
  checkObject(raw, w, path, "a day {date, exercises}");
  if (!isCalendarDate(raw.date)) throw inputError(w, join(path, "date"), `must be a date YYYY-MM-DD, got ${describe(raw.date)}`);
  if (!Array.isArray(raw.exercises)) throw inputError(w, join(path, "exercises"), `must be a list, got ${describe(raw.exercises)}`);
  checkUnit(raw, "weightUnit", w, path);
  const shape = shapeOf(raw.exercises, w, path);
  if (shape === "engine" || (shape === "empty" && opts.empty !== "tally")) {
    raw.exercises.forEach((e, j) => checkEngineExercise(e, w, join(join(path, "exercises"), j)));
    return { day: raw as unknown as DayPlan, tally: false };
  }
  return { day: tallyDayToPlan(raw, { units, where: w, path }), tally: true };
}

/** A list of plan days, each checked and converted on its own. */
export function planDays(list: unknown, w: Where, path: string, units: Units): DayPlan[] {
  if (!Array.isArray(list)) throw inputError(w, path, `must be a list of days, got ${describe(list)}`);
  return list.map((d, i) => planDay(d, w, join(path, i), units).day);
}

/** A list of plan exercises with no day around it (loads {exercises}): one shape, checked, as engine exercises. */
export function planExercises(list: unknown, w: Where, path: string, units: Units): ExerciseEntry[] {
  if (!Array.isArray(list)) throw inputError(w, path, `must be a list of exercises, got ${describe(list)}`);
  const shape = shapeOf(list, w, "");
  return list.map((e, j) => {
    const at = join(path, j);
    if (shape === "tally") return tallyExerciseToEntry(e as Record<string, unknown>, units, { where: w, path: at });
    checkEngineExercise(e, w, at);
    return e as ExerciseEntry;
  });
}

// ---------- history ----------

/** A logged exercise: a name and logged sets. A prescription with no sets is refused. */
export function checkHistoryExercise(e: unknown, w: Where, path: string): void {
  checkObject(e, w, path, "an exercise");
  checkName(e, w, path);
  if (!Array.isArray(e.sets)) {
    const plan = TALLY_PRESCRIPTION.filter((k) => k in e);
    if (plan.length > 0) throw inputError(w, path, `is a prescription (${plan.join(", ")}), not logged sets: history takes the sets that were done`);
    throw inputError(w, join(path, "sets"), `must be a list of logged sets, got ${describe(e.sets)}`);
  }
  e.sets.forEach((s, i) => checkSet(s, w, join(join(path, "sets"), i)));
}

/** Logged sessions ({date, weightUnit?, exercises}), as loads --input `history` takes them. */
export function historySessions(list: unknown, w: Where, path: string): SnapshotSession[] {
  if (!Array.isArray(list)) throw inputError(w, path, `must be a list of logged sessions, got ${describe(list)}`);
  list.forEach((s, i) => {
    const at = join(path, i);
    checkObject(s, w, at, "a session {date, exercises}");
    if (!isCalendarDate(s.date)) throw inputError(w, join(at, "date"), `must be a date YYYY-MM-DD, got ${describe(s.date)}`);
    checkUnit(s, "weightUnit", w, at);
    if (!Array.isArray(s.exercises)) throw inputError(w, join(at, "exercises"), `must be a list, got ${describe(s.exercises)}`);
    s.exercises.forEach((e, j) => checkHistoryExercise(e, w, join(join(at, "exercises"), j)));
  });
  return list as SnapshotSession[];
}

/** Logged weeks ({week_start, days: [{date, exercises}]}), as volume and targets take `logs`. A week `weeks` marked `unknown` is refused. */
export function weekLogs(list: unknown, w: Where, path: string): WeekLog[] {
  if (!Array.isArray(list)) throw inputError(w, path, `must be a list of logged weeks, got ${describe(list)}`);
  list.forEach((wk, i) => {
    const at = join(path, i);
    checkObject(wk, w, at, "a week {week_start, days}");
    if (!isCalendarDate(wk.week_start)) throw inputError(w, join(at, "week_start"), `must be a date YYYY-MM-DD, got ${describe(wk.week_start)}`);
    // W1b: `weeks` marks a week whose logged values it could not read; no count is made from it.
    if (wk.unknown !== undefined) throw inputError(w, join(at, "unknown"), `says the week ${wk.week_start} is unknown (${String(wk.unknown)}); no count is made from it`);
    if (!Array.isArray(wk.days)) throw inputError(w, join(at, "days"), `must be a list, got ${describe(wk.days)}`);
    wk.days.forEach((d, k) => {
      const dat = join(join(at, "days"), k);
      checkObject(d, w, dat, "a day {date, exercises}");
      if (!isCalendarDate(d.date)) throw inputError(w, join(dat, "date"), `must be a date YYYY-MM-DD, got ${describe(d.date)}`);
      if (!Array.isArray(d.exercises)) throw inputError(w, join(dat, "exercises"), `must be a list, got ${describe(d.exercises)}`);
      d.exercises.forEach((e, j) => checkHistoryExercise(e, w, join(join(dat, "exercises"), j)));
    });
  });
  return list as WeekLog[];
}

// ---------- notes ----------

/** A session as the note scan reads it: the session note, and each exercise's notes as a list. */
export type NotesEntry = { date: string; notes?: string; exercises: { exerciseId: string | null; name?: string; notes: string[] }[] };

/**
 * The notes of a history list, never refused (contracts §9a): every readable note is kept, and
 * each problem (an entry with no valid date, a note that is not text, notes Tally cut) is a reason
 * that names the date. Entries dated before `since` are not read.
 */
export function readNotes(list: unknown, since?: string): { entries: NotesEntry[]; problems: string[] } {
  const entries: NotesEntry[] = [];
  const problems: string[] = [];
  if (!Array.isArray(list)) return { entries, problems: [`the history is ${describe(list)}, not a list`] };
  list.forEach((s, i) => {
    if (!isObj(s)) return problems.push(`history[${i}] is ${describe(s)}, not a session`);
    if (!isCalendarDate(s.date)) return problems.push(`history[${i}] has no valid date (${describe(s.date)})`);
    const date = s.date;
    if (since && date < since) return;
    const entry: NotesEntry = { date, exercises: [] };
    if (typeof s.notes === "string") entry.notes = s.notes;
    else if (s.notes !== undefined && s.notes !== null) problems.push(`${date}: the session note is ${describe(s.notes)}, not text`);
    if (s.exercises !== undefined && s.exercises !== null && !Array.isArray(s.exercises)) problems.push(`${date}: the exercises are ${describe(s.exercises)}, not a list`);
    (Array.isArray(s.exercises) ? s.exercises : []).forEach((e, j) => {
      if (!isObj(e)) return problems.push(`${date}: exercise ${j + 1} is ${describe(e)}, not an exercise`);
      const name = sessionExerciseName(e, j);
      const notes: string[] = [];
      if (typeof e.notes === "string") notes.push(e.notes);
      else if (Array.isArray(e.notes)) {
        e.notes.forEach((n, k) => {
          if (typeof n === "string") notes.push(n);
          else problems.push(`${date} ${name}: note ${k + 1} is ${describe(n)}, not text`);
        });
      } else if (e.notes !== undefined && e.notes !== null) problems.push(`${date} ${name}: the notes are ${describe(e.notes)}, not text`);
      if (e.notesTruncated === true) problems.push(`${date} ${name}: Tally cut this exercise's notes (more than 5, or one over 300 characters)`);
      entry.exercises.push({ exerciseId: typeof e.exerciseId === "string" ? e.exerciseId : null, ...(typeof e.name === "string" ? { name: e.name } : {}), notes });
    });
    entries.push(entry);
  });
  return { entries, problems };
}
