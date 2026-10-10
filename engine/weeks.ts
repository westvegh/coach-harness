// The logged history grouped into Monday-to-Sunday weeks, ready for
// `targets` ({block, logs, today, target_week}). History dates are already calendar dates
// in the athlete's timezone (contracts §0, §9), so a week is weekStart(date).
import { addDays, isCalendarDate, weekStart } from "./dates.ts";
import { CoachError } from "./errors.ts";
import type { CalendarDate, DayLog, Snapshot, SnapshotSession, WeekLog } from "./types.ts";

export type WeeksResult = {
  from: CalendarDate;
  to: CalendarDate;
  /** Every week from the week of `from` to the week of `to`, empty weeks included (a missed week). */
  logs: WeekLog[];
  /** What the snapshot's history read covers; null when there was no valid read. */
  coverage: Snapshot["history_coverage"] | null;
  warnings: string[];
};

/** Sessions on one date merge into one DayLog (their exercises in logged order). */
export function historyWeeks(history: SnapshotSession[], from: CalendarDate, to: CalendarDate): WeekLog[] {
  if (!isCalendarDate(from) || !isCalendarDate(to)) throw new CoachError("USAGE", "weeks needs --from and --to as YYYY-MM-DD");
  if (from > to) throw new CoachError("USAGE", `weeks: --from ${from} is after --to ${to}`);
  const byDate = new Map<CalendarDate, DayLog>();
  for (const s of [...history].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    if (!isCalendarDate(s.date) || s.date < from || s.date > to) continue;
    const day = byDate.get(s.date) ?? { date: s.date, exercises: [] };
    for (const e of s.exercises) {
      day.exercises.push({
        exerciseId: e.exerciseId || null,
        name: e.name,
        muscle: e.muscle || null,
        ...(s.weightUnit ? { unit: s.weightUnit } : {}),
        sets: e.sets.map((x) => ({ weight: x.weight, reps: x.reps, rpe: x.rpe })),
      });
    }
    byDate.set(s.date, day);
  }
  // One pass: each date goes into its week's bucket, then the weeks are listed.
  const buckets = new Map<CalendarDate, DayLog[]>();
  for (const day of byDate.values()) {
    const w = weekStart(day.date);
    const list = buckets.get(w);
    if (list) list.push(day);
    else buckets.set(w, [day]);
  }
  const logs: WeekLog[] = [];
  for (let w = weekStart(from); w <= weekStart(to); w = addDays(w, 7)) logs.push({ week_start: w, days: buckets.get(w) ?? [] });
  return logs;
}

export function weeksFromSnapshot(snap: Snapshot | null, from: CalendarDate, to: CalendarDate): WeeksResult {
  const logs = historyWeeks(snap?.history ?? [], from, to);
  const warnings: string[] = [];
  const cov = snap?.history_coverage ?? null;
  if (!snap) warnings.push("no snapshot: every week is empty; read get_workout_history first");
  else if (!cov) warnings.push("no valid history read in this session: weeks may be missing sessions; read get_workout_history first");
  else {
    if (!cov.complete) warnings.push("the history read is incomplete (more pages remain)");
    if (cov.since && cov.since > from) warnings.push(`the history read starts ${cov.since}, after --from ${from}: earlier sessions are unknown, not absent`);
    if (cov.until && cov.until < to) warnings.push(`the history read ends ${cov.until}, before --to ${to}: later sessions are unknown, not absent`);
  }
  return { from, to, logs, coverage: cov, warnings };
}
