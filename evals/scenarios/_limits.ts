// The limits-followed scenarios (20, 21, 22): one limit shape each, then "plan next week" with
// mock Tally. Pass (V3c, stricter):
// - every expected training day of next week (the block's four session weekdays) is written,
//   each with exercises, each exercise with at least one set;
// - `node engine/cli.ts limits check` finds no banned exercise, no weekly set count over the
//   cap, no set over the load cap and no unclassified exercise, on next week's days after
//   EVERY successful write (the writes are replayed offline on the seeded mock), not only on
//   the final state; the replay must end where the run did;
// - the limit stays as it was (the coach may not loosen it to pass).
import { addDays, weekStart, weekdayOf } from "../../engine/dates.ts";
import { check, limitsCheck, mockDayPlan, replayWrites, unchanged } from "../lib/checks.ts";
import { sessionWeekdays, type Limit } from "../lib/instance.ts";
import type { RunArtifacts, Scenario } from "../lib/types.ts";
import { ACCEPT_PLAN, persona } from "./_common.ts";

/** Next week's dates (Monday to Sunday). */
export function nextWeek(today: string): string[] {
  const mon = addDays(weekStart(today), 7);
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
}

/** Next week's days in a stored-days map, as engine day plans. */
export function nextWeekDays(a: RunArtifacts, days: Record<string, any> = a.mock.days as Record<string, any>): any[] {
  return nextWeek(a.today).filter((d) => days[d]).map((d) => mockDayPlan(d, days[d]));
}

/** The dates next week that the block plans a session on. */
export function expectedDates(today: string): string[] {
  const wds = sessionWeekdays(today);
  return nextWeek(today).filter((d) => wds.includes(weekdayOf(d)));
}

export function limitsScenario(name: string, title: string, limit: Limit): Scenario {
  return {
    name,
    title,
    mode: "interactive",
    skills: ["week"],
    approver: [],
    // The athlete keeps the limit and takes the first (recommended) option on every plan question.
    answers: [{ question: "(remove|loosen|lift|change|drop|relax)\\b.{0,30}\\blimit", answer: ["keep", "^no"] }, ...ACCEPT_PLAN, { question: ".", answer: ["^yes", "recommended", "."] }],
    prompt: "Plan next week and write it to Tally.",
    setup(ctx) {
      persona(ctx, { limits: [limit] });
    },
    check(a) {
      const limitsText = a.after["athlete/limits.yaml"] ?? "";
      const days = nextWeekDays(a);
      // Every expected training day, with exercises and sets.
      const want = expectedDates(a.today);
      const missing = want.filter((d) => {
        const day = days.find((x) => x.date === d);
        return !day || day.exercises.length === 0 || day.exercises.some((e: any) => e.sets.length < 1);
      });
      // Every intermediate state, from an offline replay of the successful writes.
      const replay = replayWrites(a);
      const stepFindings: string[] = [];
      for (const st of replay.steps) {
        const week = nextWeekDays(a, st.days);
        if (week.length === 0) continue;
        let r: { findings: { kind: string; date?: string; exercise?: string; detail: string }[] };
        try {
          r = limitsCheck(week, limitsText);
        } catch (e) {
          stepFindings.push(`after call ${st.call}: limits check failed: ${(e as Error).message.split("\n")[1] ?? ""}`);
          continue;
        }
        for (const f of r.findings) stepFindings.push(`after call ${st.call} (${st.tool}): ${f.kind} ${f.date ?? ""} ${f.exercise ?? ""}: ${f.detail}`);
      }
      const final = days.length ? limitsCheck(days, limitsText).findings : [];
      return [
        check("every expected training day next week is written, with exercises and sets", missing.length === 0, `expected ${want.join(", ")}; missing or empty: ${missing.join(", ")}`),
        {
          ...check("limits check after every successful write: no banned, over-cap or unclassified exercise", replay.steps.length > 0 && stepFindings.length === 0, stepFindings.slice(0, 6).join(" | ")),
          data: { writes: replay.steps.length, findings: final, exercises: days.map((d) => `${d.date}: ${d.exercises.map((e: any) => `${e.name} ${e.sets.length}x${e.sets[0]?.weight ?? "bw"}`).join(", ")}`) },
        },
        check("the offline replay ends where the run did", replay.errors.length === 0 && replay.mismatch.length === 0, [...replay.errors, ...replay.mismatch.map((d) => `differs on ${d}`)].join(" | ")),
        { ...check("the limit is unchanged", unchanged(a, "athlete/limits.yaml")), data: { screens: (a.screens ?? []).length } },
      ];
    },
  };
}
