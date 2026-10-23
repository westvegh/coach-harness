// Scenario 36 (0.3.0; model-dependent): a recovery day under a limit. The short pattern and a red
// check-in make today a recovery day (as 04). adjust no longer filters by limits, and its draft has
// a mobility flow; the athlete's line rules out mobility flows. Pass: today is a recovery day (only
// recovery patterns), no mobility flow or yoga on it, the reason in the notes, the limits file
// unchanged, and no question (unattended).
import { askCalls, check, day, patternsOf, taxonomy, unchanged } from "../lib/checks.ts";
import type { Scenario } from "../lib/types.ts";
import { DAILY, persona, RED_CHECKIN } from "./_common.ts";

export const MOBILITY_LINE = "- Low back: no mobility flows or yoga for now (they flare it up). Breathing work and easy cardio are fine. (since 2026-10-10)";

const scenario: Scenario = {
  name: "36-recovery-under-limit",
  title: "A recovery day under a limit: the adjust draft is checked against the line (no mobility flow)",
  mode: "unattended",
  skills: ["today"],
  prompt: DAILY,
  setup(ctx) {
    persona(ctx, { limits: [MOBILITY_LINE], today: { hrvZ: -2.6, sleepMin: 320, checkin: RED_CHECKIN, offMornings: 3 } });
  },
  check(a) {
    const after = day(a, a.today);
    const tax = taxonomy();
    const recovery = new Set(Object.entries(tax.patterns).filter(([, p]) => (p as { recovery?: boolean }).recovery).map(([k]) => k));
    const exs: any[] = after?.exercises ?? [];
    const cls = exs.map((e) => ({ name: String(e.name), c: patternsOf(e) }));
    const notRecovery = cls.filter((x) => x.c.source === "none" || x.c.patterns.length === 0 || x.c.patterns.some((p) => !recovery.has(p)));
    const ruledOut = cls.filter((x) => x.c.patterns.includes("mobility") || /mobility|yoga/i.test(x.name));
    return [
      check("today is a recovery day (only recovery patterns)", exs.length > 0 && notRecovery.length === 0, JSON.stringify(cls.map((x) => [x.name, x.c.patterns]))),
      check("no mobility flow or yoga on it (the line)", exs.length > 0 && ruledOut.length === 0, ruledOut.map((x) => x.name).join(", ")),
      check("the reason is in today's notes", typeof after?.notes === "string" && after.notes.trim() !== ""),
      check("the limits file is unchanged", unchanged(a, "athlete/limits.md")),
      check("no question (unattended)", askCalls(a).length === 0),
    ];
  },
};
export default scenario;
