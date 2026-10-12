// Change classification (contracts §6). The model's own label is ignored: the kinds come
// from the before and after days, the block, the history and coach.yaml `approval`.
import { canonicalJson } from "./canonical.ts";
import { addDays, weekStart } from "./dates.ts";
import { blockWeekAt, findCheck } from "./progression.ts";
import { classify, classifyForSafety, normalizeName } from "./taxonomy.ts";
import type { LoggerTool } from "./logger.ts";
import type { Block, CalendarDate, ChangeKind, CoachConfig, DayPlan, ExerciseEntry, Rules, SnapshotDay, SnapshotSession, Taxonomy, Units } from "./types.ts";
import { SMALL_KINDS } from "./config.ts";

export type SessionHistory = SnapshotSession[];

export type ClassifyContext = {
  block: Block | null;
  history: SessionHistory;
  tool: LoggerTool;
  /** The snapshot day the tool changes (for a move: the source day). */
  snapshotDay?: SnapshotDay | null;
  tax: Taxonomy;
  rules: Rules;
  config: CoachConfig;
  today: CalendarDate;
  /** Sets per muscle of the week holding `after`, before and after the whole call. */
  volume?: { week_start: CalendarDate; before: Record<string, number>; after: Record<string, number> };
};

export type Classified = { kinds: ChangeKind[]; big: boolean; reasons: string[] };

export const NEW_EXERCISE_WEEKS = 8;
const LB_PER_KG = 1 / 0.45359237;

// ---------- helpers shared with validate ----------

/** A weight in `to` units (exact factor, no rounding). */
export function toUnits(weight: number, from: Units | undefined, to: Units): number {
  if (!from || from === to) return weight;
  return to === "lbs" ? weight * LB_PER_KG : weight / LB_PER_KG;
}

/** True when two exercises are the same: by exerciseId when both have one, else by normalized name. */
export function sameExercise(a: { exerciseId?: string | null; name: string }, b: { exerciseId?: string | null; name: string }): boolean {
  if (a.exerciseId && b.exerciseId && a.exerciseId === b.exerciseId) return true;
  const na = normalizeName(a.name ?? "");
  return na !== "" && na === normalizeName(b.name ?? "");
}

/** The heaviest planned set of an exercise, in `units`; null when no set carries a weight. */
export function topWeight(ex: ExerciseEntry, units: Units): number | null {
  let best: number | null = null;
  for (const s of ex.sets) {
    if (s.warmup || typeof s.weight !== "number") continue;
    const w = toUnits(s.weight, ex.unit, units);
    if (best === null || w > best) best = w;
  }
  return best;
}

function maxReps(ex: ExerciseEntry): number {
  return Math.max(0, ...ex.sets.filter((s) => !s.warmup).map((s) => s.reps ?? 0));
}

function maxOf(ex: ExerciseEntry, f: (s: ExerciseEntry["sets"][number]) => number | null | undefined): number | null {
  const xs = ex.sets.map(f).filter((x): x is number => typeof x === "number");
  return xs.length > 0 ? Math.max(...xs) : null;
}

function hardSetCount(ex: ExerciseEntry): number {
  return ex.sets.filter((s) => !s.warmup).length;
}

/**
 * Why `a` asks more than `b` in a way that top load, reps and hard sets do not show, or
 * null: per side (it doubles the work), a longer distance or duration, a higher RPE, more
 * sets with warm-ups, or a heavier warm-up. Each makes a change more work, never a trim.
 */
export function extraWork(a: ExerciseEntry, b: ExerciseEntry, units: Units): string | null {
  if (a.perSide === true && b.perSide !== true) return "it becomes per side";
  // Conservative: the maximum rises, or any kept set position gains (set i of after against
  // set i of before), so a rise below the old maximum still counts.
  const more = (f: (s: ExerciseEntry["sets"][number]) => number | null | undefined) => {
    const [x, y] = [maxOf(a, f), maxOf(b, f)];
    if (x !== null && (y === null || x > y + 1e-9)) return true;
    for (let i = 0; i < Math.min(a.sets.length, b.sets.length); i++) {
      const [xi, yi] = [f(a.sets[i]), f(b.sets[i])];
      if (typeof xi === "number" && (typeof yi !== "number" || xi > yi + 1e-9)) return true;
    }
    return false;
  };
  if (more((s) => s.distance_m)) return "the distance rises";
  if (more((s) => s.duration_s)) return "the duration rises";
  if (more((s) => s.rpe)) return "the RPE rises";
  if (a.sets.length > b.sets.length) return "sets rise (warm-ups included)";
  // A warm-up above every set of before (a heavier top set is a load change, seen elsewhere).
  const heaviest = (ex: ExerciseEntry, warmupOnly: boolean) => maxOf(ex, (s) => (typeof s.weight === "number" && (!warmupOnly || s.warmup) ? toUnits(s.weight, ex.unit, units) : null));
  const [wa, wb] = [heaviest(a, true), heaviest(b, false)];
  if (wa !== null && (wb === null || wa > wb + 1e-9)) return "a warm-up is heavier than every set before";
  return null;
}

/**
 * Why `after` asks more of an exercise it keeps from `before`, or null: extra work
 * (extraWork), more hard sets, a heavier top set or more reps. A recovery day that adds
 * work to an existing exercise is not a safe swap.
 */
export function addsWork(before: DayPlan | null, after: DayPlan, units: Units): string | null {
  if (!before) return null;
  for (const a of after.exercises) {
    const b = before.exercises.find((x) => sameExercise(a, x));
    if (!b) continue;
    const extra = extraWork(a, b, units);
    if (extra) return `${a.name}: ${extra}`;
    if (hardSetCount(a) > hardSetCount(b)) return `${a.name}: more sets`;
    const [ta, tb] = [topWeight(a, units), topWeight(b, units)];
    if (ta !== null && (tb === null || ta > tb + 1e-9)) return `${a.name}: a heavier top set`;
    if (maxReps(a) > maxReps(b)) return `${a.name}: more reps`;
  }
  return null;
}

/**
 * A trim: every exercise of `after` is on `before`, with fewer or equal hard sets, top
 * load and reps, and no extra work (extraWork) (safer, so allowed under a hold).
 */
export function isTrimOf(before: DayPlan, after: DayPlan, units: Units): boolean {
  return after.exercises.every((a) => {
    const b = before.exercises.find((x) => sameExercise(a, x));
    if (!b) return false;
    const [ta, tb] = [topWeight(a, units), topWeight(b, units)];
    if (ta !== null && (tb === null || ta > tb + 1e-9)) return false;
    if (extraWork(a, b, units) !== null) return false;
    return hardSetCount(a) <= hardSetCount(b) && maxReps(a) <= maxReps(b);
  });
}

export function isRecoveryExercise(ex: ExerciseEntry, tax: Taxonomy): boolean {
  // The id and the name both (P2 fix 3): a recovery name on a loaded exerciseId is not recovery.
  const c = classifyForSafety(ex, tax);
  return c.source !== "none" && c.patterns.length > 0 && c.regions.length === 0 && c.patterns.every((p) => tax.patterns[p]?.recovery === true);
}

/** A recovery day: at least one exercise, every one a recovery pattern, nothing loaded. */
export function isRecoveryDay(day: DayPlan, tax: Taxonomy): boolean {
  return day.exercises.length > 0 && day.exercises.every((e) => isRecoveryExercise(e, tax));
}

export function isUserDay(day: SnapshotDay | null | undefined): boolean {
  return !!day && day.found && (day.source !== "mcp" || day.userModified);
}

function inBlock(ex: ExerciseEntry, block: Block | null, tax: Taxonomy): boolean {
  if (!block) return false;
  const pats = classify(ex, tax).patterns;
  for (const d of block.days ?? []) {
    for (const s of d.slots ?? []) {
      if (s.exercise) {
        if (sameExercise(ex, { name: s.exercise, exerciseId: s.exercise })) return true;
      } else if (pats.includes(s.pattern)) return true;
    }
  }
  return false;
}

/**
 * contracts §6 block_session: every exercise matches a slot of the block (by exerciseId,
 * then normalized name, then pattern for a slot that names no exercise, as for
 * new_exercise), with hard sets not above the slot's prescription for the week (a deload
 * week scales it by deload_depth.volume). Null when it is one; else the reason.
 */
export function blockSessionProblem(after: DayPlan, ctx: Pick<ClassifyContext, "block" | "tax" | "rules">): string | null {
  if (!ctx.block) return "there is no block";
  const bw = blockWeekAt(ctx.block, weekStart(after.date));
  if (!bw) return `${after.date} is outside the block`;
  if (after.exercises.length === 0) return "the day has no exercises";
  const depth = findCheck(ctx.rules, "deload_depth")?.value as { volume?: number } | undefined;
  const scale = bw.kind === "deload" ? (typeof depth?.volume === "number" ? depth.volume : 0.7) : 1;
  for (const ex of after.exercises) {
    const pats = classify(ex, ctx.tax).patterns;
    let allowed = -1;
    for (const d of ctx.block.days ?? []) {
      for (const s of d.slots ?? []) {
        const hit = s.exercise ? sameExercise(ex, { name: s.exercise, exerciseId: s.exercise }) : pats.includes(s.pattern);
        if (hit) allowed = Math.max(allowed, Math.round(s.sets * scale));
      }
    }
    if (allowed < 0) return `${ex.name} matches no slot of the block`;
    if (hardSetCount(ex) > allowed) return `${ex.name}: ${hardSetCount(ex)} sets, above the slot's ${allowed}`;
  }
  return null;
}

function inHistory(ex: ExerciseEntry, history: SessionHistory, today: CalendarDate): boolean {
  const from = addDays(today, -7 * NEW_EXERCISE_WEEKS);
  return history.some((s) => s.date >= from && s.date <= today && s.exercises.some((h) => sameExercise(ex, h)));
}

function contentKey(day: DayPlan): string {
  return canonicalJson({ exercises: day.exercises, status: day.status ?? "planned" });
}

// ---------- classifyChange ----------

/**
 * The kinds of one day change. `before` null: the date was empty; `after` null: the day
 * is gone (delete, or the source of a move). The change is big when any kind is in
 * coach.yaml `approval.ask`, or when no small kind describes it (fail closed).
 */
export function classifyChange(before: DayPlan | null, after: DayPlan | null, ctx: ClassifyContext): Classified {
  const kinds = new Set<ChangeKind>();
  const reasons: string[] = [];
  const units = ctx.config.athlete.units;
  const userDay = isUserDay(ctx.snapshotDay);

  if (ctx.tool === "skip_planned_workout" || ctx.tool === "delete_planned_workout") {
    if (userDay) {
      kinds.add("skip_or_delete_user_day");
      reasons.push(`${ctx.tool} of a day the user built or edited (${before?.date ?? after?.date})`);
    } else {
      kinds.add("trim_session");
      reasons.push(`${ctx.tool} of a planned day: less training`);
    }
    return finish(kinds, reasons, ctx);
  }

  if (userDay) {
    kinds.add("override_user_day");
    reasons.push(`changes a day the user built or edited (${ctx.snapshotDay?.source !== "mcp" ? `source ${ctx.snapshotDay?.source}` : "userModified"})`);
  }

  if (ctx.tool === "move_planned_workout") {
    if (before && after && weekStart(before.date) === weekStart(after.date)) {
      kinds.add("reschedule_within_week");
      reasons.push(`moves ${before.date} to ${after.date} inside the week`);
    } else if (before && after) {
      reasons.push(`moves ${before.date} to ${after.date}, another week`);
    }
  } else if (after) {
    // new_exercise
    for (const ex of after.exercises) {
      if (before?.exercises.some((b) => sameExercise(ex, b))) continue;
      // Recovery work (Zone 2, mobility, breathing) loads nothing: never a new exercise.
      if (isRecoveryExercise(ex, ctx.tax)) continue;
      if (inBlock(ex, ctx.block, ctx.tax) || inHistory(ex, ctx.history, ctx.today)) continue;
      kinds.add("new_exercise");
      reasons.push(`new exercise: ${ex.name} is in neither the block nor the last ${NEW_EXERCISE_WEEKS} weeks of history`);
    }

    if (before && contentKey(before) === contentKey(after)) {
      kinds.add("annotate");
      reasons.push("only the name or notes change");
    } else if (isRecoveryDay(after, ctx.tax) && addsWork(before, after, units) === null) {
      kinds.add("swap_to_recovery");
      reasons.push("the day becomes a recovery day");
    } else if (!before) {
      const why = blockSessionProblem(after, ctx);
      if (why === null) {
        kinds.add("block_session");
        reasons.push("a template day of the block on an empty date");
      } else reasons.push(`not a block session: ${why}`);
    } else if (before) {
      const matched = after.exercises.map((a) => before.exercises.find((b) => sameExercise(a, b)) ?? null);
      const subset = matched.every((m) => m !== null);
      if (subset) {
        let up = false;
        let down = after.exercises.length < before.exercises.length;
        let tooFar = false;
        let setsUp = false;
        let extra: string | null = null;
        const jump = findCheck(ctx.rules, "top_set_jump_max");
        const jumpMax = typeof jump?.value === "number" ? jump.value : 0.1;
        after.exercises.forEach((a, i) => {
          const b = matched[i]!;
          const [ta, tb] = [topWeight(a, units), topWeight(b, units)];
          const [ra, rb] = [maxReps(a), maxReps(b)];
          const [sa, sb] = [hardSetCount(a), hardSetCount(b)];
          extra ??= extraWork(a, b, units);
          if (sa > sb) setsUp = true;
          if (sa < sb) down = true;
          if (ta !== null && tb !== null && ta > tb + 1e-9) {
            up = true;
            if (ta > tb * (1 + jumpMax) + 1e-9) tooFar = true;
          } else if (ta !== null && tb === null) {
            up = true;
            tooFar = true;
          } else if (ta !== null && tb !== null && ta < tb - 1e-9) down = true;
          if (ra > rb) up = true;
          if (ra < rb) down = true;
        });
        // A trim only when every exercise is one (isTrimOf): any extra work on any exercise
        // (per side, distance, duration, RPE, warm-ups) makes the change big.
        if (!up && !setsUp && !extra && down && isTrimOf(before, after, units)) {
          kinds.add("trim_session");
          reasons.push("the same exercises with fewer or equal sets and load");
        } else if (up && !setsUp && !extra && !tooFar && after.exercises.length === before.exercises.length) {
          kinds.add("load_progression");
          reasons.push(`load or reps rise within the ${Math.round(jumpMax * 100)}% top-set step`);
        } else if (extra) {
          reasons.push(`more work on an existing exercise: ${extra}`);
        } else if (up || setsUp) {
          reasons.push(setsUp ? "sets rise on an existing exercise" : "load rises beyond the top-set step");
        }
      } else {
        reasons.push("the exercise list changes");
      }
    }
  }

  // volume_above_plan
  if (ctx.volume && after) {
    const bw = ctx.block ? blockWeekAt(ctx.block, ctx.volume.week_start) : null;
    const targets = bw?.targets;
    for (const [m, n] of Object.entries(ctx.volume.after)) {
      const prev = ctx.volume.before[m] ?? 0;
      if (n <= prev) continue;
      if (!targets || !(m in targets)) {
        kinds.add("volume_above_plan");
        reasons.push(`${m}: ${prev} → ${n} sets in the week of ${ctx.volume.week_start}, and the block has no target for it`);
      } else if (n > targets[m] + 1) {
        kinds.add("volume_above_plan");
        reasons.push(`${m}: ${n} sets in the week of ${ctx.volume.week_start}, over the block target ${targets[m]} by more than 1`);
      }
    }
  }

  return finish(kinds, reasons, ctx);
}

function finish(kinds: Set<ChangeKind>, reasons: string[], ctx: ClassifyContext): Classified {
  const list = [...kinds];
  const ask = list.filter((k) => ctx.config.approval.ask.includes(k) || !ctx.config.approval.auto.includes(k));
  const small = list.filter((k) => (SMALL_KINDS as readonly string[]).includes(k));
  let big = ask.length > 0;
  if (small.length === 0) {
    big = true;
    reasons.push("no small kind describes the change");
  }
  return { kinds: list, big, reasons };
}

/** Kinds of a whole call: the union of its day changes. */
export function mergeClassified(parts: Classified[], ctx: Pick<ClassifyContext, "config">): Classified {
  const kinds = [...new Set(parts.flatMap((p) => p.kinds))];
  const reasons = [...new Set(parts.flatMap((p) => p.reasons))];
  const big = parts.length === 0 || parts.some((p) => p.big) || kinds.some((k) => ctx.config.approval.ask.includes(k));
  return { kinds, big, reasons };
}
