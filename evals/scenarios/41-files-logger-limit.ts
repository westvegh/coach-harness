// Scenario 41 (0.3.0): the files logger with a limit. Plans live in plans/<YYYY>-W<ww>.csv; the line
// rules out overhead pressing and dips; "plan next week". Pass: next week's file has a row for every
// session day, none of them overhead pressing or dips, and the limits file is unchanged.
import { addDays, weekdayOf, weekStart } from "../../engine/dates.ts";
import { isoWeekId, writePlan } from "../../engine/plans-files.ts";
import { check, parseCsvRows, unchanged } from "../lib/checks.ts";
import { judge, type JudgedDay } from "../lib/limit-rules.ts";
import { SESSIONS, sessionWeekdays, writeAthlete } from "../lib/instance.ts";
import type { Scenario } from "../lib/types.ts";
import { KEEP_LIMIT } from "./_limits.ts";

export const OHP_LINE = "- Right shoulder: no overhead pressing and no dips for now. (since 2026-10-01)";

const scenario: Scenario = {
  name: "41-files-logger-limit",
  title: "Files logger with a limit: next week's plan file follows the line",
  mode: "interactive",
  tally: false,
  skills: ["week"],
  approver: [],
  answers: KEEP_LIMIT,
  prompt: "Plan next week.",
  setup(ctx) {
    writeAthlete(ctx.write, ctx.today, { logger: "files", checkin: "chat", limits: [OHP_LINE] });
    const days = (dates: string[]) => dates.map((d, i) => ({ date: d, dayName: SESSIONS[i].name, exercises: SESSIONS[i].exercises }));
    const lastMon = addDays(weekStart(ctx.today), -7);
    const wds = sessionWeekdays(ctx.today);
    const inWeek = (mon: string) => wds.map((wd) => Array.from({ length: 7 }, (_, i) => addDays(mon, i)).find((d) => weekdayOf(d) === wd)!);
    writePlan(ctx.root, days(inWeek(lastMon)), "lbs");
    writePlan(ctx.root, days([0, 1, 3, 4].map((n) => addDays(ctx.today, n))), "lbs");
  },
  check(a) {
    const mon = addDays(weekStart(a.today), 7);
    const file = `plans/${isoWeekId(mon)}.csv`;
    const rows = a.after[file] ? parseCsvRows(a.after[file]!) : [];
    const dates = [...new Set(rows.map((r) => r.date))].sort();
    const days: JudgedDay[] = dates.map((d) => ({ date: d, exercises: rows.filter((r) => r.date === d && r.exercise).map((r) => ({ name: r.exercise, unit: r.unit || "lbs", sets: Array.from({ length: Number(r.sets) || 1 }, () => ({ ...(r.load && !Number.isNaN(Number(r.load)) ? { weight: Number(r.load) } : {}) })) })) }));
    const want = sessionWeekdays(a.today);
    const broken = judge(days, { says: "no overhead pressing and no dips", patterns: ["overhead_press", "vertical_push"], kind: "avoid" });
    return [
      check("next week's plan file has a row for every session day", want.every((wd) => dates.some((d) => weekdayOf(d) === wd)), `${file}: ${dates.join(", ")}`),
      { ...check("no overhead pressing or dips next week (no unclassified exercise)", days.length > 0 && broken.length === 0, broken.map((f) => f.detail).slice(0, 5).join(" | ")), data: { days: days.map((d) => `${d.date}: ${d.exercises.map((e) => e.name).join(", ")}`) } },
      check("the limits file is unchanged", unchanged(a, "athlete/limits.md")),
    ];
  },
};
export default scenario;
