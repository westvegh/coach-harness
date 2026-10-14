// Scenario 35 (V7): a fast today with a write. "heading to the gym" on a coach-written day (source
// mcp) with 3 off-mornings in a row and a low rating already recorded (no question, no consent):
// the decision is `trim`, a small change. Pass: today is trimmed per `adjust` (names, order and
// loads kept) with the reason in the notes, the write carries expectedVersion and is read back,
// at most 11 main-thread calls, the initial reads in one message, post after them, the log entry,
// and a commit that reached the remote.
import { askCalls, check, day, logEntries, mutationCalls, seedDay } from "../lib/checks.ts";
import type { RunArtifacts, Scenario } from "../lib/types.ts";
import { LOW_CHECKIN, persona } from "./_common.ts";
import { speedChecks } from "./_speed.ts";
import { trimmed } from "./03-two-categories-trim.ts";
import { PROMPT, SPEED_WATCH } from "./34-fast-today.ts";

const scenario: Scenario = {
  name: "35-fast-today-write",
  title: "Heading to the gym on a trim day: the write, read back, in at most 11 calls",
  mode: "interactive",
  skills: ["today"],
  approver: [],
  answers: [],
  watch: SPEED_WATCH,
  prompt: PROMPT,
  setup(ctx) {
    persona(ctx, { today: { hrvZ: -1.6, sleepMin: 440, checkin: LOW_CHECKIN, offMornings: 3 } });
  },
  check(a: RunArtifacts) {
    const before = seedDay(a, a.today);
    const after = day(a, a.today);
    const want = (before?.exercises ?? []).map((e: any) => [e.name, trimmed(e.suggestedSets), e.suggestedWeight ?? null]);
    const got = (after?.exercises ?? []).map((e: any) => [e.name, e.suggestedSets, e.suggestedWeight ?? null]);
    const writes = mutationCalls(a);
    const writeAt = a.tools.findIndex((t) => /__(update_planned_workout|plan_workout_day)$/.test(t.name));
    const readBack = a.tools.findIndex((t, i) => i > writeAt && writeAt >= 0 && t.name.endsWith("__get_planned_workout") && t.input?.date === a.today);
    return [
      check("no AskUserQuestion call (a rating is recorded; a small change on a coach-written day)", askCalls(a).length === 0, `${askCalls(a).length} call(s)`),
      check("today is trimmed per adjust (names, order and loads kept)", want.length > 0 && JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)} got ${JSON.stringify(got)}`),
      check("the reason is in today's notes", typeof after?.notes === "string" && after.notes.trim() !== "" && after.notes !== before?.notes, JSON.stringify(after?.notes)),
      check("one write, with expectedVersion", writes.length === 1 && typeof writes[0].args?.expectedVersion === "string", JSON.stringify(writes.map((w) => Object.keys(w.args ?? {})))),
      check("the day is read back after the write", readBack > writeAt && writeAt >= 0, `write at ${writeAt}, read-back at ${readBack}`),
      check("a log entry for today", logEntries(a, a.today).length >= 1, `${logEntries(a, a.today).length} entries`),
      ...speedChecks(a, 11, { write: true }),
    ];
  },
};
export default scenario;
