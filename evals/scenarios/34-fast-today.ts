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

/**
 * W3 (0.3.0): a representative non-empty athlete/limits.md (4 lines, about 1,200 characters) that
 * does not touch today's Lower A, so the run's work is the same and its cost can be compared.
 */
export const SPEED_LIMITS = [
  "- Left shoulder (AC joint): no bench press, no dips and no overhead pressing for now. Light cable flyes and push-ups on the knees are fine, and so is pressing with a band. If a press day comes up, swap it for flyes or band work. Side raises are fine with light dumbbells, up to 3 sets in a session, and no raise above shoulder height. (since 2026-10-02)",
  "- Right elbow: no narrow-grip chin-ups and no skull crushers. Rows and pulldowns are fine at the usual weight.\n  Pulldown and chest press only when the elbow is at 2/10 or less that morning; on a worse morning, swap them for band work and keep the sets the same. (since 2026-10-10)",
  "- Neck: no heavy shrugs and no neck bridges; light shrugs with dumbbells are fine. Stop a set when the neck tightens, and do not add weight to shrugs until it has felt fine for two weeks in a row. (since 2026-09-28, from my physio)",
  "- Right wrist: use straps for heavy pulls when the wrist is sore, and no front rack holds with a full grip. Hammer curls are fine. Wrist curls only with a light dumbbell, at most 2 sets in a session, and stop when it aches. (since 2026-09-20)",
];
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
    persona(ctx, { limits: SPEED_LIMITS, today: { hrvZ: 0, sleepMin: 450, checkin: null }, tally: (m) => missLast(m.sessions as any[], "Lower A", ctx.today) });
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
