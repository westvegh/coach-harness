// Scenario 25: the files logger (v0.2, the `log` skill). Plans live in plans/<YYYY>-W<ww>.csv;
// two sessions last week are logged. Turn 1: a chat report of today's session fills its done_
// columns; that is the third logged session, so the Tally line appears once. Turn 2 (a new
// session): a fourth session is logged, and the Tally line does not appear again.
import { addDays, weekdayOf, weekStart } from "../../engine/dates.ts";
import { fillDone, writePlan } from "../../engine/plans-files.ts";
import { check, parseCsvRows, turnText, yamlOf } from "../lib/checks.ts";
import { SESSIONS, sessionWeekdays, writeAthlete } from "../lib/instance.ts";
import type { Scenario } from "../lib/types.ts";

const TALLY_LINE = /switch to Tally/i;

/** The four session dates of the week that starts on `monday` (the persona's weekdays). */
function sessionDates(monday: string, today: string): string[] {
  const wds = sessionWeekdays(today);
  return wds.map((wd) => Array.from({ length: 7 }, (_, i) => addDays(monday, i)).find((d) => weekdayOf(d) === wd)!);
}

const lastFriday = (today: string) => sessionDates(addDays(weekStart(today), -7), today)[3];

const scenario: Scenario = {
  name: "25-files-logger",
  title: "Files logger: a chat report fills the done columns; the Tally line once, after the third session",
  mode: "interactive",
  tally: false,
  skills: ["log"],
  approver: [],
  answers: [{ question: "add it to the day", answer: ["^no"] }, { question: "which (day|date|session)", answer: ["today"] }],
  prompt: "I did today's workout: all sets as planned, and the last set of goblet squats felt heavy. Log it.",
  turns: [{ prompt: ({ today }) => `I forgot to log my session on ${lastFriday(today)}. I did all sets as planned. Log it.` }],
  setup(ctx) {
    writeAthlete(ctx.write, ctx.today, { logger: "files", checkin: "chat" });
    const lastMon = addDays(weekStart(ctx.today), -7);
    const last = sessionDates(lastMon, ctx.today);
    const days = (dates: string[]) => dates.map((d, i) => ({ date: d, dayName: SESSIONS[i].name, exercises: SESSIONS[i].exercises }));
    writePlan(ctx.root, days(last), "lbs");
    // This week: today is session 0 (Lower A), then +1, +3, +4 days.
    writePlan(ctx.root, days([0, 1, 3, 4].map((n) => addDays(ctx.today, n))), "lbs");
    for (const d of last.slice(0, 2)) fillDone(ctx.root, { date: d, asPlanned: true });
  },
  check(a) {
    const files = (side: "before" | "after") =>
      Object.entries(a[side])
        .filter(([p, t]) => /^plans\/.*\.csv$/.test(p) && t)
        .flatMap(([p, t]) => parseCsvRows(t!).map((r) => ({ ...r, file: p }) as Record<string, string>));
    const before = files("before");
    const after = files("after");
    const key = (r: Record<string, string>) => `${r.date}|${r.exercise.toLowerCase()}`;
    const fri = lastFriday(a.today);
    const logged = new Set([a.today, fri]);
    // Each logged row: done_ fields equal the plan ("all sets as planned"); "heavy" only on the goblet squats.
    const top = (reps: string) => (/^(\d+)\s*[-–]\s*(\d+)$/.exec(reps)?.[2] ?? reps);
    const doneWrong = after
      .filter((r) => logged.has(r.date))
      .filter((r) => r.done_sets !== r.sets || r.done_reps !== top(r.reps) || r.done_load !== r.load || (/goblet squat/i.test(r.exercise) && r.date === a.today ? !/heavy/i.test(r.felt) : r.felt !== ""))
      .map((r) => `${r.date} ${r.exercise}: sets ${r.done_sets}/${r.sets}, reps ${r.done_reps}/${r.reps}, load ${r.done_load}/${r.load}, felt "${r.felt}"`);
    const todayRows = after.filter((r) => r.date === a.today);
    const friRows = after.filter((r) => r.date === fri);
    // The original rows are kept: the same rows, the same plan columns, and untouched done_ columns elsewhere.
    const PLAN = ["date", "day", "exercise", "sets", "reps", "load", "unit", "notes"];
    const DONE = ["done_sets", "done_reps", "done_load", "felt"];
    const byKey = new Map(after.map((r) => [key(r), r]));
    const lost = before.filter((r) => !byKey.has(key(r))).map(key);
    const changed = before.filter((r) => byKey.has(key(r))).flatMap((r) => {
      const n = byKey.get(key(r))!;
      const cols = [...PLAN, ...(logged.has(r.date) ? [] : DONE)].filter((c) => (r[c] ?? "") !== (n[c] ?? ""));
      return cols.length ? [`${key(r)}: ${cols.join(", ")}`] : [];
    });
    const added = after.filter((r) => !before.some((b) => key(b) === key(r))).map(key);
    const cfg1 = yamlOf(a.turns?.[0]?.after["coach.yaml"]);
    const t1 = turnText(a, 0);
    const t2 = turnText(a, 1);
    const mentions = (t1.match(new RegExp(TALLY_LINE.source, "gi")) ?? []).length + (t2.match(new RegExp(TALLY_LINE.source, "gi")) ?? []).length;
    return [
      check("today's and the fourth session's done_ fields match the plan and the report", todayRows.length > 0 && friRows.length > 0 && doneWrong.length === 0, doneWrong.slice(0, 6).join(" | ") || `${todayRows.length} + ${friRows.length} rows`),
      check("the original rows are kept (no row lost or added; plan columns and other done_ columns unchanged)", lost.length === 0 && added.length === 0 && changed.length === 0, [...lost.map((k) => `lost ${k}`), ...added.map((k) => `added ${k}`), ...changed].slice(0, 6).join(" | ")),
      check("after the third logged session: the Tally line, and tally_mentioned recorded", TALLY_LINE.test(t1) && cfg1?.tally_mentioned === true, `turn 1 has the line: ${TALLY_LINE.test(t1)}; tally_mentioned: ${cfg1?.tally_mentioned}`),
      check("the Tally line appears exactly once across both turns", mentions === 1 && (a.turns?.length ?? 0) === 2, `${mentions} mention(s); turn 2: ${t2.slice(0, 200)}`),
    ];
  },
};
export default scenario;
