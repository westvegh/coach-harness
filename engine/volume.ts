// Weekly hard sets per muscle (contracts §8). These are counted sets: a cluster counts its total
// reps ÷ its rep max (engine/clusters.ts, contracts §8a); straight sets count each hard set.
import { countedSets, type ClusterEntry } from "./clusters.ts";
import { addDays, weekdayOf } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { classify } from "./taxonomy.ts";
import type { ExerciseEntry, Taxonomy, WeekLog, WeekPlan } from "./types.ts";

/** Physical hard sets of one exercise: every set not marked as a warm-up (each mini-set of a cluster). */
export function hardSets(ex: ExerciseEntry): number {
  return (ex.sets ?? []).filter((s) => s.warmup !== true).length;
}

/**
 * Throws unless week_start is a Monday and every day falls inside Monday to Sunday of
 * that week. A day outside the week would inflate the reference and bypass the cap.
 */
export function assertDaysInWeek(week: WeekPlan | WeekLog): void {
  if (weekdayOf(week.week_start) !== "mon") throw new CoachError("NOT_A_MONDAY", `week_start must be a Monday: ${week.week_start}`);
  const end = addDays(week.week_start, 6);
  for (const d of week.days) {
    if (!(d.date >= week.week_start && d.date <= end)) {
      throw new CoachError("DAY_OUTSIDE_WEEK", `day ${d.date} is outside the week ${week.week_start}..${end}`);
    }
  }
}

/**
 * Counted sets per muscle for a planned or logged week. Each counted set counts once for every
 * muscle of the exercise's classification. Skipped planned days count nothing. `clusters`: the
 * coach.yaml list (B.2); each exercise is resolved with its own day's date.
 */
export function weeklySetsByMuscle(week: WeekPlan | WeekLog, tax: Taxonomy, clusters: readonly ClusterEntry[] = []): Record<string, number> {
  assertDaysInWeek(week);
  const totals: Record<string, number> = {};
  for (const day of week.days) {
    if ("status" in day && day.status === "skipped") continue;
    for (const ex of day.exercises) {
      const n = countedSets(ex, day.date, clusters);
      if (n === 0) continue;
      for (const m of classify(ex, tax).muscles) totals[m] = (totals[m] ?? 0) + n;
    }
  }
  return Object.fromEntries(Object.entries(totals).sort(([a], [b]) => (a < b ? -1 : 1)));
}
