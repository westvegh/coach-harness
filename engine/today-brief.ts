// V7: `today-brief --stage pre|post` (contracts §22b): the today skill's data pass in one command.
// Each field calls the same code as its old command (window-check, mode, urgent status, signals,
// signals refresh, safety scan-notes, oplog done, limits check, readiness --date, loads, adjust);
// nothing is decided here. The model still decides; the engine computes and reports.
//
// - pre: the window (out of it: exit 4, nothing else), a new run, the facts the skill read from
//   files (coach.yaml, limits, the Preferences of athlete/brief.md, the log's proposals, check-in pain), the
//   wearable refresh (not under a known urgent stop), and the Tally reads to make in one message.
// - post (after the reads): coverage, the note scan (its side effect unchanged), the urgent stop,
//   today's day, already adjusted, limits on today, readiness with report facts, loads and adjust
//   when their prerequisites hold, and `need_reads`.
// - Field prerequisites: a field that cannot run is {status: "not_applicable", reason}; a field
//   that throws is {status: "failed", reason}. `urgent` and `coverage` are always returned.
// - Safety is never faster by skipping work: incomplete safety data is `unknown`, and then no
//   loads and no adjust are computed.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { convertWeight } from "../adapters/loggers/tally/day.ts";
import { loadConfig } from "./config.ts";
import { tallySnapshot } from "./coverage.ts";
import { addDays, diffDays, localDate, parseInstant, weekdayOf } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { ATOMIC_WINDOW_DAYS, atomicCoverage, HISTORY_RANGE_DAYS, type HistoryCoverage, type ReadArgs } from "./history-windows.ts";
import { mode as runMode } from "./mode.ts";
import { DEFAULT_THRESHOLDS } from "./readiness.ts";
import { SNAPSHOT_MAX_AGE_MIN } from "./snapshot.ts";
import { diagnosticsRelative, localTime, readRun, stageRelative, startRun, writeJsonAtomic, type PostLog, type RunInfo } from "./today-run.ts";
import type { CalendarDate, CoachConfig, Instant, Limit, Snapshot, SnapshotDay, SnapshotSession, Units } from "./types.ts";

export const SAFETY_NOTE_DAYS = 3;
/** The coach's own load looks back this far (CLAUDE.md rule 3). */
export const OWN_LOAD_DAYS = 28;
export const DEFAULT_TOOL_PREFIX = "mcp__claude_ai_Tally_Workout__";
/** Every Tally tool the today skill may call: the reads and the writes (one ToolSearch). */
export const TODAY_TALLY_TOOLS = ["get_planned_workout", "get_training_context", "get_workout_history", "update_planned_workout", "plan_workout_day", "search_exercises"];

type Failed = { status: "failed"; reason: string };
type NotApplicable = { status: "not_applicable"; reason: string };
const na = (reason: string): NotApplicable => ({ status: "not_applicable", reason });
const failed = (e: unknown): Failed => ({ status: "failed", reason: e instanceof CoachError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e) });
async function field<T>(fn: () => T | Promise<T>): Promise<T | Failed> {
  try {
    return await fn();
  } catch (e) {
    return failed(e);
  }
}
const isFailed = (x: unknown): x is Failed | NotApplicable => typeof x === "object" && x !== null && "status" in x && ((x as Failed).status === "failed" || (x as NotApplicable).status === "not_applicable");

export type Read = { tool: string; args: Record<string, unknown> };
const dayRead = (date: CalendarDate): Read => ({ tool: "get_planned_workout", args: { date } });
const historyRead = (r: ReadArgs): Read => ({ tool: "get_workout_history", args: { ...r } });

export type BriefOptions = { root: string; now?: Instant; session_id?: string | null };

function sessionOf(o: BriefOptions): string | null {
  return o.session_id !== undefined ? o.session_id : process.env.CLAUDE_CODE_SESSION_ID || null;
}

function config(root: string): CoachConfig {
  const p = join(root, "coach.yaml");
  if (!existsSync(p)) throw new CoachError("MISSING_FILE", "coach.yaml is missing: run the setup skill first");
  return loadConfig(p);
}

// ---------- facts from the athlete's files ----------

/** The lines under the "Preferences" heading of athlete/brief.md. */
export function preferencesOf(root: string): string[] {
  const p = join(root, "athlete/brief.md");
  if (!existsSync(p)) return [];
  const out: string[] = [];
  let inside = false;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      inside = /^#{1,6}\s*Preferences\b/i.test(line);
      continue;
    }
    if (inside && line.trim() !== "" && !/^<!--/.test(line.trim())) out.push(line.trim());
  }
  return out;
}

/** The text of the month log files, oldest first. */
function logTexts(root: string): string[] {
  const dir = join(root, "athlete/log");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}\.md$/.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"));
}

/**
 * Open proposals: each "- proposal for the next live session: X" in the last 10 log entries with no
 * "- proposal handled: <yes|no>: X" line AFTER that occurrence (V7b finding 9: a proposal made
 * again after an earlier one was handled is open again).
 */
export function openProposals(root: string): { text: string; entry: string }[] {
  const all = logTexts(root).join("\n");
  const starts = [...all.matchAll(/^## /gm)].map((m) => m.index!);
  const last = starts.slice(-10);
  const handled = [...all.matchAll(/^- proposal handled: (?:yes|no): (.+)$/gm)].map((m) => ({ at: m.index!, text: m[1].trim() }));
  const out: { text: string; entry: string }[] = [];
  last.forEach((from, k) => {
    const to = k + 1 < last.length ? last[k + 1] : all.length;
    const block = all.slice(from, to);
    const heading = block.split("\n")[0].slice(3).trim();
    for (const m of block.matchAll(/^- proposal for the next live session: (.+)$/gm)) {
      const text = m[1].trim();
      const at = from + m.index!;
      if (handled.some((h) => h.text === text && h.at > at)) continue;
      const prev = out.findIndex((x) => x.text === text);
      if (prev >= 0) out.splice(prev, 1);
      out.push({ text, entry: heading });
    }
  });
  return out;
}

/** One line per limit, with its full meaning (the session-context summary, extended). */
export function describeLimit(l: Limit): string {
  const parts = [`${l.id} ${l.region}: ${l.rule}`];
  if (l.patterns.length) parts.push(`patterns ${l.patterns.join(", ")}`);
  if (l.exercises.length) parts.push(`exercises ${l.exercises.join(", ")}`);
  if (l.allow.length) parts.push(`allowed ${l.allow.join(", ")}`);
  if (typeof l.max_sets_per_week === "number") parts.push(`at most ${l.max_sets_per_week} sets a week`);
  if (l.max_load) parts.push(`at most ${l.max_load.value} ${l.max_load.unit}`);
  if (l.build_back) parts.push("build back");
  return parts.join("; ");
}

// ---------- pre ----------

export type PreResult = { exit: number; compact: Record<string, unknown>; full?: Record<string, unknown>; run?: RunInfo };

export async function briefPre(o: BriefOptions): Promise<PreResult> {
  const root = o.root;
  const now = o.now ?? new Date().toISOString();
  const cfg = config(root);
  const tz = cfg.athlete.timezone;
  const { windowCheckFor } = await import("./cli-helpers.ts");
  const w = await windowCheckFor(["--kind", "daily", "--root", root, "--now", now]);
  const window = { inside: w.result.inside, enforced: w.result.enforced, reason: w.result.reason };
  if (w.exit !== 0) return { exit: w.exit, compact: { window } };
  const session_id = sessionOf(o);
  const run = startRun(root, { now, timezone: tz, session_id });
  const today = run.local_date;
  const mode = runMode();
  const [{ readStop, readClearances }, { loadAdapterConfig }, { loadClusters }] = await Promise.all([import("./urgent.ts"), import("./logger.ts"), import("./clusters.ts")]);
  const stop = readStop(root);
  const urgent = { stopped: stop !== null, stop, clearances: readClearances(root).slice(-3) };

  const limits = await field(async () => {
    const p = join(root, "athlete/limits.yaml");
    const l = existsSync(p) ? (await import("./limits.ts")).loadLimits(p) : { version: 1 as const, pain_threshold: 4, limits: [] };
    return { pain_threshold: l.pain_threshold, limits: l.limits, text: l.limits.map(describeLimit) };
  });
  const threshold = isFailed(limits) ? 4 : limits.pain_threshold;
  const checkin_pain = await field(async () => {
    const { loadSignals } = await import("./signals.ts");
    const sig = loadSignals({ root, from: today, to: today, now });
    const log = logTexts(root).join("\n").split("\n");
    return sig.records.flatMap((r) =>
      (r.subjective?.pain ?? [])
        .filter((p) => p.score >= threshold)
        .map((p) => {
          const at = r.checkin_at ?? r.observed_at;
          return { region: p.region, score: p.score, checkin_at: at, source: r.source, handled: log.includes(`- pain handled: ${p.region} ${at}`) };
        }),
    );
  });
  const signals_refresh = urgent.stopped
    ? na("the urgent stop is set: no wearable fetch")
    : await field(async () => {
        const r = await (await import("./signals-refresh.ts")).refreshSignals(root, cfg);
        return { refreshed: r.refreshed, note: r.note, ...(r.error ? { error: r.error } : {}) };
      });

  let reads: Read[] = [];
  let tools: Record<string, unknown> | null = null;
  if (cfg.logger === "tally") {
    // The prefix: coach.yaml's, else the server of the last Tally read in the snapshot, else the claude.ai connector's.
    let server: string | undefined;
    try {
      server = (await import("./snapshot.ts")).loadSnapshot(root)?.server;
    } catch {
      server = undefined;
    }
    const prefix = cfg.automation.tool_prefix ?? (server ? `mcp__${server}__` : DEFAULT_TOOL_PREFIX);
    tools = { prefix, toolsearch: `select:${TODAY_TALLY_TOOLS.map((t) => prefix + t).join(",")}` };
    reads = planReads(root, cfg, today, now, session_id);
  }
  const caps = await field(() => ({ opId: loadAdapterConfig("tally").capabilities.opId }));
  const compact: Record<string, unknown> = {
    run_id: run.run_id,
    window,
    mode,
    local: { date: today, time: localTime(now, tz), weekday: weekdayOf(today), timezone: tz, now },
    logger: cfg.logger,
    capabilities: caps,
    wearable: cfg.signals.wearable,
    logger_health_notes: cfg.consent.logger_health_notes,
    units: cfg.athlete.units,
    clusters: await field(() => loadClusters(root)),
    urgent,
    limits,
    preferences: preferencesOf(root),
    checkin_pain,
    proposals: await field(() => openProposals(root)),
    signals_refresh,
    reads,
    ...(tools ? { tools } : {}),
  };
  const identity = { run_id: run.run_id, session_id, local_date: today, computed_at: now, stage: "pre" as const };
  writeJsonAtomic(root, stageRelative(run.run_id, "pre"), { ...identity, ...compact });
  writeJsonAtomic(root, diagnosticsRelative("pre"), { ...identity, ...compact });
  return { exit: 0, compact, run };
}

/** The Tally reads for today: today's day, the context, each past date readiness may judge, and the history windows. Fresh reads of this session are skipped. */
export function planReads(root: string, cfg: CoachConfig, today: CalendarDate, now: Instant, session_id: string | null): Read[] {
  const expiry = cfg.thresholds?.perf_expiry_days ?? DEFAULT_THRESHOLDS.perf_expiry_days;
  let snap: Snapshot | null = null;
  try {
    snap = tallySnapshot(root, session_id);
  } catch {
    snap = null;
  }
  const nowMs = parseInstant(now, "now");
  const mine = snap && session_id && snap.session_id === session_id ? snap : null;
  const fresh = (d: SnapshotDay | undefined) => !!d && (nowMs - parseInstant(d.captured_at, "captured_at")) / 60_000 <= SNAPSHOT_MAX_AGE_MIN;
  const reads: Read[] = [];
  const dates = [today, ...Array.from({ length: expiry }, (_, i) => addDays(today, -(i + 1)))];
  for (const [i, d] of dates.entries()) {
    if (!fresh(mine?.days[d])) reads.push(dayRead(d));
    if (i === 0) reads.push({ tool: "get_training_context", args: { historyWeeks: 2 } });
  }
  // V7c: atomic windows (one request, one response; a window with a nextCursor is split, never continued).
  const cov = atomicCoverage(mine, addDays(today, -HISTORY_RANGE_DAYS), today, nowMs, { session_id });
  const windows = cov.status === "complete" ? [] : cov.need;
  for (const r of windows) reads.push(historyRead(r));
  return reads;
}

// ---------- post ----------

/** The other logger's evidence (post --input): that tool's notes history and today's day. */
export type OtherEvidence = {
  history?: { date: CalendarDate; notes?: string; exercises?: { name: string; notes?: string; sets?: unknown[] }[] }[];
  history_complete?: boolean;
  today?: { read: "ok" | "failed"; found?: boolean; protected?: boolean; day?: Record<string, unknown> };
};

export function parseEvidence(raw: unknown): OtherEvidence {
  const shape = 'expected {"history": [{"date": "YYYY-MM-DD", "notes": "...", "exercises": [{"name": "...", "notes": "..."}]}], "history_complete": true, "today": {"read": "ok", "found": true, "day": {"dayName": "...", "notes": "...", "exercises": [...]}}}';
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CoachError("INPUT_ERROR", `today-brief --input: ${shape}`);
  const e = raw as OtherEvidence;
  if (e.history !== undefined && !Array.isArray(e.history)) throw new CoachError("INPUT_ERROR", `today-brief --input: history must be a list; ${shape}`);
  return e;
}

type DayStatus =
  | { status: "found"; date: CalendarDate; version: string | null; updatedAt: string | null; protected: boolean; source: string; userModified: boolean; skipped: boolean; dayName?: string; notes?: string; exercises: { name: string; sets?: unknown; reps?: unknown; weight?: unknown }[]; weightUnit?: Units }
  | { status: "none"; date: CalendarDate; logged_only?: boolean }
  | { status: "missing" | "failed" | "stale"; date: CalendarDate; reason: string; read?: Read };

function dayStatus(snap: Snapshot | null, date: CalendarDate, nowMs: number, logger: string, session_id: string | null): DayStatus {
  const foreign = logger === "tally" && snap && session_id && snap.session_id !== session_id;
  const d = foreign ? undefined : snap?.days[date];
  if (d) {
    const age = (nowMs - parseInstant(d.captured_at, "captured_at")) / 60_000;
    if (logger === "tally" && age > SNAPSHOT_MAX_AGE_MIN) return { status: "stale", date, reason: `read ${Math.round(age)} minutes ago (limit ${SNAPSHOT_MAX_AGE_MIN})`, read: dayRead(date) };
    if (!d.found) return { status: "none", date, ...(logger === "files" ? { logged_only: true } : {}) };
    return {
      status: "found",
      date,
      version: d.version,
      updatedAt: d.updatedAt,
      // A files day is never protected by source (contracts §12a).
      protected: logger === "tally" ? d.source !== "mcp" || d.userModified : false,
      source: d.source,
      userModified: d.userModified,
      skipped: d.skipped,
      ...(d.dayName ? { dayName: d.dayName } : {}),
      ...(d.notes ? { notes: d.notes } : {}),
      exercises: d.exercises.map((e) => ({ name: String(e.name ?? ""), sets: e.suggestedSets, reps: e.suggestedReps ?? e.repsMax, weight: e.suggestedWeight })),
      ...(d.weightUnit ? { weightUnit: d.weightUnit } : {}),
    };
  }
  if (logger === "files") return { status: "none", date };
  const f = foreign ? undefined : snap?.failed_days?.[date];
  if (f) return { status: "failed", date, reason: f.reason, read: dayRead(date) };
  return { status: "missing", date, reason: foreign ? "the snapshot is from another session" : "not read in this session", read: dayRead(date) };
}

/** Plain facts for the report, from the readiness reasons (no new numbers). */
function reportFacts(r: Record<string, any>, cfg: CoachConfig) {
  const w: string[] = r.wearable?.reasons ?? [];
  const pick = (re: RegExp) => w.find((x) => re.test(x)) ?? null;
  const unknowns = (["wearable", "subjective", "performance"] as const).filter((k) => r[k]?.state === "unknown").map((k) => ({ category: k, reason: (r[k].reasons as string[]).join("; ") }));
  return {
    wearable_source: cfg.signals.wearable,
    sleep: pick(/^sleep /),
    sleep_target_min: cfg.athlete.sleep_target_min ?? 480,
    hrv: pick(/^HRV/),
    rhr: pick(/^RHR/),
    calibrating: r.wearable?.calibrating === true,
    sessions: r.performance?.reasons ?? [],
    days_of_decline: r.pattern?.days_of_decline ?? 0,
    unknowns,
  };
}

function readinessLine(r: Record<string, any>): string {
  const c = (k: string) => `${k} ${r[k].state} (${(r[k].reasons as string[]).join("; ") || "no reason"})`;
  return `${c("wearable")}, ${c("subjective")}, ${c("performance")} → ${r.decision}`;
}

/** The coach's own load bounds (CLAUDE.md rule 3) for each exercise of today's day with a load. */
function ownLoadBounds(o: {
  day: { exercises: Record<string, unknown>[] };
  unit: Units;
  history: SnapshotSession[];
  today: CalendarDate;
  suggestions: { exerciseId: string; suggestedWeight?: number }[];
  limits: Limit[];
  tax: import("./types.ts").Taxonomy;
  deload: boolean;
  limitMatch: typeof import("./limits-check.ts").limitMatch;
  normalizeName: (s: string) => string;
}) {
  const out: Record<string, unknown>[] = [];
  o.day.exercises.forEach((e, i) => {
    const name = String(e.name ?? "");
    const id = typeof e.exerciseId === "string" && e.exerciseId !== "" ? e.exerciseId : null;
    const planned = typeof e.suggestedWeight === "number" ? e.suggestedWeight : null;
    const engine = o.suggestions[i]?.suggestedWeight ?? null;
    if (planned === null && engine === null) return;
    const same = (h: { exerciseId?: string; name?: string }) => (id && h.exerciseId ? h.exerciseId === id : o.normalizeName(h.name ?? "") === o.normalizeName(name));
    const since = addDays(o.today, -OWN_LOAD_DAYS);
    const logged: number[] = [];
    let lastTop: number | null = null;
    let lastDate = "";
    for (const s of o.history) {
      if (s.date < since || s.date > o.today) continue;
      for (const h of s.exercises.filter(same)) {
        const ws = h.sets.filter((x) => x.warmup !== true && typeof x.weight === "number" && x.weight > 0).map((x) => (s.weightUnit && s.weightUnit !== o.unit ? convertWeight(x.weight as number, s.weightUnit, o.unit) : (x.weight as number)));
        // A session without a unit: its weights cannot be compared, so it gives no bound.
        if (ws.length === 0 || (!s.weightUnit && o.unit)) continue;
        logged.push(...ws);
        if (s.date >= lastDate) {
          lastDate = s.date;
          lastTop = Math.max(...ws);
        }
      }
    }
    let cap = Math.max(engine ?? planned ?? 0, lastTop ?? 0);
    const why: string[] = [`the higher of the engine's ${engine ?? "none"} and the last top set ${lastTop ?? "none"}`];
    const entry = { name, exerciseId: id, sets: [] };
    for (const l of o.limits) {
      if (!l.max_load || !o.limitMatch(l, entry, o.tax).matches) continue;
      const max = l.max_load.unit === o.unit ? l.max_load.value : convertWeight(l.max_load.value, l.max_load.unit, o.unit);
      if (max < cap) {
        cap = max;
        why.push(`${l.id} max_load ${l.max_load.value} ${l.max_load.unit}`);
      }
    }
    if (o.deload && planned !== null && planned < cap) {
      cap = planned;
      why.push("a deload week: no raise");
    }
    const choices = [...new Set([...logged, ...(planned !== null ? [planned] : [])])].filter((w) => w <= cap + 1e-9).sort((a, b) => a - b);
    out.push({ name, planned, engine, last_top_set: lastTop, cap, cap_reason: why.join("; "), choices, unit: o.unit });
  });
  return out;
}

export type PostResult = { compact: Record<string, unknown>; full: Record<string, unknown> };

export async function briefPost(o: BriefOptions & { evidence?: OtherEvidence }): Promise<PostResult> {
  const root = o.root;
  const now = o.now ?? new Date().toISOString();
  const nowMs = parseInstant(now, "now");
  const cfg = config(root);
  const tz = cfg.athlete.timezone;
  const today = localDate(now, tz);
  const run = readRun(root);
  if (!run) throw new CoachError("RUN_MISSING", "no today run: run node engine/cli.ts today-brief --stage pre first");
  if (run.local_date !== today) throw new CoachError("RUN_STALE", `the run ${run.run_id} is for ${run.local_date}, not today (${today}): run today-brief --stage pre again`);
  const session_id = sessionOf(o);
  const logger = cfg.logger;
  const ev = o.evidence;
  const sid = session_id ?? "";
  const expiry = cfg.thresholds?.perf_expiry_days ?? DEFAULT_THRESHOLDS.perf_expiry_days;

  // ---- the snapshot the engine tools read ----
  let snap: Snapshot | null = null;
  let snapError: string | null = null;
  try {
    if (logger === "tally") snap = tallySnapshot(root, session_id);
    else if (logger === "files") snap = (await import("./coach-snapshot.ts")).coachSnapshot(root, { now, cfg });
  } catch (e) {
    snapError = failed(e).reason;
  }

  // ---- coverage (always) ----
  const range = { since: addDays(today, -HISTORY_RANGE_DAYS), until: today };
  let history: HistoryCoverage;
  if (snapError) history = { status: "failed", ...range, reason: snapError, gaps: [range], need: [] };
  else if (logger === "other") {
    history = ev?.history
      ? ev.history_complete === true
        ? { status: "complete", ...range, gaps: [], need: [] }
        : { status: "missing", ...range, reason: "the evidence does not say its history is complete", gaps: [range], need: [] }
      : { status: "missing", ...range, reason: "logger other: pass that tool's notes history and today's day with --input", gaps: [range], need: [] };
  } else if (logger === "files") history = (await import("./coverage.ts")).loggerHistoryCoverage(root, cfg, range.since, range.until, now, session_id);
  else history = atomicCoverage(snap, range.since, range.until, nowMs, { session_id, windowDays: ATOMIC_WINDOW_DAYS });

  // ---- the note scan (its side effect unchanged: an urgent term writes, commits and pushes the stop) ----
  const { scanNotesResult } = await import("./cli-core.ts");
  const since = addDays(today, -SAFETY_NOTE_DAYS);
  const notesCov = logger === "other" ? (ev?.history && ev.history_complete === true ? { status: "complete" } : { status: "missing", reason: history.reason }) : undefined;
  const safety_notes = await field(() =>
    scanNotesResult({ root, since, now, session_id, ...(logger === "other" ? { history: ev?.history ?? [], coverage: notesCov } : {}) }),
  );
  const { readStop } = await import("./urgent.ts");
  const stop = readStop(root);
  const scanUnknown = isFailed(safety_notes) ? true : safety_notes.urgent_unknown === true;
  const urgent = { stopped: stop !== null, stop, unknown: stop === null && scanUnknown };

  // ---- today's day ----
  let today_day: DayStatus;
  if (logger === "other") {
    const t = ev?.today;
    today_day = !t
      ? { status: "missing", date: today, reason: "logger other: no evidence of today's day (--input)" }
      : t.read !== "ok"
        ? { status: "failed", date: today, reason: "the read of that tool failed" }
        : t.found === false
          ? { status: "none", date: today }
          : { status: "found", date: today, version: null, updatedAt: null, protected: t.protected === true, source: "other", userModified: false, skipped: false, exercises: Array.isArray(t.day?.exercises) ? (t.day!.exercises as { name: string }[]).map((e) => ({ name: String(e.name ?? "") })) : [], ...(typeof t.day?.notes === "string" ? { notes: t.day.notes as string } : {}), ...(typeof t.day?.dayName === "string" ? { dayName: t.day.dayName as string } : {}) };
  } else today_day = dayStatus(snapError ? null : snap, today, nowMs, logger, session_id);
  // V7b finding 6: the compact day is for the report; the write base is the whole day as read
  // (every Tally field kept), for a change `today-write-prep` cannot express as an edit.
  if (today_day.status === "found" && snap?.days[today]) {
    const sd = snap.days[today];
    const { tallyDayUnit } = await import("./tally-shape.ts");
    const rel = `.tmp/coach/today-${run.run_id}-day.json`;
    writeJsonAtomic(root, rel, { date: today, ...(sd.dayType ? { dayType: sd.dayType } : {}), ...(sd.dayName ? { dayName: sd.dayName } : {}), ...(sd.notes !== undefined ? { notes: sd.notes } : {}), exercises: sd.exercises, weightUnit: tallyDayUnit(sd, cfg.athlete.units) });
    (today_day as Record<string, unknown>).write_base = rel;
  }

  // Days readiness judges: each date in the expiry window with a logged session.
  const judged = [...new Set((snap?.history ?? []).filter((s) => s.date < today && diffDays(s.date, today) <= expiry && s.exercises.length > 0).map((s) => s.date))].sort().reverse();
  const days: Record<string, string> = { [today]: today_day.status === "found" || today_day.status === "none" ? "complete" : today_day.status };
  if (logger === "tally") for (const d of judged) days[d] = (() => { const s = dayStatus(snap, d, nowMs, logger, session_id).status; return s === "found" || s === "none" ? "complete" : s; })();
  const coverage = {
    history: { status: history.status, ...(history.reason ? { reason: history.reason } : {}), ...(history.gaps.length ? { gaps: history.gaps } : {}), ...("split" in history && (history as { split: unknown[] }).split.length ? { split: (history as { split: unknown[] }).split } : {}) },
    safety_notes: isFailed(safety_notes) ? "failed" : safety_notes.coverage,
    days,
  };

  // ---- need_reads (tally): pagination always; a failed, stale or missing read once ----
  const need_reads: Read[] = [];
  const gave_up: Read[] = [];
  if (logger === "tally") {
    const candidates: { read: Read; continuation: boolean; stale: boolean }[] = [
      ...history.need.map((r) => ({ read: historyRead(r), continuation: r.cursor !== undefined, stale: history.status === "stale" })),
      ...Object.entries(days)
        .filter(([, s]) => s !== "complete")
        .map(([d, s]) => ({ read: dayRead(d), continuation: false, stale: s === "stale" })),
    ];
    const asked = { ...(run.asked ?? {}) };
    for (const c of candidates) {
      const key = JSON.stringify(c.read);
      const prev = asked[key];
      const again = !prev || (c.stale && (nowMs - parseInstant(prev.at, "asked.at")) / 60_000 > SNAPSHOT_MAX_AGE_MIN);
      if (c.continuation || again) {
        need_reads.push(c.read);
        if (!c.continuation) asked[key] = { at: now, n: (prev?.n ?? 0) + 1 };
      } else gave_up.push(c.read);
    }
    writeJsonAtomic(root, ".tmp/coach/today-run.json", { ...run, asked });
  }

  // ---- already adjusted ----
  const already_adjusted = await field(async () => {
    if (logger === "tally") {
      const { opDone } = await import("./oplog.ts");
      const kinds = ["trim_session", "swap_to_recovery", "load_progression", "annotate"].map((k) => opDone(root, today, k));
      return {
        done: kinds.some((k) => k.status === "done"),
        kinds: Object.fromEntries(kinds.map((k) => [k.kind, k.status])),
        done_changes: kinds.filter((k) => k.status === "done").map((k) => ({ kind: k.kind, entries: k.entries.map((e) => e.heading) })),
        uncertain: kinds.filter((k) => k.status === "uncertain").map((k) => ({ kind: k.kind, reread: k.reread, reason: k.reason, entries: k.entries.map((e) => e.heading) })),
      };
    }
    // files (and other): a [coach] line in today's notes means today's run already changed the day.
    if (today_day.status !== "found") return na(`today's day is ${today_day.status}`);
    const line = (today_day.notes ?? "").split(/\n| \| /).find((l) => l.includes("[coach]"));
    return { done: line !== undefined, kinds: {}, done_changes: line ? [{ kind: "coach note", entries: [line.trim()] }] : [], uncertain: [] };
  });

  // ---- limits on today's day ----
  const limits_check = await field(async () => {
    if (today_day.status !== "found") return na(`today's day is ${today_day.status}`);
    if (logger === "other") return na("logger other: check the day from that tool with limits check --input");
    const [{ snapshotDayToPlan }, { checkLimits }, { loadLimits }, { loadTaxonomy }, { loadClusters }] = await Promise.all([import("./tally-shape.ts"), import("./limits-check.ts"), import("./limits.ts"), import("./taxonomy.ts"), import("./clusters.ts")]);
    const tax = loadTaxonomy({ root });
    const p = join(root, "athlete/limits.yaml");
    const lim = existsSync(p) ? loadLimits(p, tax) : { version: 1 as const, pain_threshold: 4, limits: [] };
    const findings = checkLimits([snapshotDayToPlan(today, snap!.days[today], cfg.athlete.units)], lim, tax, loadClusters(root));
    return { ok: findings.every((f) => f.kind === "unclassified"), findings };
  });

  // ---- readiness ----
  const readinessFull = await field(async () => (await import("./cli-helpers2.ts")).readinessDateResult(root, today, now));
  const r = readinessFull as Record<string, any>;
  const readiness = isFailed(readinessFull)
    ? readinessFull
    : {
        decision: r.decision,
        hold_progression: r.hold_progression,
        aversion: r.aversion,
        deload_signal: r.deload_signal,
        states: { wearable: r.wearable.state, subjective: r.subjective.state, performance: r.performance.state },
        decision_reasons: r.decision_reasons,
        pattern: { days_of_decline: r.pattern.days_of_decline, short: r.pattern.short, long: r.pattern.long },
        rule_ids: r.rule_ids,
        pain: r.pain,
        report_facts: reportFacts(r, cfg),
      };

  // ---- loads and adjust: only when today is known, safety is known and the stop is not set ----
  const blocked =
    urgent.stopped ? "the urgent stop is set"
    : urgent.unknown ? "the note scan is incomplete: safety is unknown"
    : today_day.status === "none" ? "a rest day"
    : today_day.status !== "found" ? `today's day is ${today_day.status}`
    : isFailed(readinessFull) ? "readiness failed"
    : logger === "other" ? "logger other: the engine cannot read that tool's day"
    : null;
  const sessionArgs = ["--root", root, "--now", now, ...(session_id ? ["--session", sid] : [])];
  const loads = blocked
    ? na(blocked)
    : r.hold_progression
      ? na(`hold_progression: the decision is ${r.decision}`)
      : history.status !== "complete"
        ? na(`the history is ${history.status}: ${history.reason ?? ""}`.trim())
        : await field(async () => {
            const [{ loadsFor }, { limitMatch }, { normalizeName, loadTaxonomy }, { loadLimits }, { readBlock }] = await Promise.all([import("./cli-helpers.ts"), import("./limits-check.ts"), import("./taxonomy.ts"), import("./limits.ts"), import("./block.ts")]);
            const res = await loadsFor(["--from-snapshot", today, ...sessionArgs]);
            const tax = loadTaxonomy({ root });
            const p = join(root, "athlete/limits.yaml");
            const block = readBlock(root);
            const week = block?.start ? Math.floor(diffDays(block.start, today) / 7) + 1 : null;
            const deload = !!block && week !== null && block.weeks.find((w) => w.week === week)?.kind === "deload";
            const sd = snap!.days[today];
            return {
              ...res,
              deload_week: deload,
              own_load_bounds: ownLoadBounds({
                day: sd,
                unit: (res.units as Units) ?? cfg.athlete.units,
                history: snap!.history,
                today,
                suggestions: res.suggestions as { exerciseId: string; suggestedWeight?: number }[],
                limits: existsSync(p) ? loadLimits(p, tax).limits : [],
                tax,
                deload,
                limitMatch,
                normalizeName,
              }),
            };
          });
  const adjust = blocked
    ? na(blocked)
    : !["trim", "recovery", "propose_deload"].includes(r.decision)
      ? na(`the decision is ${r.decision}`)
      : await field(async () => {
          const { adjustFor } = await import("./cli-helpers.ts");
          const res = await adjustFor(["--from-snapshot", today, "--decision", r.decision === "recovery" ? "recovery" : "trim", ...sessionArgs]);
          return { decision: r.decision, tally_day: res.tally_day, changes: res.changes, warnings: res.warnings };
        });

  const log: PostLog | undefined = isFailed(readinessFull) ? undefined : { readiness_line: readinessLine(r), rule_ids: r.rule_ids, decision: r.decision };
  const compact: Record<string, unknown> = {
    run_id: run.run_id,
    logger,
    coverage,
    urgent,
    safety_notes: isFailed(safety_notes) ? safety_notes : { matches: safety_notes.matches, urgent_terms: safety_notes.urgent_terms, urgent_stop: safety_notes.urgent_stop !== null, coverage: safety_notes.coverage, sessions: safety_notes.sessions, server: safety_notes.server },
    today_day,
    already_adjusted,
    limits_check,
    readiness,
    loads,
    adjust,
    need_reads,
    ...(gave_up.length ? { gave_up } : {}),
  };
  const identity = { run_id: run.run_id, session_id, local_date: today, computed_at: now, stage: "post" as const };
  const full = { ...identity, ...compact, readiness: readinessFull, safety_notes, history_coverage: history };
  writeJsonAtomic(root, stageRelative(run.run_id, "post"), { ...identity, ...compact, ...(log ? { log } : {}) });
  writeJsonAtomic(root, diagnosticsRelative("post"), full);
  return { compact, full };
}

export type { RunInfo };
