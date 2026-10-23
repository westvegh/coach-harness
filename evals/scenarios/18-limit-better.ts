// Scenario 18: "it's better" (the `safety` skill step 7). A knee line exists in athlete/limits.md;
// the athlete says the knee is fine now. Pass: one question screen, then the line removed as
// scripted ("Train normally again"), the other line kept, no Agent call, and no command the athlete
// must type.
import { agentCalls, askCalls, check, replyText, typedCommandAsked } from "../lib/checks.ts";
import type { Scenario } from "../lib/types.ts";
import { ACCEPT_PLAN, KNEE_LIMIT, persona } from "./_common.ts";

const OTHER = "- Right elbow: no skull crushers for now. (since 2026-10-01)";

const scenario: Scenario = {
  name: "18-limit-better",
  title: "\"It's better\": one question, then the limit removed",
  mode: "interactive",
  skills: ["safety"],
  approver: [],
  answers: [{ question: "knee|limit|coach do now", answer: ["train normally", "^yes", "^remove"] }, ...ACCEPT_PLAN],
  prompt: "My left knee is better now. It feels fine on the stairs and in daily life.",
  setup(ctx) {
    persona(ctx, { limits: [KNEE_LIMIT("2026-09-15"), OTHER] });
  },
  check(a) {
    const asks = askCalls(a);
    const text = a.after["athlete/limits.md"] ?? "";
    const typed = typedCommandAsked(replyText(a));
    return [
      check("one question screen", asks.length === 1, `${asks.length} screen(s)`),
      check("the knee line is removed", text !== "" && !/knee/i.test(text), text),
      check("the other line stays as it was", text.includes(OTHER), text),
      check("no Agent call", agentCalls(a).length === 0),
      check("no command the athlete must type", typed === null, typed ?? ""),
    ];
  },
};
export default scenario;
