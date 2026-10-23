// `plans` (coach.yaml `logger: files`; contracts §12a): the week files under plans/.
//
//   plans write --input <file.json>     {days: [...]}, {week: {days}}, {day}, or adjust's {tally_day}; exercises with
//                                       `sets` (engine DayPlan) or `suggestedSets` (Tally's shape)
//   plans read --week <YYYY-MM-DD | YYYY-Www>
//   plans done --date <YYYY-MM-DD> (--as-planned | --exercise <name>) [--sets n] [--reps r] [--load x] [--felt <text>]
//
// Every command takes --root <dir> (default: the current directory).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CoachError } from "./errors.ts";
import { checkUnit, checkWriteExercise } from "./input-shapes.ts";
import { fillDone, isoWeekMonday, readWeek, writePlan, type DayInput } from "./plans-files.ts";
import type { Units } from "./types.ts";

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function unitsOf(root: string): Promise<Units> {
  const p = join(root, "coach.yaml");
  return existsSync(p) ? (await import("./config.ts")).loadConfig(p).athlete.units : "lbs";
}

/** The days in a `plans write` input, whatever shape the coach has at hand. */
export function daysOf(raw: unknown): DayInput[] {
  if (Array.isArray(raw)) return raw as DayInput[];
  if (!isObj(raw)) throw new CoachError("INPUT_ERROR", "plans write input must be a JSON object or a list of days");
  if (Array.isArray(raw.days)) return raw.days as DayInput[];
  if (isObj(raw.week) && Array.isArray(raw.week.days)) return raw.week.days as DayInput[];
  if (isObj(raw.day)) return [raw.day as DayInput];
  if (isObj(raw.tally_day)) return [raw.tally_day as DayInput];
  if (typeof raw.date === "string" && Array.isArray(raw.exercises)) return [raw as DayInput];
  throw new CoachError("INPUT_ERROR", "plans write input needs days, week.days, day, tally_day, or one day ({date, exercises})");
}

/**
 * W1: the values of a write (contract unchanged: each exercise in its own shape, `sets` or Tally's
 * suggestedSets). A count, number, unit or warm-up it cannot read is INPUT_ERROR with its path.
 */
export function checkWriteDays(days: DayInput[], file: string): void {
  const where = { cmd: "plans write", file };
  days.forEach((d, i) => {
    if (!isObj(d) || !Array.isArray(d.exercises)) return; // writePlan names a day without a date or exercises
    checkUnit(d, "weightUnit", where, `days[${i}]`);
    // W1b: a 0 sets count is the zero-work row the CSV keeps (plans read gives it no sets).
    d.exercises.forEach((e, j) => checkWriteExercise(e, where, `days[${i}].exercises[${j}]`, { zeroSets: true }));
  });
}

export async function plansCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: "string" },
      input: { type: "string" },
      week: { type: "string" },
      date: { type: "string" },
      exercise: { type: "string" },
      "as-planned": { type: "boolean", default: false },
      sets: { type: "string" },
      reps: { type: "string" },
      load: { type: "string" },
      felt: { type: "string" },
    },
  });
  const root = resolve(values.root ?? ".");
  const sub = positionals[0];
  if (sub === "write") {
    if (!values.input) throw new CoachError("USAGE", "plans write needs --input <file.json>");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(values.input, "utf8"));
    } catch (e) {
      throw new CoachError("INPUT_ERROR", `cannot read ${values.input}: ${(e as Error).message}`);
    }
    // Cluster rows get their note (0.2.4): the input's `clusters`, else coach.yaml's.
    const { loadClusters } = await import("./clusters.ts");
    const days = daysOf(raw);
    checkWriteDays(days, values.input);
    out(writePlan(root, days, await unitsOf(root), loadClusters(root, raw)));
    return 0;
  }
  if (sub === "read") {
    const w = values.week;
    if (!w) throw new CoachError("USAGE", "plans read needs --week <YYYY-MM-DD | YYYY-Www>");
    out(readWeek(root, /^\d{4}-W\d{2}$/.test(w) ? isoWeekMonday(w) : w, await unitsOf(root)));
    return 0;
  }
  if (sub === "done") {
    out(
      fillDone(root, {
        date: values.date ?? "",
        ...(values.exercise !== undefined ? { exercise: values.exercise } : {}),
        asPlanned: values["as-planned"],
        ...(values.sets !== undefined ? { sets: values.sets } : {}),
        ...(values.reps !== undefined ? { reps: values.reps } : {}),
        ...(values.load !== undefined ? { load: values.load } : {}),
        ...(values.felt !== undefined ? { felt: values.felt } : {}),
      }),
    );
    return 0;
  }
  throw new CoachError("USAGE", "usage: plans write --input <file.json> | plans read --week <date> | plans done --date <date> (--as-planned | --exercise <name>) [--sets n] [--reps r] [--load x] [--felt <text>]");
}
