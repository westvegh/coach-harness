// Scenario 34 (V7): a fast today. "heading to the gym" on a planned Tally day (Lower A), a full
// wearable baseline and a calm morning, no check-in today, no open proposal: the decision is
// `none`. The last Lower A session missed one rep on the last set of each exercise, so `loads`
// repeats every weight: no load change. Every history window and every day completes in its first
// page (4 sessions a week, 2-week windows of limit 10). Pass: the report (verdict first, the
// athlete's numbers, the session line, the invitation), no question, at most 7 main-thread calls,
// the initial reads in one message, post after them, a no-change log entry with the run line, a
// commit that reached the remote, and a snapshot that holds every read.
import { askCalls, check, logEntries, mutationCalls, replyText } from "../lib/checks.ts";
import type { RunArtifacts, Scenario } from "../lib/types.ts";
import { persona } from "./_common.ts";
import { speedChecks } from "./_speed.ts";
import { feelQuestions, firstLine, fixtureNumbers, hasLetteredOptions } from "./31-calm-check-in.ts";

export const PROMPT = "heading to the gym";
export const SPEED_WATCH = ["athlete/.cache/snapshot.json"];

/** The latest session named `name` misses one rep on its last set of each exercise (a miss: the load repeats). */
export function missLast(sessions: any[], name: string, today: string): void {
  const last = sessions.filter((s) => s.name === name && s.date < today).sort((x, y) => (x.date < y.date ? 1 : -1))[0];
  for (const e of last?.exercises ?? []) {
    const sets = e.sets ?? [];
    if (sets.length > 0 && typeof sets[sets.length - 1].reps === "number") sets[sets.length - 1].reps -= 1;
  }
}

const scenario: Scenario = {
  name: "34-fast-today",
  title: "Heading to the gym on a calm day: the same report in at most 7 calls",
  mode: "interactive",
  skills: ["today"],
  approver: [],
  answers: [],
  watch: SPEED_WATCH,
  prompt: PROMPT,
  setup(ctx) {
    persona(ctx, { today: { hrvZ: 0, sleepMin: 450, checkin: null }, tally: (m) => missLast(m.sessions as any[], "Lower A", ctx.today) });
  },
  check(a: RunArtifacts) {
    const reply = replyText(a);
    const final = a.result.text ?? "";
    const entries = logEntries(a, a.today);
    return [
      check("no AskUserQuestion call", askCalls(a).length === 0, `${askCalls(a).length} call(s)`),
      check("no \"How do you feel today?\" question and no lettered options", feelQuestions(a) === 0 && !hasLetteredOptions(reply), reply.slice(0, 200)),
      check("the final reply starts with the verdict (as planned)", /as planned/i.test(firstLine(final)), firstLine(final)),
      check("the reply names a real sleep or HRV number from today's file", fixtureNumbers().test(reply), reply.slice(0, 300)),
      check("the reply has today's session line", /lower a|goblet squat|romanian deadlift|leg press/i.test(reply), reply.slice(0, 300)),
      check("the reply ends with the invitation", /tell me if anything hurts/i.test(final), final.slice(-200)),
      check("no Tally write (decision none, no load change)", mutationCalls(a).length === 0, JSON.stringify(mutationCalls(a).map((c) => c.tool))),
      check("one no-change log entry for today, with the run line", entries.length === 1 && /· no-change/.test(entries[0]) && /\n- run: r-\d{8}-\d{4}-[0-9a-f]{4}/.test(entries[0]), entries.join("\n---\n").slice(0, 400)),
      ...speedChecks(a, 7),
    ];
  },
};
export default scenario;
