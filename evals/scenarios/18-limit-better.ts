// Scenario 18: "it's better" (v0.2, the `safety` skill step 7). A knee limit exists; the
// athlete says the knee is fine now. Pass: one question screen, then the limit removed as
// scripted ("Yes"), no Agent call, and no command the athlete must type.
import { agentCalls, askCalls, check, replyText, typedCommandAsked, yamlOf } from "../lib/checks.ts";
import type { Scenario } from "../lib/types.ts";
import { ACCEPT_PLAN, KNEE_LIMIT, persona } from "./_common.ts";

const scenario: Scenario = {
  name: "18-limit-better",
  title: "\"It's better\": one question, then the limit removed",
  mode: "interactive",
  skills: ["safety"],
  approver: [],
  answers: [{ question: "limit", answer: ["^yes", "^remove"] }, ...ACCEPT_PLAN],
  prompt: "My left knee is better now. It feels fine on the stairs and in daily life.",
  setup(ctx) {
    persona(ctx, { limits: [KNEE_LIMIT("2026-09-15")] });
  },
  check(a) {
    const asks = askCalls(a);
    const limits = (yamlOf(a.after["athlete/limits.yaml"])?.limits ?? []) as any[];
    const typed = typedCommandAsked(replyText(a));
    return [
      check("one question screen", asks.length === 1, `${asks.length} screen(s)`),
      check("the knee limit is removed", !limits.some((l) => l.id === "L-001" || /knee/.test(String(l.region))), JSON.stringify(limits)),
      check("no Agent call", agentCalls(a).length === 0),
      check("no command the athlete must type", typed === null, typed ?? ""),
    ];
  },
};
export default scenario;
