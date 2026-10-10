// Scenario 2: one off morning (low HRV plus short sleep, both wearable signals) after a
// calm week. One day is not a pattern (NA-REC-008): a note, and no change to the session's
// exercises or sets. Loads may still progress (no load hold; they rise only on hit reps,
// within top_set_jump_max). A trim, a recovery swap, or a changed exercise or set count fails.
import { join } from "node:path";
import { loadRules, ruleCheck } from "../../engine/methods.ts";
import { check, mutationCalls, seedDay, day, successfulWrites } from "../lib/checks.ts";
import { REPO } from "../lib/instance.ts";
import type { Scenario } from "../lib/types.ts";
import { DAILY, persona } from "./_common.ts";

/** The method's top_set_jump_max (nine-adaptations: 0.10). */
const jumpMax = () => ruleCheck(loadRules(join(REPO, "methods/nine-adaptations")), "top_set_jump_max")?.value ?? 0;

/** Problems with today's change: anything but the same exercises and sets, with loads or reps held or raised within the cap. */
export function changeProblems(before: any, after: any, cap: number): string[] {
  const b = before?.exercises ?? [];
  const x = after?.exercises ?? [];
  const out: string[] = [];
  if (!after) return ["today's day is missing"];
  if (after.status !== before.status) out.push(`status ${before.status} -> ${after.status}`);
  if (b.length !== x.length) out.push(`${b.length} exercises -> ${x.length}`);
  for (let i = 0; i < Math.min(b.length, x.length); i++) {
    const [p, q] = [b[i], x[i]];
    if (p.name !== q.name || p.exerciseId !== q.exerciseId) out.push(`slot ${i + 1}: ${p.name} -> ${q.name}`);
    if (p.suggestedSets !== q.suggestedSets) out.push(`${p.name}: sets ${p.suggestedSets} -> ${q.suggestedSets}`);
    if ((q.suggestedReps ?? 0) < (p.suggestedReps ?? 0)) out.push(`${p.name}: reps ${p.suggestedReps} -> ${q.suggestedReps}`);
    const [w0, w1] = [p.suggestedWeight ?? null, q.suggestedWeight ?? null];
    if (w0 === null ? w1 !== null : w1 === null || w1 < w0 || w1 > w0 * (1 + cap) + 1e-9) out.push(`${p.name}: load ${w0} -> ${w1} (cap +${cap * 100}%)`);
  }
  return out;
}

const scenario: Scenario = {
  name: "02-one-category-no-change",
  title: "One off morning (low HRV and short sleep): a note, no change",
  mode: "unattended",
  skills: ["today"],
  prompt: DAILY,
  setup(ctx) {
    persona(ctx, { today: { hrvZ: -2.2, sleepMin: 340, checkin: null } });
  },
  check(a) {
    const writes = successfulWrites(a);
    const before = seedDay(a, a.today);
    const after = day(a, a.today);
    const others = Object.keys({ ...a.seed.days, ...a.mock.days }).filter((d) => d !== a.today && JSON.stringify((a.seed.days as any)[d]?.exercises) !== JSON.stringify((a.mock.days as any)[d]?.exercises));
    const problems = changeProblems(before, after, jumpMax());
    const notToday = writes.filter((w) => !JSON.stringify(w.args ?? {}).includes(`"${a.today}"`));
    return [
      check("same exercises and sets; loads or reps only held or raised within top_set_jump_max", problems.length === 0, problems.join("; ")),
      check("the reason note is in today's notes", typeof after?.notes === "string" && after.notes.trim() !== "" && after.notes !== before.notes, JSON.stringify(after?.notes)),
      check("at most a note and a load progression, on today only", writes.length <= 2 && notToday.length === 0, `${writes.length} writes: ${writes.map((w) => w.tool).join(", ")}`),
      check("no other day changed", others.length === 0, others.join(", ")),
      check("the run did reach Tally (read today's day)", a.mock.calls.some((c) => c.tool === "get_planned_workout" && c.args?.date === a.today), `${mutationCalls(a).length} mutation calls`),
    ];
  },
};
export default scenario;
