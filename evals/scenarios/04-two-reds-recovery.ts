// Scenario 4: the short pattern (3 off-mornings in a row) and a red check-in today
// (NA-REC-010). Today becomes a recovery day (Zone 2, mobility, breathing), and no exercise
// loads the limited region.
import { check, day, logEntries, patternsOf, taxonomy } from "../lib/checks.ts";
import { regionMatches } from "../../engine/taxonomy.ts";
import type { Scenario } from "../lib/types.ts";
import { DAILY, KNEE_LIMIT, persona, RED_CHECKIN } from "./_common.ts";

const scenario: Scenario = {
  name: "04-two-reds-recovery",
  title: "Short pattern plus a red check-in: a recovery day; no limited region loaded",
  mode: "unattended",
  skills: ["today"],
  prompt: DAILY,
  setup(ctx) {
    persona(ctx, { limits: [KNEE_LIMIT("2026-09-15")], today: { hrvZ: -2.6, sleepMin: 320, checkin: RED_CHECKIN, offMornings: 3 } });
  },
  check(a) {
    const after = day(a, a.today);
    const tax = taxonomy();
    const recovery = new Set(Object.entries(tax.patterns).filter(([, p]) => (p as { recovery?: boolean }).recovery).map(([k]) => k));
    const exs: any[] = after?.exercises ?? [];
    const cls = exs.map((e) => ({ name: e.name, c: patternsOf(e) }));
    const notRecovery = cls.filter((x) => x.c.source === "none" || x.c.patterns.length === 0 || x.c.patterns.some((p) => !recovery.has(p)));
    const loadsKnee = cls.filter((x) => regionMatches("left-knee", x.c.regions, tax));
    return [
      check("today is a recovery day (only recovery patterns)", exs.length > 0 && notRecovery.length === 0, JSON.stringify(cls.map((x) => [x.name, x.c.patterns]))),
      check("no exercise loads the limited region (left knee)", loadsKnee.length === 0, loadsKnee.map((x) => x.name).join(", ")),
      check("the reason is in today's notes", typeof after?.notes === "string" && after.notes.trim() !== ""),
      check("one log entry for today", logEntries(a, a.today).length === 1),
    ];
  },
};
export default scenario;
