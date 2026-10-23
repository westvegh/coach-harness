// V7: history coverage by logger (contracts §9a, §12a). The note scan, `loads` and the today brief
// ask the same question: does the history cover this range, so "nothing found" means nothing is
// there? Incomplete coverage is `unknown`, never "no match".
// - tally: the snapshot's windows (engine/history-windows.ts), this session's, fresh, with the
//   reads the hook could not save (a lock timeout) counted as failed;
// - files: the week files are the record; complete unless a row cannot be read;
// - other: the engine cannot read that tool; the coach passes its evidence as a file.
import { coachSnapshot } from "./coach-snapshot.ts";
import { addDays, parseInstant } from "./dates.ts";
import { chainOf, FRESH_MIN, HISTORY_RANGE_DAYS, historyCoverage, markHistoryFailed, windowDaysFor, type HistoryCoverage } from "./history-windows.ts";
import { historyValueProblems, valueProblemsText } from "./input-values.ts";
import { readCaptureFailures } from "./snapshot-lock.ts";
import { loadSnapshot } from "./snapshot.ts";
import type { CalendarDate, CoachConfig, Instant, Snapshot } from "./types.ts";

/** The session this command runs in, when Claude Code says (CLAUDE_CODE_SESSION_ID). */
export const envSession = (): string | null => process.env.CLAUDE_CODE_SESSION_ID || null;

/**
 * The reads this session's hooks could not save (a lock timeout), applied to a snapshot in memory
 * (the file is not written). Each failure is matched by its own read (V7 review finding 3):
 * - a day: failed unless the day was captured after the failure;
 * - a history first page: failed unless the window's current chain starts with a first page
 *   captured after the failure;
 * - a history page with a cursor: its window is found by its chain (also for a cursor-only read);
 *   failed unless a page with that cursor was captured after the failure.
 */
export function applyCaptureFailures(snap: Snapshot, root: string, session_id: string | null): Snapshot {
  if (!session_id) return snap;
  for (const f of readCaptureFailures(root, session_id)) {
    if (f.tool === "get_planned_workout" && f.date) {
      const day = snap.days[f.date];
      if (!day || day.captured_at < f.at) {
        delete snap.days[f.date];
        (snap.failed_days ??= {})[f.date] = { at: f.at, reason: f.reason };
      }
    }
    if (f.tool !== "get_workout_history") continue;
    const windows = snap.history_windows ?? {};
    const key = f.cursor === undefined ? `${f.since ?? ""}..${f.until ?? ""}` : chainOf(windows, f.since, f.until, f.cursor);
    if (key === null) continue; // a page of no known chain: nothing it would have refreshed is known
    const w = windows[key];
    const cleared = !w ? false : f.cursor === undefined ? w.pages[0]?.cursor === null && w.pages[0].captured_at > f.at : w.pages.some((p) => p.cursor === f.cursor && p.captured_at > f.at);
    if (!cleared) markHistoryFailed(snap, { ...(w?.since ?? f.since ? { since: w?.since ?? f.since } : {}), ...(w?.until ?? f.until ? { until: w?.until ?? f.until } : {}), ...(f.cursor ? { cursor: f.cursor } : {}) }, f.at, f.reason);
  }
  return snap;
}

/** The Tally snapshot with this session's unsaved reads applied (one load). */
export function tallySnapshot(root: string, session_id: string | null): Snapshot | null {
  const snap = loadSnapshot(root);
  return snap ? applyCaptureFailures(snap, root, session_id) : null;
}

export type LoggerCoverage = HistoryCoverage & { logger: CoachConfig["logger"] };

/**
 * Coverage of [since, until] for the configured logger. `snap`: the snapshot the caller already
 * loaded for its data, so the coverage and the data are the same read (V7 review finding 4); a Tally
 * snapshot gets this session's unsaved reads applied to a copy.
 */
export function loggerHistoryCoverage(root: string, cfg: CoachConfig | null, since: CalendarDate, until: CalendarDate, now: Instant, session_id = envSession(), snap?: Snapshot | null): LoggerCoverage {
  const logger = cfg?.logger ?? "tally";
  const nowMs = parseInstant(now, "now");
  if (logger === "other") {
    return { logger, status: "missing", since, until, reason: "logger other: the engine cannot read that tool; pass its history with --input", gaps: [{ since, until }], need: [] };
  }
  if (logger === "files") return { logger, ...historyCoverage(snap !== undefined ? snap : coachSnapshot(root, { now, cfg }), since, until, nowMs) };
  const s = snap !== undefined ? (snap ? applyCaptureFailures(structuredClone(snap), root, session_id) : null) : tallySnapshot(root, session_id);
  return { logger, ...historyCoverage(s, since, until, nowMs, { session_id, windowDays: windowDaysFor(cfg?.template.days) }) };
}

/**
 * W1b: coverage for a consumer that computes from logged sets: `failed` when the snapshot history
 * holds a logged value the engine cannot read in [since, until] (the reason names the date and the
 * field). `values` is that reason; the note scan does not use this (a bad set never stops a note).
 */
export function withHistoryValues<T extends HistoryCoverage>(cov: T, snap: Snapshot | null | undefined, since: CalendarDate | undefined, until: CalendarDate): T & { values?: string } {
  const bad = snap ? historyValueProblems(snap.history, since, until) : [];
  if (bad.length === 0) return cov;
  const values = valueProblemsText(bad);
  return { ...cov, status: "failed", reason: cov.reason && cov.status !== "complete" ? `${cov.reason}; ${values}` : values, values };
}

/** The standard history range for a date: 8 weeks before it to it (contracts §9a, the consumer table). */
export function standardRange(date: CalendarDate): { since: CalendarDate; until: CalendarDate } {
  return { since: addDays(date, -HISTORY_RANGE_DAYS), until: date };
}

export { FRESH_MIN };
