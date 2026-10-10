// is an approved proposal applied? Each write's result (in Tally's
// real shapes: written, updated, moved, deleted, per-day range results, replays) is
// checked per date, and each date against a fresh read-back. Nothing is written.
import { parseInstant } from "./dates.ts";
import { loadLogger, toolSuffix } from "./logger.ts";
import type { LoggerTool } from "./logger.ts";
import { responseOutcomes, type DayOutcome } from "./oplog.ts";
import type { Proposal } from "./proposals.ts";
import { SNAPSHOT_MAX_AGE_MIN } from "./snapshot.ts";
import type { Instant, LoggerExercise, Snapshot, SnapshotDay } from "./types.ts";
import { isPlainObject } from "./yaml-file.ts";

export type WriteCheck = {
  index: number;
  tool: string;
  dates: string[];
  result: Record<string, DayOutcome | "no_result">;
  readback: Record<string, string>;
  applied: boolean;
};

export type CheckApplied = { id: string; status: "applied" | "partial" | "not-applied"; writes: WriteCheck[]; missing: string[] };

const READ = (d: string) => `read ${d} with get_planned_workout (within ${SNAPSHOT_MAX_AGE_MIN} minutes) and check again`;
const COMPARED = ["suggestedSets", "suggestedReps", "repsMax", "suggestedDuration", "distanceMeters", "rpe", "perSide"];

const exercisesOf = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isPlainObject) : []);

/** A planned day as the call asked for it: the same exercises, in order, with the same counts. */
function samePlan(day: SnapshotDay, spec: Record<string, unknown>): string | null {
  if (day.skipped) return "the day is skipped";
  const want = exercisesOf(spec.exercises);
  const got = day.exercises;
  if (typeof spec.dayName === "string" && day.dayName !== spec.dayName) return `the day is named ${JSON.stringify(day.dayName)}, not ${JSON.stringify(spec.dayName)}`;
  const ids = (xs: LoggerExercise[] | Record<string, unknown>[]) => xs.map((e) => String(e.exerciseId)).join(", ");
  if (ids(got) !== ids(want)) return `the exercises are ${ids(got) || "none"}, not ${ids(want)}`;
  for (let i = 0; i < want.length; i++) {
    for (const f of COMPARED) if (f in want[i] && got[i][f] !== want[i][f]) return `${String(want[i].exerciseId)} ${f} is ${String(got[i][f])}, not ${String(want[i][f])}`;
  }
  return null;
}

/** update_planned_workout: each operation is visible in the day (weights are not compared: units convert). */
function hasOperations(day: SnapshotDay, args: Record<string, unknown>): string | null {
  const ex = day.exercises;
  const byTarget = (t: unknown): LoggerExercise | undefined => {
    if (!isPlainObject(t)) return undefined;
    if (typeof t.exerciseId === "string") return ex.find((e) => e.exerciseId === t.exerciseId);
    return typeof t.index === "number" ? ex[t.index] : undefined;
  };
  for (const op of exercisesOf(args.operations)) {
    const t = isPlainObject(op.target) && typeof op.target.exerciseId === "string" ? op.target.exerciseId : null;
    const added = isPlainObject(op.exercise) ? String(op.exercise.exerciseId) : null;
    if ((op.op === "add" || op.op === "replace") && added && !ex.some((e) => e.exerciseId === added)) return `${added} is not in the day`;
    if (op.op === "remove" && t && ex.some((e) => e.exerciseId === t)) return `${t} is still in the day`;
    if (op.op === "modify" && isPlainObject(op.fields)) {
      const e = byTarget(op.target);
      if (!e) return `${t ?? "the target"} is not in the day`;
      for (const f of COMPARED) if (f in op.fields && e[f] !== op.fields[f]) return `${String(e.exerciseId)} ${f} is ${String(e[f])}, not ${String(op.fields[f])}`;
    }
  }
  if (typeof args.dayName === "string" && day.dayName !== args.dayName) return `the day is named ${JSON.stringify(day.dayName)}, not ${JSON.stringify(args.dayName)}`;
  return null;
}

/** What the read-back of `date` must show after the write. Null: it matches. */
function readbackProblem(tool: string, args: Record<string, unknown>, date: string, day: SnapshotDay): string | null {
  switch (tool) {
    case "plan_workout_day":
      return day.found ? samePlan(day, args) : "the date is empty";
    case "plan_workout_range": {
      const spec = exercisesOf(args.days).find((d) => d.date === date) ?? {};
      return day.found ? samePlan(day, spec) : "the date is empty";
    }
    case "update_planned_workout":
      return day.found ? hasOperations(day, args) : "the date is empty";
    case "move_planned_workout":
      if (date === args.fromDate) return day.found ? "the day is still on the source date" : null;
      return day.found ? null : "the destination date is empty";
    case "skip_planned_workout":
      if (!day.found) return "the date is empty";
      return day.skipped === (args.skip !== false) ? null : `the day is ${day.skipped ? "skipped" : "not skipped"}`;
    case "delete_planned_workout":
      return day.found ? "the day is still there" : null;
    default:
      return `${tool} is not a day write`;
  }
}

/**
 * Checks each write of a proposal: `results[i]` is the tool response of write i (null when
 * there is none); the snapshot holds the read-back. Applied: every date of every write
 * succeeded and its read-back (at most 15 minutes old) matches. Partial: some writes are
 * applied. Not-applied: none.
 */
export function checkApplied(p: Proposal, results: unknown[] | null, snap: Snapshot | null, now: Instant): CheckApplied {
  const logger = loadLogger("tally");
  const nowMs = parseInstant(now, "now");
  const missing: string[] = [];
  const writes = p.writes.map((w, i): WriteCheck => {
    const tool = toolSuffix(w.tool);
    const args = isPlainObject(w.input) ? w.input : {};
    const where = `write ${i + 1} (${tool})`;
    let dates: string[] = [];
    try {
      dates = logger.isMutation(tool) ? logger.affectedDates(tool as LoggerTool, args) : [];
    } catch (e) {
      missing.push(`${where}: ${(e as Error).message}`);
    }
    const response = results?.[i];
    const outcomes = response === undefined || response === null ? null : responseOutcomes(tool, args, response);
    const result: WriteCheck["result"] = {};
    const readback: WriteCheck["readback"] = {};
    let ok = true;
    if (dates.length === 0) {
      missing.push(`${where}: names no date to check`);
      ok = false;
    }
    if (!outcomes) {
      missing.push(`${where}: no result; its outcome is unknown: read ${dates.join(", ")} with get_planned_workout before any retry`);
      ok = false;
    }
    for (const d of dates) {
      result[d] = outcomes ? (outcomes[d] ?? "uncertain") : "no_result";
      if (outcomes && result[d] !== "done") {
        missing.push(`${where} ${d}: the result is ${result[d]}`);
        ok = false;
      }
      const day = snap?.days[d];
      const age = day ? (nowMs - parseInstant(day.captured_at, "captured_at")) / 60_000 : Infinity;
      if (!day || !(age <= SNAPSHOT_MAX_AGE_MIN)) {
        readback[d] = "not read";
        missing.push(`${where} ${d}: ${READ(d)}`);
        ok = false;
        continue;
      }
      const problem = readbackProblem(tool, args, d, day);
      readback[d] = problem ? `mismatch: ${problem}` : "match";
      if (problem) {
        missing.push(`${where} ${d}: the read-back does not match (${problem})`);
        ok = false;
      }
    }
    return { index: i + 1, tool, dates, result, readback, applied: ok };
  });
  const n = writes.filter((w) => w.applied).length;
  const status = n === writes.length && n > 0 ? "applied" : n > 0 ? "partial" : "not-applied";
  return { id: p.id, status, writes, missing };
}
