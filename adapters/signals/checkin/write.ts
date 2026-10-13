// Chat check-ins (contracts §11). Writes the `checkin` block into
// athlete/signals/<date>.json with `source: "chat"`.
//
// - No file for the date: a new file with `source: "chat"`.
// - A Shortcut file exists: the check-in is merged into it. The file keeps its own source
//   for the wearable data, and the check-in block carries `source: "chat"`, so the
//   normalizer returns 2 records and the sources stay separate.
// - A check-in already in the file is merged by group (V6 B.3): a new rating (overall, or the
//   four scales together) replaces the old rating group; a new want_to_train or pain replaces
//   the old value; `null` clears it (pain: [] records "no pain now"); a group the answer leaves
//   out stays. The block's source and submitted_at become the new answer's, and the result
//   names the answer it replaced. A clear that leaves no field removes the block. Readiness
//   and the loader never merge: this writer is the only place.
// - A clear with no earlier answer today writes nothing (action "unchanged").
// - Urgent warning signs the athlete chose (`urgent`, term names only) write and commit the
//   urgent stop (engine/urgent.ts, source checkin) FIRST, before the signal file is read, so a
//   damaged or invalid signal file cannot prevent it. The CLI pushes it. An urgent sign alone
//   changes no signal file.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CoachError } from "../../../engine/errors.ts";
import { isCalendarDate, parseInstant } from "../../../engine/dates.ts";
import { FOUR_SCALES } from "../../../engine/checkin-shape.ts";
import type { CalendarDate, Instant, PainEntry, Scale } from "../../../engine/types.ts";
import { validateSignalFile, type SignalCheckin, type SignalFile } from "../apple-health-shortcut/normalize.ts";
import { writeJsonAtomic } from "../write-json.ts";
import { commitPaths, URGENT_RELATIVE, urgentTermNames, writeStop, type CommitResult } from "../../../engine/urgent.ts";
import type { UrgentStop } from "../../../engine/types.ts";

export const SIGNALS_DIR = "athlete/signals";

/**
 * One chat check-in. The rating is one group: `overall`, or the four scales together.
 * `null` clears a group ("--want-to-train none", "--pain none"); an absent group stays as it is.
 */
export type CheckinAnswers = {
  overall?: Scale;
  sleep_quality?: Scale;
  energy?: Scale;
  soreness?: Scale;
  stress?: Scale;
  want_to_train?: Scale | null;
  pain?: PainEntry[] | null;
};

export type CheckinResult = {
  path: string;
  /** `unchanged`: nothing was written (an urgent sign alone, or a clear with nothing to clear). */
  action: "created" | "merged" | "unchanged";
  replaced: { source: string; submitted_at: Instant } | null;
  /** The daily file after the write; null when there is none. */
  file: SignalFile | null;
  /** Why nothing was written, when `action` is `unchanged`. */
  note?: string;
  /** The urgent stop, when the check-in named an urgent sign. */
  urgent_stop?: { stop: UrgentStop; changed: boolean; commit: CommitResult };
};

const hasRating = (a: CheckinAnswers) => a.overall !== undefined || FOUR_SCALES.some((k) => a[k] !== undefined);

/** True when the answers hold something to record (a value or a clear). */
export function hasAnswer(a: CheckinAnswers): boolean {
  return hasRating(a) || a.want_to_train !== undefined || a.pain !== undefined;
}

/**
 * The check-in block after the new answer, merged by group (B.3): a new rating replaces the
 * old rating group; a new want_to_train or pain replaces the old value; null clears it; a
 * group the answer leaves out stays. Null when no field is left.
 */
export function mergeCheckin(old: SignalCheckin | undefined, a: CheckinAnswers, now: Instant): SignalCheckin | null {
  const b: SignalCheckin = {};
  if (hasRating(a)) {
    if (a.overall !== undefined) b.overall = a.overall;
    for (const k of FOUR_SCALES) if (a[k] !== undefined) b[k] = a[k] as Scale;
  } else if (old) {
    if (old.overall !== undefined) b.overall = old.overall;
    for (const k of FOUR_SCALES) if (old[k] !== undefined) b[k] = old[k];
  }
  const want = a.want_to_train !== undefined ? a.want_to_train : old?.want_to_train;
  if (want !== undefined && want !== null) b.want_to_train = want;
  const pain = a.pain === null ? [] : a.pain !== undefined ? a.pain : old?.pain;
  if (pain !== undefined) b.pain = pain.map((p) => ({ region: p.region, score: p.score }));
  if (b.overall === undefined && !FOUR_SCALES.some((k) => b[k] !== undefined) && b.want_to_train === undefined && b.pain === undefined) return null;
  return { ...b, source: "chat", submitted_at: now };
}

const fields = (c: SignalCheckin | undefined | null) => {
  if (!c) return null;
  const { source: _s, submitted_at: _t, ...rest } = c;
  return JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k as keyof typeof rest]]));
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
  const path = signalPath(root, date);
  const extra = urgentStop ? { urgent_stop: urgentStop } : {};

  let existing: SignalFile | null = null;
  if (existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new CoachError("SIGNAL_INVALID", `cannot read ${path}: ${(e as Error).message}. Fix or remove it first.`);
    }
    // Never merge into a file that does not validate: it would hide the problem.
    existing = validateSignalFile(raw, { now, expectDate: date });
  }
  // An urgent sign alone changes no signal file.
  if (!hasAnswer(answers)) return { path, action: "unchanged", replaced: null, file: existing, note: "no check-in answer: no signal file written", ...extra };

  const old = existing?.checkin;
  const onlyClears = !hasRating(answers) && [answers.want_to_train, answers.pain].every((v) => v === undefined || v === null);
  const checkin = mergeCheckin(old, answers, now);
  // A clear with no earlier answer today (or nothing left to clear) writes nothing.
  if (onlyClears && (!old || fields(old) === fields(checkin))) {
    return { path, action: "unchanged", replaced: null, file: existing, note: "nothing to clear: no earlier answer today", ...extra };
  }

  let file: SignalFile;
  let action: CheckinResult["action"];
  let replaced: CheckinResult["replaced"] = null;
  if (existing) {
    if (old) replaced = { source: old.source ?? existing.source, submitted_at: old.submitted_at ?? existing.submitted_at };
    const { checkin: _drop, ...rest } = existing;
    // A clear that leaves no field removes the block; the file and any wearable data stay.
    file = checkin ? { ...rest, checkin } : rest;
    if (existing.source === "chat") file.submitted_at = now;
    action = "merged";
  } else {
    file = { version: 1, date, source: "chat", submitted_at: now, ...(checkin ? { checkin } : {}) };
    action = "created";
  }
  validateSignalFile(file, { now, expectDate: date });
  writeJsonAtomic(path, file);
  return { path, action, replaced, file, ...extra };
}
