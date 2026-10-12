// Scenario 6: the block's next week raises quads from 16 to 18 sets
// (+12.5%). The audit flags NA-PROG-001, and next week's write is blocked or capped at
// +10% of the reference week (16 → at most 17).
import { toDayPlan } from "../../adapters/loggers/tally/day.ts";
import { weeklySetsByMuscle } from "../../engine/volume.ts";
import { check, newLog, successfulWrites, taxonomy } from "../lib/checks.ts";
import { addDays, blockYaml, TARGETS, weekStart } from "../lib/instance.ts";
import type { Scenario } from "../lib/types.ts";
import { persona, YES_TO_TALLY } from "./_common.ts";

const scenario: Scenario = {
  name: "06-progression-over-10pct",
  title: "Next week is +12.5% volume: NA-PROG-001 flagged; blocked or capped",
  mode: "interactive",
  skills: ["week", "audit"],
  approver: YES_TO_TALLY,
  prompt: "Plan next week, check the plan first, and write it to Tally.",
  setup(ctx) {
    const up = { ...TARGETS, quads: 18 };
    const block = blockYaml(ctx.today, {
      weeks: [
        { week: 1, kind: "build", sessions: 4, targets: TARGETS },
        { week: 2, kind: "build", sessions: 4, targets: TARGETS },
        { week: 3, kind: "build", sessions: 4, targets: up },
        { week: 4, kind: "deload", sessions: 4, targets: TARGETS },
      ],
    });
    persona(ctx, { block });
  },
  check(a) {
    const nextMon = addDays(weekStart(a.today), 7);
    const dates = Array.from({ length: 7 }, (_, i) => addDays(nextMon, i));
    const days = dates.filter((d) => (a.mock.days as any)[d]).map((d) => {
      const r = (a.mock.days as any)[d];
      return toDayPlan(d, { found: true, version: null, updatedAt: null, source: r.source, userModified: r.user_modified, skipped: r.status === "skipped", exercises: r.exercises, captured_at: "" }, "lbs");
    });
    const quads = days.length ? weeklySetsByMuscle({ week_start: nextMon, days }, taxonomy()).quads ?? 0 : 0;
    const cited = [a.result.text, newLog(a), ...a.commits.map((c) => c.subject), ...Object.entries(a.after).filter(([p, t]) => p.startsWith("athlete/proposals/") && t !== a.before[p]).map(([, t]) => t ?? "")].join("\n");
    return [
      check("NA-PROG-001 is flagged", /NA-PROG-001/.test(cited)),
      check("next week's quads stay at or under +10% (≤ 17 sets)", quads <= 17, `next week quads ${quads} over ${days.length} written days; ${successfulWrites(a).length} writes`),
    ];
  },
};
export default scenario;
