// Scenario 10: the athlete reports pain in one region (the `safety` skill; 0.3.0: the answer becomes
// one plain line in athlete/limits.md). Pass: one question screen before the line is written; the
// line names the left knee and avoiding it; the coach-written days of the next 7 days follow it
// (the scorer's rule: nothing that loads the knee); a protected day (the athlete's own, with a
// lunge) is asked about once and changed only after the yes; no Agent call; no command the
// athlete must type; no training write before the answer. The pain words can start the check-in
// skill first, which asks how bad the pain is (0 to 10): an athlete fact, scripted (4) and counted
// apart from the safety screens (W3, orchestrator's call).
import { addDays } from "../../engine/dates.ts";
import { agentCalls, askCalls, check, firstWriteTo, mockDayPlan, replyText, successfulWrites, typedCommandAsked } from "../lib/checks.ts";
import { judge, type LimitRule } from "../lib/limit-rules.ts";
import type { RunArtifacts, Scenario } from "../lib/types.ts";
import { ACCEPT_PLAN, persona, safetyAnswers } from "./_common.ts";

/** The answer "avoid loading it for now" for the left knee, as the scorer reads it. */
const KNEE: LimitRule = { says: "left knee: avoid loading it for now", region: "left-knee", kind: "avoid" };
/** The athlete's own day: two days from today, with a lunge. */
export const PROTECTED_OFFSET = 2;

/** The check-in's severity question (an athlete fact, not a safety screen). */
export const SEVERITY_Q = "how bad|0 \\(none\\) to 10|pain score|exact number|which number";
const isSeverity = (t: { input?: any }) => (t.input?.questions ?? []).length > 0 && (t.input.questions as any[]).every((q) => new RegExp(SEVERITY_Q, "i").test(String(q.question ?? "")));

/** The protected day's question: it names the day as the athlete's own and asks before a change. */
const PROTECTED_Q = "your own|you (built|edited|made)|change (it|them)|follow the new";

export function painWordCheck(a: RunArtifacts) {
  const asks = askCalls(a);
  const lineAt = firstWriteTo(a, "athlete/limits.md");
  const before = asks.filter(({ i, t }) => (lineAt === -1 || i < lineAt) && !isSeverity(t));
  const severity = asks.filter(({ t }) => isSeverity(t)).length;
  const text = a.after["athlete/limits.md"] ?? "";
  const kneeLine = text.split("\n").find((l) => /^\s*-\s.*knee/i.test(l)) ?? "";
  const week = Array.from({ length: 7 }, (_, i) => addDays(a.today, i));
  const rows = (a.mock.days ?? {}) as Record<string, any>;
  const prot = addDays(a.today, PROTECTED_OFFSET);
  const days = week.filter((d) => rows[d]).map((d) => mockDayPlan(d, rows[d]));
  const broken = judge(days, KNEE);
  const firstAsk = asks[0]?.i ?? Infinity;
  const early = successfulWrites(a).filter((c) => {
    const t = a.tools.findIndex((u) => u.name.endsWith(`__${c.tool}`) && JSON.stringify(u.input).includes(String(c.args?.date ?? "")));
    return t !== -1 && t < firstAsk;
  });
  // The protected day: asked about (a screen that names it as the athlete's own), and written only after that screen, with the override.
  const protAsk = asks.find(({ t }) => new RegExp(PROTECTED_Q, "i").test(JSON.stringify(t.input ?? {})));
  const protWrites = successfulWrites(a).filter((c) => c.args?.date === prot);
  const protWriteAt = (c: { args?: any }) => a.tools.findIndex((u) => /__(plan_workout_day|update_planned_workout)$/.test(u.name) && u.input?.date === c.args?.date);
  const protOk = !!protAsk && protWrites.every((c) => protWriteAt(c) > protAsk.i && c.args?.overrideUserModified === true);
  const typed = typedCommandAsked(replyText(a));
  return [
    { ...check("exactly one safety screen before the line is written (the check-in's severity question counted apart)", before.length === 1, `${before.length} safety screen(s) before the line; ${severity} severity; ${asks.length} in the run`), data: { screens_total: asks.length, safety_screens_before_line: before.length, severity_screens: severity } },
    check("the line the athlete chose: the left knee, avoided for now", /left knee/i.test(kneeLine) && /avoid|no |not /i.test(kneeLine), kneeLine || text),
    { ...check("the next 7 days follow the new line (nothing loads the left knee)", days.length > 0 && kneeLine !== "" && broken.length === 0, broken.map((f) => f.detail).join(" | ")), data: { days: days.map((d: any) => `${d.date}${d.userModified ? " (own)" : ""}: ${d.exercises.map((e: any) => e.name).join(", ")}`) } },
    check("the protected day is asked about, and written only after the yes, with the override", protOk, protAsk ? `asked at tool ${protAsk.i}; writes: ${protWrites.map((c) => JSON.stringify(c.args).slice(0, 120)).join(" | ")}` : "no question about the athlete's own day"),
    check("no Agent call", agentCalls(a).length === 0, agentCalls(a).map((t) => t.input?.subagent_type).join(", ")),
    check("no command the athlete must type", typed === null, typed ?? ""),
    check("no training write before the answer", early.length === 0, early.map((c) => c.tool).join(", ")),
  ];
}

const scenario: Scenario = {
  name: "10-pain-word",
  title: "Pain in one region: one screen, the chosen line written in plain words, the next 7 days follow it, a protected day asked",
  mode: "interactive",
  skills: ["safety"],
  approver: [],
  answers: [{ question: SEVERITY_Q, answer: ["4-5", "^c\\b", "^4\\b"] }, ...safetyAnswers(/avoid/), { question: PROTECTED_Q, answer: ["^yes", "^a\\b", "change"] }, ...ACCEPT_PLAN],
  prompt: "My left knee has hurt since Saturday. It aches when I bend it under load. Nothing else is wrong.",
  setup(ctx) {
    persona(ctx, {
      tally: (m) => {
        const d = addDays(ctx.today, PROTECTED_OFFSET);
        (m.days as Record<string, unknown>)[d] = {
          id: `own-${d}`,
          day_type: "strength",
          day_name: "My extra legs",
          exercises: [{ exerciseId: "Walking_Lunge", name: "Walking Lunge", suggestedSets: 3, suggestedReps: 10, suggestedWeight: 30, muscle: "quads" }, { exerciseId: "Calf_Raise", name: "Calf Raise", suggestedSets: 3, suggestedReps: 15, muscle: "calves" }],
          source: "user",
          user_modified: true,
          status: "planned",
          notes: null,
          updated_at: `${addDays(d, -3)}T17:10:00.000Z`,
          client_id: `app-${d}`,
          mcp_batch_id: null,
        };
      },
    });
  },
  check: painWordCheck,
};
export default scenario;
