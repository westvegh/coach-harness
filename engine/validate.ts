// The guard (contracts §7): rebuild the result of a logger mutation and validate it, in
// a fixed order. The first deny wins. Any error is a deny with code GUARD_ERROR.
import { matchApproval, type ApprovalRecord } from "./approvals.ts";
import { canonicalJson } from "./canonical.ts";
import { validateBlock } from "./block.ts";
import { NEW_EXERCISE_WEEKS, addsWork, classifyChange, isRecoveryDay, isRecoveryExercise, isTrimOf, isUserDay, mergeClassified, sameExercise, toUnits, topWeight, type Classified } from "./classify.ts";
import { addDays, localDate, parseInstant, weekStart } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { loadLogger, type DayChange, type LoggerAdapter, type LoggerTool } from "./logger.ts";
import { blockWeekAt, findCheck, referenceWeek, volumeIncreaseViolations, DEFAULT_VOLUME_CAP } from "./progression.ts";
import { opIdProblem } from "./opid.ts";
import { isUrgentHold, loadSafetyTerms } from "./safety.ts";
import { SNAPSHOT_MAX_AGE_MIN, snapshotProblems } from "./snapshot.ts";
import { classify, classifyForSafety, normalizeName, regionMatches } from "./taxonomy.ts";
import { holdScope } from "./hold.ts";
import { hardSets, weeklySetsByMuscle } from "./volume.ts";
import type {
  Block,
  CalendarDate,
  ChangeKind,
  CoachConfig,
  DayLog,
  DayPlan,
  ExerciseEntry,
  Hold,
  Instant,
  Limit,
  Limits,
  PainEntry,
  Rules,
  SafetyPending,
  Snapshot,
  SnapshotDay,
  Taxonomy,
  Units,
  WeekLog,
  WeekPlan,
} from "./types.ts";

export type Mode = "interactive" | "unattended";

export type Verdict = {
  decision: "allow" | "ask" | "deny";
  reasons: string[];
  rule_ids: string[];
  warnings: string[];
  /** the change kinds and the approval used, for the log. */
  kinds?: ChangeKind[];
  big?: boolean;
  approval?: string;
  code?: string;
};

export type GuardInput = {
  /** The tool suffix (plan_workout_day, …) or the full MCP name. */
  tool: LoggerTool | string;
  args: unknown;
  mode: Mode;
  snapshot: Snapshot | null;
  limits: Limits;
  rules: Rules;
  tax: Taxonomy;
  config: CoachConfig;
  hold: Hold | null;
  pending: SafetyPending | null;
  approvals: ApprovalRecord[];
  now: Instant;
  session_id: string;
  // Guard additions (contracts §20 item 6; §7 names the inputs above):
  /** athlete/block.yaml; null when there is none. */
  block?: Block | null;
  /** Today's check-in pain (athlete/signals/<today>.json). */
  pain?: PainEntry[];
  /** limitsHash(athlete/limits.yaml), for approval records. */
  limits_hash?: string;
  /** Default: the adapter named in coach.yaml. */
  logger?: LoggerAdapter;
};

const EPS = 1e-9;
const MINUTES_PER_SET = 3;

class Deny extends Error {
  reasons: string[];
  rule_ids: string[];
  constructor(reasons: string[], rule_ids: string[] = []) {
    super(reasons.join("; "));
    this.reasons = reasons;
    this.rule_ids = rule_ids;
  }
}

/** Runs the guard. Never throws: an error is a deny with code GUARD_ERROR. */
export function guard(input: GuardInput): Verdict {
  try {
    return run(input);
  } catch (e) {
    if (e instanceof Deny) return { decision: "deny", reasons: e.reasons, rule_ids: e.rule_ids, warnings: [] };
    const msg = e instanceof CoachError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    return { decision: "deny", reasons: [`GUARD_ERROR: ${msg}`], rule_ids: [], warnings: [], code: "GUARD_ERROR" };
  }
}

function suffix(tool: string): string {
  const i = tool.lastIndexOf("__");
  return i >= 0 ? tool.slice(i + 2) : tool;
}

function checkInputs(i: GuardInput): void {
  const missing = (["tool", "mode", "limits", "rules", "tax", "config", "now", "session_id"] as const).filter((k) => i[k] === undefined || i[k] === null || i[k] === "");
  if (missing.length > 0) throw new CoachError("GUARD_ERROR", `missing guard inputs: ${missing.join(", ")}`);
  if (i.mode !== "interactive" && i.mode !== "unattended") throw new CoachError("GUARD_ERROR", `mode must be interactive | unattended, got ${JSON.stringify(i.mode)}`);
  if (!Array.isArray(i.approvals)) throw new CoachError("GUARD_ERROR", "approvals must be a list");
  if (typeof i.args !== "object" || i.args === null || Array.isArray(i.args)) throw new CoachError("GUARD_ERROR", "the tool input must be an object");
  // a malformed block (a NaN target, say) would silence the volume checks.
  if (i.block) validateBlock(i.block);
}

// ---------- weeks ----------

type WeekView = { week_start: CalendarDate; before: WeekPlan; after: WeekPlan };

function historyDay(s: Snapshot["history"][number], units: Units): DayLog {
  return {
    date: s.date,
    exercises: s.exercises.map((e) => ({
      exerciseId: e.exerciseId || null,
      name: e.name,
      muscle: e.muscle || null,
      unit: s.weightUnit ?? units,
      sets: e.sets.map((x) => ({ weight: x.weight, reps: x.reps, rpe: x.rpe })),
    })),
  };
}

/** Logged weeks from the snapshot history, Monday to Sunday. */
export function historyWeeks(snap: Snapshot, units: Units): WeekLog[] {
  const weeks = new Map<CalendarDate, WeekLog>();
  for (const s of snap.history) {
    const ws = weekStart(s.date);
    if (!weeks.has(ws)) weeks.set(ws, { week_start: ws, days: [] });
    weeks.get(ws)!.days.push(historyDay(s, units));
  }
  return [...weeks.values()].sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
}

function weekViews(changes: DayChange[], afterPlans: Map<CalendarDate, DayPlan | null>, snap: Snapshot, ctx: { logger: LoggerAdapter; units: Units; today: CalendarDate }): WeekView[] {
  const starts = [...new Set(changes.map((c) => weekStart(c.date)))].sort();
  return starts.map((ws) => {
    const end = addDays(ws, 6);
    const before: DayPlan[] = [];
    for (const [d, day] of Object.entries(snap.days)) {
      if (d >= ws && d <= end && day.found) before.push(ctx.logger.toDayPlan(d, day, ctx.units));
    }
    // Past days with no planned day read: what was logged.
    for (const s of snap.history) {
      if (s.date >= ws && s.date <= end && s.date < ctx.today && !snap.days[s.date]?.found) before.push({ ...historyDay(s, ctx.units), status: "completed" });
    }
    const after = before.filter((d) => !afterPlans.has(d.date));
    for (const [d, plan] of afterPlans) if (d >= ws && d <= end && plan) after.push(plan);
    const sort = (xs: DayPlan[]) => xs.sort((a, b) => (a.date < b.date ? -1 : 1));
    return { week_start: ws, before: { week_start: ws, days: sort(before) }, after: { week_start: ws, days: sort(after) } };
  });
}

function setsByMuscle(days: DayPlan[], tax: Taxonomy): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of days) {
    if (d.status === "skipped") continue;
    for (const ex of d.exercises) {
      const n = hardSets(ex);
      for (const m of classify(ex, tax).muscles) out[m] = (out[m] ?? 0) + n;
    }
  }
  return out;
}

// ---------- limits ----------

function nameIs(n: string, ex: ExerciseEntry): boolean {
  const k = normalizeName(n);
  return k !== "" && (k === normalizeName(ex.name ?? "") || (!!ex.exerciseId && k === normalizeName(ex.exerciseId)));
}

function idIs(n: string, ex: ExerciseEntry): boolean {
  const k = normalizeName(n);
  return k !== "" && !!ex.exerciseId && k === normalizeName(ex.exerciseId);
}

export type LimitMatch = { matches: boolean; conflict: boolean };

/**
 * Whether a limit applies to the exercise: by name or exerciseId, or by pattern unless an
 * `allow` entry exempts it. An `allow` entry binds to the exerciseId first:
 * when it matches only the display name and the exerciseId by itself classifies to a
 * limited pattern, the exercise is an identity conflict and the limit applies.
 */
export function limitMatch(limit: Limit, ex: ExerciseEntry, tax: Taxonomy): LimitMatch {
  if (limit.exercises.some((n) => nameIs(n, ex))) return { matches: true, conflict: false };
  const pats = classify(ex, tax).patterns;
  const patternHit = pats.some((p) => limit.patterns.includes(p));
  if (limit.allow.some((n) => idIs(n, ex))) return { matches: false, conflict: false };
  if (limit.allow.some((n) => nameIs(n, ex))) {
    const byId = ex.exerciseId ? classify({ exerciseId: ex.exerciseId, name: "" }, tax).patterns : [];
    if (byId.some((p) => limit.patterns.includes(p))) return { matches: true, conflict: true };
    return { matches: false, conflict: false };
  }
  return { matches: patternHit, conflict: false };
}

export function limitMatches(limit: Limit, ex: ExerciseEntry, tax: Taxonomy): boolean {
  return limitMatch(limit, ex, tax).matches;
}

function matchingSets(days: DayPlan[], limit: Limit, tax: Taxonomy): number {
  let n = 0;
  for (const d of days) {
    if (d.status === "skipped") continue;
    for (const ex of d.exercises) if (limitMatches(limit, ex, tax)) n += hardSets(ex);
  }
  return n;
}

// ---------- update_user_profile ----------

function regionWords(region: string): string[] {
  const spaced = region.replace(/-/g, " ");
  return [...new Set([region, spaced])];
}

function mentions(text: string, region: string): boolean {
  const t = ` ${normalizeName(text)} `;
  return regionWords(region).some((w) => t.includes(` ${normalizeName(w)} `));
}

function profileVerdict(i: GuardInput, args: Record<string, unknown>): Verdict {
  const reasons: string[] = [];
  for (const k of ["limits", "injuries"]) {
    if (k in args && args[k] === null) reasons.push(`update_user_profile may not clear ${k}: the guard enforces athlete/limits.yaml, and the profile must keep naming it`);
  }
  const text = typeof args.limits === "string" ? args.limits : typeof args.injuries === "string" ? args.injuries : null;
  if (text !== null) {
    const old = i.snapshot?.profile && typeof i.snapshot.profile.limits === "string" ? (i.snapshot.profile.limits as string) : null;
    const regions = [...new Set(i.limits.limits.map((l) => l.region))];
    // A region named in limits.yaml that the profile names now (or, when the profile was
    // not read, every limits.yaml region) must stay in the new text.
    const keep = regions.filter((r) => (old === null ? true : mentions(old, r)));
    for (const r of keep) if (!mentions(text, r)) reasons.push(`update_user_profile drops the region ${r}, which athlete/limits.yaml names`);
  }
  if (reasons.length > 0) return { decision: "deny", reasons, rule_ids: [], warnings: [], kinds: ["limit_change"], big: true };
  const kinds: ChangeKind[] = text !== null ? ["limit_change"] : [];
  if (i.mode === "unattended") return { decision: "deny", reasons: ["update_user_profile is never allowed in an unattended run"], rule_ids: [], warnings: [], kinds, big: true };
  return { decision: "ask", reasons: ["update_user_profile: confirm the profile change with the user"], rule_ids: [], warnings: [], kinds, big: true };
}

// ---------- update_training_limits (Tally T3) ----------

/**
 * A change to Tally's server limits is a limit change: it asks in an interactive run (the
 * user's yes) and is denied in an unattended run. MCP can only add rules and lower caps.
 */
function trainingLimitsVerdict(i: GuardInput, warnings: string[]): Verdict {
  const kinds: ChangeKind[] = ["limit_change"];
  if (i.mode === "unattended") return { decision: "deny", reasons: ["update_training_limits is a limit change, never allowed in an unattended run"], rule_ids: [], warnings, kinds, big: true };
  return { decision: "ask", reasons: ["update_training_limits: confirm the Tally limit change with the user (it can only add rules and lower caps)"], rule_ids: [], warnings, kinds, big: true };
}

// ---------- the guard ----------

function run(i: GuardInput): Verdict {
  // 1. Inputs present and valid.
  checkInputs(i);
  const tool = suffix(String(i.tool));
  const logger = i.logger ?? loadLogger(i.config.logger);
  if (!logger.isMutation(tool)) throw new CoachError("GUARD_ERROR", `not a ${logger.config.name} mutation: ${tool}`);
  const args = i.args as Record<string, unknown>;
  const units = i.config.athlete.units;
  const today = localDate(i.now, i.config.athlete.timezone);
  const caps = logger.config.capabilities;
  const warnings: string[] = [];
  const asks: string[] = [];
  const ruleIds = new Set<string>();

  // 2. Snapshot.
  let dates: CalendarDate[];
  try {
    dates = logger.affectedDates(tool, args);
  } catch (e) {
    throw new Deny([(e as Error).message]);
  }
  const snapProblems = snapshotProblems(i.snapshot, i.session_id, i.now, dates);
  if (snapProblems.length > 0) throw new Deny(snapProblems);
  const snap = i.snapshot!;

  if (tool === "update_user_profile") {
    try {
      logger.rebuild(tool, args, snap);
    } catch (e) {
      throw new Deny([(e as Error).message]);
    }
    if (i.pending || i.hold?.active) warnings.push("a hold or a pending safety check is active");
    return profileVerdict(i, args);
  }

  if (tool === "update_training_limits") {
    try {
      logger.rebuild(tool, args, snap);
    } catch (e) {
      throw new Deny([(e as Error).message]);
    }
    return trainingLimitsVerdict(i, warnings);
  }

  // 3. Versions.
  const versionDenials: string[] = [];
  const existing = (d: CalendarDate): SnapshotDay | null => (snap.days[d]?.found ? snap.days[d] : null);
  if (typeof args.opId === "string" && !caps.opId) versionDenials.push(`${tool}: opId needs the logger's operation records (Tally T2); this adapter does not declare them`);
  else if (typeof args.opId === "string") {
    // an opId is bound to its call.
    const problem = opIdProblem(args.opId, { tool, args });
    if (problem) versionDenials.push(`opId ${args.opId} is not the engine's opId for this call: ${problem}`);
  }
  if (tool === "plan_workout_range") {
    if (!caps.rangeCreateIfAbsent) versionDenials.push("plan_workout_range is denied until the logger can create only on empty dates (Tally T2); plan one day at a time");
    else {
      // a range only creates. Every day carries ifAbsent: true, so Tally skips
      // a date that gained a day after the read (code exists) instead of overwriting it.
      const days = Array.isArray(args.days) ? args.days : [];
      for (const day of days) {
        const spec = typeof day === "object" && day !== null ? (day as Record<string, unknown>) : {};
        if (spec.ifAbsent !== true) versionDenials.push(`plan_workout_range day ${String(spec.date ?? "?")} must carry ifAbsent: true (a range only creates on empty dates)`);
      }
    }
    for (const d of dates) if (existing(d)) versionDenials.push(`plan_workout_range over ${d}, which already has a day`);
  } else if (tool === "skip_planned_workout" && args.skip !== false && (i.pending || i.hold?.active)) {
    // safer is always allowed. Under a hold or a pending safety check a skip
    // is allowed for any day, user days included, attended or not.
    let changes: DayChange[];
    try {
      changes = logger.rebuild(tool, args, snap);
    } catch (e) {
      throw new Deny([(e as Error).message]);
    }
    const kinds: ChangeKind[] = changes.some((c) => isUserDay(c.before)) ? ["skip_or_delete_user_day"] : ["trim_session"];
    return { decision: "allow", reasons: ["a skip under a hold or a pending safety check: safer, always allowed"], rule_ids: [], warnings, kinds, big: false };
  } else if ((tool === "skip_planned_workout" || tool === "delete_planned_workout") && !caps.versionedSkipDelete) {
    const msg = `${tool} carries no version until Tally T2`;
    if (i.mode === "unattended") versionDenials.push(`${msg}: denied in an unattended run`);
    else asks.push(`${msg}: confirm with the user`);
  } else {
    const d = tool === "move_planned_workout" ? (args.fromDate as string) : (args.date as string);
    const day = existing(d);
    if (tool === "plan_workout_day" && args.ifAbsent === true && day) {
      versionDenials.push(`${d} has a day: ifAbsent: true would be skipped (code exists); read it and pass expectedVersion to change it`);
    } else if (day) {
      // with Tally T2, skip and delete carry expectedVersion like every other
      // write to an existing day, in both modes. (No day: the rebuild says not found.)
      if (typeof args.expectedVersion !== "string") {
        versionDenials.push(
          args.expectedUpdatedAt !== undefined
            ? `${d} has a day: expectedUpdatedAt alone is denied (it has no row identity); pass expectedVersion from get_planned_workout`
            : `${d} has a day: the write must carry expectedVersion from get_planned_workout`,
        );
      } else if (args.expectedVersion !== day.version) {
        versionDenials.push(`expectedVersion for ${d} is not the version in the snapshot; refresh: read the affected days with get_planned_workout first`);
      }
    }
  }
  if (versionDenials.length > 0) throw new Deny(versionDenials);

  // 4. Rebuild.
  let changes: DayChange[];
  try {
    changes = logger.rebuild(tool, args, snap);
  } catch (e) {
    throw new Deny([(e as Error).message]);
  }
  const callUnit = args.weightUnit === "kg" || args.weightUnit === "lbs" ? (args.weightUnit as Units) : undefined;
  const beforePlan = (c: DayChange) => (c.before ? logger.toDayPlan(c.date, c.before, units) : null);
  const afterPlan = (c: DayChange) => (c.after ? logger.toDayPlan(c.date, c.after, callUnit ?? units) : null);
  const afterPlans = new Map<CalendarDate, DayPlan | null>(changes.map((c) => [c.date, afterPlan(c)]));
  const afterDays = [...afterPlans.values()].filter((d): d is DayPlan => d !== null);
  const isSkip = tool === "skip_planned_workout" && args.skip !== false;
  const weeks = weekViews(changes, afterPlans, snap, { logger, units, today });

  // a week whose sets this call raises is checked on fresh evidence only:
  // every day of it was read with get_planned_workout in the last 15 minutes, or lies on
  // or after a fresh training-context listing that does not list it (an empty date).
  const rising = new Map<CalendarDate, string[]>();
  for (const w of weeks) {
    const b = setsByMuscle(w.before.days, i.tax);
    const a = setsByMuscle(w.after.days, i.tax);
    const up = Object.keys(a).filter((m) => a[m] > (b[m] ?? 0));
    if (up.length > 0) rising.set(w.week_start, up);
  }

  // 5. Safety.
  const safety: string[] = [];
  const urgent = urgentEvent(i.hold, i.pending);
  if (urgent && !isSkip) {
    // An urgent warning sign is its own state (launch review finding 3): no exercise prescription at
    // all, trims and recovery workouts included. A note on an unchanged day, a rest day
    // (no exercises), a skip or a delete passes.
    for (const c of changes) {
      const after = afterPlans.get(c.date);
      if (!after || after.status === "skipped" || after.exercises.length === 0) continue;
      // Compare the full logger exercises (every field: distance, per side, rest, …), not
      // the engine's plan: only a note or a name may change.
      if (c.before && c.after && canonicalJson(c.before.exercises ?? []) === canonicalJson(c.after.exercises ?? []) && after.status === (beforePlan(c)?.status ?? after.status)) continue;
      safety.push(`${urgent}: ${c.date} gets no exercise; only a note, a rest day or a skip is allowed (stop exercising; see a clinician)`);
    }
  } else if ((i.pending || i.hold?.active) && !isSkip) {
    // A hold with regions is regional (P1): it denies only the exercises that load a held
    // region, and unclassified ones (fail closed). A hold without regions (a systemic
    // symptom) and the pending file (regions not known yet) stay global. A region id that the
    // taxonomy does not know makes the hold global too (P2 fix 2), and the reason says so.
    const scope = i.hold?.active ? holdScope(i.hold, i.tax) : { regions: [], unknown: [] };
    const unknownNote = scope.unknown.length > 0 ? `; unknown region id ${scope.unknown.join(", ")}, so it holds like a hold with no regions` : "";
    const why = i.pending ? "a safety check is pending (athlete/.safety-pending)" : `a training hold is active (${i.hold?.reason ?? "no reason"}${unknownNote})`;
    const held = !i.pending ? scope.regions : [];
    for (const c of changes) {
      const after = afterPlans.get(c.date);
      if (!after || after.status === "skipped") continue;
      const before = beforePlan(c);
      const sameContent = before && JSON.stringify(before.exercises) === JSON.stringify(after.exercises) && before.status === after.status;
      // a trim (fewer or equal sets, load and reps) is safer: allowed under a hold.
      // A recovery day passes only when it adds no work to an exercise it keeps.
      if (sameContent || (isRecoveryDay(after, i.tax) && addsWork(before, after, units) === null) || (before && after.date === before.date && isTrimOf(before, after, units))) continue;
      if (held.length === 0) {
        safety.push(`${why}: ${c.date} must be a recovery or rest day`);
        continue;
      }
      for (const ex of after.exercises) {
        // The exerciseId and the name both (P2 fix 3): a new name cannot hide a held region.
        const cl = classifyForSafety(ex, i.tax);
        if (cl.source === "none") {
          safety.push(`${why}: ${ex.name} (${c.date}) is unclassified under a regional hold; classify it first`);
          continue;
        }
        // The taxonomy names no region for conditioning (zone 2, intervals), but a bike or
        // an interval run still loads a knee. So under a regional hold such an exercise passes
        // only as a recovery exercise that adds no work to itself (the recovery-day test).
        // Each pattern on its own (P2 fix 6): another pattern's regions never exempt it.
        const regionless = cl.patterns.filter((p) => i.tax.patterns[p].loads.length === 0 && (cl.regions.length === 0 || !i.tax.patterns[p].recovery));
        if (regionless.length > 0) {
          const extra = isRecoveryExercise(ex, i.tax) ? addsWork(before, { ...after, exercises: [ex] }, units) : "not a recovery exercise";
          if (extra) safety.push(`${why}: ${ex.name} (${c.date}) loads no named region in ${regionless.join(", ")}, so under a regional hold it must be a recovery exercise that adds no work (${extra})`);
        }
        const hit = held.find((r) => regionMatches(r, cl.regions, i.tax));
        if (hit) safety.push(`${why}: ${ex.name} (${c.date}) loads a held region (${hit}); remove it, or the day must be a recovery or rest day`);
      }
    }
  }
  const painful = (i.pain ?? []).filter((p) => p.score >= i.limits.pain_threshold);
  if (painful.length > 0 && !isSkip) {
    for (const day of afterDays) {
      for (const ex of day.exercises) {
        const c = classifyForSafety(ex, i.tax);
        if (c.source === "none") {
          safety.push(`check-in pain today and ${ex.name} (${day.date}) is unclassified; classify it first`);
          continue;
        }
        for (const p of painful) if (regionMatches(p.region, c.regions, i.tax)) safety.push(`check-in pain today in ${p.region} (${p.score}/10): ${ex.name} (${day.date}) loads it`);
      }
    }
  }
  if (safety.length > 0) throw new Deny([...new Set(safety)]);

  // Before the weekly checks (steps 6 and 7): fresh evidence for each rising week.
  for (const ws of rising.keys()) {
    const missing = weekEvidenceGaps(snap, ws, i.now);
    if (missing.length > 0) {
      throw new Deny([`the week check needs fresh evidence for every day of the week of ${ws}: read ${missing.join(", ")} with get_planned_workout first (within ${SNAPSHOT_MAX_AGE_MIN} minutes)`]);
    }
  }

  // 6. Limits.
  const limitDenials: string[] = [];
  const active = i.limits.limits;
  if (!isSkip) {
    for (const day of afterDays) {
      for (const ex of day.exercises) {
        if (active.length > 0 && classify(ex, i.tax).source === "none") {
          limitDenials.push(`${ex.name} (${day.date}) is unclassified while limits are active; classify it first (athlete/movements.local.yaml)`);
          continue;
        }
        for (const l of active) {
          const lm = limitMatch(l, ex, i.tax);
          if (!lm.matches) continue;
          if (lm.conflict) {
            limitDenials.push(`${ex.name} (${day.date}): identity conflict — the name is in the ${l.id} allow list, but exerciseId ${ex.exerciseId} is a limited pattern`);
          } else if (l.rule === "ban") {
            limitDenials.push(`${ex.name} (${day.date}) is banned by ${l.id} (${l.region}${l.note ? `: ${l.note}` : ""})`);
          } else if (l.max_load) {
            const max = toUnits(l.max_load.value, l.max_load.unit, units);
            for (const s of ex.sets) {
              if (typeof s.weight !== "number") continue;
              const w = toUnits(s.weight, ex.unit, units);
              if (w > max + EPS) {
                limitDenials.push(`${ex.name} (${day.date}): ${round(w)} ${units} is over the ${l.id} cap of ${round(max)} ${units} (${l.region})`);
                break;
              }
            }
          }
        }
      }
    }
    for (const l of active) {
      if (l.rule !== "cap" || l.max_sets_per_week === undefined) continue;
      for (const w of weeks) {
        const after = matchingSets(w.after.days, l, i.tax);
        const before = matchingSets(w.before.days, l, i.tax);
        if (after > l.max_sets_per_week && after > before) {
          limitDenials.push(`${after} sets in the week of ${w.week_start} for ${l.id} (${l.region}); the cap is ${l.max_sets_per_week} a week`);
        }
      }
    }
  }
  if (limitDenials.length > 0) throw new Deny([...new Set(limitDenials)]);

  // 7. Hard rules.
  const hard: string[] = [];
  const hardIds: string[] = [];
  const volRule = findCheck(i.rules, "weekly_volume_increase_max");
  const cap = typeof volRule?.value === "number" ? volRule.value : DEFAULT_VOLUME_CAP;
  if (!volRule) warnings.push(`the pack has no weekly_volume_increase_max rule: using ${DEFAULT_VOLUME_CAP}`);
  for (const w of weeks) {
    const before = setsByMuscle(w.before.days, i.tax);
    const after = setsByMuscle(w.after.days, i.tax);
    const up = rising.get(w.week_start) ?? [];
    if (up.length === 0) continue;
    if (volRule) ruleIds.add(volRule.id);
    let base: Record<string, number> | null = null;
    let baseLabel = "";
    if (i.block) {
      const bw = blockWeekAt(i.block, w.week_start);
      const isFirstWeek = bw?.week === 1;
      const hp = isFirstWeek ? null : historyProblem(snap, today, i.now);
      if (hp) throw new Deny([`the volume check needs the logged weeks: ${hp}`]);
      const ref = referenceWeek(i.block, historyWeeks(snap, units), w.week_start);
      if (ref) {
        base = weeklySetsByMuscle(ref, i.tax);
        baseLabel = `the reference week ${ref.week_start}`;
      } else {
        const w1 = i.block.weeks.find((x) => x.week === 1);
        if (w1?.targets) {
          base = { ...w1.targets };
          baseLabel = "block week 1 as planned (no completed build week yet)";
        }
      }
    }
    if (!base) {
      for (const m of up) hard.push(`${m}: ${before[m] ?? 0} → ${after[m]} sets in the week of ${w.week_start}, and there is no reference week (no block): volume may not rise`);
      continue;
    }
    for (const v of volumeIncreaseViolations(base, after, cap)) {
      if (!up.includes(v.muscle)) continue;
      const pct = v.increase_ratio === null ? "new" : `+${round(v.increase_ratio * 100)}%`;
      hard.push(`${v.muscle}: ${v.next} sets in the week of ${w.week_start} against ${v.base} in ${baseLabel} (${pct}); the most allowed is ${v.allowed}${volRule ? ` [${volRule.id}]` : ""}`);
      if (volRule) hardIds.push(volRule.id);
    }
  }
  const jumpRule = findCheck(i.rules, "top_set_jump_max");
  if (jumpRule && typeof jumpRule.value === "number" && !isSkip) {
    for (const c of changes) {
      const after = afterPlans.get(c.date);
      if (!after) continue;
      // A move keeps the content: compare with the source day.
      const before = tool === "move_planned_workout" ? beforePlan(changes[0]) : beforePlan(c);
      for (const ex of after.exercises) {
        const top = topWeight(ex, units);
        if (top === null) continue;
        const prev = before?.exercises.find((b) => sameExercise(ex, b));
        const prevTop = prev ? topWeight(prev, units) : null;
        if (prevTop !== null && top <= prevTop + EPS) continue; // not raised by this call
        const hp = historyProblem(snap, today, i.now);
        if (hp) throw new Deny([`${ex.name} (${after.date}): the top-set check needs the logged sessions: ${hp}`]);
        const last = lastTopSet(ex, snap, units, today);
        if (last === null || last <= 0) continue;
        if (top > last * (1 + jumpRule.value) + EPS) {
          hard.push(`${ex.name} (${after.date}): top set ${round(top)} ${units} against the last logged ${round(last)} ${units} (+${round((top / last - 1) * 100)}%); the most allowed is +${round(jumpRule.value * 100)}% [${jumpRule.id}]`);
          hardIds.push(jumpRule.id);
        }
      }
    }
  }
  if (hard.length > 0) throw new Deny([...new Set(hard)], [...new Set(hardIds)]);

  // 8. Consent.
  const parts: Classified[] = [];
  const ctxBase = { block: i.block ?? null, history: snap.history, tax: i.tax, rules: i.rules, config: i.config, today, tool: tool as LoggerTool };
  const volumeFor = (d: CalendarDate) => {
    const w = weeks.find((x) => x.week_start === weekStart(d))!;
    return { week_start: w.week_start, before: setsByMuscle(w.before.days, i.tax), after: setsByMuscle(w.after.days, i.tax) };
  };
  if (tool === "move_planned_workout") {
    const [from, to] = changes;
    parts.push(classifyChange(beforePlan(from), afterPlans.get(to.date) ?? null, { ...ctxBase, snapshotDay: from.before, volume: volumeFor(to.date) }));
  } else {
    for (const c of changes) parts.push(classifyChange(beforePlan(c), afterPlans.get(c.date) ?? null, { ...ctxBase, snapshotDay: c.before, volume: volumeFor(c.date) }));
  }
  const cls = mergeClassified(parts, { config: i.config });
  const reasons: string[] = [...cls.reasons];
  let approval: string | undefined;
  const denials: string[] = [];

  const userDays = changes.filter((c) => isUserDay(c.before)).map((c) => c.date);
  if (args.overrideUserModified === true || userDays.length > 0) {
    const what = userDays.length > 0 ? `changes a day the user built or edited (${userDays.join(", ")})` : "sets overrideUserModified";
    if (i.mode === "unattended") denials.push(`${tool} ${what}: never allowed in an unattended run`);
    else asks.push(`${tool} ${what}: confirm with the user`);
  }
  if (cls.big) {
    const label = cls.kinds.length > 0 ? cls.kinds.join(", ") : "unclassified change";
    if (i.mode === "interactive") asks.push(`a big change (${label}): confirm with the user`);
    else {
      const m = matchApproval({ tool, args }, i.approvals, snap, i.limits_hash ?? "");
      if (m.record) approval = m.record.proposal_id;
      else denials.push(`a big change (${label}) needs an approved proposal in an unattended run: ${m.problems.join("; ")}`);
    }
  }
  if (denials.length > 0) return { decision: "deny", reasons: [...denials, ...reasons], rule_ids: [...ruleIds], warnings, kinds: cls.kinds, big: cls.big };

  // 9. Soft rules.
  const minutesRule = findCheck(i.rules, "session_minutes_max");
  if (minutesRule && typeof minutesRule.value === "number") {
    for (const day of afterDays) {
      if (day.status === "skipped") continue;
      const min = day.exercises.reduce((t, ex) => t + ex.sets.reduce((u, s) => u + (typeof s.duration_s === "number" && s.duration_s > 0 ? s.duration_s / 60 : MINUTES_PER_SET), 0), 0);
      if (min > minutesRule.value) warnings.push(`${day.date}: about ${Math.round(min)} minutes, over ${minutesRule.value} [${minutesRule.id}]`);
    }
  }
  const rangeRule = findCheck(i.rules, "weekly_sets_per_muscle_range");
  if (rangeRule && Array.isArray(rangeRule.value)) {
    const [lo, hi] = rangeRule.value as [number, number];
    for (const w of weeks) {
      const before = setsByMuscle(w.before.days, i.tax);
      const after = setsByMuscle(w.after.days, i.tax);
      for (const [m, n] of Object.entries(after)) {
        if (n === (before[m] ?? 0)) continue;
        if (n < lo || n > hi) warnings.push(`${m}: ${n} sets in the week of ${w.week_start}, outside ${lo}-${hi} [${rangeRule.id}]`);
      }
    }
  }

  const decision = asks.length > 0 ? "ask" : "allow";
  return {
    decision,
    reasons: decision === "ask" ? [...asks, ...reasons] : reasons,
    rule_ids: [...ruleIds],
    warnings,
    kinds: cls.kinds,
    big: cls.big,
    ...(approval ? { approval } : {}),
  };
}

/**
 * Null when the snapshot's history is evidence: a valid, complete read (no pages left)
 * that covers at least the last 8 weeks up to yesterday. Else the problem.
 */
export function historyProblem(snap: Snapshot, today: CalendarDate, now: Instant): string | null {
  const c = snap.history_coverage;
  if (!c) return "read get_workout_history first";
  const age = (parseInstant(now, "now") - parseInstant(c.captured_at, "history captured_at")) / 60_000;
  if (age > SNAPSHOT_MAX_AGE_MIN) return `the history read is ${Math.round(age)} minutes old: read get_workout_history again`;
  if (!c.complete) return "the history read is partial (more pages): read the remaining pages of get_workout_history first";
  if (c.since && c.since > addDays(today, -7 * NEW_EXERCISE_WEEKS)) return `the history read is partial (since ${c.since}): read get_workout_history over at least the last ${NEW_EXERCISE_WEEKS} weeks`;
  if (c.until && c.until < addDays(today, -1)) return `the history read is partial (until ${c.until}): read get_workout_history up to today`;
  return null;
}

/** Dates of the week with no fresh evidence. */
export function weekEvidenceGaps(snap: Snapshot, ws: CalendarDate, now: Instant): CalendarDate[] {
  const nowMs = parseInstant(now, "now");
  const fresh = (at: string) => (nowMs - parseInstant(at, "captured_at")) / 60_000 <= SNAPSHOT_MAX_AGE_MIN;
  const L = snap.planned && fresh(snap.planned.captured_at) ? snap.planned : null;
  const out: CalendarDate[] = [];
  for (let k = 0; k < 7; k++) {
    const d = addDays(ws, k);
    const day = snap.days[d];
    if (day && fresh(day.captured_at)) continue;
    if (L && d >= L.from && !(d in L.dates)) continue;
    out.push(d);
  }
  return out;
}

function round(x: number): number {
  return Math.round(x * 10) / 10;
}

let urgentTermNames: Set<string> | null = null;

/**
 * Why an urgent event is active, or null (launch review finding 3): a pending safety file with an
 * urgent term, or an active hold that is urgent (the flag, the word "urgent" in its reason,
 * or an urgent term in its reason).
 */
export function urgentEvent(hold: Hold | null, pending: SafetyPending | null): string | null {
  if (!hold?.active && !pending) return null;
  const terms = loadSafetyTerms();
  urgentTermNames ??= new Set(terms.urgent.map((e) => e.term));
  const hit = pending?.terms.find((t) => urgentTermNames!.has(t));
  if (hit) return `an urgent warning sign is pending (${hit})`;
  if (hold?.active && isUrgentHold(hold, terms)) {
    return "an urgent hold is active";
  }
  return null;
}

/** The heaviest set of the latest logged session (on or before today) that holds the exercise. */
export function lastTopSet(ex: ExerciseEntry, snap: Snapshot, units: Units, today: CalendarDate): number | null {
  const sessions = [...snap.history].filter((s) => s.date <= today).sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const s of sessions) {
    const hits = s.exercises.filter((h) => sameExercise(ex, h));
    if (hits.length === 0) continue;
    let best: number | null = null;
    for (const h of hits) for (const x of h.sets) if (typeof x.weight === "number") best = Math.max(best ?? 0, toUnits(x.weight, s.weightUnit ?? units, units));
    if (best !== null) return best;
  }
  return null;
}

export type { Limits, Rules, Taxonomy, CoachConfig, Hold, SafetyPending, Snapshot };
