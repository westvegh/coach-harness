// athlete/.cache/snapshot.json (contracts §9): load, merge logger responses, age check.
// Only the capture-reads hook writes it. The guard reads it.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeTallyVersion, encodeTallyVersion } from "../adapters/loggers/tally/version.ts";
import { isCalendarDate, parseInstant } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { isPlainObject } from "./yaml-file.ts";
import type { CalendarDate, HistoryExercise, Instant, LoggerExercise, PlannedListing, Snapshot, SnapshotDay, SnapshotSession, Units } from "./types.ts";

export const SNAPSHOT_RELATIVE = "athlete/.cache/snapshot.json";
export const SNAPSHOT_MAX_AGE_MIN = 15;
export const REFRESH_REASON = "refresh: read the affected days with get_planned_workout first";

// ---------- load and save ----------

export function validateSnapshot(raw: unknown, where = "snapshot.json"): Snapshot {
  const bad = (m: string): never => {
    throw new CoachError("SNAPSHOT_INVALID", `${where} is invalid: ${m}`);
  };
  if (!isPlainObject(raw)) bad("must be an object");
  const s = raw as Record<string, unknown>;
  if (s.version !== 1) bad("version must be 1");
  if (typeof s.session_id !== "string" || s.session_id === "") bad("session_id is required");
  try {
    parseInstant(s.captured_at, "captured_at");
  } catch (e) {
    bad((e as Error).message);
  }
  if (typeof s.timezone !== "string") bad("timezone must be a string");
  if (!isPlainObject(s.days)) bad("days must be an object");
  for (const [d, day] of Object.entries(s.days as Record<string, unknown>)) {
    if (!isCalendarDate(d)) bad(`days: bad date ${d}`);
    if (!isPlainObject(day)) bad(`days.${d} must be an object`);
    const x = day as Record<string, unknown>;
    if (typeof x.found !== "boolean") bad(`days.${d}.found must be true or false`);
    if (!Array.isArray(x.exercises)) bad(`days.${d}.exercises must be a list`);
    if (typeof x.source !== "string" || typeof x.userModified !== "boolean" || typeof x.skipped !== "boolean") {
      bad(`days.${d} needs source, userModified and skipped`);
    }
    try {
      parseInstant(x.captured_at, `days.${d}.captured_at`);
    } catch (e) {
      bad((e as Error).message);
    }
  }
  if (!Array.isArray(s.history)) bad("history must be a list");
  return raw as Snapshot;
}

/** The snapshot, or null when the file does not exist. A malformed file throws. */
export function loadSnapshot(root: string): Snapshot | null {
  const p = join(root, SNAPSHOT_RELATIVE);
  if (!existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new CoachError("SNAPSHOT_INVALID", `cannot read ${p}: ${(e as Error).message}`);
  }
  return validateSnapshot(raw, p);
}

export function saveSnapshot(root: string, snap: Snapshot): void {
  const p = join(root, SNAPSHOT_RELATIVE);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(snap, null, 2) + "\n");
  renameSync(tmp, p);
}

/** Empties the snapshot cache (`snapshot reset`): the next read starts a new one. True when a file was removed. */
export function resetSnapshot(root: string): boolean {
  const p = join(root, SNAPSHOT_RELATIVE);
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}

export function emptySnapshot(session_id: string, now: Instant, timezone: string): Snapshot {
  return { version: 1, session_id, captured_at: now, timezone, days: {}, history: [] };
}

// ---------- age and session checks ----------

export function snapshotAgeMinutes(snap: Snapshot, now: Instant): number {
  return (parseInstant(now, "now") - parseInstant(snap.captured_at, "captured_at")) / 60_000;
}

/**
 * Reasons the snapshot cannot back a write (empty when it can): missing, from another
 * session, older than 15 minutes, or a date that was not read in the last 15 minutes.
 */
export function snapshotProblems(snap: Snapshot | null, session_id: string, now: Instant, dates: CalendarDate[]): string[] {
  if (!snap) return [`no snapshot; ${REFRESH_REASON}`];
  const out: string[] = [];
  if (snap.session_id !== session_id) out.push(`the snapshot is from another session; ${REFRESH_REASON}`);
  const age = snapshotAgeMinutes(snap, now);
  if (age > SNAPSHOT_MAX_AGE_MIN) out.push(`the snapshot is ${Math.round(age)} minutes old (limit ${SNAPSHOT_MAX_AGE_MIN}); ${REFRESH_REASON}`);
  if (age < -1) out.push(`the snapshot is from the future (${snap.captured_at}); ${REFRESH_REASON}`);
  for (const d of dates) {
    const day = snap.days[d];
    if (!day) {
      out.push(`${d} was not read in this session; ${REFRESH_REASON}`);
      continue;
    }
    const dayAge = (parseInstant(now, "now") - parseInstant(day.captured_at, "captured_at")) / 60_000;
    if (dayAge > SNAPSHOT_MAX_AGE_MIN) out.push(`${d} was read ${Math.round(dayAge)} minutes ago (limit ${SNAPSHOT_MAX_AGE_MIN}); ${REFRESH_REASON}`);
  }
  return out;
}

// ---------- merging tool responses ----------

/**
 * The JSON payload of a hook's `tool_response`: an array of {type: "text", text} blocks
 * (spike #8), or an object with `content` holding them. Null when no block parses as
 * JSON (an error message, for example).
 */
export function responsePayload(toolResponse: unknown): unknown {
  let blocks: unknown = toolResponse;
  if (isPlainObject(toolResponse) && Array.isArray(toolResponse.content)) {
    if (toolResponse.isError === true) return null;
    blocks = toolResponse.content;
  }
  if (typeof blocks === "string") blocks = [{ type: "text", text: blocks }];
  if (!Array.isArray(blocks)) return isPlainObject(toolResponse) && !("content" in toolResponse) ? toolResponse : null;
  for (const b of blocks) {
    if (isPlainObject(b) && b.type === "text" && typeof b.text === "string") {
      try {
        return JSON.parse(b.text);
      } catch {
        /* not JSON: try the next block */
      }
    }
  }
  return null;
}

// ---------- Tally T3 refusals (Tally server-limits spec §6.3) ----------

/** A day or call that a Tally training limit refused: status refused, code training_limit. */
export function isRefusal(x: unknown): x is Record<string, unknown> {
  return isPlainObject(x) && x.status === "refused" && x.code === "training_limit";
}

/**
 * The top-level refusal in a mutation's response, or null. It is read even when the
 * response is flagged as an error, because a refusal is a result, not a failure.
 */
export function tallyRefusal(toolResponse: unknown): Record<string, unknown> | null {
  const p = responsePayload(toolResponse);
  if (isRefusal(p)) return p;
  if (isPlainObject(toolResponse) && toolResponse.isError === true && Array.isArray(toolResponse.content)) {
    const inner = responsePayload(toolResponse.content);
    if (isRefusal(inner)) return inner;
  }
  return null;
}

/** The refused day entries of a plan response that wrote some days (no opId). */
export function refusedDays(payload: unknown): Record<string, unknown>[] {
  if (!isPlainObject(payload)) return [];
  return ["results", "skippedDates", "refused"].flatMap((k) => (Array.isArray(payload[k]) ? (payload[k] as unknown[]).filter(isRefusal) : []));
}

const KNOWN_UNIT_SOURCES = ["settings", "history"];

function unitOf(r: Record<string, unknown>): { weightUnit?: Units; weightUnitSource?: string } {
  const u = r.weightUnit;
  const src = typeof r.weightUnitSource === "string" ? r.weightUnitSource : undefined;
  if ((u === "lbs" || u === "kg") && src && KNOWN_UNIT_SOURCES.includes(src)) return { weightUnit: u, weightUnitSource: src };
  return src ? { weightUnitSource: src } : {};
}

// ---------- response schemas ----------

/** get_planned_workout's result shape (getPlannedWorkout.ts PlannedWorkoutDetail). */
export function validPlannedDay(r: unknown): r is Record<string, unknown> {
  if (!isPlainObject(r) || !isCalendarDate(r.date) || typeof r.found !== "boolean" || !Array.isArray(r.exercises)) return false;
  if (!r.found) return r.exercises.length === 0;
  return (
    typeof r.version === "string" &&
    typeof r.source === "string" &&
    typeof r.userModified === "boolean" &&
    typeof r.skipped === "boolean" &&
    r.exercises.every((e) => isPlainObject(e) && typeof e.name === "string" && e.name !== "")
  );
}

/** get_training_context's result shape (getTrainingContext.ts TrainingContext). */
export function validTrainingContext(r: Record<string, unknown>): boolean {
  return isCalendarDate(r.today) && Array.isArray(r.futurePlanned) && r.futurePlanned.every((p) => isPlainObject(p) && isCalendarDate(p.date)) && (r.weightUnit === "lbs" || r.weightUnit === "kg");
}

/** get_workout_history's result shape (getWorkoutHistory.ts WorkoutHistory). */
export function validHistory(r: Record<string, unknown>): boolean {
  return (
    typeof r.count === "number" &&
    Array.isArray(r.sessions) &&
    r.sessions.every((s) => isPlainObject(s) && isCalendarDate(s.date) && Array.isArray(s.exercises) && s.exercises.every((e) => isPlainObject(e) && Array.isArray(e.sets))) &&
    (r.nextCursor === undefined || typeof r.nextCursor === "string")
  );
}

/** A get_planned_workout result (also update_planned_workout's `day`) as a snapshot day. */
export function dayFromPlannedWorkout(r: Record<string, unknown>, now: Instant): SnapshotDay {
  if (r.found !== true) {
    return { found: false, version: null, updatedAt: null, source: "", userModified: false, skipped: false, exercises: [], ...unitOf(r), captured_at: now };
  }
  const exercises = Array.isArray(r.exercises) ? (r.exercises.filter(isPlainObject) as LoggerExercise[]) : [];
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const day: SnapshotDay = {
    found: true,
    version: str(r.version) ?? null,
    updatedAt: str(r.updatedAt) ?? null,
    source: str(r.source) ?? "builder",
    userModified: r.userModified === true,
    skipped: r.skipped === true,
    exercises,
    ...unitOf(r),
    captured_at: now,
  };
  for (const k of ["dayName", "dayType", "notes"] as const) if (typeof r[k] === "string") day[k] = r[k] as string;
  return day;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
/** The first start-time field a history session carries. */
const startOf = (s: Record<string, unknown>) => text(s.startedAt) ?? text(s.startTime) ?? text(s.started_at) ?? text(s.start);

/** A history session as the snapshot keeps it: sets, and the session and exercise notes (V4: the note scan reads them). */
function historySession(s: Record<string, unknown>, server?: string): SnapshotSession | null {
  if (!isCalendarDate(s.date)) return null;
  const unit = s.weightUnit === "kg" || s.weightUnit === "lbs" ? (s.weightUnit as Units) : undefined;
  const exercises: HistoryExercise[] = (Array.isArray(s.exercises) ? s.exercises : []).filter(isPlainObject).map((e) => ({
    exerciseId: typeof e.exerciseId === "string" ? e.exerciseId : "",
    name: typeof e.name === "string" ? e.name : "",
    muscle: typeof e.muscle === "string" ? e.muscle : "",
    sets: (Array.isArray(e.sets) ? e.sets : []).filter(isPlainObject).map((x) => ({
      weight: typeof x.weight === "number" ? x.weight : null,
      reps: typeof x.reps === "number" ? x.reps : null,
      rpe: typeof x.rpe === "number" ? x.rpe : null,
      // 0.2.4: a warm-up marker is kept where the source has one (Tally history has none).
      ...(x.warmup === true ? { warmup: true } : {}),
    })),
    ...(text(e.notes) ? { notes: e.notes as string } : {}),
  }));
  const id = text(s.id) ?? text(s.sessionId) ?? text(s.workoutId);
  const start = startOf(s);
  return {
    date: s.date,
    ...(typeof s.name === "string" ? { name: s.name } : {}),
    ...(unit ? { weightUnit: unit } : {}),
    exercises,
    ...(text(s.notes) ? { notes: s.notes as string } : {}),
    ...(id ? { id } : {}),
    ...(start ? { startedAt: start } : {}),
    ...(server ? { server } : {}),
  };
}

/**
 * A session's identity across history pages (V4): its id when the result has one, else its
 * date, name and start time. Two sessions on one date with different names or start times stay
 * apart; the same session read twice (a repeated page) is one.
 */
export function sessionKey(s: SnapshotSession): string {
  // Not the server: two connections to one account return the same sessions, which must not count twice.
  return s.id ? `id:${s.id}` : `at:${s.date}|${s.name ?? ""}|${s.startedAt ?? ""}`;
}

/** True when a payload is a usable result for the tool (a read that passes its schema, or a write's object result). */
function validResult(tool: string, p: unknown): boolean {
  if (!isPlainObject(p)) return false;
  if (tool === "get_planned_workout") return validPlannedDay(p);
  if (tool === "get_training_context") return validTrainingContext(p);
  if (tool === "get_workout_history") return validHistory(p);
  return true;
}

export type MergeInput = {
  /** The tool suffix (get_planned_workout, plan_workout_day, …). */
  tool: string;
  input: unknown;
  response: unknown;
  session_id: string;
  now: Instant;
  /** The athlete's timezone (coach.yaml). */
  timezone: string;
  /**
   * The MCP server the tool belongs to (between mcp__ and the tool), recorded on the snapshot (V4).
   * V4b: the snapshot belongs to one server; a read from another server starts a new snapshot.
   */
  server?: string;
};

/**
 * Merges one logger response into the snapshot and returns the new snapshot. A snapshot
 * from another session is replaced. A response that is not a result (an error, a
 * skip, a conflict) changes nothing it cannot prove; a write whose result has no new
 * version removes the day, so the next write must read it again.
 */
export function mergeResponse(prev: Snapshot | null, m: MergeInput): Snapshot {
  // A snapshot from another session, or from another server (V4b: the last server read wins), is replaced.
  const sameServer = !prev?.server || !m.server || prev.server === m.server;
  // Only a valid result from another server replaces the snapshot; a failed read from it changes nothing.
  if (prev && prev.session_id === m.session_id && !sameServer && !validResult(m.tool, responsePayload(m.response))) return structuredClone(prev);
  const snap: Snapshot =
    prev && prev.session_id === m.session_id && sameServer ? structuredClone(prev) : emptySnapshot(m.session_id, m.now, m.timezone);
  snap.captured_at = m.now;
  snap.timezone = m.timezone;
  if (m.server) snap.server = m.server;
  const payload = responsePayload(m.response);
  const input = isPlainObject(m.input) ? m.input : {};
  // A Tally training limit refused the write: nothing was written, so every day the
  // call named stays as it was (Tally T3; the after-write week check sees no change).
  if (!m.tool.startsWith("get_") && tallyRefusal(m.response)) return snap;
  const refused = new Set(refusedDays(payload).map((d) => d.date).filter(isCalendarDate));
  // A written or uncertain date leaves the snapshot, so the next write must read it
  // again. It also joins the planned listing: the week check then knows the day exists
  // and requires that read before any write that raises the week's volume.
  const forget = (d: unknown) => {
    if (!isCalendarDate(d)) return;
    delete snap.days[d];
    if (snap.planned && !m.tool.startsWith("get_")) {
      snap.planned.dates[d] = { dayName: "", source: "mcp", userModified: false, skipped: false, exerciseCount: 0 };
    }
  };
  // an error or a malformed read is never evidence. It removes what it would
  // have refreshed: the day, the planned listing, or the history coverage.
  const invalidRead = () => {
    if (m.tool === "get_planned_workout") forget(input.date);
    if (m.tool === "get_training_context") delete snap.planned;
    if (m.tool === "get_workout_history") delete snap.history_coverage;
    return snap;
  };
  // Tally T2 replay: nothing new was written and the result has no content. Every date the
  // call or the stored outcome names leaves the snapshot, so the next write reads it again.
  if (!m.tool.startsWith("get_") && isPlainObject(payload) && payload.replayed === true) {
    for (const k of ["date", "fromDate", "toDate"]) forget(input[k]);
    if (Array.isArray(input.days)) for (const d of input.days) if (isPlainObject(d)) forget(d.date);
    for (const x of Array.isArray(payload.results) ? payload.results : []) if (isPlainObject(x)) for (const k of ["date", "toDate"]) forget(x[k]);
    return snap;
  }
  if (!isPlainObject(payload)) {
    if (m.tool.startsWith("get_")) return invalidRead();
    // No parsable result: a write may or may not have happened. Forget its dates.
    for (const k of ["date", "fromDate", "toDate"]) forget(input[k]);
    if (Array.isArray(input.days)) for (const d of input.days) if (isPlainObject(d)) forget(d.date);
    return snap;
  }
  const r = payload;
  if (m.tool === "get_planned_workout" && !validPlannedDay(r)) return invalidRead();
  if (m.tool === "get_training_context" && !validTrainingContext(r)) return invalidRead();
  if (m.tool === "get_workout_history" && !validHistory(r)) return invalidRead();
  switch (m.tool) {
    case "get_planned_workout": {
      const d = r.date as string;
      snap.days[d] = dayFromPlannedWorkout(r, m.now);
      const u = unitOf(r);
      if (u.weightUnit) Object.assign(snap, u);
      break;
    }
    case "get_training_context": {
      const u = unitOf(r);
      if (u.weightUnitSource) Object.assign(snap, u);
      if ("profile" in r) snap.profile = isPlainObject(r.profile) ? r.profile : null;
      if (Array.isArray(r.futurePlanned) && isCalendarDate(r.today)) {
        const dates: Record<string, PlannedListing> = {};
        for (const p of r.futurePlanned) {
          if (!isPlainObject(p) || !isCalendarDate(p.date)) continue;
          dates[p.date] = {
            dayName: String(p.dayName ?? ""),
            source: String(p.source ?? "builder"),
            userModified: p.userModified === true,
            skipped: p.skipped === true,
            exerciseCount: typeof p.exerciseCount === "number" ? p.exerciseCount : 0,
          };
        }
        snap.planned = { captured_at: m.now, from: r.today, dates };
      }
      break;
    }
    case "get_workout_history": {
      const sessions = (Array.isArray(r.sessions) ? r.sessions : [])
        .filter(isPlainObject)
        .map((x) => historySession(x, m.server))
        .filter((s): s is SnapshotSession => s !== null);
      // V4: merge by session identity, so a page never removes another page's session on the same date.
      const keys = new Set(sessions.map(sessionKey));
      const prev = snap.history_coverage;
      const str = (v: unknown) => (isCalendarDate(v) ? v : undefined);
      if (typeof input.cursor === "string") {
        // A later page continues an incomplete chain; alone, it covers nothing known.
        snap.history_coverage = prev && !prev.complete ? { ...prev, captured_at: m.now, complete: typeof r.nextCursor !== "string" } : { captured_at: m.now, complete: false };
      } else {
        snap.history_coverage = { captured_at: m.now, complete: typeof r.nextCursor !== "string", ...(str(input.since) ? { since: str(input.since) } : {}), ...(str(input.until) ? { until: str(input.until) } : {}) };
      }
      // V4b: a 0.2.1 snapshot's sessions have no id, start time or server; one on a page's date
      // is the same session read again under the old rule, so it goes (a new capture always has a server).
      const pageDates = new Set(sessions.map((x) => x.date));
      snap.history = snap.history.filter((x) => !(pageDates.has(x.date) && !x.id && !x.startedAt && !x.server));
      const seen = new Set<string>();
      const page = sessions.filter((s) => (seen.has(sessionKey(s)) ? false : (seen.add(sessionKey(s)), true)));
      snap.history = [...snap.history.filter((s) => !keys.has(sessionKey(s))), ...page].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      break;
    }
    case "update_planned_workout": {
      if (r.status === "updated" && isPlainObject(r.day) && validPlannedDay(r.day)) {
        const d = isCalendarDate(r.date) ? r.date : (input.date as string);
        snap.days[d] = dayFromPlannedWorkout(r.day, m.now);
      } else if (r.status === "not_found" && isCalendarDate(r.date)) {
        snap.days[r.date] = dayFromPlannedWorkout({ found: false }, m.now);
      } else forget(input.date);
      break;
    }
    case "move_planned_workout": {
      const from = input.fromDate;
      const to = input.toDate;
      if (r.status === "moved" && isCalendarDate(from) && isCalendarDate(to) && snap.days[from]?.found) {
        const moved = snap.days[from];
        snap.days[to] = { ...moved, skipped: false, version: typeof r.version === "string" ? r.version : null, updatedAt: null, captured_at: m.now };
        snap.days[from] = dayFromPlannedWorkout({ found: false }, m.now);
      } else {
        forget(from);
        forget(to);
      }
      break;
    }
    case "skip_planned_workout": {
      const d = isCalendarDate(r.date) ? r.date : input.date;
      const day = isCalendarDate(d) ? snap.days[d] : undefined;
      if ((r.status === "updated" || r.status === "unchanged") && day?.found && day.version) {
        // The version is base64url(id|updated_at): the id stays, updated_at is new.
        const v = decodeTallyVersion(day.version);
        const updatedAt = typeof r.updatedAt === "string" ? r.updatedAt : null;
        snap.days[d as string] = { ...day, skipped: r.skipped === true, updatedAt, version: v ? encodeTallyVersion(v.id, updatedAt) : null, captured_at: m.now };
      } else forget(d);
      break;
    }
    case "delete_planned_workout": {
      const d = isCalendarDate(r.date) ? r.date : input.date;
      if ((r.status === "deleted" || r.status === "not_found") && isCalendarDate(d)) snap.days[d] = dayFromPlannedWorkout({ found: false }, m.now);
      else forget(d);
      break;
    }
    case "plan_workout_day":
    case "plan_workout_range": {
      // The result has no version: forget every date the call named, so the next write reads again.
      // A day a training limit refused (a range without opId) stays as it was.
      if (!refused.has(input.date as string)) forget(input.date);
      if (Array.isArray(input.days)) for (const d of input.days) if (isPlainObject(d) && !refused.has(d.date as string)) forget(d.date);
      break;
    }
    case "update_training_limits":
      // Tally's limits are not part of the snapshot; no day changes.
      break;
    case "update_user_profile": {
      if (r.status === "updated" && "profile" in r) snap.profile = isPlainObject(r.profile) ? r.profile : null;
      break;
    }
    default:
      throw new CoachError("SNAPSHOT_MERGE", `not a logger tool: ${m.tool}`);
  }
  return snap;
}
