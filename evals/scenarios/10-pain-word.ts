// Scenario 10: the athlete reports pain in one region (v0.2, the `safety` skill). Pass: one
// question screen in the whole run (V3b: the skill changes the conflicting days without a
// second screen), the limit the athlete chose (scripted: avoid loading it), the planned days
// of the next 7 days follow it, no Agent call, and no command the athlete must type.
import { addDays } from "../../engine/dates.ts";
import { agentCalls, askCalls, check, firstWriteTo, limitsCheck, mockDayPlan, replyText, successfulWrites, typedCommandAsked, yamlOf } from "../lib/checks.ts";
import type { Scenario } from "../lib/types.ts";
import { ACCEPT_PLAN, persona, safetyAnswers } from "./_common.ts";

const scenario: Scenario = {
  name: "10-pain-word",
  title: "Pain in one region: one question screen, the chosen limit written, no agent",
  mode: "interactive",
  skills: ["safety"],
  approver: [],
  answers: [...safetyAnswers(/avoid/), ...ACCEPT_PLAN],
  prompt: "My left knee has hurt since Saturday. It aches when I bend it under load. Nothing else is wrong.",
  setup(ctx) {
    persona(ctx);
  },
  check(a) {
    const asks = askCalls(a);
    const limitAt = firstWriteTo(a, "athlete/limits.yaml");
    const before = asks.filter(({ i }) => limitAt === -1 || i < limitAt);
    const limits = (yamlOf(a.after["athlete/limits.yaml"])?.limits ?? []) as any[];
    const knee = limits.filter((l) => /knee/.test(String(l.region)));
    // The coach-written days of the next 7 days, checked against the limits the run left.
    const week = Array.from({ length: 7 }, (_, i) => addDays(a.today, i));
    const days = week.filter((d) => (a.mock.days as Record<string, any>)?.[d]).map((d) => mockDayPlan(d, (a.mock.days as Record<string, any>)[d]));
    let broken: { date?: string; exercise?: string; detail: string }[] = [];
    try {
      broken = days.length && knee.length ? limitsCheck(days, a.after["athlete/limits.yaml"] ?? "").findings.filter((f) => f.kind !== "unclassified") : [];
    } catch (e) {
      broken = [{ detail: `limits check failed: ${(e as Error).message.split("\n")[1] ?? (e as Error).message}` }];
    }
    const firstAsk = asks[0]?.i ?? Infinity;
    const early = successfulWrites(a).filter((c) => {
      const t = a.tools.findIndex((u) => u.name.endsWith(`__${c.tool}`) && JSON.stringify(u.input).includes(String(c.args?.date ?? "")));
      return t !== -1 && t < firstAsk;
    });
    const typed = typedCommandAsked(replyText(a));
    return [
      { ...check("one question screen in the whole run", asks.length === 1, `${asks.length} screen(s) in the run; ${before.length} before the limit`), data: { screens_total: asks.length, screens_before_limit: before.length } },
      check("the limit the athlete chose: a ban on the left knee", knee.length === 1 && knee[0].rule === "ban" && /left-knee|^knee$/.test(knee[0].region), JSON.stringify(knee)),
      { ...check("the next 7 days follow the new limit (limits check on the planned days)", knee.length > 0 && broken.length === 0, broken.map((f) => `${f.date} ${f.exercise}: ${f.detail}`).join(" | ")), data: { days: days.map((d: any) => `${d.date}: ${d.exercises.map((e: any) => e.name).join(", ")}`) } },
      check("no Agent call", agentCalls(a).length === 0, agentCalls(a).map((t) => t.input?.subagent_type).join(", ")),
      check("no command the athlete must type", typed === null, typed ?? ""),
      check("no training write before the answer", early.length === 0, early.map((c) => c.tool).join(", ")),
    ];
  },
};
export default scenario;
