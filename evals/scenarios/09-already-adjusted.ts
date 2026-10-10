// Scenario 9: today was already adjusted (a log entry and a Tally
// operation receipt say so), and today's signals would trim again. The run exits with no
// second write.
import { check, day, logEntries, seedDay, successfulWrites } from "../lib/checks.ts";
import type { Scenario } from "../lib/types.ts";
import { DAILY, LOW_CHECKIN, persona } from "./_common.ts";
import { trimmed } from "./03-two-categories-trim.ts";

const scenario: Scenario = {
  name: "09-already-adjusted",
  title: "Today already adjusted: the run exits, no second write",
  mode: "unattended",
  skills: ["today"],
  mock: { t2: true },
  prompt: DAILY,
  setup(ctx) {
    const opId = `op-${ctx.today}-trim_session-3fa1c2d9e0b4`;
    const doneAt = new Date(Date.now() - 50 * 60_000).toISOString();
    persona(ctx, {
      today: { hrvZ: -1.6, sleepMin: 440, checkin: LOW_CHECKIN, offMornings: 3 },
      tally(m) {
        const row = (m.days as any)[ctx.today];
        row.exercises = row.exercises.map((e: any) => ({ ...e, suggestedSets: trimmed(e.suggestedSets) }));
        row.notes = "Trimmed 20% of sets: HRV below the band 3 mornings in a row (NA-REC-009).";
        row.updated_at = doneAt;
        m.operations = [
          { opId, tool: "update_planned_workout", requestHash: "0".repeat(64), recordedAt: doneAt, result: [{ input_date: ctx.today, action: "update", date: ctx.today, status: "written", id: row.id, updated_at: doneAt }], dates: [ctx.today] },
        ];
      },
    });
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: ctx.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(doneAt));
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
        "- result: written",
        "",
      ].join("\n"),
    );
  },
  check(a) {
    const before = seedDay(a, a.today);
    const after = day(a, a.today);
    const writes = successfulWrites(a);
    return [
      check("no second write", writes.length === 0, writes.map((w) => `${w.tool} ${JSON.stringify(w.args).slice(0, 120)}`).join(" | ")),
      check("today's day is unchanged", JSON.stringify(before.exercises) === JSON.stringify(after?.exercises) && before.notes === after?.notes),
      check("no second operation entry in the log", !logEntries(a, a.today).some((e) => /· op-/.test(e) && /result: written/.test(e))),
    ];
  },
};
export default scenario;
