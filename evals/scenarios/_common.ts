// Shared scenario pieces: the persona setup, today's signals and the dispatch prompts.
import { addDays, hrvAtZ, KNEE_LIMIT, offMornings, signalFile, tallyState, writeAthlete, type Checkin, type Limit } from "../lib/instance.ts";
import type { SetupContext } from "../lib/types.ts";
import type { MockState } from "../mock-tally/client.ts";

/** The routine prompt (contracts §14: prompts dispatch explicitly). */
export const DAILY = "Read .claude/skills/today/SKILL.md and follow it exactly. Unattended run.";
export const WEEKLY = "Read .claude/skills/week/SKILL.md and follow it exactly. Unattended run.";

/** The scripted user says yes to every guard question on a Tally write, and no to anything else. */
export const YES_TO_TALLY = [{ tool: "^mcp__.*[Tt]ally.*__", behavior: "allow" as const }];

/** `offMornings`: the run of off-mornings ending today, today included (today's hrvZ must be off too). */
export type TodaySignal = { hrvZ?: number; sleepMin?: number; checkin?: Checkin | null; offMornings?: number };

export const GOOD_CHECKIN: Checkin = { sleep_quality: 4, energy: 4, soreness: 2, stress: 2 };
/** Mean 2.0 after inversion (soreness and stress 4 → 2): subjective amber, no scale at 1. */
export const LOW_CHECKIN: Checkin = { sleep_quality: 2, energy: 2, soreness: 4, stress: 4 };
/** Every scale at its worst: subjective red. */
export const RED_CHECKIN: Checkin = { sleep_quality: 1, energy: 1, soreness: 5, stress: 5 };

/** The standard instance: Alex's files, 45 baseline days, today's signal file and the Tally state. */
export function persona(ctx: SetupContext, o: { limits?: Limit[]; today?: TodaySignal; weekly?: { day: string; time: string }; block?: string; tally?: (m: MockState) => void } = {}): void {
  writeAthlete(ctx.write, ctx.today, { limits: o.limits, weekly: o.weekly, block: o.block });
  const t = o.today ?? {};
  if (t.offMornings) offMornings(ctx.write, ctx.today, t.offMornings);
  ctx.write(
    `athlete/signals/${ctx.today}.json`,
    signalFile(ctx.today, { hrv: hrvAtZ(t.hrvZ ?? 0), sleepMin: t.sleepMin ?? 450, checkin: t.checkin === undefined ? GOOD_CHECKIN : t.checkin }),
  );
  Object.assign(ctx.mock, tallyState(ctx.today));
  o.tally?.(ctx.mock);
}

export { addDays, KNEE_LIMIT };
