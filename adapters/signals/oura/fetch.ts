// Oura v2 fetch (Mac only in v1).
//
//   node adapters/signals/oura/fetch.ts --days 30 [--root <repo>] [--tz <IANA>]
//
// Reads /v2/usercollection/sleep (average_hrv as RMSSD, lowest_heart_rate, the sleep
// period) and /v2/usercollection/daily_readiness (score → vendor_score), normalizes them to
// DayRecord[] (method rmssd; the main sleep period only) and merges them into
// athlete/.cache/signals/oura.json: fetched dates are replaced, older dates are kept so
// the 30-day baseline survives a short fetch.
//
// Auth: OAuth tokens from the Keychain (see auth.ts). A legacy personal token in
// OURA_PERSONAL_TOKEN is still accepted, with a deprecation warning.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { addDays, isCalendarDate, isValidTimezone, localDate, parseInstant } from "../../../engine/dates.ts";
import { CoachError } from "../../../engine/errors.ts";
import type { CalendarDate, DayRecord } from "../../../engine/types.ts";
import { isPlainObject, readYamlFile } from "../../../engine/yaml-file.ts";
import { writeJsonAtomic } from "../write-json.ts";
import { REQUEST_TIMEOUT_MS, getAccessToken, type FetchFn, type OuraDeps } from "./auth.ts";
import { formatCliError, transportError } from "./errors.ts";
import { KeychainStore } from "./secrets.ts";

export const API_BASE = "https://api.ouraring.com";
export const CACHE_RELATIVE = "athlete/.cache/signals/oura.json";
export const SOURCE = "oura";
export const MAX_DAYS = 400;

/** The fields of PublicModifiedSleepModel this adapter reads (Oura OpenAPI 1.41). */
export type OuraSleep = {
  id: string;
  day: string;
  type?: "deleted" | "sleep" | "long_sleep" | "late_nap" | "rest" | null;
  bedtime_start: string;
  bedtime_end: string;
  total_sleep_duration?: number | null;
  time_in_bed?: number;
  efficiency?: number | null;
  average_hrv?: number | null;
  lowest_heart_rate?: number | null;
};

/** The fields of PublicDailyReadiness this adapter reads. */
export type OuraReadiness = { id: string; day: string; score?: number | null; timestamp: string };

const MAIN_TYPES = new Set(["long_sleep", "sleep", null, undefined]);

/** The main sleep period of a day: a long_sleep before a short sleep, then the longest. */
export function mainSleep(periods: OuraSleep[]): OuraSleep | undefined {
  const rank = (s: OuraSleep) => (s.type === "long_sleep" ? 2 : s.type == null ? 1 : 0);
  const length = (s: OuraSleep) => s.total_sleep_duration ?? s.time_in_bed ?? 0;
  return periods
    .filter((s) => MAIN_TYPES.has(s.type))
    .sort((a, b) => rank(b) - rank(a) || length(b) - length(a))[0];
}

function validInstant(s: unknown): s is string {
  try {
    parseInstant(s);
    return true;
  } catch {
    return false;
  }
}

/** Maps Oura documents to one DayRecord per day in [from, to]. Bad documents become warnings. */
export function normalizeOura(sleep: OuraSleep[], readiness: OuraReadiness[], range: { from: CalendarDate; to: CalendarDate }): { records: DayRecord[]; warnings: string[] } {
  const warnings: string[] = [];
  const inRange = (d: unknown): d is string => isCalendarDate(d) && d >= range.from && d <= range.to;
  const sleepByDay = new Map<string, OuraSleep[]>();
  for (const s of sleep) {
    if (!inRange(s?.day)) continue;
    if (!validInstant(s.bedtime_start) || !validInstant(s.bedtime_end)) {
      warnings.push(`sleep ${s.id ?? "?"} on ${s.day} skipped: bedtime is not an ISO instant with an offset`);
      continue;
    }
    sleepByDay.set(s.day, [...(sleepByDay.get(s.day) ?? []), s]);
  }
  const scoreByDay = new Map<string, OuraReadiness>();
  for (const r of readiness) if (inRange(r?.day)) scoreByDay.set(r.day, r);

  const days = [...new Set([...sleepByDay.keys(), ...scoreByDay.keys()])].sort();
  const records: DayRecord[] = [];
  for (const day of days) {
    const main = mainSleep(sleepByDay.get(day) ?? []);
    const ready = scoreByDay.get(day);
    const score = typeof ready?.score === "number" ? ready.score : undefined;
    if (main) {
      const rec: DayRecord = {
        date: day,
        source: SOURCE,
        observed_at: main.bedtime_end,
        complete: main.type === "long_sleep" && typeof main.total_sleep_duration === "number",
      };
      if (typeof main.total_sleep_duration === "number") {
        rec.sleep = {
          duration_min: Math.round(main.total_sleep_duration / 60),
          start_at: main.bedtime_start,
          end_at: main.bedtime_end,
          ...(typeof main.efficiency === "number" ? { efficiency: main.efficiency } : {}),
        };
      }
      if (typeof main.average_hrv === "number") rec.hrv = { value_ms: main.average_hrv, method: "rmssd" };
      if (typeof main.lowest_heart_rate === "number") rec.rhr = { bpm: main.lowest_heart_rate };
      if (score !== undefined) rec.vendor_score = score;
      records.push(rec);
    } else if (ready && score !== undefined) {
      if (!validInstant(ready.timestamp)) {
        warnings.push(`daily_readiness on ${day} skipped: timestamp is not an ISO instant with an offset`);
        continue;
      }
      records.push({ date: day, source: SOURCE, observed_at: ready.timestamp, complete: false, vendor_score: score });
    }
  }
  return { records, warnings };
}

async function getCollection<T>(fetchFn: FetchFn, token: string, path: string, start: CalendarDate, end: CalendarDate, timeoutMs: number): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = null;
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({ start_date: start, end_date: end });
    if (next) q.set("next_token", next);
    const url = `${API_BASE}${path}?${q.toString()}`;
    let res: Response;
    let body: { data?: T[]; next_token?: unknown } | null = null;
    try {
      res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        try {
          body = (await res.json()) as { data?: T[]; next_token?: unknown };
        } catch (e) {
          const name = (e as { name?: string })?.name;
          if (name === "TimeoutError" || name === "AbortError") throw e;
          // Not JSON: reported below without the body.
        }
      }
    } catch (e) {
      throw transportError(e, `the Oura request for ${path}`);
    }
    // Status codes and our own path only: never the body or a header value.
    if (res.status === 401) throw new CoachError("OURA_UNAUTHORIZED", `Oura answered 401 for ${path}. Run: node adapters/signals/oura/auth.ts`);
    if (res.status === 403) throw new CoachError("OURA_FORBIDDEN", `Oura answered 403 for ${path}: a missing scope or an expired Oura membership`);
    if (res.status === 429) {
      const after = res.headers.get("retry-after");
      throw new CoachError("OURA_RATE_LIMIT", `Oura rate limit for ${path}; retry after ${after && /^\d{1,6}$/.test(after) ? `${after} s` : "a while"}`);
    }
    if (!res.ok) throw new CoachError("OURA_HTTP", `Oura answered HTTP ${res.status} for ${path}`);
    if (!body || !Array.isArray(body.data)) throw new CoachError("OURA_SHAPE", `Oura ${path} response is not JSON with a data array`);
    out.push(...body.data);
    next = typeof body.next_token === "string" && body.next_token !== "" ? body.next_token : null;
    if (!next) return out;
  }
  throw new CoachError("OURA_SHAPE", `Oura ${path} paginated more than 100 pages`);
}

export type FetchResult = { path: string; from: CalendarDate; to: CalendarDate; records: number; kept: number; auth: "oauth" | "personal-token"; warnings: string[] };

/** The cache file: fetched dates replaced, other dates kept, sorted by date. */
export function mergeCache(existing: DayRecord[], fresh: DayRecord[], range: { from: CalendarDate; to: CalendarDate }): DayRecord[] {
  const kept = existing.filter((r) => r.source === SOURCE && isCalendarDate(r.date) && (r.date < range.from || r.date > range.to));
  return [...kept, ...fresh].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export async function fetchOura(opts: {
  root: string;
  days: number;
  tz: string;
  deps: OuraDeps;
  /** A legacy personal token (deprecated). When set, OAuth is not used. */
  personalToken?: string;
  warn?: (msg: string) => void;
}): Promise<FetchResult> {
  const { root, days, tz, deps } = opts;
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new CoachError("USAGE", `--days must be an integer from 1 to ${MAX_DAYS}`);
  const now = deps.now ?? Date.now;
  const to = localDate(now(), tz);
  const from = addDays(to, -(days - 1));

  let token: string;
  let auth: FetchResult["auth"];
  if (opts.personalToken) {
    (opts.warn ?? (() => undefined))("OURA_PERSONAL_TOKEN is deprecated: Oura is retiring personal access tokens. Run node adapters/signals/oura/auth.ts to switch to OAuth.");
    token = opts.personalToken;
    auth = "personal-token";
  } else {
    token = await getAccessToken(deps);
    auth = "oauth";
  }

  // end_date is padded by a day: the sleep endpoint has been reported to treat it as
  // exclusive. Records are filtered to [from, to] afterwards either way.
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const sleep = await getCollection<OuraSleep>(deps.fetch, token, "/v2/usercollection/sleep", from, addDays(to, 1), timeoutMs);
  const readiness = await getCollection<OuraReadiness>(deps.fetch, token, "/v2/usercollection/daily_readiness", from, addDays(to, 1), timeoutMs);
  const { records, warnings } = normalizeOura(sleep, readiness, { from, to });

  const path = join(root, CACHE_RELATIVE);
  let existing: DayRecord[] = [];
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(raw)) existing = raw;
      else warnings.push(`${CACHE_RELATIVE} was not an array; replaced`);
    } catch {
      warnings.push(`${CACHE_RELATIVE} was not valid JSON; replaced`);
    }
  }
  const merged = mergeCache(existing, records, { from, to });
  writeJsonAtomic(path, merged);
  return { path, from, to, records: records.length, kept: merged.length - records.length, auth, warnings };
}

function athleteTimezone(root: string): string | undefined {
  const p = join(root, "coach.yaml");
  if (!existsSync(p)) return undefined;
  const cfg = readYamlFile(p, "CONFIG_INVALID");
  const tz = isPlainObject(cfg) && isPlainObject(cfg.athlete) ? cfg.athlete.timezone : undefined;
  return typeof tz === "string" ? tz : undefined;
}

async function main(argv: string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, strict: true, options: { days: { type: "string" }, root: { type: "string" }, tz: { type: "string" } } });
    const root = resolve(values.root ?? ".");
    const tz = values.tz ?? athleteTimezone(root) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!isValidTimezone(tz)) throw new CoachError("BAD_TIMEZONE", `unknown IANA timezone: ${tz}`);
    const result = await fetchOura({
      root,
      days: values.days === undefined ? 30 : Number(values.days),
      tz,
      deps: { store: new KeychainStore(), fetch },
      personalToken: process.env.OURA_PERSONAL_TOKEN || undefined,
      warn: (m) => process.stderr.write(`warning: ${m}\n`),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (e) {
    const err = formatCliError(e);
    process.stdout.write(JSON.stringify({ error: err }, null, 2) + "\n");
    process.stderr.write(`${err.code}: ${err.message}\n`);
    return err.code === "USAGE" ? 2 : 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
