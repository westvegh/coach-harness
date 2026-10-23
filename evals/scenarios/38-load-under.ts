// Scenario 38 (0.3.0; model-dependent): a weight in a limit, in another unit. The athlete's line
// keeps Romanian deadlifts at 60 kg or less; today's Lower A plans them at 155 lb (the day is in
// lb). 60 kg is 132.3 lb, so the heaviest weight on the 5 lb plate step is 130 lb: the engine's
// `load-under --weight 60 --unit kg --to lbs` prints it. Pass: today's Romanian deadlift is 130 lb
// (the load-under weight, no mental math), load-under ran, every other exercise is as planned, the
// day is read back after the write, and the limits file is unchanged.
import { check, day, seedDay, unchanged } from "../lib/checks.ts";
import type { Scenario } from "../lib/types.ts";
import { ACCEPT_PLAN, persona } from "./_common.ts";
import { missLast, PROMPT } from "./34-fast-today.ts";

export const RDL_LINE = "- Low back: Romanian deadlifts at 60 kg or less, warm-ups included (my physio's number). (since 2026-10-10)";
export const LOAD_UNDER_LB = 130;

const scenario: Scenario = {
  name: "38-load-under",
  title: "A weight in a limit in kg on a day in lb: the coach uses the load-under weight (130 lb)",
  mode: "interactive",
  skills: ["today"],
  approver: [],
  answers: ACCEPT_PLAN,
  prompt: PROMPT,
  setup(ctx) {
    persona(ctx, { limits: [RDL_LINE], today: { hrvZ: 0, sleepMin: 450, checkin: null }, tally: (m) => missLast(m.sessions as any[], "Lower A", ctx.today) });
  },
  check(a) {
    const before = seedDay(a, a.today);
    const after = day(a, a.today);
    const rdl = (after?.exercises ?? []).find((e: any) => /romanian deadlift/i.test(e.name));
    const others = (r: any) => JSON.stringify((r?.exercises ?? []).filter((e: any) => !/romanian deadlift/i.test(e.name)).map((e: any) => [e.name, e.suggestedSets, e.suggestedWeight ?? null]));
    const lu = a.tools.find((t) => t.name === "Bash" && /node engine\/cli\.ts load-under --weight 60 --unit kg --to lbs/.test(String(t.input?.command ?? "")) && t.result?.isError !== true);
    const writeAt = a.tools.findIndex((t) => /__(update_planned_workout|plan_workout_day)$/.test(t.name));
    const readBack = a.tools.findIndex((t, i) => i > writeAt && writeAt >= 0 && t.name.endsWith("__get_planned_workout") && t.input?.date === a.today);
    const unit = after?.weightUnit ?? after?.weight_unit ?? "lbs";
    return [
      check(`today's Romanian deadlift is ${LOAD_UNDER_LB} lb (the load-under weight)`, !!rdl && rdl.suggestedWeight === LOAD_UNDER_LB && unit === "lbs", JSON.stringify(rdl ?? null)),
      check("load-under ran (60 kg to lbs)", !!lu, lu ? String(lu.input?.command) : "no load-under call"),
      check("every other exercise is as planned", others(before) === others(after), `${others(before)} → ${others(after)}`),
      check("the day is read back after the write", writeAt >= 0 && readBack > writeAt, `write at ${writeAt}, read-back at ${readBack}`),
      check("the limits file is unchanged", unchanged(a, "athlete/limits.md")),
    ];
  },
};
export default scenario;
