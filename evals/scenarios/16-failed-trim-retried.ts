// Scenario 16: today's trim was attempted earlier and failed: the log entry for today
// says `result: conflict` (the day changed since the read). Today's signals still call for
// a trim. `oplog done` is not done for a conflict, so the run must try the trim again (or
// report why not) and must not exit with "Today is already adjusted."
import { check, day, logEntries, replyText, seedDay, tallyToolUses } from "../lib/checks.ts";
import type { Scenario } from "../lib/types.ts";
import { DAILY, LOW_CHECKIN, persona } from "./_common.ts";
import { trimmed } from "./03-two-categories-trim.ts";

/** Tool uses that target `date` (a date or toDate argument, or a range day). */
const touches = (input: any, date: string) => JSON.stringify(input ?? {}).includes(`"${date}"`);

/** The skill's exit line as a statement: not "whether/if today is already adjusted", not "not already adjusted". */
export const saidAlreadyAdjusted = (text: string) => /(?<!\b(?:whether|if|not)\s)today is already adjusted/i.test(text);

const scenario: Scenario = {
  name: "16-failed-trim-retried",
  title: "A failed trim (conflict) is not \"already adjusted\": the run tries again",
  mode: "unattended",
  skills: ["today"],
  mock: { t2: true },
  prompt: DAILY,
  setup(ctx) {
    const opId = `op-${ctx.today}-trim_session-7c2e91d04ab3`;
    const triedAt = new Date(Date.now() - 50 * 60_000).toISOString();
    persona(ctx, {
      today: { hrvZ: -1.6, sleepMin: 440, checkin: LOW_CHECKIN, offMornings: 3 },
      tally(m) {
        // The day changed after the earlier read (a newer version), so that write conflicted.
        const row = (m.days as any)[ctx.today];
        row.updated_at = new Date(Date.now() - 55 * 60_000).toISOString();
      },
    });
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: ctx.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(triedAt));
    ctx.write(
      `athlete/log/${ctx.today.slice(0, 7)}.md`,
      [
        `# Operation log ${ctx.today.slice(0, 7)}`,
        "",
        `## ${ctx.today} ${time} · ${opId}`,
        "- trigger: daily run (cloud)",
        "- readiness: wearable amber (HRV z -1.6), 3 off-mornings in a row, subjective amber (2.0), performance green → trim",
        "- rules: NA-REC-009",
        "- change: Lower A, sets trimmed by 20%",
        "- approval: auto (trim_session)",
        "- result: conflict: version conflict: the day changed since the read",
        "",
      ].join("\n"),
    );
  },
  check(a) {
    const before = seedDay(a, a.today);
    const after = day(a, a.today);
    const want = before.exercises.map((e: any) => [e.name, trimmed(e.suggestedSets), e.suggestedWeight ?? null]);
    const got = (after?.exercises ?? []).map((e: any) => [e.name, e.suggestedSets, e.suggestedWeight ?? null]);
    const isTrimmed = JSON.stringify(got) === JSON.stringify(want);
    const unchanged = JSON.stringify(before.exercises) === JSON.stringify(after?.exercises);
    const attempts = tallyToolUses(a, ["update_planned_workout", "plan_workout_day", "plan_workout_range"]).filter((t) => touches(t.input, a.today));
    const entries = logEntries(a, a.today);
    const reply = replyText(a);
    const saidDone = saidAlreadyAdjusted(reply);
    return [
      check("does not exit as \"already adjusted\"", !saidDone, reply.slice(0, 300)),
      check("the trim is attempted again, or a new log entry says why not", attempts.length > 0 || entries.length > 0, `${attempts.length} write attempts on ${a.today}; ${entries.length} new log entries`),
      check("today ends trimmed once per adjust, or unchanged with a reason logged", isTrimmed || (unchanged && entries.length > 0), `want ${JSON.stringify(want)} got ${JSON.stringify(got)}`),
    ];
  },
};
export default scenario;
