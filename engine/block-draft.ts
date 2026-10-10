// block draft. Expands a method-pack template into a block:
// the slots under the emphasis multiplier, the block targets allocated across the slots,
// a weekly step, deload weeks and deload loads. The model does none of this arithmetic.
//
// Rules, in order:
// 1. Base slot sets: scaledSets (multiplier, rounded; a multiplier above 0 keeps 1 set).
// 2. Week-1 targets: `targets` from the input, else the base counts. Muscles per slot are
//    the slot exercise's classification, else the slot pattern's muscles (as the guard counts).
// 3. Allocation: each target muscle's sets split across the slots that train it, in
//    proportion to their base sets (largest remainder). A slot takes the smallest share its
//    muscles give it, so no target is exceeded, and never fewer than 1 set (the per-slot
//    minimum; a warning names any muscle that the minimum puts above its target). Slots
//    that train no target muscle keep their base sets.
// 4. Build weeks: target_k = round(target_1 × (1 + step)^(j − 1)) for the j-th build week,
//    capped by allowedSets(previous build week's planned sets, weekly_volume_increase_max).
//    With logged history, week 1 is capped the same way against the reference week (the
//    last completed non-deload week before the block, as the guard finds it), and every
//    muscle of the template gets a target; `capped` lists the targets the cap lowered.
//    With no reference week, week 1 is the targets as given.
// 5. Deload weeks (every deload_every_weeks-th week, or `deload_weeks`): every non-recovery
//    slot keeps round(sets × deload_depth.volume) of the previous build week, at least 1;
//    loads are × deload_depth.load, rounded to the plate step (5 lbs / 2.5 kg), at least one
//    step. A block week's `targets` are the sets the week plans (so the guard and the plan agree).
// 6. The block's slot sets are each slot's most in any build week (the prescription the
//    guard's block_session check reads; a deload scales it).
// 7. Only resolved slots (an exercise from input.exercises that classifies) appear in the
//    returned days. Others are listed in `unresolved`, `ready` is false, and
//    `sets_by_muscle` is weeklySetsByMuscle of the returned days; `planned_by_muscle` (the
//    block week's targets) counts every slot.
import { addDays, isCalendarDate, localDate, weekdayOf, WEEKDAYS } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { scaledSets, type Count, type Emphasis, type Slot, type Template } from "./methods.ts";
import { allowedSets, DEFAULT_DELOAD_DEPTH, DEFAULT_VOLUME_CAP, findCheck, referenceWeek } from "./progression.ts";
import { PLATE_STEP } from "./loads.ts";
import { classify } from "./taxonomy.ts";
import { validateBlock } from "./block.ts";
import { weeklySetsByMuscle } from "./volume.ts";
import type { Block, BlockDay, BlockSlot, CalendarDate, CappedMuscle, DayPlan, ExerciseEntry, Rules, SetEntry, Taxonomy, Units, Weekday, WeekKind, WeekLog } from "./types.ts";

/** A slot's exercise: by "day.slot" key (1-based, e.g. "1.2"), else by pattern. */
export type SlotExercise = { name: string; exerciseId?: string };

export type BlockDraftInput = {
  /** A Monday. Default: the Monday after today. */
  start?: CalendarDate;
  emphasis?: Emphasis;
  /** Week-1 hard sets per muscle. Default: the template's own counts. */
  targets?: Record<string, number>;
  /** The weekly step for build weeks (a fraction). Default 0.05; never above the volume cap. */
  step?: number;
  /** Block weeks that are deloads. Default: every deload_every_weeks-th week. */
  deload_weeks?: number[];
  /** The weekday of each template day, in order. Default by day count (see DEFAULT_WEEKDAYS). */
  weekdays?: Weekday[];
  exercises?: Record<string, SlotExercise>;
  /** Working load per exercise (name or exerciseId), in the athlete's units. */
  loads?: Record<string, number>;
  id?: string;
};

export const DEFAULT_STEP = 0.05;
export const DEFAULT_WEEKDAYS: Record<number, Weekday[]> = {
  3: ["mon", "wed", "fri"],
  4: ["mon", "tue", "thu", "fri"],
  5: ["mon", "tue", "wed", "fri", "sat"],
};

/** `resolved`: the slot has an exercise that classifies. */
type SlotRef = { day: number; index: number; slot: Slot; key: string; exercise: SlotExercise | null; resolved: boolean; muscles: string[]; recovery: boolean; base: number };

/** A slot with no resolved exercise: it is in the block, but in no returned DayPlan. */
export type UnresolvedSlot = { slot: string; day: Weekday; pattern: string; adaptation: string; sets: number; reason: string };

export type DraftWeek = {
  week: number;
  kind: WeekKind;
  week_start: CalendarDate;
  load_factor: number;
  /** Hard sets per muscle of the returned days: weeklySetsByMuscle of `days`. */
  sets_by_muscle: Record<string, number>;
  /** Hard sets per muscle the week plans, unresolved slots included (the block week's targets). */
  planned_by_muscle: Record<string, number>;
  /** The targets before allocation (build weeks), for audit. */
  targets: Record<string, number>;
  /** Resolved exercises only. */
  days: DayPlan[];
};

export type BlockDraft = {
  block: Block;
  /** True when every slot has a resolved exercise; only then are the days a full plan. */
  ready: boolean;
  unresolved: UnresolvedSlot[];
  weeks: DraftWeek[];
  /** The logged week that caps week 1 (null: no history, so no cap). */
  reference: { week_start: CalendarDate; sets_by_muscle: Record<string, number> } | null;
  /** Week-1 targets the reference week lowered: base = reference sets, planned = the wanted target. */
  capped: CappedMuscle[];
  rule_ids: string[];
  warnings: string[];
};

const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
const countText = (c: Count | undefined) => (c === undefined ? undefined : typeof c === "number" ? c : `${c[0]}-${c[1]}`);
const top = (c: Count | undefined) => (c === undefined ? null : typeof c === "number" ? c : c[1]);

/** Splits `total` in proportion to `weights` (largest remainder; ties to the earlier slot). */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w * total) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, x) => a + x, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length].i]++;
  return out;
}

function countMuscles(slots: SlotRef[], sets: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  slots.forEach((s, i) => {
    if (s.recovery) return;
    for (const m of s.muscles) out[m] = (out[m] ?? 0) + sets[i];
  });
  return sorted(out);
}

/** Slot sets for one week's targets (rule 3). */
function allocate(slots: SlotRef[], targets: Record<string, number>, warnings: string[] | null): number[] {
  const share: (number | null)[] = slots.map(() => null);
  for (const [m, t] of Object.entries(targets)) {
    const idx = slots.flatMap((s, i) => (!s.recovery && s.base > 0 && s.muscles.includes(m) ? [i] : []));
    if (idx.length === 0) {
      warnings?.push(`${m}: target ${t} sets, but no slot of the template trains it`);
      continue;
    }
    const parts = apportion(t, idx.map((i) => slots[i].base));
    idx.forEach((i, k) => (share[i] = share[i] === null ? parts[k] : Math.min(share[i]!, parts[k])));
  }
  // A slot the emphasis drops (base 0) stays out.
  return slots.map((s, i) => (s.base === 0 ? 0 : share[i] === null ? s.base : Math.max(1, share[i]!)));
}

function nextMonday(today: CalendarDate): CalendarDate {
  let d = addDays(today, 1);
  while (weekdayOf(d) !== "mon") d = addDays(d, 1);
  return d;
}

const roundTo = (x: number, step: number) => Math.round(x / step) * step;

export function draftBlock(
  template: Template,
  weeksN: number,
  ctx: { tax: Taxonomy; rules: Rules; units: Units; method: string; today: CalendarDate; emphasis: Emphasis; templateId: string; history?: WeekLog[] },
  input: BlockDraftInput = {},
): BlockDraft {
  if (!Number.isInteger(weeksN) || weeksN < 1 || weeksN > 52) throw new CoachError("USAGE", "block draft --weeks must be a whole number from 1 to 52");
  if (![3, 4, 5].includes(template.days)) throw new CoachError("BLOCK_DRAFT", `template ${ctx.templateId} has ${template.days} days; a block needs 3, 4 or 5`);
  const warnings: string[] = [];
  const ruleIds = new Set<string>();
  const emphasis = input.emphasis ?? ctx.emphasis;
  if (!template.emphasis[emphasis]) throw new CoachError("BLOCK_DRAFT", `template ${ctx.templateId} has no emphasis ${emphasis}`);

  const start = input.start ?? nextMonday(ctx.today);
  if (!isCalendarDate(start) || weekdayOf(start) !== "mon") throw new CoachError("BLOCK_DRAFT", `start must be a Monday: ${start}`);
  const weekdays = input.weekdays ?? DEFAULT_WEEKDAYS[template.days];
  if (weekdays.length !== template.days || weekdays.some((d) => !WEEKDAYS.includes(d)) || new Set(weekdays).size !== weekdays.length) {
    throw new CoachError("BLOCK_DRAFT", `weekdays must name ${template.days} different days (mon … sun)`);
  }
  const order = weekdays.map((d) => WEEKDAYS.indexOf(d));
  if (order.some((x, i) => i > 0 && x <= order[i - 1])) throw new CoachError("BLOCK_DRAFT", "weekdays must be in calendar order, Monday first");

  // Volume cap, step, deload rules.
  const capCheck = findCheck(ctx.rules, "weekly_volume_increase_max");
  const cap = typeof capCheck?.value === "number" ? capCheck.value : DEFAULT_VOLUME_CAP;
  if (capCheck) ruleIds.add(capCheck.id);
  else warnings.push(`the pack has no weekly_volume_increase_max rule: using ${DEFAULT_VOLUME_CAP}`);
  let step = input.step ?? DEFAULT_STEP;
  if (!(typeof step === "number" && step >= 0)) throw new CoachError("BLOCK_DRAFT", "step must be a fraction of 0 or more");
  if (step > cap) {
    warnings.push(`step ${step} is above the volume cap ${cap}: using ${cap}`);
    step = cap;
  }
  const depthCheck = findCheck(ctx.rules, "deload_depth");
  const depth = (depthCheck?.value as { volume: number; load: number } | undefined) ?? DEFAULT_DELOAD_DEPTH;
  if (depthCheck) ruleIds.add(depthCheck.id);
  const every = findCheck(ctx.rules, "deload_every_weeks");
  let deloads: Set<number>;
  if (input.deload_weeks) {
    if (input.deload_weeks.some((w) => !Number.isInteger(w) || w < 2 || w > weeksN)) throw new CoachError("BLOCK_DRAFT", `deload_weeks must be weeks 2 to ${weeksN}`);
    deloads = new Set(input.deload_weeks);
  } else if (every && typeof every.value === "number") {
    ruleIds.add(every.id);
    deloads = new Set(Array.from({ length: weeksN }, (_, i) => i + 1).filter((w) => w % (every.value as number) === 0));
  } else deloads = new Set();
  if (every && typeof every.value === "number") {
    let run = 0;
    for (let w = 1; w <= weeksN; w++) {
      run = deloads.has(w) ? 0 : run + 1;
      if (run > every.value - 1 && !deloads.has(w)) {
        warnings.push(`week ${w}: ${run} build weeks in a row; the pack deloads every ${every.value} weeks [${every.id}]`);
        ruleIds.add(every.id);
        break;
      }
    }
  }

  // Slots.
  const slots: SlotRef[] = [];
  template.week.forEach((d) =>
    d.slots.forEach((slot, j) => {
      const key = `${d.day}.${j + 1}`;
      const exercise = input.exercises?.[key] ?? input.exercises?.[slot.pattern] ?? null;
      const pat = ctx.tax.patterns[slot.pattern];
      if (!pat) warnings.push(`slot ${key}: pattern ${slot.pattern} is not in the taxonomy`);
      let muscles = pat?.muscles ?? [];
      let resolved = false;
      if (exercise) {
        const c = classify({ name: exercise.name, exerciseId: exercise.exerciseId ?? null }, ctx.tax);
        if (c.source === "none") warnings.push(`slot ${key}: ${exercise.name} is unclassified; the slot stays unresolved`);
        else {
          resolved = true;
          if (!c.patterns.includes(slot.pattern)) warnings.push(`slot ${key}: ${exercise.name} classifies as ${c.patterns.join(", ")}, not ${slot.pattern}`);
          muscles = c.muscles;
        }
      }
      slots.push({ day: d.day, index: j, slot, key, exercise, resolved, muscles, recovery: pat?.recovery === true, base: scaledSets(slot, template, emphasis) });
    }),
  );
  const baseSets = slots.map((s) => s.base);
  const baseCounts = countMuscles(slots, baseSets);
  const t1 = input.targets ? { ...input.targets } : { ...baseCounts };
  for (const [m, n] of Object.entries(t1)) if (!Number.isInteger(n) || n < 0) throw new CoachError("BLOCK_DRAFT", `targets.${m} must be a whole number of 0 or more`);

  // The reference week for week 1: the guard compares week 1 with it (NA-PROG-001 in the shipped pack).
  let reference: BlockDraft["reference"] = null;
  if (ctx.history && ctx.history.length > 0) {
    const shape = { start, template: { days: template.days, emphasis }, weeks: [] } as unknown as Block;
    const log = referenceWeek(shape, ctx.history, start);
    if (log) reference = { week_start: log.week_start, sets_by_muscle: weeklySetsByMuscle(log, ctx.tax) };
  }
  // With a reference, every muscle the template trains gets a target, so the cap covers it.
  if (reference) for (const [m, n] of Object.entries(baseCounts)) if (!(m in t1)) t1[m] = n;
  const capped: CappedMuscle[] = [];

  // Week by week.
  const plate = PLATE_STEP[ctx.units];
  const weeks: DraftWeek[] = [];
  const maxBuild = slots.map(() => 0);
  let prevBuild: { sets: number[]; counts: Record<string, number> } | null = null;
  let buildIndex = 0;
  for (let w = 1; w <= weeksN; w++) {
    const week_start = addDays(start, 7 * (w - 1));
    const kind: WeekKind = deloads.has(w) ? "deload" : "build";
    let sets: number[];
    let targets: Record<string, number>;
    if (kind === "build") {
      buildIndex++;
      targets = {};
      for (const [m, t] of Object.entries(t1)) {
        const want = Math.round(t * (1 + step) ** (buildIndex - 1));
        const prev = prevBuild ? prevBuild.counts[m] : reference ? (reference.sets_by_muscle[m] ?? 0) : undefined;
        targets[m] = prev === undefined ? want : Math.min(want, allowedSets(prev, cap));
        if (!prevBuild && reference && targets[m] < want) {
          capped.push({ muscle: m, base: prev!, planned: want, allowed: targets[m] });
          warnings.push(`${m}: week-1 target ${want} capped at ${targets[m]} against ${prev} sets in the reference week ${reference.week_start}${capCheck ? ` [${capCheck.id}]` : ""}`);
        }
      }
      sets = allocate(slots, targets, w === 1 ? warnings : null);
      const counts = countMuscles(slots, sets);
      if (w === 1) {
        for (const [m, n] of Object.entries(counts)) {
          if (!(m in targets) || n <= targets[m]) continue;
          warnings.push(`${m}: the 1-set minimum per slot gives ${n} sets, above the target ${targets[m]}`);
          if (reference) warnings.push(`${m}: week 1 plans ${n} sets against ${reference.sets_by_muscle[m] ?? 0} in the reference week ${reference.week_start}; the guard allows ${allowedSets(reference.sets_by_muscle[m] ?? 0, cap)}`);
        }
      }
      prevBuild = { sets, counts };
      sets.forEach((n, i) => (maxBuild[i] = Math.max(maxBuild[i], n)));
    } else {
      const from = prevBuild?.sets ?? baseSets;
      sets = slots.map((s, i) => (s.recovery || from[i] === 0 ? from[i] : Math.max(1, Math.round(from[i] * depth.volume))));
      targets = countMuscles(slots, sets);
    }
    const loadFactor = kind === "deload" ? depth.load : 1;
    const days: DayPlan[] = weekdays.map((wd, di) => {
      const date = addDays(week_start, WEEKDAYS.indexOf(wd));
      const tday = template.week[di];
      const exercises = slots
        .map((s, i) => ({ s, n: sets[i] }))
        .filter(({ s, n }) => s.day === tday.day && n > 0 && s.resolved)
        .map(({ s, n }) => slotExercise(s, n, loadFactor, plate, input.loads, ctx.units, warnings));
      return { date, dayName: tday.focus, exercises };
    });
    weeks.push({
      week: w,
      kind,
      week_start,
      load_factor: loadFactor,
      sets_by_muscle: weeklySetsByMuscle({ week_start, days }, ctx.tax),
      planned_by_muscle: countMuscles(slots, sets),
      targets: sorted(targets),
      days,
    });
  }

  // The block (athlete/block.yaml shape).
  const blockDays: BlockDay[] = template.week.map((d, di) => ({
    day: weekdays[di],
    focus: d.focus,
    slots: slots
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.day === d.day && s.base > 0)
      .map(({ s, i }): BlockSlot => {
        const reps = countText(s.slot.reps);
        const duration = countText(s.slot.duration);
        return {
          pattern: s.slot.pattern,
          adaptation: s.slot.adaptation,
          sets: Math.max(1, maxBuild[i]),
          ...(reps !== undefined ? { reps } : {}),
          ...(duration !== undefined ? { duration } : {}),
          rest_s: s.slot.rest_s,
          ...(s.exercise ? { exercise: s.exercise.exerciseId ?? s.exercise.name } : {}),
        };
      }),
  }));
  const block: Block = {
    version: 1,
    id: input.id ?? "",
    method: ctx.method,
    template: { days: template.days as 3 | 4 | 5, emphasis },
    start,
    weeks: weeks.map((w) => ({ week: w.week, kind: w.kind, sessions: template.days, targets: w.planned_by_muscle })),
    days: blockDays,
  };
  if (block.id) validateBlock(block, "block draft");
  else warnings.push("the block has no id: run `ids next --kind block` and pass it as id");
  const unresolved: UnresolvedSlot[] = slots
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.base > 0 && !s.resolved)
    .map(({ s, i }) => ({
      slot: s.key,
      day: weekdays[template.week.findIndex((d) => d.day === s.day)],
      pattern: s.slot.pattern,
      adaptation: s.slot.adaptation,
      sets: Math.max(1, maxBuild[i]),
      reason: s.exercise ? `${s.exercise.name} is unclassified` : "no exercise given (input.exercises)",
    }));
  if (unresolved.length > 0) warnings.push(`${unresolved.length} slots have no resolved exercise: the days leave them out until input.exercises names them`);
  return { block, ready: unresolved.length === 0, unresolved, weeks, reference, capped, rule_ids: [...ruleIds], warnings: [...new Set(warnings)] };
}

function slotExercise(s: SlotRef, n: number, loadFactor: number, plate: number, loads: Record<string, number> | undefined, units: Units, warnings: string[]): ExerciseEntry & { pattern: string; adaptation: string } {
  const name = s.exercise!.name;
  let weight: number | null = null;
  const base = s.exercise ? (loads?.[s.exercise.exerciseId ?? ""] ?? loads?.[s.exercise.name]) : undefined;
  if (typeof base === "number" && base > 0) {
    weight = loadFactor === 1 ? base : Math.max(plate, roundTo(base * loadFactor, plate));
  } else if (loadFactor !== 1 && s.exercise && !s.recovery && s.slot.reps !== undefined) {
    warnings.push(`${name}: no working load given, so the deload load is not set (deload factor ${loadFactor})`);
  }
  const set: SetEntry = {
    weight,
    reps: top(s.slot.reps),
    duration_s: top(s.slot.duration),
  };
  return {
    exerciseId: s.exercise?.exerciseId ?? null,
    name,
    muscle: null,
    unit: units,
    sets: Array.from({ length: n }, () => ({ ...set })),
    pattern: s.slot.pattern,
    adaptation: s.slot.adaptation,
  };
}

/** The template id ("4-day") from coach.yaml's template.days. */
export function templateIdFor(days: number): string {
  return `${days}-day`;
}

/** Today in the athlete's timezone (for the default start). */
export function todayIn(tz: string, now?: string): CalendarDate {
  return localDate(now ?? new Date().toISOString(), tz);
}
