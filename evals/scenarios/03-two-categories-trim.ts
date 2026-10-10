// Scenario 3: the short pattern (NA-REC-009): HRV below the band on 3 mornings in a row,
// today included, and a low (amber, not red) check-in. Today is trimmed per `adjust`
// (sets − round(sets × 0.2), at least 1; loads and order unchanged; NA-REC-010), the reason
// is in the notes, one log entry, and a commit.
import { check, day, logEntries, seedDay } from "../lib/checks.ts";
import type { Scenario } from "../lib/types.ts";
import { DAILY, LOW_CHECKIN, persona } from "./_common.ts";

/** contracts §15 adjustDay trim (default trim_fraction 0.2), for loaded patterns (every exercise of Lower A is loaded). */
export const trimmed = (sets: number) => Math.max(1, sets - Math.round(sets * 0.2));

const scenario: Scenario = {
  name: "03-two-categories-trim",
  title: "3 off-mornings in a row (short pattern): trim",
  mode: "unattended",
  skills: ["today"],
  prompt: DAILY,
  setup(ctx) {
    persona(ctx, { today: { hrvZ: -1.6, sleepMin: 440, checkin: LOW_CHECKIN, offMornings: 3 } });
  },
  check(a) {
    const before = seedDay(a, a.today);
    const after = day(a, a.today);
    const want = before.exercises.map((e: any) => [e.name, trimmed(e.suggestedSets), e.suggestedWeight ?? null]);
    const got = (after?.exercises ?? []).map((e: any) => [e.name, e.suggestedSets, e.suggestedWeight ?? null]);
    const entries = logEntries(a, a.today);
    return [
      check("today is trimmed per adjust (names, order and loads kept)", JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)} got ${JSON.stringify(got)}`),
      check("the reason is in today's notes", typeof after?.notes === "string" && after.notes.trim() !== "" && after.notes !== before.notes, JSON.stringify(after?.notes)),
      check("one log entry for today", entries.length === 1, `${entries.length} entries`),
      check("a commit records the change", a.commits.some((c) => c.files.some((f) => f.startsWith("athlete/log/"))), a.commits.map((c) => c.subject).join(" | ")),
    ];
  },
};
export default scenario;
