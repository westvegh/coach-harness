// Readiness model (contracts §5). Pure: the same input always gives the same output.
import { addDays, diffDays, isCalendarDate, isValidTimezone, parseInstant, zonedTimeToEpoch } from "./dates.ts";
import { checkinBlockProblems } from "./checkin-shape.ts";
import { CoachError } from "./errors.ts";
import type { CalendarDate, CategoryState, DayRecord, MorningState, Readiness, ReadinessInput, ReadinessPattern, SessionPerf, Thresholds } from "./types.ts";

export const DEFAULT_THRESHOLDS: Thresholds = {
  // 4 weeks of valid days inside 6 weeks: the source's 4-to-6-week personal baseline (NA-REC-005).
  baseline_days_min: 28,
  baseline_window_days: 42,
  hrv_z_amber: -1.0,
  hrv_z_red: -2.0,
  rhr_z_amber: 1.0,
  rhr_z_red: 2.0,
  sleep_ratio_amber: 0.85,
  subjective_amber: 2.5,
  subjective_red: 1.5,
  perf_shortfall_amber: 0.2,
  rpe_drift_amber: 1.5,
  perf_expiry_days: 4,
  trim_fraction: 0.2,
};

/** Defaults for the pack's readiness checks (contracts §4), used when the pack has none. */
export const DEFAULT_SHORT_PATTERN_MORNINGS = 3;
export const DEFAULT_LONG_PATTERN_DAYS = 7;
export const DEFAULT_PROGRAM_CHANGE_CATEGORIES = 3;
export const DEFAULT_AVERSION_MAX = 1;

type Range = { min: number; max: number; minOpen?: boolean; maxOpen?: boolean; integer?: boolean };
const RANGES: Record<keyof Thresholds, Range> = {
  baseline_days_min: { min: 2, max: 365, integer: true },
  baseline_window_days: { min: 7, max: 365, integer: true },
  hrv_z_amber: { min: -5, max: 0, maxOpen: true },
  hrv_z_red: { min: -10, max: 0, maxOpen: true },
  rhr_z_amber: { min: 0, max: 5, minOpen: true },
  rhr_z_red: { min: 0, max: 10, minOpen: true },
  sleep_ratio_amber: { min: 0, max: 1, minOpen: true },
  subjective_amber: { min: 1, max: 5 },
  subjective_red: { min: 1, max: 5 },
  perf_shortfall_amber: { min: 0, max: 1, minOpen: true },
  rpe_drift_amber: { min: 0, max: 10, minOpen: true },
  perf_expiry_days: { min: 1, max: 14, integer: true },
  trim_fraction: { min: 0, max: 1, minOpen: true, maxOpen: true },
};

/**
 * Problems with threshold overrides, as "thresholds.<key>: …" lines. Values must be
 * finite and in range, and the merged set must keep its order (red beyond amber, the
 * minimum baseline inside the window).
 */
export function thresholdErrors(overrides: Partial<Record<string, unknown>>): string[] {
  const errors: string[] = [];
  for (const [k, v] of Object.entries(overrides)) {
    const r = RANGES[k as keyof Thresholds];
    if (!r) {
      errors.push(`thresholds.${k}: unknown threshold`);
      continue;
    }
    const lo = r.minOpen ? "above" : "at least";
    const hi = r.maxOpen ? "below" : "at most";
    const ok =
      typeof v === "number" &&
      Number.isFinite(v) &&
      (r.minOpen ? v > r.min : v >= r.min) &&
      (r.maxOpen ? v < r.max : v <= r.max) &&
      (!r.integer || Number.isInteger(v));
    if (!ok) errors.push(`thresholds.${k}: must be a ${r.integer ? "whole number" : "number"} ${lo} ${r.min} and ${hi} ${r.max}, got ${JSON.stringify(v ?? null)}`);
  }
  if (errors.length > 0) return errors;
  const t = { ...DEFAULT_THRESHOLDS, ...(overrides as Partial<Thresholds>) };
  if (t.baseline_days_min > t.baseline_window_days) errors.push("thresholds: baseline_days_min must not exceed baseline_window_days");
  if (!(t.hrv_z_red < t.hrv_z_amber)) errors.push("thresholds: hrv_z_red must be below hrv_z_amber");
  if (!(t.rhr_z_red > t.rhr_z_amber)) errors.push("thresholds: rhr_z_red must be above rhr_z_amber");
  if (!(t.subjective_red < t.subjective_amber)) errors.push("thresholds: subjective_red must be below subjective_amber");
  return errors;
}

// Percent fallback when the standard deviation is under 1% of the mean.
const HRV_PCT_AMBER = -0.1;
const HRV_PCT_RED = -0.2;
const RHR_PCT_AMBER = 0.05;
const RHR_PCT_RED = 0.1;
const EPS = 1e-9;

type Component = { state: "green" | "amber" | "red"; reason: string };

/** The words of the one check-in question (B.2); 5 is "great". */
const OVERALL_WORDS: Record<number, string> = { 1: "wrecked", 2: "run down", 3: "okay", 4: "good", 5: "great" };

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const flagged = (s: CategoryState) => s === "amber" || s === "red";

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sampleSd(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Scores one value against its baseline. `dir` is −1 when low is bad (HRV) and +1 when
 * high is bad (RHR).
 */
function scoreAgainstBaseline(
  label: string,
  unit: string,
  value: number,
  base: number[],
  dir: 1 | -1,
  z: { amber: number; red: number },
  pct: { amber: number; red: number },
): Component | null {
  const m = mean(base);
  const sd = sampleSd(base, m);
  // A baseline that cannot support either rule (for example all zeros) scores nothing.
  if (!(m > 0) || !Number.isFinite(sd) || !(value > 0)) return null;
  const worse = (x: number, limit: number) => (dir < 0 ? x <= limit + EPS : x >= limit - EPS);
  if (sd < 0.01 * Math.abs(m)) {
    const p = (value - m) / m;
    const state = worse(p, pct.red) ? "red" : worse(p, pct.amber) ? "amber" : "green";
    return { state, reason: `${label} ${round(value, 1)} ${unit}, ${round(p * 100, 1)}% vs baseline ${round(m, 1)} (low variance: percent rule)` };
  }
  const zs = (value - m) / sd;
  const state = worse(zs, z.red) ? "red" : worse(zs, z.amber) ? "amber" : "green";
  return { state, reason: `${label} ${round(value, 1)} ${unit}, z ${round(zs)} (baseline ${round(m, 1)} ± ${round(sd, 1)})` };
}

function checkRecord(r: DayRecord, i: number, nowMs: number): void {
  if (!isCalendarDate(r?.date)) throw new CoachError("READINESS_INPUT", `records[${i}].date must be YYYY-MM-DD`);
  if (typeof r.source !== "string" || r.source === "") throw new CoachError("READINESS_INPUT", `records[${i}].source is required`);
  const num = (v: unknown, path: string) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new CoachError("READINESS_INPUT", `records[${i}].${path} must be a number of 0 or more`);
  };
  if (r.sleep) num(r.sleep.duration_min, "sleep.duration_min");
  if (r.hrv) {
    num(r.hrv.value_ms, "hrv.value_ms");
    if (r.hrv.method !== "rmssd" && r.hrv.method !== "sdnn") throw new CoachError("READINESS_INPUT", `records[${i}].hrv.method must be rmssd | sdnn`);
  }
  if (r.rhr) num(r.rhr.bpm, "rhr.bpm");
  if (r.temperature !== undefined) {
    const t = r.temperature;
    if (typeof t !== "object" || t === null || Array.isArray(t) || typeof t.deviation_c !== "number" || !Number.isFinite(t.deviation_c) || t.deviation_c < -5 || t.deviation_c > 5) {
      throw new CoachError("READINESS_INPUT", `records[${i}].temperature must be an object with deviation_c a number from -5 to 5`);
    }
  }
  if (r.subjective !== undefined) {
    const problems = checkinBlockProblems(r.subjective, `records[${i}].subjective`);
    if (problems.length > 0) throw new CoachError("READINESS_INPUT", problems.join("; "));
  }
  // V6b fix 5: the check-in time must be an instant, and not after now.
  if (r.checkin_at !== undefined) {
    let at: number;
    try {
      at = parseInstant(r.checkin_at, "checkin_at");
    } catch {
      throw new CoachError("READINESS_INPUT", `records[${i}].checkin_at must be an ISO 8601 instant with an offset`);
    }
    if (at > nowMs) throw new CoachError("READINESS_INPUT", `records[${i}].checkin_at ${r.checkin_at} is after now`);
  }
}

/** Instants of a record that must not be in the future. Throws on a malformed instant. */
function recordInstants(r: DayRecord): [string, number][] {
  const out: [string, number][] = [["observed_at", parseInstant(r.observed_at, "observed_at")]];
  if (r.sleep) {
    out.push(["sleep.end_at", parseInstant(r.sleep.end_at, "sleep.end_at")]);
    out.push(["sleep.start_at", parseInstant(r.sleep.start_at, "sleep.start_at")]);
  }
  return out;
}

function futureField(r: DayRecord, nowMs: number): string | null {
  for (const [field, ms] of recordInstants(r)) if (ms > nowMs) return field;
  return null;
}

function latestByObserved(rs: DayRecord[]): DayRecord | undefined {
  return [...rs].sort((a, b) => parseInstant(b.observed_at) - parseInstant(a.observed_at))[0];
}

const validHrv = (r: DayRecord) => (r.hrv && r.hrv.value_ms > 0 ? r.hrv : undefined);
const validRhr = (r: DayRecord) => (r.rhr && r.rhr.bpm > 0 ? r.rhr : undefined);
const validSleep = (r: DayRecord) => (r.sleep && r.sleep.duration_min > 0 ? r.sleep : undefined);

/**
 * Wearable category. Each metric (HRV, RHR, sleep) takes its own latest fresh observation
 * for today, so a later record without HRV cannot hide an earlier HRV reading. Only
 * records marked `complete` count, for today and for baselines. Each metric needs at
 * least baseline_days_min valid days from the same source (and, for HRV, the same method);
 * otherwise the category is calibrating and unknown.
 */
function wearable(input: ReadinessInput, th: Thresholds, nowMs: number): Readiness["wearable"] {
  const { today, tz } = input;
  const reasons: string[] = [];
  const prev = addDays(today, -1);
  const windowStartMs = zonedTimeToEpoch(prev, "18:00", tz);

  const fresh: DayRecord[] = [];
  for (const r of input.records) {
    if (r.date !== today || !(r.hrv || r.rhr || r.sleep)) continue;
    const future = futureField(r, nowMs);
    if (future) {
      reasons.push(`rejected ${r.source} record: ${future} is after now`);
      continue;
    }
    const endMs = r.sleep ? parseInstant(r.sleep.end_at) : parseInstant(r.observed_at);
    if (endMs <= windowStartMs) {
      reasons.push(`${r.source} ${r.sleep ? "sleep" : "record"} ended before 18:00 on ${prev}: not counted for ${today}`);
      continue;
    }
    if (r.complete !== true) {
      reasons.push(`${r.source} record observed ${r.observed_at} is incomplete: not counted`);
      continue;
    }
    fresh.push(r);
  }

  const from = addDays(today, -th.baseline_window_days);
  const history = input.records.filter((r) => r.complete === true && r.date >= from && r.date < today && !futureField(r, nowMs));
  /** One value per date (the latest observation that carries a valid value). */
  const baseline = (source: string, pick: (r: DayRecord) => number | undefined): number[] => {
    const byDate = new Map<string, DayRecord>();
    for (const r of history) {
      if (r.source !== source || pick(r) === undefined) continue;
      const seen = byDate.get(r.date);
      if (!seen || parseInstant(r.observed_at) > parseInstant(seen.observed_at)) byDate.set(r.date, r);
    }
    return [...byDate.values()].map((r) => pick(r)!);
  };

  type Metric = { name: string; rec: DayRecord; pick: (r: DayRecord) => number | undefined };
  const metrics: Metric[] = [];
  const hrvRec = latestByObserved(fresh.filter((r) => validHrv(r)));
  if (hrvRec) {
    const method = hrvRec.hrv!.method;
    // Methods are never mixed: an SDNN day is not a baseline day for RMSSD.
    metrics.push({ name: `${method.toUpperCase()} HRV`, rec: hrvRec, pick: (r) => (validHrv(r)?.method === method ? r.hrv!.value_ms : undefined) });
  }
  const rhrRec = latestByObserved(fresh.filter((r) => validRhr(r)));
  if (rhrRec) metrics.push({ name: "resting HR", rec: rhrRec, pick: (r) => validRhr(r)?.bpm });
  const sleepRec = latestByObserved(fresh.filter((r) => validSleep(r)));
  if (sleepRec) metrics.push({ name: "sleep", rec: sleepRec, pick: (r) => validSleep(r)?.duration_min });
  for (const r of fresh) {
    if (r.hrv && !validHrv(r)) reasons.push(`${r.source} HRV ${r.hrv.value_ms} is not a valid reading: not counted`);
    if (r.rhr && !validRhr(r)) reasons.push(`${r.source} resting HR ${r.rhr.bpm} is not a valid reading: not counted`);
  }
  if (metrics.length === 0) {
    reasons.push("no fresh wearable observation for today");
    return { state: "unknown", reasons, calibrating: false };
  }
  const observed_at = metrics.map((m) => m.rec.observed_at).sort((a, b) => parseInstant(a) - parseInstant(b)).at(-1);

  const bases = new Map<string, number[]>();
  let calibrating = false;
  for (const m of metrics) {
    const base = baseline(m.rec.source, m.pick);
    bases.set(m.name, base);
    if (base.length < th.baseline_days_min) {
      calibrating = true;
      reasons.push(`calibrating: ${base.length}/${th.baseline_days_min} valid days of ${m.name} from ${m.rec.source}`);
    }
  }
  if (calibrating) return { state: "unknown", reasons, calibrating: true, observed_at };

  const components: Component[] = [];
  for (const m of metrics) {
    let c: Component | null;
    if (m.name === "sleep") {
      const ratio = m.rec.sleep!.duration_min / input.sleep_target_min;
      c = { state: ratio < th.sleep_ratio_amber ? "amber" : "green", reason: `sleep ${m.rec.sleep!.duration_min} min = ${round(ratio * 100, 0)}% of target` };
    } else if (m.name === "resting HR") {
      c = scoreAgainstBaseline("RHR", "bpm", m.rec.rhr!.bpm, bases.get(m.name)!, 1, { amber: th.rhr_z_amber, red: th.rhr_z_red }, { amber: RHR_PCT_AMBER, red: RHR_PCT_RED });
    } else {
      c = scoreAgainstBaseline(`HRV (${m.rec.hrv!.method})`, "ms", m.rec.hrv!.value_ms, bases.get(m.name)!, -1, { amber: th.hrv_z_amber, red: th.hrv_z_red }, { amber: HRV_PCT_AMBER, red: HRV_PCT_RED });
    }
    if (!c) {
      reasons.push(`${m.name}: the baseline cannot be scored`);
      return { state: "unknown", reasons, calibrating: false, observed_at };
    }
    components.push(c);
  }
  for (const c of components) reasons.push(`${c.reason}: ${c.state}`);
  const reds = components.filter((c) => c.state === "red").length;
  const ambers = components.filter((c) => c.state === "amber").length;
  let state: CategoryState = "green";
  if (reds > 0) state = "red";
  else if (ambers >= 2) {
    state = "red";
    reasons.push("two ambers make red");
  } else if (ambers === 1) state = "amber";
  return { state, reasons, calibrating: false, observed_at };
}

function subjective(input: ReadinessInput, th: Thresholds, nowMs: number): { cat: Readiness["subjective"]; pain: Readiness["pain"]; want?: number } {
  const reasons: string[] = [];
  const todays = input.records.filter((r) => r.subjective && r.date === input.today);
  const valid = todays.filter((r) => {
    if (parseInstant(r.observed_at) > nowMs) {
      reasons.push(`rejected ${r.source} check-in: observed_at is after now`);
      return false;
    }
    return true;
  });
  const rec = latestByObserved(valid);
  if (!rec) {
    reasons.push("no check-in for today");
    return { cat: { state: "unknown", reasons }, pain: [] };
  }
  const s = rec.subjective!;
  let state: CategoryState = "unknown";
  if (s.overall !== undefined) {
    // One overall rating (B.3): 1 red, 2 amber, 3 to 5 green with the default thresholds.
    state = s.overall <= th.subjective_red + EPS ? "red" : s.overall <= th.subjective_amber + EPS ? "amber" : "green";
    reasons.push(`feels ${OVERALL_WORDS[s.overall]} (${s.overall}/5)`);
  } else if (s.sleep_quality !== undefined && s.energy !== undefined && s.soreness !== undefined && s.stress !== undefined) {
    // Soreness and stress are inverted so that 1 is always the worst value.
    const oriented = { sleep_quality: s.sleep_quality, energy: s.energy, soreness: 6 - s.soreness, stress: 6 - s.stress };
    const m = mean(Object.values(oriented));
    state = m <= th.subjective_red + EPS ? "red" : m <= th.subjective_amber + EPS ? "amber" : "green";
    reasons.push(`check-in mean ${round(m)}`);
    const atOne = Object.entries(oriented).filter(([, v]) => v === 1).map(([k]) => k);
    if (atOne.length > 0) {
      reasons.push(`worst value on ${atOne.join(", ")}`);
      if (state === "green") state = "amber";
    }
  } else reasons.push("no rating today");
  // Want-to-train is its own signal (aversion), not part of the mean.
  if (s.want_to_train !== undefined) reasons.push(`want to train ${s.want_to_train}/5`);
  return { cat: { state, reasons }, pain: (s.pain ?? []).map((p) => ({ region: p.region, score: p.score })), want: s.want_to_train };
}

function sessionAmber(s: SessionPerf, th: Thresholds): string[] {
  const why: string[] = [];
  const setShort = s.planned_sets > 0 ? 1 - s.completed_sets / s.planned_sets : 0;
  const shortfall = Math.max(s.reps_shortfall_ratio, setShort);
  if (shortfall >= th.perf_shortfall_amber - EPS) why.push(`shortfall ${round(shortfall * 100, 0)}%`);
  if ((s.rpe_drift ?? 0) >= th.rpe_drift_amber - EPS) why.push(`RPE drift +${s.rpe_drift}`);
  if (s.top_set_dropped) why.push("top set dropped");
  return why;
}

/**
 * One observation per date: exact copies count once, and two different sessions on one
 * date merge (sets add up; the worst shortfall, drift and top-set result win).
 */
function sessionsByDate(sessions: SessionPerf[]): SessionPerf[] {
  const unique = new Map<string, SessionPerf>();
  for (const s of sessions) unique.set(JSON.stringify([s.date, s.planned_sets, s.completed_sets, s.reps_shortfall_ratio, s.rpe_drift ?? null, s.top_set_dropped]), s);
  const byDate = new Map<string, SessionPerf>();
  for (const s of unique.values()) {
    const m = byDate.get(s.date);
    byDate.set(
      s.date,
      m
        ? {
            date: s.date,
            planned_sets: m.planned_sets + s.planned_sets,
            completed_sets: m.completed_sets + s.completed_sets,
            reps_shortfall_ratio: Math.max(m.reps_shortfall_ratio, s.reps_shortfall_ratio),
            rpe_drift: Math.max(m.rpe_drift ?? 0, s.rpe_drift ?? 0),
            top_set_dropped: m.top_set_dropped || s.top_set_dropped,
          }
        : s,
    );
  }
  return [...byDate.values()];
}

function performance(input: ReadinessInput, th: Thresholds): Readiness["performance"] {
  input.sessions.forEach((s, i) => {
    if (!isCalendarDate(s?.date)) throw new CoachError("READINESS_INPUT", `sessions[${i}].date must be YYYY-MM-DD`);
    for (const k of ["planned_sets", "completed_sets", "reps_shortfall_ratio"] as const) {
      if (typeof s[k] !== "number" || !Number.isFinite(s[k]) || s[k] < 0) throw new CoachError("READINESS_INPUT", `sessions[${i}].${k} must be a number of 0 or more`);
    }
    if (s.rpe_drift !== undefined && (typeof s.rpe_drift !== "number" || !Number.isFinite(s.rpe_drift))) {
      throw new CoachError("READINESS_INPUT", `sessions[${i}].rpe_drift must be a finite number`);
    }
  });
  // Expiry applies to every session used; each date is one observation.
  const all = sessionsByDate(input.sessions).filter((s) => s.date <= input.today);
  const live = all.filter((s) => diffDays(s.date, input.today) <= th.perf_expiry_days).sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = live[0];
  if (!latest) {
    const last = all.sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const reason = last ? `last session ${last.date} is ${diffDays(last.date, input.today)} days old (expires after ${th.perf_expiry_days})` : "no logged session";
    return { state: "unknown", reasons: [reason], sessions_used: [] };
  }
  const why = sessionAmber(latest, th);
  if (why.length === 0) return { state: "green", reasons: [`session ${latest.date} on plan`], sessions_used: [latest.date] };
  const prev = live[1];
  const prevWhy = prev ? sessionAmber(prev, th) : [];
  if (prev && prevWhy.length > 0) {
    return {
      state: "red",
      reasons: [`session ${latest.date}: ${why.join(", ")}`, `session ${prev.date}: ${prevWhy.join(", ")}`, "two sessions in a row"],
      sessions_used: [latest.date, prev.date],
    };
  }
  return { state: "amber", reasons: [`session ${latest.date}: ${why.join(", ")}`], sessions_used: [latest.date] };
}

// ---------- the morning pattern (NA-REC-008 to NA-REC-011) ----------

/** A complete, valid reading of one signal, with its parsed observation time. */
type Reading = { date: CalendarDate; source: string; method?: string; value: number; at: number };

/** Every complete, valid, not-future reading of one signal, parsed once. */
function readings(records: DayRecord[], signal: "hrv" | "rhr", nowMs: number): Reading[] {
  const out: Reading[] = [];
  for (const r of records) {
    if (r.complete !== true) continue;
    const v = signal === "hrv" ? validHrv(r)?.value_ms : validRhr(r)?.bpm;
    if (v === undefined || futureField(r, nowMs)) continue;
    out.push({ date: r.date, source: r.source, method: r.hrv?.method, value: v, at: parseInstant(r.observed_at) });
  }
  return out;
}

/**
 * One signal on one morning against the athlete's own band. The reading is the latest
 * complete record dated that morning (observed by now); the baseline is one value per date
 * from the same source (and HRV method) in the baseline window before it. Off means the
 * amber line or beyond: HRV low, RHR high. No reading, too short a baseline, or a baseline
 * that cannot be scored is unknown, never off.
 */
function morningState(rs: Reading[], date: CalendarDate, signal: "hrv" | "rhr", th: Thresholds): MorningState {
  let rec: Reading | undefined;
  for (const r of rs) if (r.date === date && (!rec || r.at > rec.at)) rec = r;
  if (!rec) return "unknown";
  const from = addDays(date, -th.baseline_window_days);
  const byDate = new Map<string, Reading>();
  for (const r of rs) {
    if (r.date < from || r.date >= date || r.source !== rec.source || (signal === "hrv" && r.method !== rec.method)) continue;
    const seen = byDate.get(r.date);
    if (!seen || r.at > seen.at) byDate.set(r.date, r);
  }
  if (byDate.size < th.baseline_days_min) return "unknown";
  const base = [...byDate.values()].map((r) => r.value);
  const c =
    signal === "hrv"
      ? scoreAgainstBaseline("HRV", "ms", rec.value, base, -1, { amber: th.hrv_z_amber, red: th.hrv_z_red }, { amber: HRV_PCT_AMBER, red: HRV_PCT_RED })
      : scoreAgainstBaseline("RHR", "bpm", rec.value, base, 1, { amber: th.rhr_z_amber, red: th.rhr_z_red }, { amber: RHR_PCT_AMBER, red: RHR_PCT_RED });
  if (!c) return "unknown";
  return c.state === "green" ? "ok" : "off";
}

/**
 * Consecutive off-mornings ending on `today`, per signal and for either signal. A morning
 * counts for "either" when one signal is off; an unknown or ok morning ends the run.
 */
export function morningPattern(input: Pick<ReadinessInput, "today" | "records">, th: Thresholds, nowMs: number, short: number, long: number): ReadinessPattern {
  const lookback = Math.max(long, short);
  const hrvReadings = readings(input.records, "hrv", nowMs);
  const rhrReadings = readings(input.records, "rhr", nowMs);
  const cache = new Map<string, { hrv: MorningState; rhr: MorningState }>();
  const at = (i: number) => {
    const date = addDays(input.today, -i);
    let m = cache.get(date);
    if (!m) {
      m = { hrv: morningState(hrvReadings, date, "hrv", th), rhr: morningState(rhrReadings, date, "rhr", th) };
      cache.set(date, m);
    }
    return { date, ...m };
  };
  const run = (off: (m: { hrv: MorningState; rhr: MorningState }) => boolean) => {
    let n = 0;
    // The run can be longer than the long pattern; it stops at the window's edge, where baselines run out.
    while (n <= th.baseline_window_days && off(at(n))) n++;
    return n;
  };
  const hrv = run((m) => m.hrv === "off");
  const rhr = run((m) => m.rhr === "off");
  const either = run((m) => m.hrv === "off" || m.rhr === "off");
  const mornings = Array.from({ length: lookback }, (_, k) => at(lookback - 1 - k));
  return { mornings, off_mornings: { hrv, rhr, either }, days_of_decline: either, short: either >= short, long: either >= long };
}

export function readiness(input: ReadinessInput): Readiness {
  if (!isCalendarDate(input?.today)) throw new CoachError("READINESS_INPUT", "today must be YYYY-MM-DD");
  if (!isValidTimezone(input.tz)) throw new CoachError("READINESS_INPUT", `tz must be an IANA timezone: ${input.tz}`);
  const nowMs = parseInstant(input.now, "now");
  if (!(typeof input.sleep_target_min === "number" && Number.isFinite(input.sleep_target_min) && input.sleep_target_min > 0)) {
    throw new CoachError("READINESS_INPUT", "sleep_target_min must be a positive number");
  }
  if (!Array.isArray(input.records) || !Array.isArray(input.sessions)) {
    throw new CoachError("READINESS_INPUT", "records and sessions must be lists");
  }
  input.records.forEach((r, i) => checkRecord(r, i, nowMs));
  const thErrors = thresholdErrors(input.thresholds ?? {});
  if (thErrors.length > 0) throw new CoachError("READINESS_INPUT", thErrors.join("; "));
  const th: Thresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const rr = input.readiness_rules ?? {};
  const shortN = rr.short_pattern?.mornings ?? DEFAULT_SHORT_PATTERN_MORNINGS;
  const longN = rr.long_pattern?.days ?? DEFAULT_LONG_PATTERN_DAYS;
  const triadN = rr.program_change?.categories ?? DEFAULT_PROGRAM_CHANGE_CATEGORIES;
  const aversionMax = rr.aversion?.max ?? DEFAULT_AVERSION_MAX;

  const w = wearable(input, th, nowMs);
  const { cat: s, pain, want } = subjective(input, th, nowMs);
  const p = performance(input, th);
  const states = [w.state, s.state, p.state];
  const known = states.filter((x) => x !== "unknown").length;
  const pattern = morningPattern(input, th, nowMs, shortN, longN);
  const aversion = want !== undefined && want <= aversionMax;
  // The program-change signal: physiology (the long pattern), how the athlete feels and performance agree.
  const evidence = [pattern.long, flagged(s.state), flagged(p.state)].filter(Boolean).length;
  const deload_signal = pattern.long && evidence >= triadN;

  // Precedence: a recovery day, then a proposal, then a trim, then a note.
  const reasons: string[] = [];
  const ids: string[] = [];
  const runText = `${pattern.days_of_decline} off-mornings in a row (HRV ${pattern.off_mornings.hrv}, resting HR ${pattern.off_mornings.rhr})`;
  let decision: Readiness["decision"] = "none";
  if (aversion) {
    decision = "recovery";
    reasons.push(`want to train ${want}/5: aversion is a reason to rest`);
    ids.push(...(rr.aversion?.ids ?? []));
  } else if (pattern.short && (s.state === "red" || p.state === "red")) {
    decision = "recovery";
    reasons.push(`${runText}, and ${s.state === "red" ? "the check-in" : "performance"} is red today`);
    ids.push(...(rr.short_pattern?.ids ?? []));
  } else if (deload_signal) {
    decision = "propose_deload";
    reasons.push(`${runText}: ${longN} or more, with the check-in ${s.state} and performance ${p.state} today`);
    ids.push(...(rr.long_pattern?.ids ?? []), ...(rr.program_change?.ids ?? []));
  } else if (pattern.short) {
    decision = "trim";
    reasons.push(`${runText}: ${shortN} or more`);
    ids.push(...(rr.short_pattern?.ids ?? []));
  } else if (states.some(flagged)) {
    decision = "note";
    const which = (["wearable", "subjective", "performance"] as const).filter((_, i) => flagged(states[i]));
    reasons.push(`${which.join(", ")} off today, with ${pattern.days_of_decline} off-morning${pattern.days_of_decline === 1 ? "" : "s"} in a row: one day is not a pattern`);
    ids.push(...(rr.single_day_ids ?? []));
  }
  if (deload_signal && decision === "recovery") reasons.push("the long pattern with all three kinds of evidence also holds: the week run proposes a program change");

  return {
    date: input.today,
    wearable: w,
    subjective: s,
    performance: p,
    known,
    decision,
    decision_reasons: reasons,
    hold_progression: decision === "trim" || decision === "recovery" || decision === "propose_deload",
    aversion,
    deload_signal,
    pattern,
    rule_ids: [...new Set(ids)],
    pain,
  };
}

/** Two instants are one observation when they parse to the same moment, however spelled. */
function sameInstant(a: string, b: string | undefined): boolean {
  if (b === undefined) return false;
  try {
    return parseInstant(a) === parseInstant(b);
  } catch {
    return a === b;
  }
}

export type ProgramChangeOptions = { min_categories?: number; days?: number; window_days?: number };

/**
 * True when `days` (3) distinct dates in the last `window_days` (7) each show at least
 * `min_categories` (3) categories amber or red, built from distinct observations: no
 * performance session and no wearable observation may count for two dates.
 */
export function programChangeSignal(history: Readiness[], opts: ProgramChangeOptions = {}): boolean {
  const minCats = opts.min_categories ?? 3;
  const need = opts.days ?? 3;
  const windowDays = opts.window_days ?? 7;
  if (history.length === 0) return false;
  const latest = history.map((r) => r.date).sort().at(-1)!;
  const from = addDays(latest, -(windowDays - 1));
  const qualifying = history.filter((r) => {
    if (r.date < from || r.date > latest) return false;
    return [r.wearable.state, r.subjective.state, r.performance.state].filter(flagged).length >= minCats;
  });

  const pick = (start: number, chosen: Readiness[]): boolean => {
    if (chosen.length === need) return true;
    for (let i = start; i < qualifying.length; i++) {
      const r = qualifying[i];
      const clash = chosen.some(
        (c) =>
          c.date === r.date ||
          c.performance.sessions_used.some((s) => r.performance.sessions_used.includes(s)) ||
          (c.wearable.observed_at !== undefined && sameInstant(c.wearable.observed_at, r.wearable.observed_at)),
      );
      if (!clash && pick(i + 1, [...chosen, r])) return true;
    }
    return false;
  };
  return pick(0, []);
}
