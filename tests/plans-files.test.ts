// V2: the files logger (coach.yaml logger: files; contracts §12a). One CSV per ISO week under
// plans/; the engine writes the plan columns, reads the done_ columns back for the tools, and
// fills them from a chat report with one command (`plans done`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, instance, writeJson } from "./e3/helpers.ts";
import { filesSnapshot, isoWeekId, isoWeekMonday, parseCsv, PLAN_COLUMNS, readWeek, writePlan } from "../engine/plans-files.ts";

const files = () => {
  const dir = instance((y) => y.replace(/^logger: .*$/m, "logger: files"));
  mkdirSync(join(dir, "plans"), { recursive: true });
  return dir;
};

const WEEK = [
  {
    date: "2026-10-12",
    dayName: "Lower A",
    notes: "Start light",
    exercises: [
      { name: "Back Squat", unit: "lbs", sets: [{ weight: 95, reps: 5, warmup: true }, { weight: 185, reps: 5 }, { weight: 185, reps: 5 }, { weight: 185, reps: 5 }] },
      { name: 'Press, "strict"', sets: [{ weight: 95, reps: 8 }, { weight: 95, reps: 10 }] },
    ],
  },
  { date: "2026-10-14", dayName: "Zone 2", exercises: [{ name: "Bike", sets: [{ duration_s: 2400 }] }] },
];

test("ISO week ids: the file name for a date, across year ends", () => {
  assert.equal(isoWeekId("2026-10-12"), "2026-W42");
  assert.equal(isoWeekId("2026-10-18"), "2026-W42");
  assert.equal(isoWeekId("2026-12-31"), "2026-W53");
  assert.equal(isoWeekId("2027-01-03"), "2026-W53");
  assert.equal(isoWeekId("2027-01-04"), "2027-W01");
  assert.equal(isoWeekId("2025-12-29"), "2026-W01");
  assert.equal(isoWeekMonday("2026-W42"), "2026-10-12");
  assert.equal(isoWeekMonday("2026-W01"), "2025-12-29");
  assert.throws(() => isoWeekMonday("2025-W53"));
});

test("files round trip: plans write, then plans read gives the same days; the header is the spec's columns", () => {
  const dir = files();
  const input = writeJson(dir, ".tmp/coach/week.json", { week: { week_start: "2026-10-12", days: WEEK } });
  const w = cli(["plans", "write", "--input", input, "--root", dir]);
  assert.equal(w.code, 0, w.stderr);
  assert.deepEqual(w.json.files, ["plans/2026-W42.csv"]);
  const csv = readFileSync(join(dir, "plans/2026-W42.csv"), "utf8");
  assert.equal(csv.split("\n")[0], "date,day,exercise,sets,reps,load,unit,notes,done_sets,done_reps,done_load,felt");
  assert.deepEqual(parseCsv(csv)[0], [...PLAN_COLUMNS]);
  const r = cli(["plans", "read", "--week", "2026-10-15", "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.week, "2026-W42");
  assert.equal(r.json.week_start, "2026-10-12");
  const [mon, wed] = r.json.days;
  assert.equal(mon.dayName, "Lower A");
  assert.equal(mon.notes, "Start light");
  // Warm-ups are not plan sets; three working sets of 5 at 185.
  assert.equal(mon.exercises[0].name, "Back Squat");
  assert.equal(mon.exercises[0].sets.length, 3);
  assert.deepEqual(mon.exercises[0].sets[0], { weight: 185, reps: 5 });
  // A name with a comma and quotes survives the CSV; a rep range keeps its bottom.
  assert.equal(mon.exercises[1].name, 'Press, "strict"');
  assert.equal(mon.exercises[1].sets.length, 2);
  assert.equal(mon.exercises[1].sets[0].reps, 8);
  assert.equal(wed.exercises[0].sets[0].duration_s, 2400);
  assert.deepEqual(r.json.logged, []);
  // The same week through --week YYYY-Www.
  assert.deepEqual(cli(["plans", "read", "--week", "2026-W42", "--root", dir]).json.days, r.json.days);
});

test("files: plans write takes Tally-shaped days too (adjust's tally_day)", () => {
  const dir = files();
  const input = writeJson(dir, ".tmp/coach/day.json", {
    tally_day: { date: "2026-10-12", dayName: "Lower A", weightUnit: "kg", exercises: [{ exerciseId: "x", name: "Back Squat", suggestedSets: 2, suggestedReps: 5, repsMax: 6, suggestedWeight: 80 }] },
  });
  assert.equal(cli(["plans", "write", "--input", input, "--root", dir]).code, 0);
  const row = parseCsv(readFileSync(join(dir, "plans/2026-W42.csv"), "utf8"))[1];
  assert.deepEqual(row.slice(0, 7), ["2026-10-12", "Lower A", "Back Squat", "2", "5-6", "80", "kg"]);
});

test("files: a spreadsheet's BOM, CRLF and an added column are read, and the column is kept on the next write", () => {
  const dir = files();
  writePlan(dir, WEEK, "lbs");
  const path = join(dir, "plans/2026-W42.csv");
  const lines = readFileSync(path, "utf8").trim().split("\n");
  // The athlete adds a column and logs a row in Numbers, which saves with a BOM and CRLF.
  const edited = [`${lines[0]},my notes`, `${lines[1].replace(/,,,,$/, ",3,5,185,RPE 8")},felt good`, ...lines.slice(2).map((l) => `${l},`)];
  writeFileSync(path, "﻿" + edited.join("\r\n") + "\r\n");
  const read = readWeek(dir, "2026-10-12", "lbs");
  assert.deepEqual(read.warnings, []);
  assert.equal(read.logged.length, 1);
  assert.deepEqual(read.logged[0].exercises[0].sets[0], { weight: 185, reps: 5, rpe: 8 });
  // The coach rewrites the plan: the log, the RPE and the athlete's column stay.
  const res = writePlan(dir, WEEK, "lbs");
  assert.equal(res.kept_done, 1);
  const table = parseCsv(readFileSync(path, "utf8"));
  assert.equal(table[0].at(-1), "my notes");
  assert.equal(table[1].at(-1), "felt good");
  assert.deepEqual(table[1].slice(8, 12), ["3", "5", "185", "RPE 8"]);
});

test("files: a logged row the new plan drops is kept, never lost", () => {
  const dir = files();
  writePlan(dir, WEEK, "lbs");
  assert.equal(cli(["plans", "done", "--date", "2026-10-12", "--as-planned", "--root", dir]).code, 0);
  const res = writePlan(dir, [{ date: "2026-10-12", dayName: "Lower A", exercises: [{ name: "Leg Press", sets: [{ weight: 300, reps: 10 }] }] }], "lbs");
  assert.deepEqual(res.dropped_done.map((d) => d.exercise).sort(), ["Back Squat", 'Press, "strict"']);
  const names = readWeek(dir, "2026-10-12", "lbs").days[0].exercises.map((e) => e.name);
  assert.deepEqual(names.sort(), ["Back Squat", "Leg Press", 'Press, "strict"']);
});

test("files chat fill: 'did all sets, last set of squats felt heavy' fills the done_ columns with plans done", () => {
  const dir = files();
  writePlan(dir, WEEK, "lbs");
  // "Did all sets": every row of the day as planned.
  const all = cli(["plans", "done", "--date", "2026-10-12", "--as-planned", "--root", dir]);
  assert.equal(all.code, 0, all.stderr);
  assert.equal(all.json.updated.length, 2);
  // "The last set of squats felt heavy": a felt note on that exercise (name match ignores case).
  const felt = cli(["plans", "done", "--date", "2026-10-12", "--exercise", "back squat", "--felt", "last set heavy", "--root", dir]);
  assert.equal(felt.code, 0, felt.stderr);
  assert.deepEqual(felt.json.updated, [{ date: "2026-10-12", exercise: "Back Squat", done_sets: "3", done_reps: "5", done_load: "185", felt: "last set heavy" }]);
  const rows = parseCsv(readFileSync(join(dir, "plans/2026-W42.csv"), "utf8"));
  assert.deepEqual(rows[1].slice(8), ["3", "5", "185", "last set heavy"]);
  // A rep range done as planned records its top.
  assert.deepEqual(rows[2].slice(8, 11), ["2", "10", "95"]);
  // The engine reads it back: the logged week for targets.
  const weeks = cli(["weeks", "--from", "2026-10-12", "--to", "2026-10-18", "--root", dir]);
  assert.equal(weeks.code, 0, weeks.stderr);
  assert.deepEqual(weeks.json.warnings, []);
  const day = weeks.json.logs[0].days[0];
  assert.equal(day.date, "2026-10-12");
  assert.equal(day.exercises[0].sets.length, 3);
  assert.equal(all.json.logged_sessions, 1);
  // Per-set reps and a failed name are handled.
  assert.equal(cli(["plans", "done", "--date", "2026-10-12", "--exercise", "back squat", "--reps", "5,5,4", "--root", dir]).code, 0);
  assert.deepEqual(readWeek(dir, "2026-10-12", "lbs").logged[0].exercises[0].sets.map((s) => s.reps), [5, 5, 4]);
  const miss = cli(["plans", "done", "--date", "2026-10-12", "--exercise", "deadlift", "--sets", "3", "--root", dir]);
  assert.equal(miss.code, 1);
  assert.equal(miss.json.error.code, "NOT_PLANNED");
  assert.match(miss.json.error.message, /planned: Back Squat/);
  // No value and no --as-planned is a usage error.
  assert.equal(cli(["plans", "done", "--date", "2026-10-12", "--exercise", "back squat", "--root", dir]).code, 2);
});

test("files: the engine tools read the files (loads and adjust from the plan, scan-notes from the felt column)", () => {
  const dir = files();
  writePlan(dir, [{ date: "2026-10-05", dayName: "Lower A", exercises: [{ name: "Back Squat", sets: [{ weight: 185, reps: 5 }, { weight: 185, reps: 5 }] }] }, ...WEEK], "lbs");
  assert.equal(cli(["plans", "done", "--date", "2026-10-05", "--as-planned", "--root", dir]).code, 0);
  const loads = cli(["loads", "--from-snapshot", "2026-10-12", "--root", dir]);
  assert.equal(loads.code, 0, loads.stderr);
  assert.equal(loads.json.suggestions.length, 2);
  const adjust = cli(["adjust", "--from-snapshot", "2026-10-12", "--decision", "trim", "--root", dir]);
  assert.equal(adjust.code, 0, adjust.stderr);
  assert.ok(adjust.json.tally_day, "adjust prints the day for plans write");
  const missing = cli(["adjust", "--from-snapshot", "2026-10-13", "--decision", "trim", "--root", dir]);
  assert.equal(missing.json.error.code, "NOT_PLANNED");
  assert.equal(cli(["plans", "done", "--date", "2026-10-12", "--exercise", "bike", "--sets", "1", "--felt", "chest pain on the bike", "--root", dir]).code, 1, "Bike is on the 14th");
  assert.equal(cli(["plans", "done", "--date", "2026-10-14", "--exercise", "bike", "--sets", "1", "--felt", "chest pain on the bike", "--root", dir]).code, 0);
  const scan = cli(["safety", "scan-notes", "--since", "2026-10-01", "--dry-run", "--root", dir]);
  assert.equal(scan.code, 0, scan.stderr);
  assert.deepEqual(scan.json.urgent_terms, ["chest pain"]);
  assert.equal(existsSync(join(dir, "athlete/.urgent-stop")), false, "dry run");
});

test("files snapshot: planned days in the logger's shape, the logged rows as a complete history", () => {
  const dir = files();
  writePlan(dir, WEEK, "lbs");
  cli(["plans", "done", "--date", "2026-10-12", "--exercise", "back squat", "--sets", "3", "--reps", "5", "--load", "185", "--felt", "8", "--root", dir]);
  const snap = filesSnapshot(dir, { units: "lbs", timezone: "America/Los_Angeles", now: "2026-10-12T20:00:00Z" });
  assert.equal(snap.days["2026-10-12"].exercises[0].suggestedSets, 3);
  assert.equal(snap.days["2026-10-12"].exercises[1].repsMax, 10);
  assert.equal(snap.days["2026-10-14"].exercises[0].suggestedDuration, 2400);
  assert.equal(snap.history.length, 1);
  assert.deepEqual(snap.history[0].exercises[0].sets[0], { weight: 185, reps: 5, rpe: 8 });
  assert.equal(snap.history_coverage?.complete, true);
});

test("files under the urgent stop: plans write and plans done refuse (they run through Bash, which the urgent gate does not see)", () => {
  const dir = files();
  writePlan(dir, WEEK, "lbs");
  const before = readFileSync(join(dir, "plans/2026-W42.csv"), "utf8");
  writeFileSync(join(dir, "athlete/.urgent-stop"), "not even json");
  const input = writeJson(dir, ".tmp/coach/week.json", { days: WEEK });
  const w = cli(["plans", "write", "--input", input, "--root", dir]);
  assert.equal(w.code, 1);
  assert.equal(w.json.error.code, "URGENT_STOP");
  const d = cli(["plans", "done", "--date", "2026-10-12", "--as-planned", "--root", dir]);
  assert.equal(d.json.error.code, "URGENT_STOP");
  assert.equal(readFileSync(join(dir, "plans/2026-W42.csv"), "utf8"), before, "the file is unchanged");
  // Reading still works.
  assert.equal(cli(["plans", "read", "--week", "2026-10-12", "--root", dir]).code, 0);
});

// ---------- V2b fix round ----------

const HEADER = "date,day,exercise,sets,reps,load,unit,notes,done_sets,done_reps,done_load,felt";

test("V2b fix 1: a spreadsheet date and broken quoting are never lost on a rewrite of another day, and are reported", () => {
  const dir = files();
  const path = join(dir, "plans/2026-W42.csv");
  writePlan(dir, WEEK, "lbs");
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const sheetDate = '10/13/2026,Upper A,Bench Press,3,5,135,lbs,,3,5,135,"felt ok, easy",kept';
  const broken = '2026-10-15,Upper B,"Pull-up,3,8,,,,,,,';
  writeFileSync(path, [`${lines[0]},coach notes`, ...lines.slice(1).map((l) => `${l},`), sheetDate, broken].join("\n") + "\n");
  const read = readWeek(dir, "2026-10-12", "lbs");
  assert.equal(read.unparsed, 2);
  assert.ok(read.warnings.some((w) => /"10\/13\/2026" is not YYYY-MM-DD; it was not read and is kept as it is/.test(w)), read.warnings.join("\n"));
  assert.ok(read.warnings.some((w) => /a quote that never closes/.test(w)), read.warnings.join("\n"));
  assert.equal(read.days.length, 2, "the good rows are still read");
  // A rewrite of another day keeps both rows, the added column included.
  writePlan(dir, [{ date: "2026-10-14", dayName: "Zone 2", exercises: [{ name: "Row", sets: [{ duration_s: 1800 }] }] }], "lbs");
  const after = readFileSync(path, "utf8");
  assert.ok(after.includes(broken), "the broken line stays verbatim");
  const table = parseCsv(after);
  const kept = table.find((r) => r[0] === "10/13/2026");
  assert.ok(kept, "the spreadsheet-date row stays");
  assert.deepEqual(kept, ["10/13/2026", "Upper A", "Bench Press", "3", "5", "135", "lbs", "", "3", "5", "135", "felt ok, easy", "kept"]);
  assert.equal(table[0].at(-1), "coach notes");
  // A chat fill keeps them too.
  assert.equal(cli(["plans", "done", "--date", "2026-10-12", "--as-planned", "--root", dir]).code, 0);
  assert.ok(readFileSync(path, "utf8").includes(broken));
  assert.ok(parseCsv(readFileSync(path, "utf8")).some((r) => r[0] === "10/13/2026"));
  // The engine results and the snapshot carry the warnings; the history is incomplete.
  const weeks = cli(["weeks", "--from", "2026-10-12", "--to", "2026-10-18", "--root", dir]);
  assert.ok(weeks.json.warnings.some((w: string) => /10\/13\/2026/.test(w)), JSON.stringify(weeks.json.warnings));
  const snap = filesSnapshot(dir, { units: "lbs", timezone: "America/Los_Angeles", now: "2026-10-16T20:00:00Z" });
  assert.equal(snap.history_coverage?.complete, false);
  assert.ok((snap.warnings ?? []).length >= 2);
  // A sign written in an unparsed row is still scanned.
  writeFileSync(path, readFileSync(path, "utf8") + "10/16/2026,Upper A,Bench Press,3,5,135,lbs,,3,5,135,chest pain on the last set,\n");
  assert.deepEqual(cli(["safety", "scan-notes", "--since", "2026-10-01", "--dry-run", "--root", dir]).json.urgent_terms, ["chest pain"]);
});

test("V2b fix 2: units per row: a mixed-unit day converts each load to the snapshot's unit; a unit change after logging keeps the logged unit", () => {
  const dir = files();
  const path = join(dir, "plans/2026-W42.csv");
  writeFileSync(path, [HEADER, "2026-10-12,Lower A,Back Squat,3,5,185,lbs,,3,5,185,", "2026-10-12,Lower A,Leg Press,3,10,80,kg,,3,10,80,"].join("\n") + "\n");
  const snap = filesSnapshot(dir, { units: "lbs", timezone: "America/Los_Angeles", now: "2026-10-12T20:00:00Z" });
  const ex = snap.days["2026-10-12"].exercises;
  assert.equal(snap.days["2026-10-12"].weightUnit, "lbs");
  assert.equal(ex[0].suggestedWeight, 185);
  assert.equal(ex[1].suggestedWeight, 176, "80 kg in lbs (Tally's rounding)");
  assert.deepEqual(snap.history[0].exercises.map((e) => e.sets[0].weight), [185, 176]);
  // The coach replans the squat in kg after the athlete logged it in lbs.
  const res = writePlan(dir, [{ date: "2026-10-12", dayName: "Lower A", exercises: [{ name: "Back Squat", unit: "kg", sets: [{ weight: 85, reps: 5 }, { weight: 85, reps: 5 }, { weight: 85, reps: 5 }] }, { name: "Leg Press", unit: "kg", sets: [{ weight: 80, reps: 10 }] }] }], "lbs");
  assert.equal(res.kept_done, 2);
  const squat = parseCsv(readFileSync(path, "utf8")).find((r) => r[2] === "Back Squat")!;
  assert.deepEqual(squat.slice(5, 7), ["187", "lbs"], "the plan load follows the logged unit");
  assert.equal(squat[10], "185", "the logged load is unchanged");
  assert.deepEqual(readWeek(dir, "2026-10-12", "lbs").logged[0].exercises[0], { exerciseId: null, name: "Back Squat", unit: "lbs", sets: [{ weight: 185, reps: 5, rpe: null }, { weight: 185, reps: 5, rpe: null }, { weight: 185, reps: 5, rpe: null }] });
});

test("V2b fix 3: athlete-entered counts are bounded: 4294967296, -1 and abc are unknown with a warning, and the raw cells stay", () => {
  const dir = files();
  const path = join(dir, "plans/2026-W42.csv");
  writeFileSync(
    path,
    [HEADER, "2026-10-12,Lower A,Back Squat,4294967296,5,185,lbs,,4294967296,5,185,", "2026-10-12,Lower A,Lunge,-1,-1,40,lbs,,-1,abc,40,", "2026-10-12,Lower A,Calf Raise,abc,4294967296,0,lbs,,abc,12,0,", "2026-10-12,Lower A,Plank,3,30s,,,,3,,,"].join("\n") + "\n",
  );
  const t0 = Date.now();
  const read = readWeek(dir, "2026-10-12", "lbs");
  assert.ok(Date.now() - t0 < 2000, "no huge allocation");
  const sets = read.days[0].exercises.map((e) => e.sets.length);
  assert.deepEqual(sets, [0, 0, 0, 3], "unknown counts give no sets");
  for (const v of ["4294967296", "-1", "abc"]) assert.ok(read.warnings.some((w) => w.includes(`"${v}" is not a whole number from 0 to`)), `${v}: ${read.warnings.join("\n")}`);
  assert.ok(read.warnings.some((w) => /Back Squat: done sets "4294967296"/.test(w)));
  assert.deepEqual(read.logged[0].exercises.map((e) => e.sets.length).slice(0, 3), [0, 0, 0]);
  const snap = filesSnapshot(dir, { units: "lbs", timezone: "America/Los_Angeles", now: "2026-10-12T20:00:00Z" });
  // W1b: a sets cell it cannot read stays as its text, so a check that needs it is refused (never 1 set).
  assert.equal(snap.days["2026-10-12"].exercises[0].suggestedSets, "4294967296");
  assert.equal(snap.days["2026-10-12"].exercises[3].suggestedSets, 3);
  assert.equal(snap.history_coverage?.complete, false);
  // A rewrite of another day keeps the raw cells.
  writePlan(dir, [{ date: "2026-10-14", exercises: [{ name: "Bike", sets: [{ duration_s: 2400 }] }] }], "lbs");
  const rows = parseCsv(readFileSync(path, "utf8"));
  assert.equal(rows.find((r) => r[2] === "Back Squat")![3], "4294967296");
  assert.equal(rows.find((r) => r[2] === "Lunge")![9], "abc");
});
