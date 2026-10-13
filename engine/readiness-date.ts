// readiness --date. Builds the readiness input (contracts
// §5) from the athlete's files, so the model does no arithmetic:
// - records: engine/signals.ts over the baseline window up to the date;
// - sessions: each logged session in the snapshot history, judged against THAT date's own
//   plan (the snapshot day read with get_planned_workout), never today's plan;
// - sleep target: coach.yaml athlete.sleep_target_min (default 480);
// - the readiness rules and their IDs: the method pack's check types (contracts §4).
// Missing evidence is unknown, never estimated: a session whose date was not read is not
// judged, and an older session never stands in for it. A session on a date that was read and
// has no planned day is judged against the athlete's own history (V6 L, judgeUnplanned).
import { DEFAULT_SLEEP_TARGET_MIN } from "./config.ts";
import { addDays, diffDays, isCalendarDate, localDate, parseInstant, zonedTimeToEpoch } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { DEFAULT_LONG_PATTERN_DAYS, DEFAULT_THRESHOLDS, readiness } from "./readiness.ts";
import { loadSignals } from "./signals.ts";
import { SNAPSHOT_MAX_AGE_MIN } from "./snapshot.ts";
import { normalizeName } from "./taxonomy.ts";
import { convertWeight } from "../adapters/loggers/tally/day.ts";
import type { CalendarDate, CoachConfig, HistoryExercise, Instant, LoggerExercise, Readiness, ReadinessInput, ReadinessRules, Rules, SessionPerf, Snapshot, SnapshotDay, SnapshotSession, Units } from "./types.ts";

/** How one logged session was judged. `perf` is absent when the evidence is missing. */
export type SessionJudgement = {
  date: CalendarDate;
  /** `none`: the date was read and has no planned day; the session is judged against the athlete's own history (V6 L). */
  plan: "found" | "missing" | "empty" | "none";
  perf?: SessionPerf;
  notes: string[];
};

export type ReadinessForDate = Readiness & {
  inputs: ReadinessInput & { signals_warnings: string[]; sessions_judged: SessionJudgement[]; notes: string[] };
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

type PlannedEx = { id: string | null; name: string; sets: number | null; repsMin: number | null; rpe: number | null; weight: number | null; timed: boolean };

function plannedExercise(e: LoggerExercise): PlannedEx {
  return {
    id: typeof e.exerciseId === "string" && e.exerciseId !== "" ? e.exerciseId : null,
    name: typeof e.name === "string" ? e.name : "",
    // No set count is unknown, never 1.
    sets: Number.isInteger(e.suggestedSets) && (e.suggestedSets as number) > 0 ? (e.suggestedSets as number) : null,
    // A shortfall is measured against the bottom of a rep range.
    repsMin: num(e.suggestedReps) ?? num(e.repsMax),
    rpe: num(e.rpe),
    weight: num(e.suggestedWeight),
    timed: num(e.suggestedReps) === null && num(e.repsMax) === null && num(e.suggestedDuration) !== null,
  };
}

function matches(p: PlannedEx, h: HistoryExercise): boolean {
  if (p.id && h.exerciseId) return p.id === h.exerciseId;
  return normalizeName(p.name) === normalizeName(h.name ?? "");
}

/**
 * A logged session against its own plan (contracts §5 SessionPerf):
 * - planned_sets: the plan's sets; completed_sets: logged sets of planned exercises, at most
 *   the planned count per exercise (a set with 0 reps does not count);
 * - reps_shortfall_ratio: Σ max(0, target − reps) / Σ target over the completed sets (the
 *   target is the bottom of the rep range);
 * - rpe_drift: the mean of (logged RPE − planned RPE) over sets that have both; absent when
 *   no set has both (unknown, not 0);
 * - top_set_dropped: a planned weight whose heaviest logged set is lighter (same unit, or
 *   converted when both units are known).
 * Exercises logged but not planned are not judged. A timed exercise (a duration and no rep
 * target) is not judged either: the history holds no durations.
 *
 * Missing evidence gives no SessionPerf: a planned exercise without a set
 * count or a rep target, a logged set without reps, a planned weight with no logged weight,
 * or a weight whose unit is unknown on one side. The notes say which.
 */
export function judgeSession(session: SnapshotSession, plan: SnapshotDay, planUnit: Units | null): SessionJudgement {
  const notes: string[] = [];
  const missing: string[] = [];
  const all = plan.exercises.map(plannedExercise);
  if (all.length === 0) return { date: session.date, plan: "empty", notes: ["the plan for this date has no exercises"] };
  for (const p of all.filter((x) => x.timed)) notes.push(`${p.name}: timed, not judged (the history holds no durations)`);
  const planned = all.filter((x) => !x.timed);
  if (planned.length === 0) return { date: session.date, plan: "found", notes: [...notes, "unknown: no planned exercise has a rep target"] };
  let plannedSets = 0;
  let completed = 0;
  let shortSum = 0;
  let targetSum = 0;
  const drifts: number[] = [];
  let dropped = false;
  const used = new Set<HistoryExercise>();
  for (const p of planned) {
    if (p.sets === null) missing.push(`${p.name}: the plan has no set count`);
    if (p.repsMin === null || p.repsMin <= 0) missing.push(`${p.name}: the plan has no rep target`);
    if (p.sets === null || p.repsMin === null || p.repsMin <= 0) continue;
    plannedSets += p.sets;
    const logged = session.exercises.find((h) => !used.has(h) && matches(p, h));
    if (!logged) {
      notes.push(`${p.name}: planned ${p.sets} sets, none logged`);
      continue;
    }
    used.add(logged);
    // Physical sets: each logged set (a cluster's mini-sets) against the planned sets. Warm-ups are not work.
    const work = logged.sets.filter((x) => x.warmup !== true);
    if (work.some((x) => x.reps === null)) {
      missing.push(`${p.name}: a logged set has no reps`);
      continue;
    }
    const done = work.filter((x) => (x.reps as number) > 0).slice(0, p.sets);
    completed += done.length;
    for (const x of done) {
      targetSum += p.repsMin;
      shortSum += Math.max(0, p.repsMin - (x.reps as number));
      if (p.rpe !== null && x.rpe !== null) drifts.push(x.rpe - p.rpe);
    }
    if (p.weight !== null && p.weight > 0) {
      const weights = work.map((x) => x.weight).filter((w): w is number => typeof w === "number");
      if (weights.length === 0) {
        missing.push(`${p.name}: a weight was planned, but no logged set has one`);
        continue;
      }
      const logUnit = session.weightUnit ?? null;
      if ((planUnit === null) !== (logUnit === null)) {
        missing.push(`${p.name}: the weight unit is unknown on one side, so the top set cannot be compared`);
        continue;
      }
      let top = Math.max(...weights);
      if (planUnit && logUnit && planUnit !== logUnit) top = convertWeight(top, logUnit, planUnit);
      if (top < p.weight - 1e-9) {
        dropped = true;
        notes.push(`${p.name}: top set ${top} below the planned ${p.weight}`);
      }
    }
  }
  if (missing.length > 0) return { date: session.date, plan: "found", notes: [...notes, ...missing.map((m) => `unknown: ${m}`)] };
  if (drifts.length === 0) notes.push("no set has both a planned and a logged RPE: RPE drift unknown");
  const perf: SessionPerf = {
    date: session.date,
    planned_sets: plannedSets,
    completed_sets: completed,
    reps_shortfall_ratio: targetSum > 0 ? round(shortSum / targetSum) : 0,
    ...(drifts.length > 0 ? { rpe_drift: round(drifts.reduce((a, d) => a + d, 0) / drifts.length) } : {}),
    top_set_dropped: dropped,
  };
  return { date: session.date, plan: "found", perf, notes };
}

/** How far back an unplanned session looks for the last time an exercise was done (V6 L). */
export const UNPLANNED_LOOKBACK_DAYS = 28;

type TopSet = { weight: number | null; reps: number; rpe: number | null };

/** The heaviest work set (warm-ups and sets without reps left out); the most reps at that weight. Null when there is none. */
function topSet(ex: HistoryExercise): TopSet | null {
  const work = ex.sets.filter((x) => x.warmup !== true && typeof x.reps === "number" && x.reps > 0);
  if (work.length === 0) return null;
  const weighted = work.filter((x) => typeof x.weight === "number" && x.weight > 0);
  const pool = weighted.length > 0 ? weighted : work;
  const weight = weighted.length > 0 ? Math.max(...weighted.map((x) => x.weight as number)) : null;
  const at = pool.filter((x) => (weight === null ? true : x.weight === weight));
  const best = at.reduce((a, x) => ((x.reps as number) > (a.reps as number) ? x : a));
  return { weight, reps: best.reps as number, rpe: best.rpe ?? null };
}

const sameLogged = (a: HistoryExercise, b: HistoryExercise) =>
  a.exerciseId && b.exerciseId ? a.exerciseId === b.exerciseId : normalizeName(a.name ?? "") === normalizeName(b.name ?? "");

/**
 * A logged session on a date that was read and has no planned day (V6 L), judged against the
 * athlete's own history: for each exercise, the most recent earlier logged session of the same
 * exercise within 28 days, in the same unit after conversion.
 * - top_set_dropped: the top set's weight is lower than last time, or the same weight with fewer reps;
 * - rpe_drift: the mean of (top-set RPE − last time's top-set RPE) over exercises that have both;
 * - no plan, so no rep shortfall: planned_sets and completed_sets are the logged work sets.
 * An exercise with no earlier session, a last session without a usable top set (never an older
 * stand-in), or a unit known on one side only is not judged; a session in which no exercise can
 * be judged gives no SessionPerf.
 */
export function judgeUnplanned(session: SnapshotSession, history: SnapshotSession[]): SessionJudgement {
  const notes: string[] = [];
  const from = addDays(session.date, -UNPLANNED_LOOKBACK_DAYS);
  const earlier = history.filter((h) => h.date < session.date && h.date >= from).sort((x, y) => (x.date < y.date ? 1 : -1));
  const unit = session.weightUnit ?? null;
  let sets = 0;
  let judged = 0;
  let dropped = false;
  const drifts: number[] = [];
  for (const ex of session.exercises) {
    const now = topSet(ex);
    if (!now) {
      notes.push(`${ex.name}: no logged work set with reps, not judged`);
      continue;
    }
    let prevSession: SnapshotSession | undefined;
    let prevEx: HistoryExercise | undefined;
    // The most recent earlier session that has the exercise (V6b fix 2): an older session never
    // stands in for it, also when its sets cannot give a top set.
    for (const h of earlier) {
      const m = h.exercises.find((e) => sameLogged(e, ex));
      if (m) {
        prevSession = h;
        prevEx = m;
        break;
      }
    }
    if (!prevSession || !prevEx) {
      notes.push(`${ex.name}: no earlier session in the last ${UNPLANNED_LOOKBACK_DAYS} days, not judged`);
      continue;
    }
    const prev = topSet(prevEx);
    if (!prev) {
      notes.push(`${ex.name}: the last session (${prevSession.date}) has no work set with reps, not judged`);
      continue;
    }
    const prevUnit = prevSession.weightUnit ?? null;
    if ((now.weight === null) !== (prev.weight === null)) {
      notes.push(`${ex.name}: weighted one time and not the other, not judged`);
      continue;
    }
    let prevWeight = prev.weight;
    if (now.weight !== null && prevWeight !== null) {
      if ((unit === null) !== (prevUnit === null)) {
        notes.push(`${ex.name}: the weight unit is unknown on one side, not judged`);
        continue;
      }
      if (unit && prevUnit && unit !== prevUnit) prevWeight = convertWeight(prevWeight, prevUnit, unit);
    }
    judged++;
    sets += ex.sets.filter((x) => x.warmup !== true && typeof x.reps === "number" && x.reps > 0).length;
    const lower = now.weight !== null && prevWeight !== null && now.weight < prevWeight - 1e-9;
    const same = now.weight === null ? prevWeight === null : prevWeight !== null && Math.abs(now.weight - prevWeight) <= 1e-9;
    if (lower || (same && now.reps < prev.reps)) {
      dropped = true;
      notes.push(`${ex.name}: top set ${now.weight ?? "bodyweight"} × ${now.reps} below ${prevWeight ?? "bodyweight"} × ${prev.reps} on ${prevSession.date}`);
    } else notes.push(`${ex.name}: top set ${now.weight ?? "bodyweight"} × ${now.reps} against ${prevWeight ?? "bodyweight"} × ${prev.reps} on ${prevSession.date}`);
    if (now.rpe !== null && prev.rpe !== null) drifts.push(now.rpe - prev.rpe);
  }
  if (judged === 0) return { date: session.date, plan: "none", notes: [...notes, `session ${session.date} not judged: no plan and no earlier session to compare`] };
  if (drifts.length === 0) notes.push("no top set has an RPE both times: RPE drift unknown");
  const perf: SessionPerf = {
    date: session.date,
    planned_sets: sets,
    completed_sets: sets,
    reps_shortfall_ratio: 0,
    ...(drifts.length > 0 ? { rpe_drift: round(drifts.reduce((a, d) => a + d, 0) / drifts.length) } : {}),
    top_set_dropped: dropped,
  };
  return { date: session.date, plan: "none", perf, notes };
}

export type BuildInput = {
  root: string;
  date: CalendarDate;
  /** The current instant. A past date is judged as of 23:59 local on that date. */
  now: Instant;
  config: CoachConfig;
  rules: Rules;
  snapshot: Snapshot | null;
};

function ruleIdsOf(rules: Rules, type: string): { value: number | null; ids: string[] } {
  const hits = rules.rules.filter((r) => r.check?.type === type);
  const v = hits.length > 0 ? Number(hits[0].check!.value) : null;
  return { value: v !== null && Number.isInteger(v) && v > 0 ? v : null, ids: hits.map((r) => r.id) };
}

/** The pack's readiness checks; a check the pack lacks keeps the engine default. */
export function readinessRules(rules: Rules): ReadinessRules {
  const out: ReadinessRules = {};
  const single = ruleIdsOf(rules, "single_day_action");
  if (single.ids.length > 0) out.single_day_ids = single.ids;
  const short = ruleIdsOf(rules, "off_mornings_short_pattern");
  if (short.value !== null) out.short_pattern = { mornings: short.value, ids: short.ids };
  const long = ruleIdsOf(rules, "off_mornings_long_pattern");
  if (long.value !== null) out.long_pattern = { days: long.value, ids: long.ids };
  const pc = ruleIdsOf(rules, "program_change_min_categories");
  if (pc.value !== null) out.program_change = { categories: pc.value, ids: pc.ids };
  const av = ruleIdsOf(rules, "aversion_scale_max");
  if (av.value !== null) out.aversion = { max: av.value, ids: av.ids };
  return out;
}

/**
 * Why the history read cannot back a performance judgment, or null when it
 * can: it must exist, be complete (no pages left), be read in the last 15 minutes, and
 * cover the expiry window up to the date (`since` no later than date − perf_expiry_days,
 * `until` no earlier than the date; an absent bound means the read had none).
 */
export function coverageProblem(snap: Snapshot | null, date: CalendarDate, nowMs: number, expiryDays: number): string | null {
  const cov = snap?.history_coverage;
  if (!snap || !cov) return "no workout history read in this session (get_workout_history)";
  if (!cov.complete && snap.warnings?.length) return `the plans files have rows the engine cannot read (${snap.warnings[0]}): a session may be missing`;
  if (!cov.complete) return "the history read is incomplete (more pages remain): the latest session may be missing";
  const age = (nowMs - parseInstant(cov.captured_at, "history_coverage.captured_at")) / 60_000;
  if (age > SNAPSHOT_MAX_AGE_MIN) return `the history was read ${Math.round(age)} minutes ago (limit ${SNAPSHOT_MAX_AGE_MIN}): read get_workout_history again`;
  const from = addDays(date, -expiryDays);
  if (cov.since && cov.since > from) return `the history read starts ${cov.since}, after ${from}: earlier sessions are unknown`;
  if (cov.until && cov.until < date) return `the history read ends ${cov.until}, before ${date}: later sessions are unknown`;
  return null;
}

export function readinessForDate(b: BuildInput): ReadinessForDate {
  const tz = b.config.athlete.timezone;
  if (!isCalendarDate(b.date)) throw new CoachError("USAGE", "readiness --date needs YYYY-MM-DD");
  const nowMs = parseInstant(b.now, "now");
  const today = localDate(nowMs, tz);
  if (b.date > today) throw new CoachError("USAGE", `readiness --date ${b.date} is after today (${today})`);
  // A past date sees only what was known by the end of that day.
  const asOfMs = b.date < today ? zonedTimeToEpoch(b.date, "23:59", tz) + 59_999 : nowMs;
  const asOf = new Date(asOfMs).toISOString();
  const th = { ...DEFAULT_THRESHOLDS, ...b.config.thresholds };
  const notes: string[] = [];

  const rr = readinessRules(b.rules);
  // Enough days for the baseline of each morning in the long pattern, in one read.
  const lookback = th.baseline_window_days + (rr.long_pattern?.days ?? DEFAULT_LONG_PATTERN_DAYS) + 1;
  const signals = loadSignals({ root: b.root, from: addDays(b.date, -lookback), to: b.date, now: asOfMs });

  const judged: SessionJudgement[] = [];
  const sessions: SessionPerf[] = [];
  const snap = b.snapshot;
  const covProblem = coverageProblem(snap, b.date, nowMs, th.perf_expiry_days);
  if (covProblem) notes.push(`performance unknown: ${covProblem}`);
  else if (snap) {
    // Newest first, inside the expiry window. Stop at the first date that cannot be judged:
    // an older session never stands in for a newer one (contracts §5 "each session counts once").
    const window = snap.history
      .filter((s) => s.date <= b.date && diffDays(s.date, b.date) <= th.perf_expiry_days && s.exercises.length > 0)
      .sort((x, y) => (x.date < y.date ? 1 : -1));
    const dates = [...new Set(window.map((s) => s.date))];
    for (const d of dates) {
      const day = snap.days[d];
      if (!day) {
        judged.push({ date: d, plan: "missing", notes: [`no plan for ${d} in the snapshot: read it with get_planned_workout, or the session stays unknown`] });
        notes.push(`session ${d} not judged: its plan is not in the snapshot`);
        break;
      }
      if (!day.found) {
        // Read, and no planned day: judged against the athlete's own history (V6 L).
        const perDate = window.filter((s) => s.date === d).map((s) => judgeUnplanned(s, snap.history));
        judged.push(...perDate);
        if (perDate.some((j) => !j.perf)) {
          notes.push(`session ${d} not judged: no plan and no earlier session to compare`);
          break;
        }
        sessions.push(...perDate.map((j) => j.perf!));
        continue;
      }
      const unit = day.weightUnit ?? null;
      const perDate = window.filter((s) => s.date === d).map((s) => judgeSession(s, day, unit));
      judged.push(...perDate);
      if (perDate.some((j) => !j.perf)) {
        notes.push(`session ${d} not judged: the evidence is incomplete`);
        break;
      }
      sessions.push(...perDate.map((j) => j.perf!));
    }
  }

  const input: ReadinessInput = {
    today: b.date,
    now: asOf,
    tz,
    records: signals.records,
    sessions,
    sleep_target_min: b.config.athlete.sleep_target_min ?? DEFAULT_SLEEP_TARGET_MIN,
    thresholds: { ...b.config.thresholds },
    readiness_rules: rr,
  };
  const r = readiness(input);
  // A session that could not be judged makes performance unknown, with the reason.
  if (sessions.length === 0 && judged.some((j) => !j.perf)) {
    r.performance = { state: "unknown", reasons: judged.filter((j) => !j.perf).flatMap((j) => j.notes), sessions_used: [] };
  } else if (covProblem) {
    r.performance = { state: "unknown", reasons: [covProblem], sessions_used: [] };
  }
  return { ...r, inputs: { ...input, signals_warnings: signals.warnings, sessions_judged: judged, notes } };
}
