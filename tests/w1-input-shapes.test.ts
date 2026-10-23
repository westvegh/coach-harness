// W1 (0.2.8): no engine command reports a result from input it could not read, and the urgent stop
// reads the notes an athlete adds to an exercise in Tally's note sheet. Made-up fixtures only.
//
// The first test is the 2026-10-16 case. Set W1_REPO=<a checkout> to run it against another tree
// (the report records that it fails on the base, 45311f6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extraWork } from "../engine/classify.ts";
import { addDays } from "../engine/dates.ts";
import { planWindows } from "../engine/history-windows.ts";
import { readNotes } from "../engine/input-shapes.ts";
import { scanSessionNotes } from "../engine/safety.ts";
import { mergeResponse, saveSnapshot } from "../engine/snapshot.ts";
import { tallyExerciseToEntry } from "../engine/tally-shape.ts";
import type { Snapshot } from "../engine/types.ts";
import { cli, instance as e3Instance, REPO, writeJson } from "./e3/helpers.ts";

const NOW = "2026-10-14T15:00:00.000Z"; // 08:00 in Los Angeles
const TODAY = "2026-10-14";
const SESSION = "s-w1";
const SERVER = "claude_ai_Tally_Workout";
const LIVE = `mcp__${SERVER}__`;
const ENV = { env: { CLAUDE_CODE_SESSION_ID: SESSION } };
const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];

const SQUAT = { exerciseId: "Barbell_Squat", name: "Back Squat", suggestedSets: 4, suggestedReps: 5, suggestedWeight: 185 };
const SPLIT = { exerciseId: "Dumbbell_Split_Squat", name: "Split Squat", suggestedSets: 3, suggestedReps: 8, repsMax: 10, perSide: true, notes: "slow down" };
const ROW = { exerciseId: "Cable_Row", name: "Cable Row", suggestedSets: 3, suggestedReps: 10 };
const tday = (over: Record<string, unknown> = {}) => ({ date: TODAY, found: true, version: `v-${TODAY}-1`, updatedAt: "t0", source: "mcp", userModified: false, skipped: false, dayType: "lower", dayName: "Lower A", exercises: [SQUAT, SPLIT, ROW], weightUnit: "lbs", weightUnitSource: "settings", ...over });
const eng = (name: string, n: number, weight = 100) => ({ name, sets: Array.from({ length: n }, () => ({ weight, reps: 8 })) });

/** A temp instance (coach.yaml, methods) with no limits. */
function instance(edit?: (yaml: string) => string): string {
  const dir = e3Instance(edit);
  writeFileSync(join(dir, "athlete/limits.yaml"), "version: 1\npain_threshold: 4\nlimits: []\n");
  return dir;
}

/** An instance whose snapshot holds today's Tally read (this session's). */
function withToday(day = tday()): string {
  const dir = instance();
  saveSnapshot(dir, mergeResponse(null, { tool: "get_planned_workout", input: { date: TODAY }, response: text(day), session_id: SESSION, now: NOW, timezone: "America/Los_Angeles", server: SERVER }));
  return dir;
}

/** The refusal every check gives: exit 1, INPUT_ERROR, the path, and where the shape is. */
function refused(r: ReturnType<typeof cli>, path: string, what: RegExp, cmd: string) {
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json?.error?.code, "INPUT_ERROR", r.stdout);
  assert.ok(r.json.error.message.includes(path), `the message names ${path}: ${r.json.error.message}`);
  assert.match(r.json.error.message, what);
  assert.ok(r.json.error.message.endsWith(`see node engine/cli.ts help ${cmd}`), r.json.error.message);
}

// ---------- the end-to-end regression (2026-10-16) ----------

test("2026-10-16: limits check on Tally-shaped days counts their sets (a cap over 6 hard sets is reported, never 'ok')", () => {
  const CLI = join(process.env.W1_REPO ?? REPO, "engine/cli.ts");
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: "utf8" });
    return { code: r.status, json: JSON.parse(r.stdout), stderr: r.stderr };
  };
  const names = { row: "Chest-Supported Dumbbell Row", pulldown: "Neutral-Grip Lat Pulldown", press: "Machine Chest Press" };
  assert.ok(run(["classify", "--exercise", names.row]).json.patterns.includes("horizontal_pull"));
  assert.ok(run(["classify", "--exercise", names.pulldown]).json.patterns.includes("vertical_pull"));
  assert.ok(run(["classify", "--exercise", names.press]).json.patterns.includes("horizontal_push"));
  const root = mkdtempSync(join(tmpdir(), "w1-limits-"));
  mkdirSync(join(root, "athlete"));
  writeFileSync(join(root, "athlete/limits.yaml"), "version: 1\npain_threshold: 4\nlimits:\n  - id: L-001\n    region: right-shoulder\n    rule: cap\n    patterns: [horizontal_pull, vertical_pull, horizontal_push]\n    exercises: []\n    allow: []\n    max_sets_per_week: 6\n    source: athlete\n    since: 2026-10-20\n");
  const days = {
    days: [
      { date: "2026-11-03", dayName: "Upper A", exercises: [{ exerciseId: "chest_supported_row", name: names.row, suggestedSets: 3, suggestedReps: 10, suggestedWeight: 40 }] },
      { date: "2026-11-07", dayName: "Upper B", exercises: [{ exerciseId: "lat_pulldown", name: names.pulldown, suggestedSets: 3, suggestedReps: 10, suggestedWeight: 100 }, { exerciseId: "chest_press", name: names.press, suggestedSets: 3, suggestedReps: 10, suggestedWeight: 90 }] },
    ],
  };
  const r = run(["limits", "check", "--root", root, "--input", writeJson(root, "days.json", days)]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, false);
  assert.deepEqual(r.json.findings.map((f: any) => [f.limit, f.kind]), [["L-001", "over_sets"]]);
  assert.match(r.json.findings[0].detail, /^9 hard sets match L-001/);
});

// ---------- plan mode: shapes ----------

test("plan mode: a day in either shape; a mixed day is refused; sets: [] and exercises: [] are valid; a name with no prescription is one set", () => {
  const dir = instance();
  const check = (days: unknown[]) => cli(["limits", "check", "--root", dir, "--input", writeJson(dir, "d.json", { days })]);
  const mixed = check([{ date: "2026-11-02", exercises: [eng("Bench Press", 3)] }, { date: "2026-11-03", exercises: [eng("Bench Press", 3), { name: "Cable Row", suggestedSets: 3 }] }]);
  refused(mixed, "days[1]", /mixes the engine's sets with Tally's suggestedSets; use one shape per day/, "limits check");
  const ok = check([{ date: "2026-11-02", exercises: [{ name: "Bench Press", sets: [] }] }, { date: "2026-11-03", exercises: [] }]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json.ok, true);
  // A Tally exercise with a name and nothing else counts one set (documented default).
  writeFileSync(join(dir, "athlete/limits.yaml"), "version: 1\npain_threshold: 4\nlimits:\n  - id: L-001\n    region: low-back\n    rule: cap\n    patterns: [hinge]\n    exercises: []\n    allow: []\n    max_sets_per_week: 1\n    source: athlete\n    since: 2026-10-01\n");
  const one = check([{ date: "2026-11-02", exercises: [{ name: "Romanian Deadlift" }] }, { date: "2026-11-04", exercises: [{ name: "Romanian Deadlift" }] }]);
  assert.equal(one.json.ok, false);
  assert.match(one.json.findings[0].detail, /^2 hard sets/);
  // 0.2.7's two failures: exerciseName in place of name, and "sets": 3.
  refused(check([{ date: "2026-11-02", exercises: [{ exerciseName: "Bench Press", suggestedSets: 3 }] }]), "days[0].exercises[0]", /has no name; the field is `name`/, "limits check");
  refused(check([{ date: "2026-11-02", exercises: [{ name: "Bench Press", sets: 3 }] }]), "days[0].exercises[0].sets", /must be a list of sets, got 3/, "limits check");
  refused(check([{ date: "11/02", exercises: [] }]), "days[0].date", /must be a date YYYY-MM-DD/, "limits check");
  refused(cli(["limits", "check", "--root", dir, "--input", writeJson(dir, "w.json", { exercises: [] })]), "w.json", /must be \{week: \{days\}\}, \{days\} or a list of days/, "limits check");
});

// ---------- the value checks, per site ----------

const TALLY_BAD: [string, Record<string, unknown>, string, RegExp][] = [
  ["a string count", { suggestedSets: "9" }, "exercises[0].suggestedSets", /must be a whole number from 1 to 50, got the string "9"/],
  ["a string weight", { suggestedWeight: "200" }, "exercises[0].suggestedWeight", /must be a number, got the string "200"/],
  ["a count of 0", { suggestedSets: 0 }, "exercises[0].suggestedSets", /from 1 to 50, got 0/],
  ["a count of 1e9", { suggestedSets: 1e9 }, "exercises[0].suggestedSets", /from 1 to 50, got 1000000000/],
  ["a non-boolean perSide", { perSide: "yes" }, "exercises[0].perSide", /must be true or false, got the string "yes"/],
  ["an RPE above 10", { rpe: 11 }, "exercises[0].rpe", /must be at most 10/],
];
const ENGINE_BAD: [string, Record<string, unknown>, string, RegExp][] = [
  ["a string weight", { weight: "200" }, "exercises[0].sets[0].weight", /must be a number, got the string "200"/],
  ["a non-boolean warmup", { warmup: "yes" }, "exercises[0].sets[0].warmup", /must be true or false, got the string "yes"/],
  ["a negative reps", { reps: -1 }, "exercises[0].sets[0].reps", /must be 0 or more, got -1/],
];
const tallyEx = (over: Record<string, unknown>) => ({ ...SQUAT, ...over });
const engEx = (over: Record<string, unknown>) => ({ name: "Back Squat", sets: [{ weight: 185, reps: 5, ...over }, { weight: 185, reps: 5 }] });
const engDay = (over: Record<string, unknown> = {}) => ({ date: TODAY, exercises: [engEx(over)] });
const tallyDay = (over: Record<string, unknown> = {}) => ({ date: TODAY, dayName: "Lower A", exercises: [tallyEx(over)], weightUnit: "lbs" });

/** `zeroSets`: a write input for the files logger, where a 0 sets count is the plans/ zero-work row (W1b). */
type Site = { name: string; cmd: string; prefix: string; run: (dir: string, day: Record<string, unknown>) => ReturnType<typeof cli>; tally: boolean; engine: boolean; zeroSets?: boolean };
const SITES: Site[] = [
  { name: "limits check {days}", cmd: "limits check", prefix: "days[0].", tally: true, engine: true, run: (dir, d) => cli(["limits", "check", "--root", dir, "--input", writeJson(dir, "x.json", { days: [d] })]) },
  { name: "volume {week}", cmd: "volume", prefix: "week.days[0].", tally: true, engine: true, run: (dir, d) => cli(["volume", "--root", dir, "--input", writeJson(dir, "x.json", { week: { week_start: "2026-10-12", days: [d] } })]) },
  { name: "loads (a Tally day on stdin)", cmd: "loads", prefix: "", tally: true, engine: false, run: (dir, d) => cli(["loads", "--root", dir, "--now", NOW], { input: JSON.stringify(d) }) },
  { name: "loads {exercises}", cmd: "loads", prefix: "", tally: false, engine: true, run: (dir, d) => cli(["loads", "--root", dir, "--now", NOW, "--input", writeJson(dir, "x.json", { exercises: d.exercises, history: [], units: "lbs" })]) },
  { name: "adjust {day}", cmd: "adjust", prefix: "day.", tally: true, engine: true, run: (dir, d) => cli(["adjust", "--root", dir, "--input", writeJson(dir, "x.json", { day: d, decision: "trim" })]) },
  { name: "classify --input {after}", cmd: "classify", prefix: "after.", tally: true, engine: true, run: (dir, d) => cli(["classify", "--root", dir, "--input", writeJson(dir, "x.json", { before: null, after: d, tool: "plan_workout_day", today: TODAY })]) },
  { name: "plans write {days} (write input)", cmd: "plans write", prefix: "days[0].", tally: true, engine: true, zeroSets: true, run: (dir, d) => cli(["plans", "write", "--root", dir, "--input", writeJson(dir, "x.json", { days: [d] })]) },
  { name: "tally-days (write input, the engine's shape)", cmd: "tally-days", prefix: "days[0].", tally: false, engine: true, run: (dir, d) => cli(["tally-days", "--root", dir, "--input", writeJson(dir, "x.json", { week: { week_start: "2026-10-12", days: [d] } })]) },
  { name: "loads --fill (a week file)", cmd: "loads", prefix: "days[0].", tally: false, engine: true, run: (dir, d) => cli(["loads", "--fill", "--root", dir, "--now", NOW, "--input", writeJson(dir, "x.json", { week: { week_start: "2026-10-12", days: [d] } })]) },
];

for (const site of SITES) {
  test(`values: ${site.name}: valid input passes; a bad count, weight, warm-up or flag is INPUT_ERROR with its path`, () => {
    const dir = instance();
    if (site.tally) assert.equal(site.run(dir, tallyDay()).code, 0, `${site.name}: a valid Tally day`);
    if (site.engine) assert.equal(site.run(dir, engDay()).code, 0, `${site.name}: a valid engine day`);
    // W1b: plans write keeps a 0 sets count (the CSV's zero-work row); its count range starts at 0.
    const tallyBad = site.zeroSets ? TALLY_BAD.filter(([n]) => n !== "a count of 0").map(([n, o, p, re]) => [n, o, p, new RegExp(re.source.replace("from 1 to 50", "from 0 to 50"))] as const) : TALLY_BAD;
    if (site.zeroSets) assert.equal(site.run(dir, tallyDay({ suggestedSets: 0 })).code, 0, `${site.name}: a 0 sets count is the zero-work row`);
    if (site.tally) for (const [, over, path, what] of tallyBad) refused(site.run(dir, tallyDay(over)), site.prefix + path, what, site.cmd);
    if (site.engine) for (const [, over, path, what] of ENGINE_BAD) refused(site.run(dir, engDay(over)), site.prefix + path, what, site.cmd);
  });
}

test("values: today-write-prep checks the final day (after, and an edit after its nulls are applied)", () => {
  const dir = withToday();
  const prep = (input: unknown) => cli(["today-write-prep", "--input", writeJson(dir, ".tmp/coach/wp.json", input), "--now", NOW, "--root", dir], ENV);
  const after = (over: Record<string, unknown>) => ({ ...tday(), found: undefined, version: undefined, exercises: [{ ...SQUAT, ...over }, SPLIT, ROW] });
  for (const [, over, path, what] of TALLY_BAD) refused(prep({ after: after(over), tool: "update_planned_workout", kind: "trim_session" }), `after: ${path}`, what, "today-write-prep");
  refused(prep({ edit: { exercises: [{ index: 0, set: { suggestedWeight: "200" } }] }, tool: "update_planned_workout", kind: "load_progression" }), "today's day after the edit: exercises[0].suggestedWeight", /must be a number/, "today-write-prep");
});

test("null in an edit clears a field: clearing perSide or suggestedSets gives the same write as on the base", () => {
  const dir = withToday();
  const prep = (input: unknown) => cli(["today-write-prep", "--input", writeJson(dir, ".tmp/coach/wp.json", input), "--now", NOW, "--root", dir], ENV);
  // The write arguments 0.2.7 gave for these two edits (the report records the comparison).
  const a = prep({ edit: { exercises: [{ index: 1, set: { perSide: null } }] }, tool: "update_planned_workout", kind: "trim_session" });
  assert.equal(a.code, 0, a.stdout);
  assert.deepEqual(a.json.write.plain.args, { date: TODAY, timezone: "America/Los_Angeles", expectedVersion: `v-${TODAY}-1`, weightUnit: "lbs", operations: [{ op: "modify", target: { index: 1 }, fields: { perSide: null } }], opId: "op-2026-10-14-trim_session-23038501d0bc" });
  const b = prep({ edit: { exercises: [{ index: 2, set: { suggestedSets: null } }] }, tool: "update_planned_workout", kind: "trim_session" });
  assert.equal(b.code, 0, b.stdout);
  assert.deepEqual(b.json.write.plain.args, { date: TODAY, timezone: "America/Los_Angeles", expectedVersion: `v-${TODAY}-1`, weightUnit: "lbs", operations: [{ op: "modify", target: { index: 2 }, fields: { suggestedSets: null } }], opId: "op-2026-10-14-trim_session-2738f75e5d10" });
  assert.deepEqual(b.json.classify.kinds, ["trim_session"]);
});

// ---------- history mode ----------

test("history mode: logged sets only; a prescription with no sets is refused (it would invent completed work)", () => {
  const dir = instance();
  const plan = { date: "2026-10-12", exercises: [{ name: "Back Squat", suggestedSets: 3, suggestedReps: 5, suggestedWeight: 185 }] };
  refused(cli(["loads", "--root", dir, "--input", writeJson(dir, "l.json", { exercises: [engEx({})], history: [plan], units: "lbs" })]), "history[0].exercises[0]", /is a prescription \(suggestedSets, suggestedReps, suggestedWeight\), not logged sets/, "loads");
  refused(cli(["loads", "--root", dir, "--input", writeJson(dir, "l.json", { exercises: [engEx({})], history: [{ date: "2026-10-12", exercises: [{ name: "Back Squat", sets: [{ weight: "185", reps: 5 }] }] }], units: "lbs" })]), "history[0].exercises[0].sets[0].weight", /must be a number/, "loads");
  const block = JSON.parse(cli(["block", "draft", "--weeks", "6", "--root", dir, "--now", NOW]).stdout).block;
  const logs = [{ week_start: "2026-10-05", days: [plan] }];
  refused(cli(["targets", "--root", dir, "--input", writeJson(dir, "t.json", { block, logs, today: TODAY, target_week: 2 })]), "logs[0].days[0].exercises[0]", /is a prescription/, "targets");
  refused(cli(["volume", "--root", dir, "--input", writeJson(dir, "v.json", { block, logs, today: TODAY, target_week: 2 })]), "logs[0].days[0].exercises[0]", /is a prescription/, "volume");
  const hist = writeJson(dir, "h.json", { units: "lbs", sessions: [plan] });
  const wf = writeJson(dir, "wf.json", { week: { week_start: "2026-10-12", days: [engDay()] } });
  refused(cli(["loads", "--fill", "--root", dir, "--input", wf, "--history", hist]), "sessions[0].exercises[0]", /is a prescription/, "loads");
  // Logged sets in either case pass.
  const good = cli(["volume", "--root", dir, "--input", writeJson(dir, "v.json", { block, logs: [{ week_start: "2026-10-05", days: [{ ...engDay(), date: "2026-10-06" }] }], today: TODAY, target_week: 2 })]);
  assert.equal(good.code, 0, good.stdout);
});

// ---------- Tally conversion fields ----------

test("classify: a change to per-side work and a longer distance are more work (the converter keeps perSide and distance_m)", () => {
  const before = tallyExerciseToEntry({ exerciseId: "Sled_Push", name: "Sled Push", suggestedSets: 3, distanceMeters: 20 }, "lbs");
  const longer = tallyExerciseToEntry({ exerciseId: "Sled_Push", name: "Sled Push", suggestedSets: 2, distanceMeters: 40 }, "lbs");
  assert.equal(longer.sets[0].distance_m, 40);
  assert.equal(extraWork(longer, before, "lbs"), "the distance rises");
  const row = tallyExerciseToEntry(ROW, "lbs");
  const perSide = tallyExerciseToEntry({ ...ROW, suggestedSets: 2, perSide: true }, "lbs");
  assert.equal(perSide.perSide, true);
  assert.equal(extraWork(perSide, row, "lbs"), "it becomes per side");
  // Through today-write-prep: fewer sets but per side is not a trim (0.2.7 called it one).
  const dir = withToday();
  const r = cli(["today-write-prep", "--input", writeJson(dir, ".tmp/coach/wp.json", { after: { ...tday(), found: undefined, version: undefined, exercises: [SQUAT, SPLIT, { ...ROW, suggestedSets: 2, perSide: true }] }, tool: "update_planned_workout", kind: "trim_session" }), "--now", NOW, "--root", dir], ENV);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.classify.big, true);
  assert.ok(r.json.classify.reasons.includes("more work on an existing exercise: it becomes per side"), JSON.stringify(r.json.classify));
});

// ---------- round trips stay exact ----------

test("round trips: adjust → today-write-prep → tally_day; plans write keeps a rep range; opid is the base's id", () => {
  const dir = withToday();
  const a = cli(["adjust", "--from-snapshot", TODAY, "--decision", "trim", "--now", NOW, "--root", dir], ENV);
  assert.equal(a.code, 0, a.stdout);
  assert.deepEqual(a.json.tally_day.exercises[1], { ...SPLIT, suggestedSets: 2 }, "rep range, per side and notes kept");
  const w = cli(["today-write-prep", "--input", writeJson(dir, ".tmp/coach/wp.json", { after: a.json.tally_day, tool: "plan_workout_day", kind: "trim_session" }), "--now", NOW, "--root", dir], ENV);
  assert.equal(w.code, 0, w.stdout);
  assert.deepEqual(w.json.write.plain.args.exercises, a.json.tally_day.exercises);
  const p = cli(["plans", "write", "--root", dir, "--input", writeJson(dir, "pw.json", { tally_day: { date: TODAY, dayName: "Lower A", exercises: [SPLIT, ROW], weightUnit: "lbs" } })]);
  assert.equal(p.code, 0, p.stdout);
  assert.match(readFileSync(join(dir, "plans/2026-W42.csv"), "utf8"), /2026-10-14,Lower A,Split Squat,3,8-10,/);
  const o = cli(["opid", "--date", TODAY, "--kind", "trim_session", "--root", dir, "--input", writeJson(dir, "call.json", { tool: "plan_workout_day", args: { date: TODAY, exercises: [SPLIT], expectedVersion: "v1" } })]);
  assert.equal(o.json.opid, "op-2026-10-14-trim_session-54539e3dd70f");
});

// ---------- the safety contract ----------

test("notes: each string of an exercise's list is scanned; a cut list, a note of another type or a bad entry is a reason, never a failure", () => {
  const { entries, problems } = readNotes([
    { date: "2026-10-12", notes: "good", exercises: [{ name: "Squat", notes: ["felt fine", "chest pain"] }] },
    { date: "2026-10-13", exercises: [{ name: "Row", notes: ["ok", 7], notesTruncated: true }] },
    { date: "bad", notes: "x" },
    "not a session",
    { date: "2026-10-01", notes: 5 },
  ], "2026-10-10");
  assert.deepEqual(entries.map((e) => e.date), ["2026-10-12", "2026-10-13"]);
  assert.deepEqual(problems, [
    "2026-10-13 Row: note 2 is 7, not text",
    "2026-10-13 Row: Tally cut this exercise's notes (more than 5, or one over 300 characters)",
    'history[2] has no valid date (the string "bad")',
    "history[3] is the string \"not a session\", not a session",
  ]);
  const m = scanSessionNotes(entries);
  assert.deepEqual(m.map((x) => [x.date, x.where, x.urgent]), [["2026-10-12", "exercise", ["chest pain"]]]);
});

test("scan-notes --input: list notes reach the urgent stop; a cut list or a bad entry makes coverage incomplete; the exit stays 0", () => {
  const scan = (dir: string, history: unknown[], extra: string[] = []) => cli(["safety", "scan-notes", "--since", "2026-10-10", "--now", NOW, "--root", dir, "--input", writeJson(dir, "h.json", { history, complete: true }), ...extra]);
  let dir = instance();
  const urgent = scan(dir, [{ date: "2026-10-12", exercises: [{ name: "Squat", notes: ["felt fine", "chest pain"] }] }]);
  assert.equal(urgent.code, 0, urgent.stderr);
  assert.deepEqual(urgent.json.urgent_terms, ["chest pain"]);
  assert.equal(urgent.json.coverage, "complete");
  assert.ok(existsSync(join(dir, "athlete/.urgent-stop")), "the urgent stop is written");
  dir = instance();
  const cut = scan(dir, [{ date: "2026-10-12", exercises: [{ name: "Squat", notes: ["felt fine"], notesTruncated: true }] }]);
  assert.equal(cut.code, 0);
  assert.equal(cut.json.coverage, "incomplete");
  assert.equal(cut.json.urgent_unknown, true);
  assert.match(cut.json.coverage_detail.reason, /2026-10-12 Squat: Tally cut this exercise's notes/);
  dir = instance();
  const mixed = scan(dir, [{ date: 7 }, { date: "2026-10-12", notes: "chest pain after the run" }]);
  assert.equal(mixed.code, 0);
  assert.deepEqual(mixed.json.urgent_terms, ["chest pain"]);
  assert.ok(existsSync(join(dir, "athlete/.urgent-stop")), "a readable urgent note still writes the stop");
  assert.equal(mixed.json.coverage, "incomplete");
  assert.match(mixed.json.coverage_detail.reason, /history\[0\] has no valid date/);
});

// ---------- the notes regression, end to end ----------

const W = planWindows(addDays(TODAY, -56), TODAY, 14);
const page = (sessions: unknown[]) => text({ count: sessions.length, sessions });
const logged = (date: string, id: string, exNotes?: unknown, extra: Record<string, unknown> = {}) => ({ id, date, name: "Lower A", weightUnit: "lbs", exercises: [{ exerciseId: "Barbell_Squat", name: "Back Squat", muscle: "quads", trackingType: "weight_reps", sets: [{ weight: 185, reps: 5 }], ...(exNotes !== undefined ? { notes: exNotes } : {}), ...extra }] });

function runHook(root: string, payload: unknown): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_CODE_SESSION_ID"].includes(k)));
    const child = spawn(process.execPath, [join(REPO, ".claude/hooks/capture-reads.ts")], { env: { ...env, CLAUDE_PROJECT_DIR: root, COACH_NOW: NOW } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify({ session_id: SESSION, hook_event_name: "PostToolUse", ...(payload as object) }));
  });
}

/** Every 8-week window read (older ones in process, the newest through the capture hook), then the scan. */
async function captureAndScan(newest: unknown[]): Promise<{ dir: string; scan: ReturnType<typeof cli>; snap: Snapshot }> {
  const dir = instance();
  let s: Snapshot | null = null;
  for (const w of W.slice(1)) s = mergeResponse(s, { tool: "get_workout_history", input: w, response: page([]), session_id: SESSION, now: NOW, timezone: "America/Los_Angeles", server: SERVER });
  saveSnapshot(dir, s!);
  const h = await runHook(dir, { tool_name: LIVE + "get_workout_history", tool_input: W[0], tool_response: page(newest) });
  assert.equal(h.code, 0, h.stderr);
  const snap = JSON.parse(readFileSync(join(dir, "athlete/.cache/snapshot.json"), "utf8")) as Snapshot;
  const scan = cli(["safety", "scan-notes", "--since", "2026-10-11", "--now", NOW, "--root", dir], ENV);
  return { dir, scan, snap };
}

test("notes regression: Tally's list notes ['felt fine', 'chest pain'] → the capture hook → scan-notes → the urgent stop", async () => {
  const { dir, scan, snap } = await captureAndScan([logged("2026-10-13", "h1", ["felt fine", "chest pain"])]);
  assert.deepEqual(snap.history.find((x) => x.id === "h1")?.exercises[0].notes, ["felt fine", "chest pain"], "the capture keeps the list");
  assert.equal(scan.code, 0, scan.stderr);
  assert.deepEqual(scan.json.urgent_terms, ["chest pain"]);
  assert.equal(scan.json.coverage, "complete");
  assert.ok(existsSync(join(dir, "athlete/.urgent-stop")), "the urgent stop is written");
});

test("notes regression: notesTruncated → coverage incomplete and urgent_unknown; a malformed note next to an urgent one → the stop and incomplete", async () => {
  const cut = await captureAndScan([logged("2026-10-13", "h1", ["felt fine"], { notesTruncated: true })]);
  assert.equal(cut.snap.history[0].exercises[0].notesTruncated, true, "the capture keeps notesTruncated");
  assert.equal(cut.scan.code, 0, cut.scan.stderr);
  assert.equal(cut.scan.json.coverage, "incomplete");
  assert.equal(cut.scan.json.urgent_unknown, true);
  assert.match(cut.scan.json.coverage_detail.reason, /Tally cut this exercise's notes/);
  const bad = await captureAndScan([logged("2026-10-12", "h1", { text: "odd" }), logged("2026-10-13", "h2", ["chest pain"])]);
  assert.deepEqual(bad.scan.json.urgent_terms, ["chest pain"]);
  assert.ok(existsSync(join(bad.dir, "athlete/.urgent-stop")));
  assert.equal(bad.scan.json.coverage, "incomplete");
  assert.match(bad.scan.json.coverage_detail.reason, /2026-10-12 Back Squat: the notes are an object, not text/);
});

test("today-brief --stage post (logger other): the evidence's list notes reach the stop; a cut list makes safety unknown", () => {
  const post = (notes: unknown, extra: Record<string, unknown> = {}) => {
    const dir = instance((y) => y.replace(/^logger: tally/m, "logger: other"));
    const pre = cli(["today-brief", "--stage", "pre", "--now", NOW, "--root", dir], ENV);
    assert.equal(pre.code, 0, pre.stderr);
    const evidence = { history: [{ date: "2026-10-13", exercises: [{ name: "Back Squat", notes, ...extra }] }], history_complete: true, today: { read: "ok", found: false } };
    const r = cli(["today-brief", "--stage", "post", "--now", NOW, "--root", dir, "--input", writeJson(dir, ".tmp/coach/ev.json", evidence)], ENV);
    assert.equal(r.code, 0, r.stderr);
    return { dir, j: r.json };
  };
  const a = post(["felt fine", "chest pain"]);
  assert.equal(a.j.urgent.stopped, true);
  assert.deepEqual(a.j.safety_notes.urgent_terms, ["chest pain"]);
  const b = post(["felt fine"], { notesTruncated: true });
  assert.equal(b.j.urgent.stopped, false);
  assert.equal(b.j.urgent.unknown, true);
  assert.equal(b.j.coverage.safety_notes, "incomplete");
});

// ---------- the coach's rule (skill text) ----------

test("CLAUDE.md and the today skill: the engine's result is the answer; limits check again only after a change", () => {
  const md = readFileSync(join(REPO, "CLAUDE.md"), "utf8");
  const at = md.indexOf("- **No source reading.**");
  const rule = md.indexOf("- **The engine's result is the answer.** Report the number it prints in one line.");
  assert.ok(at >= 0 && rule > at && md.slice(at, rule).split("\n").length === 2, "the bullet follows No source reading");
  assert.match(md, /To ask the engine about a day you read from Tally, pass the day as Tally returned it\. When a command fails, its error names the field to fix\./);
  const skill = readFileSync(join(REPO, ".claude/skills/today/SKILL.md"), "utf8");
  assert.match(skill, /A limit it reports: change the day and run it again\. Its `limits` result stands for these days: run `limits check` again only after a day, the limits or the week's reads change \(`unknown` days still need their reads\)\./);
});
