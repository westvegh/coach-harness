// The value checks of the engine's input (W1, 0.2.8; contracts §13a), and the logged-value checks
// of a snapshot history (W1b). engine/input-shapes.ts re-exports them with the input modes. This
// module imports no other engine code, so the capture hook, readiness and weeks load only it, and
// engine/tally-shape.ts runs the same checks without an import cycle.
//
// Values: a present value of the wrong type or range is refused; a missing optional value keeps its
// default. A refusal is INPUT_ERROR: "<file>: <path> <what is wrong>; see node engine/cli.ts help <command>".
import { CoachError } from "./errors.ts";
import type { SnapshotSession } from "./types.ts";

/** Where an input came from: the command (for its help) and the file or flag. */
export type Where = { cmd?: string; file?: string };

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** "the string \"200\"", "1000000000", "a list", "nothing": the value as the error names it. */
export function describe(v: unknown): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (typeof v === "string") return `the string ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v)}`;
  if (Array.isArray(v)) return "a list";
  if (typeof v === "object") return "an object";
  return String(v);
}

export function inputError(w: Where, path: string, what: string): CoachError {
  const at = [w.file, path].filter((x) => x).join(": ");
  return new CoachError("INPUT_ERROR", `${at ? `${at} ` : ""}${what}${w.cmd ? `; see node engine/cli.ts help ${w.cmd}` : ""}`);
}

export const joinPath = (path: string, key: string | number) => (typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key);

// ---------- values ----------

/** Tally's set count: a whole number from 1 to 50 (it also bounds the sets the conversion makes). */
export const MAX_SET_COUNT = 50;
const TALLY_NUMBERS = ["suggestedReps", "repsMax", "suggestedWeight", "suggestedDuration", "distanceMeters", "rpe"] as const;
const SET_NUMBERS = ["weight", "reps", "duration_s", "distance_m", "rpe"] as const;
/** The fields of a Tally prescription: an exercise with one of these and no `sets` is a plan, not a log. */
export const TALLY_PRESCRIPTION = ["suggestedSets", ...TALLY_NUMBERS] as const;

/** A finite number of 0 or more (RPE at most 10); missing or null keeps its default. */
function checkNumber(o: Record<string, unknown>, key: string, w: Where, path: string): void {
  const v = o[key];
  if (v === undefined || v === null) return;
  const at = joinPath(path, key);
  if (typeof v !== "number" || !Number.isFinite(v)) throw inputError(w, at, `must be a number, got ${describe(v)}`);
  if (v < 0) throw inputError(w, at, `must be 0 or more, got ${v}`);
  if (key === "rpe" && v > 10) throw inputError(w, at, `must be at most 10, got ${v}`);
}

function checkCount(o: Record<string, unknown>, key: string, w: Where, path: string, min = 1): void {
  const v = o[key];
  if (v === undefined || v === null) return;
  if (!(typeof v === "number" && Number.isInteger(v) && v >= min && v <= MAX_SET_COUNT)) throw inputError(w, joinPath(path, key), `must be a whole number from ${min} to ${MAX_SET_COUNT}, got ${describe(v)}`);
}

/**
 * W1b: what a prescription may hold. `zeroSets`: the files logger's zero-work row (a 0 in a plans/
 * sets cell, which `plans read` reads as `sets: []`); a real Tally prescription keeps 1 to 50.
 */
export type PrescriptionOptions = { zeroSets?: boolean };

function checkBoolean(o: Record<string, unknown>, key: string, w: Where, path: string): void {
  const v = o[key];
  if (v !== undefined && typeof v !== "boolean") throw inputError(w, joinPath(path, key), `must be true or false, got ${describe(v)}`);
}

export function checkUnit(o: Record<string, unknown>, key: string, w: Where, path: string): void {
  const v = o[key];
  if (v !== undefined && v !== "lbs" && v !== "kg") throw inputError(w, joinPath(path, key), `must be lbs or kg, got ${describe(v)}`);
}

/** A name is a non-empty string after trimming. `exerciseName` alone is a common slip. */
export function checkName(e: Record<string, unknown>, w: Where, path: string): void {
  if (typeof e.name === "string" && e.name.trim() !== "") return;
  if (e.name === undefined && "exerciseName" in e) throw inputError(w, path, "has no name; the field is `name`");
  throw inputError(w, joinPath(path, "name"), `must be a name (text that is not empty), got ${describe(e.name)}`);
}

export function checkObject(v: unknown, w: Where, path: string, what: string): asserts v is Record<string, unknown> {
  if (!isObj(v)) throw inputError(w, path, `must be ${what}, got ${describe(v)}`);
}

/** One engine set: {weight, reps, duration_s, distance_m, rpe, warmup}. */
export function checkSet(s: unknown, w: Where, path: string): void {
  checkObject(s, w, path, "a set ({weight, reps, …})");
  for (const k of SET_NUMBERS) checkNumber(s, k, w, path);
  checkBoolean(s, "warmup", w, path);
}

/** An exercise in the engine's shape: a name and a `sets` list (empty is valid). */
export function checkEngineExercise(e: unknown, w: Where, path: string): void {
  checkObject(e, w, path, "an exercise");
  checkName(e, w, path);
  if (!Array.isArray(e.sets)) throw inputError(w, joinPath(path, "sets"), `must be a list of sets, got ${describe(e.sets)}`);
  e.sets.forEach((s, i) => checkSet(s, w, joinPath(joinPath(path, "sets"), i)));
  checkUnit(e, "unit", w, path);
  checkBoolean(e, "perSide", w, path);
}

/** An exercise in Tally's shape: a name and its prescription (suggestedSets, suggestedReps, …). */
export function checkTallyExercise(e: unknown, w: Where, path: string, o: PrescriptionOptions = {}): void {
  checkObject(e, w, path, "an exercise");
  checkName(e, w, path);
  checkCount(e, "suggestedSets", w, path, o.zeroSets ? 0 : 1);
  for (const k of TALLY_NUMBERS) checkNumber(e, k, w, path);
  checkBoolean(e, "perSide", w, path);
}

/** A write input's exercise (plans write): each exercise is checked in its own shape. */
export function checkWriteExercise(e: unknown, w: Where, path: string, o: PrescriptionOptions = {}): void {
  if (isObj(e) && "sets" in e) checkEngineExercise(e, w, path);
  else checkTallyExercise(e, w, path, o);
}

// ---------- logged values in a snapshot history (W1b) ----------

/** The name a problem gives a logged exercise: its name, else "exercise <n>". */
export function sessionExerciseName(e: Record<string, unknown>, j: number): string {
  return typeof e.name === "string" && e.name !== "" ? e.name : `exercise ${j + 1}`;
}

/** W1b: the problems of logged sets, never thrown ("sets[1].rpe must be at most 10, got 12"); the capture records them. */
export function loggedSetProblems(sets: readonly unknown[]): string[] {
  const out: string[] = [];
  sets.forEach((x, i) => {
    try {
      checkSet(x, {}, `sets[${i}]`);
    } catch (e) {
      out.push((e as Error).message);
    }
  });
  return out;
}

/**
 * W1b: the logged values of a snapshot history the engine cannot read, for the sessions dated in
 * [since, until]: the problems the capture recorded, and each kept set checked again (history
 * mode). A consumer that computes from logged sets (loads, readiness, weeks, block draft, the
 * today brief) reports unknown or failed with these, never a number. The note scan does not use
 * them: a bad set never stops a note from being scanned.
 */
export function historyValueProblems(history: readonly SnapshotSession[], since?: string, until?: string): string[] {
  const out = new Set<string>();
  for (const s of history) {
    if (!isObj(s) || (since && s.date < since) || (until && s.date > until)) continue;
    for (const p of Array.isArray(s.problems) ? s.problems : []) out.add(String(p));
    (Array.isArray(s.exercises) ? s.exercises : []).forEach((e, j) => {
      if (!isObj(e) || !Array.isArray(e.sets)) return;
      for (const p of loggedSetProblems(e.sets)) out.add(`${s.date} ${sessionExerciseName(e, j)}: ${p}`);
    });
  }
  return [...out];
}

/** The reason a consumer gives for those problems (at most three named). */
export function valueProblemsText(problems: readonly string[]): string {
  const shown = problems.slice(0, 3).join("; ");
  return `a logged value cannot be read (${shown}${problems.length > 3 ? `; and ${problems.length - 3} more` : ""})`;
}
