// The limits-followed scenarios (20, 21, 21b, 22, 42): one limit line in athlete/limits.md, in plain
// words (0.3.0), then "plan next week" with mock Tally. Every guarantee of the 0.2.x scorer stays:
// - every expected training day of next week (the block's four session weekdays) is written,
//   each with exercises, each exercise with at least one set;
// - the scenario's rule (evals/lib/limit-rules.ts: what the line means, stated in code) holds on
//   next week's days after EVERY successful write (the writes are replayed offline on the seeded
//   mock), not only on the final state; the replay must end where the run did; an exercise the
//   taxonomy cannot classify fails;
// - athlete/limits.md stays as it was, unless the scenario lets the coach change it.
import { addDays, weekStart, weekdayOf } from "../../engine/dates.ts";
import { check, mockDayPlan, replayWrites, unchanged } from "../lib/checks.ts";
import { judge, weeklySets, type LimitRule } from "../lib/limit-rules.ts";
import { sessionWeekdays } from "../lib/instance.ts";
import type { AnswerRule, Check, RunArtifacts, Scenario, SetupContext } from "../lib/types.ts";
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

/** The athlete keeps the limit and takes the first (recommended) option on every plan question. */
export const KEEP_LIMIT: AnswerRule[] = [{ question: "(remove|loosen|lift|change|drop|relax)\\b.{0,30}\\blimit", answer: ["keep", "^no"] }, ...ACCEPT_PLAN, { question: ".", answer: ["^yes", "recommended", "."] }];

/** The checks of a limits-followed run: every day written, the rule after every write, the replay, the file. */
export function limitChecks(a: RunArtifacts, rule: LimitRule, o: { fileMayChange?: boolean } = {}): Check[] {
  const days = nextWeekDays(a);
  const want = expectedDates(a.today);
  const missing = want.filter((d) => {
    const day = days.find((x) => x.date === d);
    return !day || day.exercises.length === 0 || day.exercises.some((e: any) => e.sets.length < 1);
  });
  const replay = replayWrites(a);
  const stepFindings: string[] = [];
  for (const st of replay.steps) {
    const week = nextWeekDays(a, st.days);
    if (week.length === 0) continue;
    for (const f of judge(week, rule)) stepFindings.push(`after call ${st.call} (${st.tool}): ${f.kind} ${f.date ?? ""} ${f.exercise ?? ""}: ${f.detail}`);
  }
  const final = days.length ? judge(days, rule) : [];
  return [
    check("every expected training day next week is written, with exercises and sets", missing.length === 0, `expected ${want.join(", ")}; missing or empty: ${missing.join(", ")}`),
    {
      ...check(`the limit holds after every successful write ("${rule.says}"; no unclassified exercise)`, replay.steps.length > 0 && stepFindings.length === 0, stepFindings.slice(0, 6).join(" | ")),
      data: { writes: replay.steps.length, findings: final, weekly_sets: rule.kind === "weekly_sets" ? weeklySets(days, rule) : undefined, exercises: days.map((d) => `${d.date}: ${d.exercises.map((e: any) => `${e.name} ${e.sets.length}x${e.sets[0]?.weight ?? "bw"}`).join(", ")}`) },
    },
    check("the offline replay ends where the run did", replay.errors.length === 0 && replay.mismatch.length === 0, [...replay.errors, ...replay.mismatch.map((d) => `differs on ${d}`)].join(" | ")),
    ...(o.fileMayChange ? [] : [{ ...check("the limits file is unchanged", unchanged(a, "athlete/limits.md")), data: { screens: (a.screens ?? []).length } }]),
  ];
}

export function limitsScenario(name: string, title: string, line: string, rule: LimitRule, o: { setup?: (ctx: SetupContext) => void; lines?: string[] } = {}): Scenario {
  return {
    name,
    title,
    mode: "interactive",
    skills: ["week"],
    approver: [],
    answers: KEEP_LIMIT,
    prompt: "Plan next week and write it to Tally.",
    setup(ctx) {
      persona(ctx, { limits: o.lines ?? [line] });
      o.setup?.(ctx);
    },
    check: (a) => limitChecks(a, rule),
  };
}
