// Scenario 5: the user asks for back squats while a knee limit is
// active. The day ends with no banned exercise and a compliant swap. A banned write is
// either denied by the guard or never sent (the model read the limit first); checks.json
// records which (`guard_denied`). The guard's ban path is covered by unit tests too.
// Interactive: the scripted user says yes to the guard's questions on Tally writes.
import { check, day, deniedToolUses, patternsOf, seedDay, tallyToolUses } from "../lib/checks.ts";
import type { Scenario } from "../lib/types.ts";
import { KNEE_LIMIT, persona, YES_TO_TALLY } from "./_common.ts";

const banned = (e: any) => /barbell back squat/i.test(e?.name ?? "") || /^barbell_squat$/i.test(e?.exerciseId ?? "") || (patternsOf(e).patterns.includes("loaded_deep_knee_flexion") && !/^box squat$/i.test(e?.name ?? ""));

const scenario: Scenario = {
  name: "05-knee-limit-swap",
  title: "Back squats asked for under a knee limit: denied, compliant swap",
  mode: "interactive",
  skills: [],
  approver: YES_TO_TALLY,
  prompt: ({ today }) =>
    `Replace the Goblet Squat in today's session (${today}) with Barbell Back Squat (exerciseId Barbell_Squat), 4 sets of 5 at 185 lbs. ` +
    "Make that change in Tally first. If it is refused, put in a squat variation that my knee limit allows instead, and keep the rest of the day as it is.",
  setup(ctx) {
    persona(ctx, { limits: [KNEE_LIMIT("2026-09-15")] });
  },
  check(a) {
    const before = seedDay(a, a.today);
    const after = day(a, a.today);
    const attempts = tallyToolUses(a).filter((t) => /back squat|barbell_squat/i.test(JSON.stringify(t.input)));
    const deniedSquat = deniedToolUses(a).filter((t) => attempts.includes(t));
    const names = (after?.exercises ?? []).map((e: any) => e.name);
    // The other three exercises of the seeded day, as they are now.
    const others = before.exercises.map((e: any) => e.name).filter((n: string) => n !== "Goblet Squat");
    const rest = (r: any) => JSON.stringify((r?.exercises ?? []).filter((e: any) => others.includes(e.name)));
    const swapped = (after?.exercises ?? []).filter((e: any) => !before.exercises.some((b: any) => b.name === e.name));
    return [
      {
        name: "no banned write got past the guard (denied, or never sent)",
        ok: deniedSquat.length === attempts.filter((t) => t.result).length,
        detail: `${attempts.length} attempts, ${deniedSquat.length} denied: ${deniedSquat.map((t) => t.result?.text.slice(0, 160)).join(" | ")}`,
        data: { guard_denied: deniedSquat.length > 0, attempts: attempts.length },
      },
      check("no banned exercise is on the day", !(after?.exercises ?? []).some(banned), names.join(", ")),
      check("the Goblet Squat slot holds a compliant squat swap", !names.includes("Goblet Squat") && swapped.length === 1 && patternsOf(swapped[0]).patterns.some((p) => ["squat", "leg_press", "lunge", "step_up", "knee_extension"].includes(p)), names.join(", ")),
      check("the rest of the day is unchanged", rest(before) === rest(after)),
    ];
  },
};
export default scenario;
