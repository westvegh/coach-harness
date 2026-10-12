// Shared types for the coach-harness engine. Source of truth: docs/contracts.md.
// Section numbers (§) refer to that file.
//
// Decisions made on 2026-10-09 (in docs/contracts.md §16):
// 1. "Hard-rule kinds" in §1 are the big kinds below (BigChangeKind). A kind in neither
//    approval list is treated as `ask`.
// 2. Performance amber (§5): shortfall = max(reps_shortfall_ratio, 1 − completed/planned);
//    a dropped top set is also amber.
// 3. "Any scale at 1" (§5) applies after inversion (soreness 5 counts as 1).
// 4. nextWeekTargets (§8) takes a 4th parameter {tax, week}; `week` is required.
// 5. `Block` (athlete/block.yaml) is defined here.
// 6. deload_depth {volume: 0.7, load: 0.7} means the deload week keeps 70% (rounded).
// Also: the small kind `annotate` (only notes or dayName change; allowed under a hold).

// ---------- §0 conventions ----------

/** A calendar date, YYYY-MM-DD, in the athlete's timezone. */
export type CalendarDate = string;
/** An ISO 8601 instant with an offset. */
export type Instant = string;
export type Units = "lbs" | "kg";

// ---------- §1 coach.yaml ----------

export type SmallChangeKind =
  | "trim_session"
  | "swap_to_recovery"
  | "load_progression"
  | "reschedule_within_week"
  | "annotate"
  | "block_session";
export type BigChangeKind =
  | "new_exercise"
  | "volume_above_plan"
  | "override_user_day"
  | "skip_or_delete_user_day"
  | "limit_change"
  | "new_block"
  | "method_change";
export type ChangeKind = SmallChangeKind | BigChangeKind;

export type Emphasis = "all-around" | "strength" | "hypertrophy" | "endurance" | "general-health";
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type CoachConfig = {
  version: 1;
  /** sleep_target_min: optional; readiness uses DEFAULT_SLEEP_TARGET_MIN (480) without it. */
  athlete: { name: string; timezone: string; units: Units; sleep_target_min?: number };
  method: string;
  template: { days: 3 | 4 | 5; emphasis: Emphasis };
  signals: { wearable: "apple-health-shortcut" | "oura" | "none"; checkin: "shortcut" | "chat" };
  /** Where plans live (v0.2): Tally, the week files under plans/, or another tool the athlete connected. */
  logger: "tally" | "files" | "other";
  /** True once the coach has mentioned Tally to an athlete who logs by hand (never repeated). */
  tally_mentioned: boolean;
  /** logger_health_notes: symptoms, regions, pain scores and readiness reasons may go into logger notes (v0.2 default true; false keeps the notes generic). */
  consent: { logger_health_notes: boolean };
  automation: {
    mode: "cloud" | "mac" | "manual";
    daily_window: { start: string; end: string };
    weekly: { day: Weekday; time: string };
    verified: boolean;
    /** The connected logger's tool-name prefix for the Mac allowlist (launch review finding 7). */
    tool_prefix?: string;
  };
  approval: { auto: ChangeKind[]; ask: ChangeKind[] };
  thresholds: Partial<Thresholds>;
};

// ---------- §2 limits.yaml ----------

export type Limit = {
  id: string;
  region: string;
  rule: "ban" | "cap";
  patterns: string[];
  exercises: string[];
  allow: string[];
  max_load?: { value: number; unit: Units };
  max_sets_per_week?: number;
  /** A cap that rises: the `week` skill asks once a week how the region felt and raises the cap when it felt fine. */
  build_back?: boolean;
  note?: string;
  source: "athlete" | "clinician-reported";
  since: CalendarDate;
};

export type Limits = { version: 1; pain_threshold: number; limits: Limit[] };

// ---------- §3 movement taxonomy ----------

export type MovementPattern = { loads: string[]; muscles: string[]; recovery: boolean };

export type Taxonomy = {
  version: 1;
  regions: string[];
  patterns: Record<string, MovementPattern>;
  /** Normalized lowercase keyword → patterns. The longest match wins. */
  keywords: Record<string, string[]>;
  /** Exact name or exerciseId → patterns. Beats keywords. */
  exercises: Record<string, string[]>;
};

export type ExerciseRef = { exerciseId?: string | null; name: string; muscle?: string | null };

export type Classification = {
  patterns: string[];
  regions: string[];
  muscles: string[];
  source: "exercise" | "keyword" | "none";
  /** The patterns of each source entry: an exercises entry or one keyword match (P3 fix 2). */
  groups?: string[][];
};

// ---------- §4 method pack (the subset the engine reads) ----------

export type RuleCheck = { type: string; value: unknown };
export type Rule = {
  id: string;
  text: string;
  kind: "sourced" | "policy";
  severity: "hard" | "soft";
  source?: { ref: string; at: string };
  check?: RuleCheck;
};
export type Rules = { pack: string; version: number; rules: Rule[] };

// ---------- §5 readiness ----------

export type Scale = 1 | 2 | 3 | 4 | 5;
export type PainEntry = { region: string; score: number };

export type DayRecord = {
  date: CalendarDate;
  source: string;
  observed_at: Instant;
  complete: boolean;
  sleep?: { duration_min: number; start_at: Instant; end_at: Instant; efficiency?: number };
  hrv?: { value_ms: number; method: "rmssd" | "sdnn" };
  rhr?: { bpm: number };
  vendor_score?: number;
  /** want_to_train (optional): 1 means aversion, not wanting to train at all (contracts §5). */
  subjective?: { sleep_quality: Scale; energy: Scale; soreness: Scale; stress: Scale; want_to_train?: Scale; pain?: PainEntry[] };
};

export type SessionPerf = {
  date: CalendarDate;
  planned_sets: number;
  completed_sets: number;
  reps_shortfall_ratio: number;
  rpe_drift?: number;
  top_set_dropped: boolean;
};

export type Thresholds = {
  baseline_days_min: number;
  baseline_window_days: number;
  hrv_z_amber: number;
  hrv_z_red: number;
  rhr_z_amber: number;
  rhr_z_red: number;
  sleep_ratio_amber: number;
  subjective_amber: number;
  subjective_red: number;
  perf_shortfall_amber: number;
  rpe_drift_amber: number;
  perf_expiry_days: number;
  trim_fraction: number;
};

export type ReadinessInput = {
  today: CalendarDate;
  now: Instant;
  tz: string;
  records: DayRecord[];
  sessions: SessionPerf[];
  sleep_target_min: number;
  thresholds?: Partial<Thresholds>;
  /** The pack's readiness checks (readiness --date reads them); defaults when absent. */
  readiness_rules?: ReadinessRules;
};

/** The method pack's readiness rules, by check type, with the IDs of the rules that carry them. */
export type ReadinessRules = {
  /** single_day_action: one day's flags give a note at most. */
  single_day_ids?: string[];
  /** off_mornings_short_pattern (default 3). */
  short_pattern?: { mornings: number; ids: string[] };
  /** off_mornings_long_pattern (default 7). */
  long_pattern?: { days: number; ids: string[] };
  /** program_change_min_categories (default 3): of physiology, check-in and performance. */
  program_change?: { categories: number; ids: string[] };
  /** aversion_scale_max (default 1): a want-to-train answer at or below it is aversion. */
  aversion?: { max: number; ids: string[] };
};

/** One morning of one signal against the athlete's own band: off (outside it), ok, or unknown (no reading or no baseline). */
export type MorningState = "off" | "ok" | "unknown";

export type ReadinessPattern = {
  /** The last long-pattern days of mornings, oldest first, the date last. */
  mornings: { date: CalendarDate; hrv: MorningState; rhr: MorningState }[];
  /** Consecutive off-mornings ending on the date: HRV below its band, RHR above its band, or either. */
  off_mornings: { hrv: number; rhr: number; either: number };
  /** The run of off-mornings (either signal) that the short and long patterns read. */
  days_of_decline: number;
  short: boolean;
  long: boolean;
};

export type CategoryState = "green" | "amber" | "red" | "unknown";

export type Readiness = {
  date: CalendarDate;
  wearable: { state: CategoryState; reasons: string[]; calibrating: boolean; observed_at?: Instant };
  subjective: { state: CategoryState; reasons: string[] };
  performance: { state: CategoryState; reasons: string[]; sessions_used: string[] };
  known: number;
  decision: "none" | "note" | "trim" | "recovery" | "propose_deload";
  /** Why the decision, in order. */
  decision_reasons: string[];
  /** True when today's load progression must wait: decision trim, recovery or propose_deload. */
  hold_progression: boolean;
  /** The check-in's want-to-train answer is at or below the aversion line. */
  aversion: boolean;
  /** The long pattern with all three kinds of evidence (the program-change signal), whatever today's decision. */
  deload_signal: boolean;
  pattern: ReadinessPattern;
  rule_ids: string[];
  pain: PainEntry[];
};

// ---------- plans, logs and blocks (§6, §8, §12) ----------

export type SetEntry = {
  weight?: number | null;
  reps?: number | null;
  duration_s?: number | null;
  rpe?: number | null;
  /** Distance in meters (Tally distanceMeters), only when the logger sets one. */
  distance_m?: number | null;
  /** Warm-up sets are not hard sets. */
  warmup?: boolean;
};

export type ExerciseEntry = {
  exerciseId?: string | null;
  name: string;
  muscle?: string | null;
  unit?: Units;
  /** Each set is done once per side (Tally perSide), only when true. */
  perSide?: boolean;
  sets: SetEntry[];
};

export type DayPlan = {
  date: CalendarDate;
  dayName?: string;
  dayType?: string;
  notes?: string;
  status?: "planned" | "skipped" | "completed";
  source?: string;
  userModified?: boolean;
  exercises: ExerciseEntry[];
};

export type WeekKind = "build" | "deload" | "test";

/** A planned week, Monday to Sunday in the athlete's timezone. */
export type WeekPlan = { week_start: CalendarDate; days: DayPlan[] };

export type DayLog = { date: CalendarDate; exercises: ExerciseEntry[] };

/** A logged week. `kind` and `planned_sessions` fall back to the block when absent. */
export type WeekLog = {
  week_start: CalendarDate;
  kind?: WeekKind;
  planned_sessions?: number;
  days: DayLog[];
};

export type BlockSlot = {
  pattern: string;
  adaptation: string;
  sets: number;
  reps?: string | number;
  duration?: string | number;
  rest_s?: number;
  exercise?: string;
};

export type BlockDay = { day: Weekday; focus: string; slots: BlockSlot[] };

export type BlockWeek = {
  week: number;
  kind: WeekKind;
  sessions: number;
  /** Planned hard sets per muscle for the week (the block step). */
  targets?: Record<string, number>;
};

/** athlete/block.yaml. Not yet in contracts.md; proposed for contracts v2. */
export type Block = {
  version: 1;
  id: string;
  method: string;
  template: { days: 3 | 4 | 5; emphasis: Emphasis };
  /** A Monday. Week n starts on start + 7 × (n − 1) days. */
  start: CalendarDate;
  weeks: BlockWeek[];
  days: BlockDay[];
};

export type CappedMuscle = { muscle: string; base: number; planned: number; allowed: number };

export type Targets = {
  week: number;
  week_start: CalendarDate;
  kind: WeekKind;
  reference: { source: "log" | "bootstrap"; week_start: CalendarDate; sets: Record<string, number> };
  /** Planned sets per muscle after the cap. */
  sets: Record<string, number>;
  /** The block's planned sets per muscle before the cap. */
  planned: Record<string, number>;
  /** 1 for build and test weeks; deload_depth.load for deload weeks. */
  load_factor: number;
  capped: CappedMuscle[];
  rule_ids: string[];
  warnings: string[];
};

export type VolumeViolation = {
  muscle: string;
  base: number;
  next: number;
  allowed: number;
  increase_ratio: number | null;
};

// ---------- §9 snapshot ----------

export type HistorySet = { weight: number | null; reps: number | null; rpe: number | null };
export type HistoryExercise = { exerciseId: string; name: string; muscle: string; sets: HistorySet[] };

/**
 * One exercise as the logger stores it (for Tally: the get_planned_workout shape, with
 * suggestedSets, suggestedWeight and so on). The adapter's toDayPlan converts it (§12).
 */
export type LoggerExercise = Record<string, unknown>;

/**
 * A day as last read from the logger. `found: false` records a read that found
 * no day on the date: the guard needs it to know the date is empty.
 */
export type SnapshotDay = {
  found: boolean;
  version: string | null;
  updatedAt: string | null;
  source: string;
  userModified: boolean;
  skipped: boolean;
  dayName?: string;
  dayType?: string;
  notes?: string;
  exercises: LoggerExercise[];
  /** The logger's weight unit for this day, and whether the logger knows it. */
  weightUnit?: Units;
  weightUnitSource?: string;
  captured_at: Instant;
};

/** A logged session, as captured from the logger's history read. */
export type SnapshotSession = { date: CalendarDate; name?: string; weightUnit?: Units; exercises: HistoryExercise[] };

/** A future day the logger listed in its training context (no exercise detail, no version). */
export type PlannedListing = { dayName: string; source: string; userModified: boolean; skipped: boolean; exerciseCount: number };

export type Snapshot = {
  version: 1;
  session_id: string;
  captured_at: Instant;
  timezone: string;
  days: Record<CalendarDate, SnapshotDay>;
  history: SnapshotSession[];
  /**
   * What the history reads cover. Absent: no valid history read. `complete`
   * is false while more pages remain. `since`/`until` echo the requested range.
   */
  history_coverage?: { captured_at: Instant; complete: boolean; since?: CalendarDate; until?: CalendarDate };
  profile?: Record<string, unknown> | null;
  /** From the training-context read: every planned day from `planned_from` on. */
  planned?: { captured_at: Instant; from: CalendarDate; dates: Record<CalendarDate, PlannedListing> };
  /** The logger's weight unit for the athlete, and whether the logger knows it. */
  weightUnit?: Units;
  weightUnitSource?: string;
  /** Files logger only: rows or cells the engine could not read; the history is then incomplete (V2b fix 1). */
  warnings?: string[];
};

// ---------- §10 the urgent stop ----------

/** athlete/.urgent-stop: term names, sources and the time only, never the athlete's words. */
export type UrgentStop = { version: 1; at: Instant; terms: string[]; sources: UrgentSource[] };
/** `legacy`: converted from a v0.1 urgent hold or pending file at the first v0.2 session. */
export type UrgentSource = "chat" | "checkin" | "note" | "answer" | "legacy";
/** One line of athlete/log/urgent-clearances.jsonl. */
export type UrgentClearance = { date: CalendarDate; at: Instant; terms: string[]; sources: UrgentSource[]; reason: "clinician" | "false-alarm" };

// ---------- §11 signals ----------

export type ShortcutSignalFile = {
  version: 1;
  date: CalendarDate;
  source: "apple-health-shortcut";
  submitted_at: Instant;
  sleep?: { start_at: Instant; end_at: Instant; duration_min: number };
  hrv?: { value_ms: number; method: "rmssd" | "sdnn"; samples?: number };
  rhr?: { bpm: number };
  checkin?: { sleep_quality: Scale; energy: Scale; soreness: Scale; stress: Scale; pain?: PainEntry[] };
};
