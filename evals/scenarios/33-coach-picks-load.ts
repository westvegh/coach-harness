// Scenario 33 (V6): the coach picks the load. Today's planned day is protected (built in the app,
// source not mcp) and plans Romanian Deadlift at 155 lbs. The history has the miss case: a miss
// at 155 two weeks ago, then a miss at 145 last week (9, 9, 7 of 8 is a hit on two sets, short on
// one; 155 × 8, 6, 6 the week before). The athlete asks "what's my workout today?"; the scripted
// answer to the one consent question is "Yes". Pass: exactly one question, with the options Yes,
// Change something and Not now, and no question that offers load choices; the reply gives 145
// with a reason; no Tally write before the consent answer (V6b fix 6); Tally's day after the run
// has the deadlift at 145 (repeated, not the 5% drop to 135) and equals the approved list exactly:
// every exercise, set count, reps and load, none extra or missing.
import { join } from "node:path";
import { suggestLoads } from "../../engine/loads.ts";
import { readYamlFile } from "../../engine/yaml-file.ts";
import type { Rules } from "../../engine/types.ts";
import { askCalls, check, day, MUTATIONS, replyText, seedDay, taxonomy } from "../lib/checks.ts";
import { addDays, REPO } from "../lib/instance.ts";
import type { RunArtifacts, Scenario } from "../lib/types.ts";
import { persona } from "./_common.ts";

export const RDL = "Romanian Deadlift";

/**
 * Tally writes made before the consent answer (V6b fix 6): a mutation tool use before the
 * question in the run's order, or a mock write stamped before the answer came back. With no
 * question at all, every write is early.
 */
export function writesBeforeConsent(a: RunArtifacts): string[] {
  const ask = a.tools.findIndex((t) => t.name === "AskUserQuestion");
  const out: string[] = [];
  a.tools.forEach((t, i) => {
    if ((ask === -1 || i < ask) && MUTATIONS.some((m) => t.name.endsWith(`__${m}`))) out.push(`tool ${i} ${t.name.split("__").pop()} before the question`);
  });
  // The answer time: the question's tool result, else the screen's stamp; unknown leaves the order check alone.
  const stamp = ask === -1 ? NaN : (a.tools[ask].resultAt ?? Date.parse(a.screens?.[0]?.at ?? ""));
  for (const c of a.mock.calls ?? []) {
    if (!MUTATIONS.includes(c.tool)) continue;
    if (ask === -1 || (Number.isFinite(stamp) && Date.parse(c.at) < stamp)) out.push(`${c.tool} at ${c.at}, before the answer`);
  }
  return [...new Set(out)];
}

/**
 * The approved list: today's planned day with each load the engine suggests from the seeded
 * history (the deadlift repeats 145; a hit steps up), and the planned sets and reps. The day after
 * the run must equal it exactly: no extra or missing exercise, the same set counts, reps and loads.
 */
export function approvedDay(a: RunArtifacts): { name: string; sets: number; reps: number | null; weight: number | null }[] {
  const plan: any[] = seedDay(a, a.today)?.exercises ?? [];
  const history = ((a.seed.sessions ?? []) as any[]).map((s) => ({
    date: s.date,
    weightUnit: s.weightUnit,
    exercises: s.exercises.map((e: any) => ({ exerciseId: "", name: e.name, muscle: e.muscle ?? "", sets: e.sets.map((x: any) => ({ weight: x.weight ?? null, reps: x.reps ?? null, rpe: null })) })),
  }));
  const rules = readYamlFile(join(REPO, "methods/nine-adaptations/rules.yaml")) as Rules;
  return plan.map((e) => {
    const [s] = suggestLoads([{ name: e.name, sets: Array.from({ length: e.suggestedSets }, () => ({ reps: e.suggestedReps })) }], history as any, rules, "lbs", { tax: taxonomy() });
    return { name: e.name, sets: e.suggestedSets, reps: e.suggestedReps ?? null, weight: e.suggestedWeight === undefined ? null : (s.suggestedWeight ?? e.suggestedWeight) };
  });
}

/** How the day after the run differs from the approved list; empty when it matches. */
export function dayProblems(a: RunArtifacts): string[] {
  const want = approvedDay(a);
  const got: any[] = day(a, a.today)?.exercises ?? [];
  const out: string[] = [];
  for (const w of want) {
    const g = got.find((e) => e.name === w.name);
    if (!g) {
      out.push(`${w.name}: missing`);
      continue;
    }
    const gw = g.suggestedWeight ?? null;
    if (g.suggestedSets !== w.sets) out.push(`${w.name}: sets ${g.suggestedSets}, approved ${w.sets}`);
    if ((g.suggestedReps ?? null) !== w.reps) out.push(`${w.name}: reps ${g.suggestedReps}, approved ${w.reps}`);
    if (gw !== w.weight) out.push(`${w.name}: load ${gw}, approved ${w.weight}`);
  }
  for (const g of got) if (!want.some((w) => w.name === g.name)) out.push(`${g.name}: not in the approved list`);
  if (got.length !== want.length) out.push(`${got.length} exercises, approved ${want.length}`);
  return [...new Set(out)];
}

const scenario: Scenario = {
  name: "33-coach-picks-load",
  title: "The coach picks the load on a protected day: one consent question, the lighter weight repeated",
  mode: "interactive",
  skills: ["today"],
  approver: [],
  // The label may carry its letter ("A) Yes").
  answers: [{ question: "apply these", answer: ["^(a\\) )?yes"] }],
  prompt: "what's my workout today?",
  setup(ctx) {
    persona(ctx, {
      tally(m) {
        const row = (m.days as any)[ctx.today];
        row.source = "builder";
        const sessions = m.sessions as any[];
        const rdl = (date: string) => sessions.find((s) => s.date === date)?.exercises.find((e: any) => e.name === RDL);
        const lastWeek = rdl(addDays(ctx.today, -7));
        const twoWeeks = rdl(addDays(ctx.today, -14));
        if (lastWeek) lastWeek.sets = [9, 9, 7].map((reps) => ({ weight: 145, reps }));
        if (twoWeeks) twoWeeks.sets = [8, 6, 6].map((reps) => ({ weight: 155, reps }));
      },
    });
  },
  check(a: RunArtifacts) {
    const asks = askCalls(a);
    const qs = asks.flatMap(({ t }) => (t.input?.questions ?? []) as any[]);
    const opts = (q: any) => (q?.options ?? []).map((o: any) => String(o.label ?? o));
    const consent = qs.length === 1 && [/^(a\) )?yes/i, /change something/i, /not now/i].every((re) => opts(qs[0]).some((o: string) => re.test(o)));
    const loadChoice = qs.filter((q) => opts(q).some((o: string) => /\d+\s*(lb|lbs|kg)\b/i.test(o)) || /which weight/i.test(String(q.question)));
    const early = writesBeforeConsent(a);
    const diff = dayProblems(a);
    const rdl = (day(a, a.today)?.exercises ?? []).find((e: any) => e.name === RDL);
    const reply = replyText(a);
    return [
      check("exactly one question: Yes, Change something, Not now", asks.length === 1 && consent, JSON.stringify(qs.map((q) => [q.question, opts(q)]))),
      check("no question offers load choices", loadChoice.length === 0, JSON.stringify(loadChoice.map((q) => q.question))),
      check("no Tally write before the consent answer", early.length === 0, early.join(" | ")),
      check("the reply gives 145 with a reason", /\b145\b/.test(reply) && /miss|short|last time|lighter|repeat|9, 9, 7|9,9,7/i.test(reply), reply.slice(0, 400)),
      check("Tally has the deadlift at 145 (repeated, not the 5% drop)", rdl?.suggestedWeight === 145, JSON.stringify(rdl ?? null)),
      check("the day after the run equals the approved list exactly (every exercise, sets, reps and load; none extra or missing)", diff.length === 0, diff.join(" | ")),
    ];
  },
};
export default scenario;
