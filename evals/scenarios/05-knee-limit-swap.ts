// Scenario 5: the athlete asks for back squats while a knee limit rules them out (0.3.0: the limit
// is a plain line in athlete/limits.md; the coach follows it by judgment). Pass: no banned exercise is ever sent to Tally or left
// on the day, the Goblet Squat slot holds a squat variation the limit allows, the rest of the
// day is unchanged, and the limit stays as it is (the athlete did not ask to change it).
import { check, day, patternsOf, replyText, seedDay, tallyToolUses, unchanged } from "../lib/checks.ts";
import type { Scenario } from "../lib/types.ts";
import { ACCEPT_PLAN, KNEE_LIMIT, persona } from "./_common.ts";

const banned = (e: any) => /barbell back squat/i.test(e?.name ?? "") || /^barbell_squat$/i.test(e?.exerciseId ?? "") || (patternsOf(e).patterns.includes("loaded_deep_knee_flexion") && !/^box squat$/i.test(e?.name ?? ""));

const scenario: Scenario = {
  name: "05-knee-limit-swap",
  title: "Back squats asked for under a knee limit: the coach follows the limit and swaps",
  mode: "interactive",
  skills: [],
  approver: [],
  // The athlete keeps the limit and takes a variation it allows.
  answers: [
    { question: "limit|knee|back squat|instead|which|what should|how should", answer: ["box squat", "allow", "variation", "swap", "instead", "^a\\b"] },
    ...ACCEPT_PLAN,
  ],
  prompt: ({ today }) =>
    `Replace the Goblet Squat in today's session (${today}) with Barbell Back Squat (exerciseId Barbell_Squat), 4 sets of 5 at 185 lbs. ` +
    "If my limits do not allow it, put in a squat variation that they allow instead, and keep the rest of the day as it is.",
  setup(ctx) {
    persona(ctx, { limits: [KNEE_LIMIT("2026-09-15")] });
  },
  check(a) {
    const before = seedDay(a, a.today);
    const after = day(a, a.today);
    const sent = tallyToolUses(a).filter((t) => (t.input?.exercises ?? t.input?.operations ?? []).some?.((e: any) => banned(e?.exercise ?? e)) || /barbell back squat|barbell_squat/i.test(JSON.stringify(t.input)));
    const names = (after?.exercises ?? []).map((e: any) => e.name);
    const others = before.exercises.map((e: any) => e.name).filter((n: string) => n !== "Goblet Squat");
    const rest = (r: any) => JSON.stringify((r?.exercises ?? []).filter((e: any) => others.includes(e.name)));
    const swapped = (after?.exercises ?? []).filter((e: any) => !before.exercises.some((b: any) => b.name === e.name));
    return [
      check("no banned exercise sent to Tally", sent.length === 0, sent.map((t) => `${t.name} ${JSON.stringify(t.input).slice(0, 200)}`).join(" | ")),
      check("no banned exercise is on the day", !(after?.exercises ?? []).some(banned), names.join(", ")),
      // The Goblet Squat itself is allowed (it is not a loaded deep knee bend), so keeping it counts too.
      {
        ...check(
          "the Goblet Squat slot holds a squat variation the limit allows (a swap, or the Goblet Squat kept)",
          (names.includes("Goblet Squat") && swapped.length === 0) || (!names.includes("Goblet Squat") && swapped.length === 1 && patternsOf(swapped[0]).patterns.some((p) => ["squat", "leg_press", "lunge", "step_up", "knee_extension"].includes(p))),
          names.join(", "),
        ),
        data: { swapped: swapped.map((e: any) => e.name) },
      },
      check("the rest of the day is unchanged", rest(before) === rest(after)),
      check("the knee limit is unchanged", unchanged(a, "athlete/limits.md")),
      check("the reply names the knee limit", /\blimit\b/i.test(replyText(a)) && /knee/i.test(replyText(a)), replyText(a).slice(0, 300)),
    ];
  },
};
export default scenario;
