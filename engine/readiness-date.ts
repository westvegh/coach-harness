// readiness --date. Builds the readiness input (contracts
// §5) from the athlete's files, so the model does no arithmetic:
// - records: engine/signals.ts over the baseline window up to the date;
// - sessions: each logged session in the snapshot history, judged against THAT date's own
//   plan (the snapshot day read with get_planned_workout), never today's plan;
// - sleep target: coach.yaml athlete.sleep_target_min (default 480);
// - the readiness rules and their IDs: the method pack's check types (contracts §4).
// Missing evidence is unknown, never estimated: a session without its plan is not judged,
// and an older session never stands in for it.
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
  plan: "found" | "missing" | "empty";
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
      if (!day || !day.found) {
        judged.push({ date: d, plan: "missing", notes: [`no plan for ${d} in the snapshot: read it with get_planned_workout, or the session stays unknown`] });
        notes.push(`session ${d} not judged: its plan is not in the snapshot`);
        break;
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
