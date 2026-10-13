// Scenario 31 (V6): a calm check-in. A full wearable baseline and a green morning, no check-in
// today, and a planned session (logger: tally). The athlete says "check in". Pass: no
// AskUserQuestion call and no lettered option list in the reply; the final reply starts with the
// verdict ("as planned"); it names a real sleep or HRV number from today's file; no check-in
// block is written today; the urgent stop is not written.
import { askCalls, check, replyText } from "../lib/checks.ts";
import { hrvAtZ } from "../lib/instance.ts";
import type { RunArtifacts, Scenario } from "../lib/types.ts";
import { persona } from "./_common.ts";

const SLEEP_MIN = 450;

/** The numbers of today's file the report may name: last night's sleep and HRV. */
export function fixtureNumbers(): RegExp {
  const hrv = hrvAtZ(0);
  const forms = [String(hrv), String(Math.round(hrv)), String(SLEEP_MIN), "7 ?h(ours?)? ?(and )?30", "7\\.5 ?h", "7:30"];
  return new RegExp(`(^|[^\\d.])(${forms.join("|")})(?![\\d])`, "i");
}

/** The first line the athlete reads in the final reply, without markdown. */
export function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim() !== "") ?? "").replace(/[*_#>`]/g, "").trim();
}

/**
 * Lettered options, on one line or across Markdown list items ("- A) Good" then "- B) Okay"; V6b fix 7).
 * Markdown emphasis is ignored, and list lines are joined before the match.
 */
export function hasLetteredOptions(text: string): boolean {
  const flat = text.replace(/[*_`]/g, "").replace(/\n\s*(?:[-*•+]|\d+\.)?\s*/g, " ");
  return /(^|\s)\(?A\)\s[\s\S]*?\s\(?B\)\s/.test(flat);
}

/** A "How do you feel today?" question, asked with AskUserQuestion or in the reply text. */
export function feelQuestions(a: RunArtifacts): number {
  const asked = askCalls(a).flatMap(({ t }) => (t.input?.questions ?? []).map((q: any) => String(q.question ?? ""))).filter((q) => /how do you feel/i.test(q)).length;
  return asked + (replyText(a).match(/how do you feel today\?/gi) ?? []).length;
}

const scenario: Scenario = {
  name: "31-calm-check-in",
  title: "Check in on a calm morning: the report, no form and no question",
  mode: "interactive",
  skills: ["check-in", "today"],
  approver: [],
  // Any question is unanswered and fails the run ("every question had a scripted answer").
  answers: [],
  prompt: "check in",
  setup(ctx) {
    persona(ctx, { today: { hrvZ: 0, sleepMin: SLEEP_MIN, checkin: null } });
  },
  check(a: RunArtifacts) {
    const reply = replyText(a);
    const final = a.result.text ?? "";
    const today = a.after[`athlete/signals/${a.today}.json`];
    let checkin: unknown = "unreadable";
    try {
      checkin = today ? JSON.parse(today).checkin : undefined;
    } catch {
      /* stays unreadable */
    }
    return [
      check("no AskUserQuestion call", askCalls(a).length === 0, `${askCalls(a).length} call(s)`),
      check("no lettered option list in the reply", !hasLetteredOptions(reply), reply.slice(0, 300)),
      check("no \"How do you feel today?\" question", feelQuestions(a) === 0, `${feelQuestions(a)} found`),
      check("the final reply starts with the verdict (as planned)", /as planned/i.test(firstLine(final)), firstLine(final)),
      check("the reply names a real sleep or HRV number from today's file", fixtureNumbers().test(reply), reply.slice(0, 300)),
      check("no check-in block is written today", checkin === undefined, JSON.stringify(checkin)),
      check("the urgent stop is not written", a.after["athlete/.urgent-stop"] === null),
    ];
  },
};
export default scenario;
