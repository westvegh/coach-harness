import { test } from "node:test";
import assert from "node:assert/strict";
import { weeklySetsByMuscle } from "./volume.ts";
import { loadTaxonomy } from "./taxonomy.ts";
import type { SetEntry, WeekPlan } from "./types.ts";

const tax = loadTaxonomy({ localPath: null });
const sets = (n: number, extra: SetEntry = {}): SetEntry[] => Array.from({ length: n }, () => ({ weight: 100, reps: 5, ...extra }));

test("sets per muscle: hard sets only, every muscle of the classification", () => {
  const week: WeekPlan = {
    week_start: "2026-10-12",
    days: [
      {
        date: "2026-10-12",
        exercises: [
          { name: "Back Squat", sets: [...sets(1, { warmup: true }), ...sets(3)] },
          { name: "Bench Press", sets: sets(4) },
        ],
      },
      { date: "2026-10-14", exercises: [{ name: "Goblet Squat", sets: sets(2) }, { name: "Mystery Move", muscle: "Calves", sets: sets(2) }] },
      { date: "2026-10-16", status: "skipped", exercises: [{ name: "Back Squat", sets: sets(5) }] },
    ],
  };
  assert.deepEqual(weeklySetsByMuscle(week, tax), { calves: 2, chest: 4, glutes: 5, quads: 5, triceps: 4 });
});

test("a logged week counts the same way", () => {
  const log = { week_start: "2026-10-12", days: [{ date: "2026-10-13", exercises: [{ name: "Pull-up", sets: sets(3) }] }] };
  assert.deepEqual(weeklySetsByMuscle(log, tax), { biceps: 3, lats: 3 });
});

test("A4: a day outside the declared Monday-Sunday week is rejected, not counted", () => {
  const leg = (n: number) => ({ name: "Leg Extension", sets: sets(n) });
  const log = {
    week_start: "2026-10-12",
    days: [
      { date: "2026-10-12", exercises: [leg(32)] },
      { date: "2026-10-14", exercises: [leg(32)] },
      { date: "2026-10-19", exercises: [leg(8)] }, // the following Monday
    ],
  };
  assert.throws(() => weeklySetsByMuscle(log, tax), /outside the week/);
  assert.throws(() => weeklySetsByMuscle({ week_start: "2026-10-13", days: [] }, tax), /must be a Monday/);
});
