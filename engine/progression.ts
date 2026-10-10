// Reference week and next-week targets (contracts §8, §7 step 7).
import { addDays, diffDays, weekdayOf, weekStart } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { assertDaysInWeek, hardSets, weeklySetsByMuscle } from "./volume.ts";
import type { Block, BlockWeek, CalendarDate, CappedMuscle, Rules, Targets, Taxonomy, VolumeViolation, WeekKind, WeekLog } from "./types.ts";

export const DEFAULT_VOLUME_CAP = 0.1;
export const DEFAULT_DELOAD_DEPTH = { volume: 0.7, load: 0.7 };
const EPS = 1e-9;

/** The first rule in the pack with a check of this type. */
export function findCheck(rules: Rules | null | undefined, type: string): { id: string; value: unknown } | null {
  const r = rules?.rules.find((x) => x.check?.type === type);
  return r ? { id: r.id, value: r.check!.value } : null;
}

function assertMonday(date: CalendarDate, what: string): void {
  if (weekdayOf(date) !== "mon") throw new CoachError("NOT_A_MONDAY", `${what} must be a Monday: ${date}`);
}

export function blockWeekStart(block: Block, week: number): CalendarDate {
  assertMonday(block.start, "block.start");
  return addDays(block.start, 7 * (week - 1));
}

/** The block week that starts on `weekStart`, or null when it is outside the block. */
export function blockWeekAt(block: Block, weekStart: CalendarDate): BlockWeek | null {
  assertMonday(block.start, "block.start");
  const d = diffDays(block.start, weekStart);
  if (d < 0 || d % 7 !== 0) return null;
  return block.weeks.find((w) => w.week === d / 7 + 1) ?? null;
}

/** Distinct dates inside the week with at least one hard set logged. */
export function loggedSessions(log: WeekLog): number {
  assertDaysInWeek(log);
  return new Set(log.days.filter((d) => d.exercises.some((e) => hardSets(e) > 0)).map((d) => d.date)).size;
}

function logKind(block: Block, log: WeekLog): WeekKind {
  return log.kind ?? blockWeekAt(block, log.week_start)?.kind ?? "build";
}

/** "Completed" means at least 50% of the planned sessions were logged. */
export function isCompleted(block: Block, log: WeekLog): boolean {
  const planned = log.planned_sessions ?? blockWeekAt(block, log.week_start)?.sessions ?? block.template.days;
  return planned > 0 && loggedSessions(log) >= planned * 0.5 - EPS;
}

/**
 * The last completed build week that ended before the week holding `today`. Deload and
 * test weeks never count, and a missed week keeps the previous reference. Null means
 * bootstrap: the reference is block week 1 as planned.
 */
export function referenceWeek(block: Block, logs: WeekLog[], today: CalendarDate): WeekLog | null {
  const current = weekStart(today);
  let best: WeekLog | null = null;
  for (const log of logs) {
    assertMonday(log.week_start, "week_start");
    if (log.week_start >= current) continue;
    if (logKind(block, log) !== "build" || !isCompleted(block, log)) continue;
    if (!best || log.week_start > best.week_start) best = log;
  }
  return best;
}

/** The most sets the next week may plan for a muscle. A base under 10 sets allows +1. */
export function allowedSets(base: number, cap: number): number {
  if (base < 10) return base + Math.max(1, Math.floor(base * cap + EPS));
  return base + Math.floor(base * cap + EPS);
}

/** Muscles whose next-week sets exceed the cap over the reference (validate: hard rule). */
export function volumeIncreaseViolations(base: Record<string, number>, next: Record<string, number>, cap: number): VolumeViolation[] {
  const out: VolumeViolation[] = [];
  for (const [muscle, n] of Object.entries(next)) {
    const b = base[muscle] ?? 0;
    const allowed = allowedSets(b, cap);
    if (n > allowed) out.push({ muscle, base: b, next: n, allowed, increase_ratio: b > 0 ? (n - b) / b : null });
  }
  return out;
}

export type NextWeekOptions = {
  /** Needed to count the sets of a logged reference week. */
  tax?: Taxonomy;
  /**
   * The block week to plan. Required: it cannot be inferred from the reference, because
   * deload, test and missed weeks sit between them.
   */
  week?: number;
};

function readCap(rules: Rules, warnings: string[], ruleIds: string[]): number {
  const c = findCheck(rules, "weekly_volume_increase_max");
  if (!c) {
    warnings.push(`the pack has no weekly_volume_increase_max rule: using ${DEFAULT_VOLUME_CAP}`);
    return DEFAULT_VOLUME_CAP;
  }
  if (typeof c.value !== "number" || !(c.value >= 0)) throw new CoachError("RULE_INVALID", `${c.id}: weekly_volume_increase_max must be a fraction`);
  ruleIds.push(c.id);
  return c.value;
}

function readDepth(rules: Rules, warnings: string[], ruleIds: string[]): { volume: number; load: number } {
  const c = findCheck(rules, "deload_depth");
  if (!c) {
    warnings.push(`the pack has no deload_depth rule: using volume ${DEFAULT_DELOAD_DEPTH.volume}, load ${DEFAULT_DELOAD_DEPTH.load}`);
    return DEFAULT_DELOAD_DEPTH;
  }
  const v = c.value as { volume?: unknown; load?: unknown };
  if (typeof v?.volume !== "number" || typeof v?.load !== "number") throw new CoachError("RULE_INVALID", `${c.id}: deload_depth needs {volume, load}`);
  ruleIds.push(c.id);
  return { volume: v.volume, load: v.load };
}

/**
 * Targets for a block week: the block step, capped against the reference week. A deload
 * week keeps deload_depth of the reference volume and load. The week after a deload is
 * capped against the pre-deload reference (deload weeks are never the reference), so it
 * may return to that level plus at most one regular step.
 */
export function nextWeekTargets(block: Block, ref: WeekLog | null, rules: Rules, opts: NextWeekOptions = {}): Targets {
  const warnings: string[] = [];
  const ruleIds: string[] = [];

  if (opts.week === undefined) throw new CoachError("TARGET_WEEK_REQUIRED", "nextWeekTargets: opts.week is required (the block week to plan)");
  const weekNo = opts.week;
  const tw = block.weeks.find((w) => w.week === weekNo);
  if (!tw) throw new CoachError("BLOCK_WEEK_MISSING", `block ${block.id} has no week ${weekNo}`);

  let reference: Targets["reference"];
  if (ref) {
    if (!opts.tax) throw new CoachError("TAXONOMY_REQUIRED", "nextWeekTargets needs opts.tax to count the sets of a logged reference week");
    reference = { source: "log", week_start: ref.week_start, sets: weeklySetsByMuscle(ref, opts.tax) };
  } else {
    const w1 = block.weeks.find((w) => w.week === 1);
    if (!w1?.targets) throw new CoachError("BLOCK_WEEK_MISSING", `block ${block.id} week 1 has no targets to bootstrap from`);
    reference = { source: "bootstrap", week_start: blockWeekStart(block, 1), sets: { ...w1.targets } };
  }
  const base = reference.sets;
  const planned = { ...(tw.targets ?? {}) };
  const sets: Record<string, number> = {};
  const capped: CappedMuscle[] = [];
  let loadFactor = 1;

  if (tw.kind === "deload") {
    const depth = readDepth(rules, warnings, ruleIds);
    loadFactor = depth.load;
    for (const m of Object.keys(base)) {
      sets[m] = Math.round(base[m] * depth.volume);
      if (m in planned && planned[m] !== sets[m]) {
        warnings.push(`${m}: the block plans ${planned[m]} deload sets; the method depth gives ${sets[m]}`);
        if (planned[m] > sets[m]) capped.push({ muscle: m, base: base[m], planned: planned[m], allowed: sets[m] });
      }
    }
  } else {
    const cap = readCap(rules, warnings, ruleIds);
    if (Object.keys(planned).length === 0) {
      warnings.push(`week ${weekNo} has no targets: holding the reference`);
      Object.assign(planned, base);
    }
    for (const [m, p] of Object.entries(planned)) {
      const b = base[m] ?? 0;
      const allowed = allowedSets(b, cap);
      sets[m] = Math.min(p, allowed);
      if (p > allowed) capped.push({ muscle: m, base: b, planned: p, allowed });
    }
    const every = findCheck(rules, "deload_every_weeks");
    if (tw.kind === "build" && every && typeof every.value === "number") {
      let run = 0;
      for (let w = weekNo - 1; w >= 1; w--) {
        const k = block.weeks.find((x) => x.week === w)?.kind;
        if (k !== "build") break;
        run++;
      }
      if (run >= every.value) {
        warnings.push(`deload due: ${run} build weeks in a row before week ${weekNo} [${every.id}]`);
        ruleIds.push(every.id);
      }
    }
  }
  for (const c of capped) {
    if (tw.kind !== "deload") warnings.push(`${c.muscle}: planned ${c.planned} sets over a base of ${c.base}; capped at ${c.allowed}`);
  }

  return {
    week: weekNo,
    week_start: blockWeekStart(block, weekNo),
    kind: tw.kind,
    reference,
    sets: Object.fromEntries(Object.entries(sets).sort(([a], [b]) => (a < b ? -1 : 1))),
    planned: tw.targets ? { ...tw.targets } : {},
    load_factor: loadFactor,
    capped,
    rule_ids: ruleIds,
    warnings,
  };
}
