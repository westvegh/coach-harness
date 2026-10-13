// Cluster sets (contracts §8a, 0.2.4). A cluster is one block of short mini-sets with a short
// rest between them, for example 6 mini-sets of 6 reps at a 12-rep-max load, 10 s apart.
//
// The coach.yaml `clusters` list is the only record of which exercises are clusters: week files,
// plans CSV rows and Tally days carry no style. `clusterOf` decides for one exercise on one date:
//   1. A list entry matches when both have an exerciseId and they are equal, else when the
//      normalized names are equal. A matched exercise is a cluster on or after `since` (always
//      without `since`) and straight sets before it; the name rule below never applies to it.
//   2. No entry matches: a cluster when the name has the word "cluster".
//   3. Otherwise straight sets.
//
// Two counts (contracts §8a): "counted sets" measure training volume (a cluster counts
// max(1, round(total reps ÷ rm)), `clusterCount`); "physical sets" are the mini-sets to do.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isCalendarDate, isValidTimezone, localDate } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { normalizeName } from "./taxonomy.ts";
import { isPlainObject, readYamlFile } from "./yaml-file.ts";
import type { CalendarDate, ExerciseEntry, SetEntry } from "./types.ts";

export type ClusterEntry = {
  /** Required: the plans CSV has no exerciseId. */
  name: string;
  exerciseId?: string;
  mini_sets: number;
  /** Reps per mini-set. */
  reps: number;
  /** The rep max the load matches. */
  rm: number;
  rest_s?: number;
  /** Before this date the exercise is straight sets. */
  since?: CalendarDate;
};

/** How one exercise is done on one date: a list entry, the name word, or straight sets (null). */
export type ClusterMatch = { entry: ClusterEntry | null; by: "list" | "name" };

const CLUSTER_WORD = /\bcluster\b/i;
const KEYS = ["name", "exerciseId", "mini_sets", "reps", "rm", "rest_s", "since"];

type Ident = { exerciseId?: string | null; name?: string | null };

/** The list entry for this exercise (by exerciseId when both have one, else by normalized name), or null. */
export function listEntry(ex: Ident, list: readonly ClusterEntry[]): ClusterEntry | null {
  const n = normalizeName(ex.name ?? "");
  for (const e of list) {
    if (e.exerciseId && ex.exerciseId) {
      if (e.exerciseId === ex.exerciseId) return e;
    } else if (n !== "" && normalizeName(e.name) === n) return e;
  }
  return null;
}

/** The one decision (B.2): a cluster on `date`, or null for straight sets. */
export function clusterOf(ex: Ident, date: CalendarDate | null | undefined, list: readonly ClusterEntry[]): ClusterMatch | null {
  const e = listEntry(ex, list);
  if (e) return !e.since || !date || date >= e.since ? { entry: e, by: "list" } : null;
  return CLUSTER_WORD.test(ex.name ?? "") ? { entry: null, by: "name" } : null;
}

/** A whole number of 1 or more. */
const repsOf = (s: SetEntry): number | null => (typeof s.reps === "number" && Number.isInteger(s.reps) && s.reps >= 1 ? s.reps : null);

/** The work mini-sets: every set not marked as a warm-up. */
export function workSets(sets: readonly SetEntry[]): SetEntry[] {
  return sets.filter((s) => s.warmup !== true);
}

/** The rep max a count uses: the given one, else 2 × the largest work mini-set rep count (null with no reps). */
export function clusterRm(sets: readonly SetEntry[], rm?: number | null): number | null {
  if (typeof rm === "number" && rm > 0) return rm;
  const reps = workSets(sets).map(repsOf).filter((r): r is number => r !== null);
  return reps.length > 0 ? 2 * Math.max(...reps) : null;
}

/**
 * A cluster's counted sets (B.3): no work mini-sets → 0; no reps logged or planned → the number
 * of work mini-sets; else max(1, round(total reps ÷ rm)), rounded half up.
 */
export function clusterCount(sets: readonly SetEntry[], rm?: number | null): number {
  const work = workSets(sets);
  if (work.length === 0) return 0;
  const reps = work.map(repsOf).filter((r): r is number => r !== null);
  if (reps.length === 0) return work.length;
  const total = reps.reduce((a, r) => a + r, 0);
  return Math.max(1, Math.floor(total / clusterRm(work, rm)! + 0.5));
}

/** Counted sets of one exercise on one date: a cluster's count, else its hard sets (warm-ups left out). */
export function countedSets(ex: Pick<ExerciseEntry, "exerciseId" | "name" | "sets">, date: CalendarDate | null | undefined, list: readonly ClusterEntry[]): number {
  const sets = ex.sets ?? [];
  const c = clusterOf(ex, date, list);
  if (!c) return workSets(sets).length;
  return clusterCount(sets, c.entry?.rm);
}

/** "6 × 6 cluster, counts as 3 sets" (the audit's line), or null for straight sets. */
export function clusterLine(ex: Pick<ExerciseEntry, "exerciseId" | "name" | "sets">, date: CalendarDate | null | undefined, list: readonly ClusterEntry[]): { mini_sets: number; reps: string; rm: number | null; counted: number; text: string } | null {
  const c = clusterOf(ex, date, list);
  if (!c) return null;
  const work = workSets(ex.sets ?? []);
  const reps = work.map(repsOf).filter((r): r is number => r !== null);
  const repText = reps.length === 0 ? "" : Math.min(...reps) === Math.max(...reps) ? String(reps[0]) : reps.join(",");
  const counted = clusterCount(ex.sets ?? [], c.entry?.rm);
  const shape = repText ? `${work.length} × ${repText}` : `${work.length} mini-sets`;
  return { mini_sets: work.length, reps: repText, rm: clusterRm(work, c.entry?.rm), counted, text: `${shape} cluster, counts as ${counted} ${counted === 1 ? "set" : "sets"}` };
}

/**
 * The plain note for a cluster (B.7): "Cluster: 6 × 6 at 12RM, 10 s between mini-sets", leaving
 * out what is not known. `mini` and `reps` describe the planned work mini-sets.
 */
export function clusterNote(mini: number, reps: number | null, rm: number | null, rest_s: number | undefined): string {
  const shape = reps !== null ? `${mini} × ${reps}` : `${mini} mini-sets`;
  return `Cluster: ${shape}${rm !== null ? ` at ${rm}RM` : ""}${typeof rest_s === "number" ? `, ${rest_s} s between mini-sets` : ""}`;
}

/** The note for one planned exercise that is a cluster on `date`, or null. */
export function exerciseClusterNote(ex: Pick<ExerciseEntry, "exerciseId" | "name" | "sets">, date: CalendarDate | null | undefined, list: readonly ClusterEntry[]): string | null {
  const c = clusterOf(ex, date, list);
  if (!c) return null;
  const work = workSets(ex.sets ?? []);
  const reps = work.map(repsOf).filter((r): r is number => r !== null);
  const one = reps.length > 0 && reps.every((r) => r === reps[0]) ? reps[0] : reps.length > 0 ? Math.max(...reps) : (c.entry?.reps ?? null);
  return clusterNote(work.length, one, clusterRm(work, c.entry?.rm) ?? c.entry?.rm ?? null, c.entry?.rest_s);
}

/** True for a note line or segment the engine wrote for a cluster ("Cluster: …"). */
export const isClusterNote = (s: string) => /^\s*cluster:/i.test(s);

/**
 * Notes without the engine's "Cluster: …" lines and " | " segments; everything else stays as it
 * was, in order. Writing a day again then never duplicates or keeps a stale cluster line.
 */
export function stripClusterNotes(notes: string | undefined): string {
  if (!notes) return "";
  const lines: string[] = [];
  for (const line of notes.split("\n")) {
    const segs = line.split(" | ");
    const kept = segs.filter((seg) => !isClusterNote(seg));
    // A line that held only cluster segments goes; any other line stays as it was.
    if (kept.length === segs.length) lines.push(line);
    else if (kept.length > 0) lines.push(kept.join(" | "));
  }
  return lines.join("\n");
}

// ---------- validation and loading ----------

const whole = (v: unknown, min: number) => typeof v === "number" && Number.isInteger(v) && v >= min;

/** Problems with a `clusters` list (B.1), each "clusters[i].key: …". Empty when valid. */
export function clusterProblems(raw: unknown, where = "clusters"): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return [`${where}: must be a list`];
  const out: string[] = [];
  const ids = new Map<string, number>();
  const names = new Map<string, number>();
  raw.forEach((e, i) => {
    const at = `${where}[${i}]`;
    if (!isPlainObject(e)) return out.push(`${at}: must be a mapping`);
    for (const k of Object.keys(e)) if (!KEYS.includes(k)) out.push(`${at}.${k}: unknown key (allowed: ${KEYS.join(", ")})`);
    if (typeof e.name !== "string" || normalizeName(e.name) === "") out.push(`${at}.name: is required (the exercise name as the plan writes it)`);
    if (e.exerciseId !== undefined && (typeof e.exerciseId !== "string" || e.exerciseId === "")) out.push(`${at}.exerciseId: must be a non-empty string`);
    if (!whole(e.mini_sets, 1)) out.push(`${at}.mini_sets: must be a whole number of 1 or more`);
    if (!whole(e.reps, 1)) out.push(`${at}.reps: must be a whole number of 1 or more`);
    if (!whole(e.rm, 1)) out.push(`${at}.rm: must be a whole number of 1 or more`);
    else if (whole(e.reps, 1) && (e.rm as number) <= (e.reps as number)) out.push(`${at}.rm: must be above reps (${e.reps})`);
    if (e.rest_s !== undefined && !whole(e.rest_s, 0)) out.push(`${at}.rest_s: must be a whole number of seconds`);
    if (e.since !== undefined && !isCalendarDate(e.since)) out.push(`${at}.since: must be a date (YYYY-MM-DD)`);
    // No two entries for one exercise: the same exerciseId, or the same name.
    if (typeof e.exerciseId === "string" && e.exerciseId !== "") {
      if (ids.has(e.exerciseId)) out.push(`${at}: a second entry for exerciseId ${e.exerciseId} (first: ${where}[${ids.get(e.exerciseId)}])`);
      else ids.set(e.exerciseId, i);
    }
    if (typeof e.name === "string" && normalizeName(e.name) !== "") {
      const n = normalizeName(e.name);
      if (names.has(n)) out.push(`${at}: a second entry for ${e.name} (first: ${where}[${names.get(n)}])`);
      else names.set(n, i);
    }
  });
  return out;
}

/** A validated list (throws `code` listing every problem). */
export function parseClusters(raw: unknown, where = "clusters", code = "INPUT_ERROR"): ClusterEntry[] {
  const problems = clusterProblems(raw, where);
  if (problems.length > 0) throw new CoachError(code, `${where} is invalid:\n  - ${problems.join("\n  - ")}`);
  if (!Array.isArray(raw)) return [];
  return raw.map((e: Record<string, unknown>) => ({
    name: e.name as string,
    ...(typeof e.exerciseId === "string" ? { exerciseId: e.exerciseId } : {}),
    mini_sets: e.mini_sets as number,
    reps: e.reps as number,
    rm: e.rm as number,
    ...(typeof e.rest_s === "number" ? { rest_s: e.rest_s } : {}),
    ...(typeof e.since === "string" ? { since: e.since } : {}),
  }));
}

/** coach.yaml's `clusters` and timezone (both optional; coach.yaml itself is optional). */
function fromConfig(root: string): { clusters: ClusterEntry[]; timezone: string | null } {
  const p = join(root, "coach.yaml");
  if (!existsSync(p)) return { clusters: [], timezone: null };
  const raw = readYamlFile(p, "CONFIG_INVALID");
  if (!isPlainObject(raw)) return { clusters: [], timezone: null };
  const tz = isPlainObject(raw.athlete) && typeof raw.athlete.timezone === "string" && isValidTimezone(raw.athlete.timezone) ? raw.athlete.timezone : null;
  return { clusters: parseClusters(raw.clusters, "coach.yaml clusters", "CONFIG_INVALID"), timezone: tz };
}

/**
 * The shared loader (B.2): the input's `clusters` when it has the key, else coach.yaml's, else
 * none. coach.yaml stays optional. `input` is any parsed command input (a week file, a day, …).
 */
export function loadClusters(root: string, input?: unknown): ClusterEntry[] {
  if (isPlainObject(input) && "clusters" in input && input.clusters !== undefined) return parseClusters(input.clusters, "input clusters");
  return fromConfig(root).clusters;
}

/** Today in the athlete's timezone (coach.yaml), else the system's: the date of an entry with no date. */
export function athleteToday(root: string, now?: string): CalendarDate {
  const tz = fromConfig(root).timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return localDate(now ?? new Date().toISOString(), tz);
}
