// Chat check-ins (contracts §11). Writes the `checkin` block into
// athlete/signals/<date>.json with `source: "chat"`.
//
// - No file for the date: a new file with `source: "chat"`.
// - A Shortcut file exists: the check-in is merged into it. The file keeps its own source
//   for the wearable data, and the check-in block carries `source: "chat"`, so the
//   normalizer returns 2 records and the sources stay separate.
// - A check-in already in the file is replaced (the latest answer wins); the result
//   names the one it replaced.
// - Urgent warning signs the athlete chose (`urgent`, term names only) write and commit the
//   urgent stop (engine/urgent.ts, source checkin) FIRST, before the signal file is read, so a
//   damaged or invalid signal file cannot prevent it. The CLI pushes it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CoachError } from "../../../engine/errors.ts";
import { isCalendarDate, parseInstant } from "../../../engine/dates.ts";
import type { CalendarDate, Instant, PainEntry, Scale } from "../../../engine/types.ts";
import { validateSignalFile, type SignalCheckin, type SignalFile } from "../apple-health-shortcut/normalize.ts";
import { writeJsonAtomic } from "../write-json.ts";
import { commitPaths, URGENT_RELATIVE, urgentTermNames, writeStop, type CommitResult } from "../../../engine/urgent.ts";
import type { UrgentStop } from "../../../engine/types.ts";

export const SIGNALS_DIR = "athlete/signals";

export type CheckinAnswers = { sleep_quality: Scale; energy: Scale; soreness: Scale; stress: Scale; want_to_train?: Scale; pain?: PainEntry[] };

export type CheckinResult = {
  path: string;
  action: "created" | "merged";
  replaced: { source: string; submitted_at: Instant } | null;
  file: SignalFile;
  /** The urgent stop, when the check-in named an urgent sign. */
  urgent_stop?: { stop: UrgentStop; changed: boolean; commit: CommitResult };
};

export function signalPath(root: string, date: CalendarDate): string {
  return join(root, SIGNALS_DIR, `${date}.json`);
}

/** Writes and commits the urgent stop for the urgent terms of a check-in (term names only). */
export function recordCheckinUrgent(root: string, terms: string[], now?: Instant): { stop: UrgentStop; changed: boolean; commit: CommitResult } | null {
  const urgent = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (urgent.length === 0) return null;
  const known = urgentTermNames();
  const bad = urgent.filter((t) => !known.includes(t));
  if (bad.length > 0) throw new CoachError("USAGE", `unknown urgent term ${bad.join(", ")}; use one of: ${known.join(", ")}`);
  const w = writeStop(root, { terms: urgent, source: "checkin", ...(now ? { now } : {}) });
  // Every call reconciles the commit, also when the content did not change.
  return { ...w, commit: commitPaths(root, [URGENT_RELATIVE], "urgent stop (checkin)") };
}

export function writeCheckin(input: { root: string; date: CalendarDate; answers: CheckinAnswers; now?: Instant; urgent?: string[] }): CheckinResult {
  const { root, date, answers } = input;
  // The urgent stop first: nothing below (the date, the signal file) can prevent it.
  const urgentStop = recordCheckinUrgent(root, input.urgent ?? [], input.now);
  if (!isCalendarDate(date)) throw new CoachError("USAGE", `checkin date must be YYYY-MM-DD: ${JSON.stringify(date)}`);
  const now = input.now ?? new Date().toISOString();
  parseInstant(now, "now");
  const checkin: SignalCheckin = {
    sleep_quality: answers.sleep_quality,
    energy: answers.energy,
    soreness: answers.soreness,
    stress: answers.stress,
    ...(answers.want_to_train !== undefined ? { want_to_train: answers.want_to_train } : {}),
    ...(answers.pain && answers.pain.length > 0 ? { pain: answers.pain } : {}),
    source: "chat",
    submitted_at: now,
  };

  const path = signalPath(root, date);
  let file: SignalFile;
  let action: CheckinResult["action"];
  let replaced: CheckinResult["replaced"] = null;
  if (existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new CoachError("SIGNAL_INVALID", `cannot read ${path}: ${(e as Error).message}. Fix or remove it first.`);
    }
    // Never merge into a file that does not validate: it would hide the problem.
    const existing = validateSignalFile(raw, { now, expectDate: date });
    if (existing.checkin) {
      replaced = { source: existing.checkin.source ?? existing.source, submitted_at: existing.checkin.submitted_at ?? existing.submitted_at };
    }
    file = { ...existing, checkin };
    if (existing.source === "chat") file.submitted_at = now;
    action = "merged";
  } else {
    file = { version: 1, date, source: "chat", submitted_at: now, checkin };
    action = "created";
  }
  validateSignalFile(file, { now, expectDate: date });
  writeJsonAtomic(path, file);
  return { path, action, replaced, file, ...(urgentStop ? { urgent_stop: urgentStop } : {}) };
}
