// Scenario 17: aversion. A calm, green morning, but the check-in's want-to-train answer is 1
// (NA-REC-012). Not wanting to train is a reason to rest: an unattended run swaps today to a
// recovery day (the safer change is always allowed), with the reason in the notes, one log
// entry, and no load progression.
import { check, day, logEntries, patternsOf, taxonomy } from "../lib/checks.ts";
import type { Scenario } from "../lib/types.ts";
import { DAILY, GOOD_CHECKIN, persona } from "./_common.ts";

const scenario: Scenario = {
  name: "17-aversion-recovery",
  title: "Want to train 1 on a green morning: a recovery day",
  mode: "unattended",
  skills: ["today"],
  prompt: DAILY,
  setup(ctx) {
    persona(ctx, { today: { hrvZ: 0.2, sleepMin: 455, checkin: { ...GOOD_CHECKIN, want_to_train: 1 } } });
  },
  check(a) {
    const after = day(a, a.today);
    const tax = taxonomy();
    const recovery = new Set(Object.entries(tax.patterns).filter(([, p]) => (p as { recovery?: boolean }).recovery).map(([k]) => k));
    const exs: any[] = after?.exercises ?? [];
    const cls = exs.map((e) => ({ name: e.name, c: patternsOf(e) }));
    const notRecovery = cls.filter((x) => x.c.source === "none" || x.c.patterns.length === 0 || x.c.patterns.some((p) => !recovery.has(p)));
    // load_progression: a `modify` operation that sets a weight.
    const progressed = a.tools.filter((t) => /update_planned_workout$/.test(t.name) && (t.input?.operations ?? []).some((o: any) => o?.op === "modify" && o?.fields?.suggestedWeight !== undefined));
    return [
      check("today is a recovery day (only recovery patterns)", exs.length > 0 && notRecovery.length === 0, JSON.stringify(cls.map((x) => [x.name, x.c.patterns]))),
      check("the reason is in today's notes", typeof after?.notes === "string" && after.notes.trim() !== ""),
      check("one log entry for today", logEntries(a, a.today).length === 1),
      check("no load progression write", progressed.length === 0, `${progressed.length} writes with suggestedWeight`),
    ];
  },
};
export default scenario;
