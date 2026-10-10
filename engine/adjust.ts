// Day adjustments for a readiness decision (contracts §15): trim a session, or swap it
// for a recovery day.
import { CoachError } from "./errors.ts";
import { DEFAULT_THRESHOLDS } from "./readiness.ts";
import { classify, normalizeName, regionMatches } from "./taxonomy.ts";
import type { Count, Template } from "./methods.ts";
import type { DayPlan, ExerciseEntry, Hold, Limits, SetEntry, Taxonomy, Thresholds } from "./types.ts";

export type AdjustContext = {
  tax: Taxonomy;
  thresholds: Partial<Thresholds>;
  /** The pack template; its recovery slots shape the recovery day. */
  template?: Template;
  limits: Limits;
  /** An active hold's regions are never loaded by a recovery day. */
  hold?: Hold | null;
  /** The planned session length in minutes. Default: estimated from the day (see estimateMinutes). */
  planned_minutes?: number;
};

export type AdjustResult = { day: DayPlan; changes: string[] };

/** Seconds per set without a duration: about 40 s of work plus 90 s of rest. */
export const SECONDS_PER_REP_SET = 130;

/** Exercise names for the recovery patterns. Each one classifies back to its pattern. */
const RECOVERY_NAMES: Record<string, string> = {
  zone2_cardio: "Zone 2 Cardio",
  mobility: "Mobility Flow",
  breathing: "Box Breathing",
};

/** Used when no template is given: the pack's recovery slots (4-day template, day 2 and 4). */
const DEFAULT_RECOVERY_SLOTS: { pattern: string; seconds: number }[] = [
  { pattern: "zone2_cardio", seconds: 2400 },
  { pattern: "mobility", seconds: 600 },
  { pattern: "breathing", seconds: 300 },
];

function isRecoveryExercise(ex: ExerciseEntry, tax: Taxonomy): boolean {
  const c = classify(ex, tax);
  return c.patterns.length > 0 && c.patterns.every((p) => tax.patterns[p]?.recovery === true);
}

function trimFraction(th: Partial<Thresholds>): number {
  const f = th.trim_fraction ?? DEFAULT_THRESHOLDS.trim_fraction;
  if (typeof f !== "number" || !(f > 0 && f < 1)) throw new CoachError("BAD_THRESHOLD", `trim_fraction must be between 0 and 1, got ${JSON.stringify(f)}`);
  return f;
}

function label(ex: ExerciseEntry): string {
  return ex.name || ex.exerciseId || "exercise";
}

/**
 * Trim: for every exercise with a loaded (non-recovery) pattern, hard sets drop by
 * round(sets × trim_fraction), to a minimum of 1. The last hard sets go; warm-ups, loads,
 * reps and the exercise order stay. Unclassified exercises count as loaded.
 */
function trimDay(day: DayPlan, ctx: AdjustContext): AdjustResult {
  const f = trimFraction(ctx.thresholds);
  const changes: string[] = [];
  const exercises = day.exercises.map((ex) => {
    if (isRecoveryExercise(ex, ctx.tax)) return structuredClone(ex);
    const hard = ex.sets.filter((s) => s.warmup !== true).length;
    if (hard === 0) return structuredClone(ex);
    const keep = Math.max(1, hard - Math.round(hard * f));
    if (keep === hard) return structuredClone(ex);
    let kept = 0;
    const sets: SetEntry[] = [];
    for (const s of ex.sets) {
      if (s.warmup === true) sets.push({ ...s });
      else if (kept < keep) {
        sets.push({ ...s });
        kept++;
      }
    }
    changes.push(`${label(ex)}: ${hard} → ${keep} sets`);
    return { ...structuredClone(ex), sets };
  });
  return { day: { ...structuredClone(day), exercises }, changes };
}

/** Minutes of a planned day: timed sets count their duration; other sets count SECONDS_PER_REP_SET. */
export function estimateMinutes(day: DayPlan): number {
  let s = 0;
  for (const ex of day.exercises) for (const set of ex.sets) s += typeof set.duration_s === "number" && set.duration_s > 0 ? set.duration_s : SECONDS_PER_REP_SET;
  return s / 60;
}

function countMin(c: Count | undefined): number | null {
  if (typeof c === "number") return c;
  if (Array.isArray(c)) return c[0];
  return null;
}

/** The template's recovery slots, one per pattern, in order of first appearance. */
function recoverySlots(ctx: AdjustContext): { pattern: string; seconds: number }[] {
  if (!ctx.template) return DEFAULT_RECOVERY_SLOTS;
  const out: { pattern: string; seconds: number }[] = [];
  for (const d of ctx.template.week) {
    for (const s of d.slots) {
      if (ctx.tax.patterns[s.pattern]?.recovery !== true || out.some((o) => o.pattern === s.pattern)) continue;
      out.push({ pattern: s.pattern, seconds: countMin(s.duration) ?? 600 });
    }
  }
  return out.length > 0 ? out : DEFAULT_RECOVERY_SLOTS;
}

/**
 * True when a limit names the exercise or one of its patterns (a recovery
 * pattern loads no region, so only the pattern list can ban it). A name in the limit's
 * `allow` list beats its patterns, as in the guard (§7.6); a named exercise stays out.
 * Caps count too: a recovery day never brings in a pattern that a limit is about.
 */
function limitedByLimit(name: string, patterns: string[], limits: Limits): boolean {
  const n = normalizeName(name);
  return limits.limits.some((l) => {
    if (l.exercises.some((e) => normalizeName(e) === n)) return true;
    const allowed = l.allow.some((a) => normalizeName(a) === n);
    return !allowed && l.patterns.some((p) => patterns.includes(p));
  });
}

/** Splits `total` whole seconds in proportion to `weights`; the parts sum to `total` exactly. */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, w) => a + w, 0);
  const raw = weights.map((w) => (w * total) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, x) => a + x, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k].i]++;
  return out;
}

const fmtMin = (s: number) => `${Math.round((s / 60) * 10) / 10} min`;

/**
 * Recovery: the day becomes the template's recovery slots (Zone 2 cardio, mobility,
 * breathing), with the same total duration as the planned session, to the second (§15). The longest slot takes what the others leave after their template
 * duration; when that is under 5 minutes, every slot scales in proportion. An exercise is
 * left out when it loads a limited or held region, or when a limit names it or one of its
 * patterns. A planned length of 0 gives a rest day (no exercises).
 */
function recoveryDay(day: DayPlan, ctx: AdjustContext): AdjustResult {
  const planned = ctx.planned_minutes ?? estimateMinutes(day);
  if (!(Number.isFinite(planned) && planned >= 0)) throw new CoachError("BAD_INPUT", `planned_minutes must be a number of 0 or more`);
  const target = Math.round(planned * 60);
  const blocked = [...ctx.limits.limits.map((l) => l.region), ...(ctx.hold?.active ? ctx.hold.regions : [])];
  const slots = recoverySlots(ctx).filter((s) => {
    const name = RECOVERY_NAMES[s.pattern] ?? s.pattern.replace(/_/g, " ");
    const c = classify({ name }, ctx.tax);
    if (!c.patterns.every((p) => ctx.tax.patterns[p]?.recovery === true) || c.patterns.length === 0) return false;
    if (blocked.some((r) => regionMatches(r, c.regions, ctx.tax))) return false;
    return !limitedByLimit(name, c.patterns, ctx.limits);
  });
  if (slots.length === 0) throw new CoachError("NO_RECOVERY_SLOTS", "no recovery exercise passes the limits and the hold");

  const { dayType: _dropped, ...base } = structuredClone(day);
  if (target === 0) {
    return { day: { ...base, dayName: "Rest", exercises: [] }, changes: [`${day.dayName ?? "session"} → rest day (nothing planned to match)`] };
  }
  const fill = slots.reduce((best, s, i) => (s.seconds > slots[best].seconds ? i : best), 0);
  let secs = slots.map((s) => s.seconds);
  const fixed = secs.reduce((a, s, i) => (i === fill ? a : a + s), 0);
  if (target - fixed >= 5 * 60) secs[fill] = target - fixed;
  else secs = apportion(target, secs);

  const exercises: ExerciseEntry[] = slots.map((s, i) => ({
    name: RECOVERY_NAMES[s.pattern] ?? s.pattern.replace(/_/g, " "),
    sets: [{ duration_s: secs[i] }],
  })).filter((e) => (e.sets[0].duration_s ?? 0) > 0);
  const out: DayPlan = { ...base, dayName: "Recovery", exercises };
  const changes = [
    `${day.dayName ?? "session"} → recovery day, ${fmtMin(target)} (planned ${fmtMin(target)})`,
    ...exercises.map((e) => `${e.name}: ${fmtMin(e.sets[0].duration_s ?? 0)}`),
  ];
  return { day: out, changes };
}

export function adjustDay(day: DayPlan, decision: "trim" | "recovery", ctx: AdjustContext): AdjustResult {
  if (!day || !Array.isArray(day.exercises)) throw new CoachError("BAD_INPUT", "adjustDay needs a DayPlan with exercises");
  if (decision === "trim") return trimDay(day, ctx);
  if (decision === "recovery") return recoveryDay(day, ctx);
  throw new CoachError("BAD_INPUT", `decision must be trim or recovery, got ${JSON.stringify(decision)}`);
}
