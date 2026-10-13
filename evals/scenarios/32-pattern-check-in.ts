// Scenario 32 (V6): a check-in on a pattern day. 3 off-mornings in a row, no check-in today, and
// the last session (3 days ago, no plan in Tally) fell short of the week before, so performance
// is amber. The athlete says "check in"; the one question "How do you feel today?" is scripted to
// "Wrecked". Pass: exactly one AskUserQuestion call with one question; today's signal file has
// `overall: 1`; today becomes a recovery day in Tally; no second readiness question.
import { askCalls, check, day, patternsOf, replyText, taxonomy } from "../lib/checks.ts";
import { addDays } from "../lib/instance.ts";
import type { RunArtifacts, Scenario } from "../lib/types.ts";
import { persona } from "./_common.ts";

const scenario: Scenario = {
  name: "32-pattern-check-in",
  title: "Check in on a pattern day: one question, Wrecked makes a recovery day",
  mode: "interactive",
  skills: ["check-in", "today"],
  approver: [],
  answers: [{ question: "how do you feel", answer: ["wrecked"] }],
  prompt: "check in",
  setup(ctx) {
    persona(ctx, {
      today: { hrvZ: -1.6, sleepMin: 440, checkin: null, offMornings: 3 },
      tally(m) {
        // The last session (Upper B, 3 days ago) fell short at the same weights: amber against the athlete's own history.
        const last = (m.sessions as any[]).find((s) => s.date === addDays(ctx.today, -3));
        for (const e of last?.exercises ?? []) e.sets = e.sets.map((s: any, i: number) => ({ ...s, reps: Math.max(1, s.reps - 2 - i) }));
      },
    });
  },
  check(a: RunArtifacts) {
    const asks = askCalls(a);
    const questions = asks.flatMap(({ t }) => (t.input?.questions ?? []).map((q: any) => String(q.question ?? "")));
    const today = a.after[`athlete/signals/${a.today}.json`];
    let overall: unknown = null;
    try {
      overall = today ? JSON.parse(today).checkin?.overall : null;
    } catch {
      /* stays null */
    }
    const tax = taxonomy();
    const recovery = new Set(Object.entries(tax.patterns).filter(([, p]) => (p as { recovery?: boolean }).recovery).map(([k]) => k));
    const exs: any[] = day(a, a.today)?.exercises ?? [];
    const notRecovery = exs.map((e) => ({ name: e.name, c: patternsOf(e) })).filter((x) => x.c.source === "none" || x.c.patterns.length === 0 || x.c.patterns.some((p) => !recovery.has(p)));
    const textAsks = (replyText(a).match(/how do you feel today\?/gi) ?? []).length;
    return [
      check("exactly one AskUserQuestion call with one question: How do you feel today?", asks.length === 1 && questions.length === 1 && /how do you feel/i.test(questions[0]), JSON.stringify(questions)),
      check("today's signal file has overall: 1", overall === 1, JSON.stringify(overall)),
      check("today is a recovery day in Tally (only recovery patterns)", exs.length > 0 && notRecovery.length === 0, JSON.stringify(exs.map((e) => e.name))),
      check("no second readiness question (none as text either)", textAsks === 0, `${textAsks} in the reply`),
    ];
  },
};
export default scenario;
