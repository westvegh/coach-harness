// V7: one `today` run's identity and files (contracts §22b). `today-brief --stage pre` starts a
// run and writes .tmp/coach/today-run.json; each stage writes its output to
// .tmp/coach/today-<run_id>-<stage>.json; `save --run <run_id>` reads the post output back and
// refuses one that is not this run's, not this session's, not today's, old, or older than a
// later check-in or safety change.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { localDate, parseInstant } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { limitsFingerprint } from "./limits-text.ts";
import type { CalendarDate, Instant } from "./types.ts";

export const RUN_RELATIVE = ".tmp/coach/today-run.json";
/** A post result older than this cannot back a save (the same 15 minutes as the snapshot). */
export const POST_MAX_AGE_MIN = 15;

export type RunInfo = {
  run_id: string;
  session_id: string | null;
  local_date: CalendarDate;
  started_at: Instant;
  /** The reads post asked for again (a failed, stale or missing read is asked once; pagination is not counted). */
  asked?: Record<string, { at: Instant; n: number }>;
};

/** The run's identity in every stage file. */
export type StageIdentity = { run_id: string; session_id: string | null; local_date: CalendarDate; computed_at: Instant; stage: "pre" | "post" };

/** What `save --no-change` needs from post: the readiness line, the rules and the decision. */
export type PostLog = { readiness_line: string; rule_ids: string[]; decision: string | null };

export const stageRelative = (run_id: string, stage: "pre" | "post") => `.tmp/coach/today-${run_id}-${stage}.json`;
export const diagnosticsRelative = (stage: "pre" | "post") => `.tmp/coach/today-brief-${stage}.json`;

const RUN_ID = /^r-\d{8}-\d{4}-[0-9a-f]{4}$/;
export const isRunId = (s: unknown): s is string => typeof s === "string" && RUN_ID.test(s);

export function localTime(now: Instant, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(parseInstant(now, "now")));
}

export function writeJsonAtomic(root: string, rel: string, value: unknown): string {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, p);
  return p;
}

function readJson(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new CoachError("INPUT_ERROR", `cannot read ${p}: ${(e as Error).message}`);
  }
}

/** A new run: `r-<YYYYMMDD>-<HHMM>-<4 hex>`, in the athlete's timezone. */
export function startRun(root: string, o: { now: Instant; timezone: string; session_id: string | null }): RunInfo {
  const date = localDate(o.now, o.timezone);
  const run: RunInfo = { run_id: `r-${date.replace(/-/g, "")}-${localTime(o.now, o.timezone).replace(":", "")}-${randomBytes(2).toString("hex")}`, session_id: o.session_id, local_date: date, started_at: o.now };
  writeJsonAtomic(root, RUN_RELATIVE, run);
  return run;
}

/** The current run, or null when there is none (pre has not run). */
export function readRun(root: string): RunInfo | null {
  const p = join(root, RUN_RELATIVE);
  if (!existsSync(p)) return null;
  const r = readJson(p) as RunInfo;
  return r && isRunId(r.run_id) ? r : null;
}

const mtime = (p: string): number | null => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * The files whose change after post means post must run again: today's signal file (a check-in),
 * the limits text, coach.yaml (the pain threshold), the urgent stop and the clearances (a safety change).
 */
export function changedSince(root: string, date: CalendarDate, computedMs: number): string[] {
  const files = [`athlete/signals/${date}.json`, "athlete/limits.md", "coach.yaml", "athlete/.urgent-stop", "athlete/log/urgent-clearances.jsonl"];
  return files.filter((f) => {
    const m = mtime(join(root, f));
    return m !== null && m > computedMs + 1;
  });
}

export type PostRecord = StageIdentity & { log?: PostLog; urgent?: { stopped?: boolean } } & Record<string, unknown>;

/**
 * The post output of `run_id`, checked for a save: the file exists, is this run's and this
 * session's (when the session is known), is today's, is at most 15 minutes old, and no check-in
 * or safety file changed after it. Otherwise POST_STALE with the fix.
 */
export function postForSave(root: string, run_id: string, o: { now: Instant; timezone: string; session_id: string | null }): PostRecord {
  const fix = "run node engine/cli.ts today-brief --stage post again";
  const p = join(root, stageRelative(run_id, "post"));
  if (!existsSync(p)) throw new CoachError("POST_STALE", `no post result for run ${run_id}: ${fix}`);
  const post = readJson(p) as PostRecord;
  if (post.run_id !== run_id) throw new CoachError("POST_STALE", `the post result is from run ${post.run_id}, not ${run_id}: ${fix}`);
  if (o.session_id && post.session_id && post.session_id !== o.session_id) throw new CoachError("POST_STALE", `the post result is from another session: ${fix}`);
  const today = localDate(o.now, o.timezone);
  if (post.local_date !== today) throw new CoachError("POST_STALE", `the post result is for ${post.local_date}, not today (${today}): ${fix}`);
  const computed = parseInstant(post.computed_at, "computed_at");
  const age = (parseInstant(o.now, "now") - computed) / 60_000;
  if (age > POST_MAX_AGE_MIN) throw new CoachError("POST_STALE", `the post result is ${Math.round(age)} minutes old (limit ${POST_MAX_AGE_MIN}): ${fix}`);
  const changed = changedSince(root, post.local_date, computed);
  if (changed.length > 0) throw new CoachError("POST_STALE", `${changed.join(", ")} changed after the post result (a check-in or a safety change): ${fix}`);
  // W3b: the limits by content, not only by time: the sources must be what post saw.
  const seen = (post as { limits_freshness?: { fingerprint?: unknown } }).limits_freshness?.fingerprint;
  if (typeof seen === "string" && seen !== limitsFingerprint(root)) throw new CoachError("POST_STALE", `the limits changed after the post result: ${fix}, and Read the limits in full before planning or writing`);
  if (existsSync(join(root, "athlete/.urgent-stop")) && post.urgent?.stopped !== true) throw new CoachError("POST_STALE", `the urgent stop is set and the post result does not know it: ${fix}`);
  return post;
}
