// W1b (0.2.8 fix round, after the diff review of W1): a malformed history entry never hides the
// urgent notes beside it; a logged value the capture cannot read is never a number; a bad plans/
// load cell is unknown, never clean; today-write-prep checks the unit it is given; a 0 in a plans/
// sets cell keeps the daily run working; a bench as equipment is not a bench press. Made-up
// fixtures only. To record the base result, run this file in a checkout of the base (3ceb99b).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addDays } from "../engine/dates.ts";
import { planWindows } from "../engine/history-windows.ts";
import { mergeResponse, saveSnapshot } from "../engine/snapshot.ts";
import type { Snapshot } from "../engine/types.ts";
import { cli, instance as e3Instance, REPO, writeJson } from "./e3/helpers.ts";

const NOW = "2026-10-14T15:00:00.000Z"; // 08:00 in Los Angeles
const TODAY = "2026-10-14";
const SESSION = "s-w1b";
const SERVER = "claude_ai_Tally_Workout";
const ENV = { env: { CLAUDE_CODE_SESSION_ID: SESSION } };
const W = planWindows(addDays(TODAY, -56), TODAY, 14);
const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];
const page = (sessions: unknown[]) => text({ count: sessions.length, sessions });

const SQUAT = { exerciseId: "Barbell_Squat", name: "Back Squat", suggestedSets: 3, suggestedReps: 8, suggestedWeight: 100 };
const tday = (date = TODAY, exercises: unknown[] = [SQUAT]) => ({ date, found: true, version: `v-${date}-1`, updatedAt: "t0", source: "mcp", userModified: false, skipped: false, dayType: "lower", dayName: "Lower A", exercises, weightUnit: "lbs", weightUnitSource: "settings" });
const noDay = (date: string) => ({ date, found: false, exercises: [], weightUnit: "lbs", weightUnitSource: "settings" });
/** A logged Back Squat session: 3 sets of 8 at 100, with `set` merged into the first set. */
const squatSession = (date: string, id: string, set: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id,
  date,
  name: "Lower A",
  weightUnit: "lbs",
  exercises: [{ exerciseId: "Barbell_Squat", name: "Back Squat", muscle: "quads", trackingType: "weight_reps", sets: [{ weight: 100, reps: 8, ...set }, { weight: 100, reps: 8 }, { weight: 100, reps: 8 }], ...extra }],
});

function instance(edit?: (yaml: string) => string): string {
  const dir = e3Instance(edit);
  writeFileSync(join(dir, "athlete/limits.md"), "# Injuries and limits\n\nNone yet.\n");
  return dir;
}

function merge(prev: Snapshot | null, tool: string, input: Record<string, unknown>, response: unknown): Snapshot {
  return mergeResponse(prev, { tool, input, response, session_id: SESSION, now: NOW, timezone: "America/Los_Angeles", server: SERVER });
}

/** Today's day and the 8 weeks of history windows read in this session (in process), with `sessions` in their windows. */
function readAll(dir: string, sessions: unknown[], days: Record<string, unknown> = {}): Snapshot {
  let s = merge(null, "get_planned_workout", { date: TODAY }, text(tday()));
  for (const [d, v] of Object.entries(days)) s = merge(s, "get_planned_workout", { date: d }, text(v));
  for (const w of W) s = merge(s, "get_workout_history", w, page(sessions.filter((x: any) => x.date >= w.since && x.date <= w.until)));
  saveSnapshot(dir, s);
  return s;
}

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

/** Every 8-week window read (the older ones in process, the newest through the capture hook), then the note scan. */
async function captureAndScan(newest: unknown[]) {
  const dir = instance();
  let s: Snapshot | null = null;
  for (const w of W.slice(1)) s = merge(s, "get_workout_history", w, page([]));
  saveSnapshot(dir, s!);
  const h = await runHook(dir, { tool_name: `mcp__${SERVER}__get_workout_history`, tool_input: W[0], tool_response: page(newest) });
  assert.equal(h.code, 0, h.stderr);
  const snap = JSON.parse(readFileSync(join(dir, "athlete/.cache/snapshot.json"), "utf8")) as Snapshot;
  const scan = cli(["safety", "scan-notes", "--since", "2026-10-11", "--now", NOW, "--root", dir], ENV);
  return { dir, scan, snap };
}

// ---------- fix 1: a malformed history entry never hides the urgent notes on its page ----------

test("fix 1: a malformed entry on a history page → the capture hook → scan-notes: the urgent note beside it writes the stop; coverage stays incomplete", async () => {
  // The review's case: a null session next to a session whose exercise note is urgent.
  const { dir, scan, snap } = await captureAndScan([null, { date: "2026-10-13", exercises: [{ name: "Squat", sets: [], notes: ["chest pain"] }] }]);
  assert.equal(scan.code, 0, scan.stderr);
  assert.deepEqual(scan.json.urgent_terms, ["chest pain"]);
  assert.ok(existsSync(join(dir, "athlete/.urgent-stop")), "the urgent stop is written");
  assert.equal(scan.json.coverage, "incomplete", "the page failed validation: coverage is not complete");
  // The window stays failed: loads and readiness still see the history as unknown up to today.
  assert.ok(snap.history_windows?.[`${W[0].since}..${W[0].until}`]?.failed, "the window is failed");
  assert.ok(!snap.history_coverage?.complete || (snap.history_coverage.until ?? "") < W[0].since, JSON.stringify(snap.history_coverage));
  const l = cli(["loads", "--input", writeJson(dir, ".tmp/coach/l.json", { exercises: [{ name: "Back Squat", sets: [{ weight: 100, reps: 8 }] }], date: TODAY }), "--now", NOW, "--root", dir], ENV);
  assert.equal(l.json.coverage.status, "failed", JSON.stringify(l.json.coverage));
  assert.deepEqual(snap.history, [], "the page's sessions are not history: their sets are not evidence");
  // A session whose exercise has no sets list (it fails the page too) keeps its notes for the scan.
  const noSets = await captureAndScan([{ date: "2026-10-13", exercises: [{ name: "Squat", notes: "chest pain after the run" }] }, squatSession("2026-10-12", "h2")]);
  assert.deepEqual(noSets.scan.json.urgent_terms, ["chest pain"]);
  assert.ok(existsSync(join(noSets.dir, "athlete/.urgent-stop")));
  assert.equal(noSets.scan.json.coverage, "incomplete");
});

test("fix 1: a malformed page with no urgent note: urgent_unknown stays true (no false all-clear); a later good read of the window replaces the kept notes", async () => {
  const { dir, scan } = await captureAndScan([null, { date: "2026-10-13", exercises: [{ name: "Squat", sets: [], notes: ["felt fine"] }] }]);
  assert.equal(scan.code, 0);
  assert.deepEqual(scan.json.urgent_terms, []);
  assert.equal(scan.json.coverage, "incomplete");
  assert.equal(scan.json.urgent_unknown, true);
  assert.equal(existsSync(join(dir, "athlete/.urgent-stop")), false);
  // The window read again, whole: coverage complete; the notes kept from the failed page leave with it.
  const h = await runHook(dir, { tool_name: `mcp__${SERVER}__get_workout_history`, tool_input: W[0], tool_response: page([squatSession("2026-10-13", "h1")]) });
  assert.equal(h.code, 0, h.stderr);
  const again = cli(["safety", "scan-notes", "--since", "2026-10-11", "--now", NOW, "--root", dir], ENV);
  assert.equal(again.json.coverage, "complete", JSON.stringify(again.json));
  assert.equal(again.json.sessions, 1);
  const snap = JSON.parse(readFileSync(join(dir, "athlete/.cache/snapshot.json"), "utf8")) as Snapshot;
  assert.equal((snap as Record<string, unknown>).unread_notes, undefined);
});

// ---------- fix 2: a logged value the capture cannot read is never a number ----------

const BAD_RPE = squatSession("2026-10-12", "h1", { rpe: "11" });

test("fix 2: a logged set with rpe \"11\" → the capture keeps the problem; loads gives no number and names the date and field", async () => {
  const dir = instance();
  const snap = readAll(dir, [BAD_RPE]);
  assert.deepEqual(snap.history[0].problems, ['2026-10-12 Back Squat: sets[0].rpe must be a number, got the string "11"']);
  const l = cli(["loads", "--from-snapshot", TODAY, "--now", NOW, "--root", dir], ENV);
  assert.equal(l.code, 0, l.stdout);
  assert.equal(l.json.coverage.status, "failed");
  assert.match(l.json.coverage.reason, /2026-10-12 Back Squat: sets\[0\]\.rpe must be a number/);
  for (const s of l.json.suggestions) {
    assert.equal(s.suggestedWeight, undefined, JSON.stringify(s));
    assert.equal(s.held_suggestion, undefined, "no number, not even a held one");
    assert.match(s.reason, /2026-10-12 Back Squat: sets\[0\]\.rpe/);
  }
  assert.deepEqual(l.json.update.operations, [], "no load change is written");
  // The same history with a readable RPE: a suggestion (the control).
  const ok = instance();
  readAll(ok, [squatSession("2026-10-12", "h1", { rpe: 8 })]);
  const c = cli(["loads", "--from-snapshot", TODAY, "--now", NOW, "--root", ok], ENV);
  assert.equal(c.json.coverage.status, "complete");
  assert.equal(typeof c.json.suggestions[0].suggestedWeight, "number");
  // A set that is not an object, and an RPE over 10, are problems too.
  const odd = instance();
  const s2 = readAll(odd, [{ ...squatSession("2026-10-12", "h1", { rpe: 12 }), exercises: [{ ...squatSession("2026-10-12", "h1", { rpe: 12 }).exercises[0], sets: [{ weight: 100, reps: 8, rpe: 12 }, "8 at 100"] }] }]);
  assert.deepEqual(s2.history[0].problems, ["2026-10-12 Back Squat: sets[0].rpe must be at most 10, got 12", '2026-10-12 Back Squat: sets[1] must be a set ({weight, reps, …}), got the string "8 at 100"']);
});

test("fix 2: every snapshot consumer that computes from logged sets says unknown or failed (readiness, weeks, block draft, loads --fill, today-brief)", () => {
  const dir = instance();
  readAll(dir, [BAD_RPE], { "2026-10-12": tday("2026-10-12"), "2026-10-13": noDay("2026-10-13") });
  // readiness --date: performance unknown, with the date and field.
  const r = cli(["readiness", "--date", TODAY, "--now", NOW, "--root", dir], ENV);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.performance.state, "unknown");
  assert.match(r.json.performance.reasons.join(" "), /2026-10-12 Back Squat: sets\[0\]\.rpe/);
  // weeks: the coverage is not complete, and a warning names the value.
  const w = cli(["weeks", "--from", "2026-10-05", "--to", TODAY, "--now", NOW, "--root", dir], ENV);
  assert.equal(w.code, 0, w.stdout);
  assert.equal(w.json.coverage.complete, false);
  assert.ok(w.json.warnings.some((x: string) => /2026-10-12 Back Squat: sets\[0\]\.rpe/.test(x)), JSON.stringify(w.json.warnings));
  // The week that holds it has no count, and targets refuses it (never a number from it).
  const wk = w.json.logs.find((x: any) => x.week_start === "2026-10-12");
  assert.match(wk.unknown, /2026-10-12 Back Squat: sets\[0\]\.rpe/);
  assert.equal(wk.sets_by_muscle, null);
  assert.equal(w.json.logs.find((x: any) => x.week_start === "2026-10-05").unknown, undefined);
  const block = JSON.parse(cli(["block", "draft", "--weeks", "6", "--now", NOW, "--root", instance()]).stdout).block;
  const t = cli(["targets", "--root", dir, "--input", writeJson(dir, ".tmp/coach/t.json", { block, logs: w.json.logs, today: TODAY, target_week: 2 })]);
  assert.equal(t.code, 1, t.stdout);
  assert.equal(t.json.error.code, "INPUT_ERROR");
  assert.match(t.json.error.message, /logs\[1\]\.unknown says the week 2026-10-12 is unknown \(a logged value cannot be read/);
  // block draft: no reference week from a history it cannot read.
  const b = cli(["block", "draft", "--weeks", "6", "--now", NOW, "--root", dir], ENV);
  assert.equal(b.code, 1, b.stdout);
  assert.equal(b.json.error.code, "INPUT_ERROR");
  assert.match(b.json.error.message, /2026-10-12 Back Squat: sets\[0\]\.rpe/);
  // loads --fill from the logged weeks: refused before the file is written.
  const week = writeJson(dir, ".tmp/coach/week.json", { week: { week_start: "2026-10-12", days: [{ date: TODAY, exercises: [{ name: "Back Squat", sets: [{ weight: null, reps: 8 }] }] }] } });
  const before = readFileSync(week, "utf8");
  const f = cli(["loads", "--input", week, "--fill", "--now", NOW, "--root", dir], ENV);
  assert.equal(f.code, 1, f.stdout);
  assert.equal(f.json.error.code, "INPUT_ERROR");
  assert.match(f.json.error.message, /2026-10-12 Back Squat: sets\[0\]\.rpe/);
  assert.equal(readFileSync(week, "utf8"), before);
  // loads {exercises} with no history: the snapshot's history is checked too.
  const e = cli(["loads", "--input", writeJson(dir, ".tmp/coach/l.json", { exercises: [{ name: "Back Squat", sets: [{ weight: 100, reps: 8 }] }], date: TODAY }), "--now", NOW, "--root", dir], ENV);
  assert.equal(e.code, 0, e.stdout);
  assert.equal(e.json.suggestions[0].suggestedWeight, undefined);
  assert.match(e.json.suggestions[0].reason, /2026-10-12 Back Squat: sets\[0\]\.rpe/);
});

test("fix 2: today-brief --stage post: the history is failed and loads gives no number; the note scan stays independent (a bad set never stops a note)", () => {
  const dir = instance();
  readAll(dir, [squatSession("2026-10-12", "h1", { rpe: "11" }, { notes: ["chest pain"] })], { "2026-10-12": tday("2026-10-12"), "2026-10-13": noDay("2026-10-13") });
  assert.equal(cli(["today-brief", "--stage", "pre", "--now", NOW, "--root", dir], ENV).code, 0);
  const p = cli(["today-brief", "--stage", "post", "--now", NOW, "--root", dir], ENV);
  assert.equal(p.code, 0, p.stdout);
  assert.equal(p.json.coverage.history.status, "failed");
  assert.match(p.json.coverage.history.reason, /2026-10-12 Back Squat: sets\[0\]\.rpe/);
  assert.equal(p.json.loads.status, "not_applicable", JSON.stringify(p.json.loads));
  // The note scan reads the note on the same exercise, and its coverage is its own.
  assert.equal(p.json.coverage.safety_notes, "complete");
  assert.deepEqual(p.json.safety_notes.urgent_terms, ["chest pain"]);
  assert.equal(p.json.urgent.stopped, true);
});

// ---------- fixes 3 and 5: plans/ CSV cells ----------

const HEADER = "date,day,exercise,sets,reps,load,unit,notes,done_sets,done_reps,done_load,felt\n";
function filesRoot(rows: string): string {
  const dir = instance((y) => y.replace(/^logger: .*$/m, "logger: files"));
  writeFileSync(join(dir, "athlete/limits.md"), "# Injuries and limits\n\n- Right shoulder: pressing at most 50 lb. (since 2026-10-01)\n");
  mkdirSync(join(dir, "plans"), { recursive: true });
  writeFileSync(join(dir, "plans/2026-W42.csv"), HEADER + rows);
  return dir;
}
test("fix 3: a bench press row with load \"heavy\" is unknown (never clean), naming the date, exercise and column", () => {
  const dir = filesRoot("2026-10-14,Upper A,Bench Press,3,8,heavy,lbs,,,,,\n");
  // plans read: the cell is unknown, with a warning.
  const r = cli(["plans", "read", "--week", TODAY, "--root", dir]);
  assert.equal(r.code, 0, r.stdout);
  assert.ok(r.json.warnings.some((w: string) => w === '2026-10-14 Bench Press: load "heavy" is not a load; read as unknown'), JSON.stringify(r.json.warnings));
  // The daily run: the loads cannot read the load: never a number (0.3.0: no limits check in post).
  assert.equal(cli(["today-brief", "--stage", "pre", "--now", NOW, "--root", dir]).code, 0);
  const p = cli(["today-brief", "--stage", "post", "--now", NOW, "--root", dir]);
  assert.equal(p.code, 0, p.stdout);
  assert.equal(p.json.limits_check, undefined);
  assert.notEqual(p.json.coverage.history.status, "complete", "the files have a cell the engine cannot read");
  // adjust and loads from the files: the same refusal, never a number.
  const a = cli(["loads", "--from-snapshot", TODAY, "--now", NOW, "--root", dir]);
  assert.equal(a.code, 1, a.stdout);
  assert.equal(a.json.error.code, "INPUT_ERROR");
  assert.match(a.json.error.message, /the planned day 2026-10-14 \(as read\): Bench Press: the load cell "heavy" is not a load/);
});

test("fix 3: a bad sets cell is unknown in the snapshot too (0.2.7 counted it as 1 set); a 'bw' load stays no load", () => {
  const dir = filesRoot("2026-10-14,Upper A,Bench Press,three,8,40,lbs,,,,,\n2026-10-14,Upper A,Push-Up,3,10,bw,,,,,,\n");
  assert.equal(cli(["today-brief", "--stage", "pre", "--now", NOW, "--root", dir]).code, 0);
  const p = cli(["today-brief", "--stage", "post", "--now", NOW, "--root", dir]);
  assert.notEqual(p.json.coverage.history.status, "complete", JSON.stringify(p.json.coverage));
  assert.ok(cli(["plans", "read", "--week", TODAY, "--root", dir]).json.warnings.some((w: string) => /Bench Press: sets "three"/.test(w)));
  assert.notEqual(p.json.loads.status, "complete");
  const bw = filesRoot("2026-10-14,Upper A,Push-Up,3,10,bw,,,,,,\n");
  assert.equal(cli(["today-brief", "--stage", "pre", "--now", NOW, "--root", bw]).code, 0);
  const q = cli(["today-brief", "--stage", "post", "--now", NOW, "--root", bw]);
  assert.equal(q.json.coverage.history.status, "complete", JSON.stringify(q.json.coverage));
  assert.deepEqual(cli(["plans", "read", "--week", TODAY, "--root", bw]).json.warnings, []);
});

test("fix 5: a 0 in a plans/ sets cell: today-brief --stage post gives the base's result; adjust → today-write-prep → plans write keeps the 0", () => {
  const dir = filesRoot("2026-10-14,Lower A,Back Squat,3,8,100,lbs,,,,,\n2026-10-14,Lower A,Cable Row,0,10,60,lbs,,,,,\n");
  assert.equal(cli(["today-brief", "--stage", "pre", "--now", NOW, "--root", dir]).code, 0);
  const p = cli(["today-brief", "--stage", "post", "--now", NOW, "--root", dir]);
  assert.equal(p.code, 0, p.stdout);
  // The fields the base (3ceb99b's parent release, 0.2.7) gave for this day: the run is not failed.
  assert.equal(p.json.today_day.status, "found");
  assert.deepEqual(p.json.today_day.exercises.map((e: any) => e.name), ["Back Squat", "Cable Row"]);
  assert.equal(p.json.coverage.history.status, "complete");
  assert.notEqual(p.json.loads.status, "failed", JSON.stringify(p.json.loads));
  // plans read and the snapshot agree: the 0 row has no sets (the zero-work form).
  const r = cli(["plans", "read", "--week", TODAY, "--root", dir]);
  assert.deepEqual(r.json.days[0].exercises[1].sets, []);
  assert.deepEqual(r.json.warnings, []);
  // The write path keeps the 0: adjust's tally_day, today-write-prep, then plans write.
  const a = cli(["adjust", "--from-snapshot", TODAY, "--decision", "trim", "--now", NOW, "--root", dir]);
  assert.equal(a.code, 0, a.stdout);
  const row = a.json.tally_day.exercises.find((e: any) => e.name === "Cable Row");
  assert.equal(row.suggestedSets, 0);
  const wp = cli(["today-write-prep", "--input", writeJson(dir, ".tmp/coach/wp.json", { after: a.json.tally_day, tool: "plan_workout_day", kind: "trim_session" }), "--now", NOW, "--root", dir]);
  assert.equal(wp.code, 0, wp.stdout);
  const pw = cli(["plans", "write", "--input", writeJson(dir, ".tmp/coach/pw.json", wp.json.write.plain.input), "--root", dir]);
  assert.equal(pw.code, 0, pw.stdout);
  assert.match(readFileSync(join(dir, "plans/2026-W42.csv"), "utf8"), /2026-10-14,Lower A,Cable Row,0,10,60,lbs/);
  // A real Tally prescription keeps the strict count: 0 is refused there.
  const t = cli(["volume", "--root", dir, "--input", writeJson(dir, "d.json", { week: { days: [{ date: TODAY, exercises: [{ name: "Cable Row", suggestedSets: 0 }] }] } })]);
  assert.equal(t.code, 1);
  assert.match(t.json.error.message, /suggestedSets must be a whole number from 1 to 50, got 0/);
});

// ---------- fix 4: today-write-prep checks the supplied unit first ----------

test("fix 4: today-write-prep refuses after.weightUnit \"kilograms\" (never replaced by the stored unit)", () => {
  const dir = instance();
  saveSnapshot(dir, merge(null, "get_planned_workout", { date: TODAY }, text(tday())));
  const prep = (after: unknown) => cli(["today-write-prep", "--input", writeJson(dir, ".tmp/coach/wp.json", { after, tool: "plan_workout_day", kind: "trim_session" }), "--now", NOW, "--root", dir], ENV);
  const { found: _f, version: _v, weightUnitSource: _s, ...write } = tday();
  const r = prep({ ...write, weightUnit: "kilograms", exercises: [{ ...SQUAT, suggestedSets: 2 }] });
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.error.code, "INPUT_ERROR");
  assert.equal(r.json.error.message, 'after: weightUnit must be lbs or kg, got the string "kilograms"; see node engine/cli.ts help today-write-prep');
  // Absent: the stored unit; kg: kept.
  const absent = prep({ ...write, weightUnit: undefined, exercises: [{ ...SQUAT, suggestedSets: 2 }] });
  assert.equal(absent.code, 0, absent.stdout);
  assert.equal(absent.json.write.plain.args.weightUnit, "lbs");
  assert.equal(prep({ ...write, weightUnit: "kg", exercises: [{ ...SQUAT, suggestedSets: 2 }] }).json.write.plain.args.weightUnit, "kg");
});

// ---------- fix 6: a bench as equipment is not a bench press ----------

test("fix 6: an exercise done on a bench is not a bench press; the common bench press names still classify", () => {
  const patterns = (name: string) => cli(["classify", "--exercise", name]).json.patterns as string[];
  for (const name of ["Copenhagen Plank (short lever, knee on bench)", "Hip Thrust (back on bench)", "Bulgarian Split Squat (rear foot on bench)", "Bench Step-Up"]) {
    assert.ok(!patterns(name).includes("horizontal_push"), `${name}: ${patterns(name)}`);
  }
  assert.deepEqual(patterns("Copenhagen Plank (short lever, knee on bench)"), ["hip_adduction", "core_lateral", "core_anti_extension"]);
  assert.deepEqual(patterns("Hip Thrust (back on bench)"), ["hip_thrust"]);
  assert.deepEqual(patterns("Bulgarian Split Squat (rear foot on bench)"), ["lunge", "loaded_deep_knee_flexion"]);
  assert.deepEqual(patterns("Bench Step-Up"), ["step_up"]);
  for (const name of ["Dumbbell Bench Press", "Bench Press (Dumbbell)", "DB Bench", "Barbell Bench"]) assert.deepEqual(patterns(name), ["horizontal_push"], name);
  assert.deepEqual(patterns("Incline Bench Press"), ["incline_push"]);
  assert.deepEqual(patterns("Close Grip Bench"), ["horizontal_push", "elbow_extension"]);
  // The real-data case: Copenhagen plank sets count no chest sets in the week's volume.
  const dir = instance();
  const days = { week: { week_start: "2026-10-12", days: [{ date: TODAY, exercises: [{ name: "Dumbbell Bench Press", suggestedSets: 3, suggestedReps: 10 }, { name: "Copenhagen Plank (short lever, knee on bench)", suggestedSets: 3, suggestedDuration: 20 }] }] } };
  const r = cli(["volume", "--root", dir, "--input", writeJson(dir, "d.json", days)]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.sets_by_muscle.chest, 3, JSON.stringify(r.json.sets_by_muscle));
});

// ---------- W1b confirmation review: the value check covers every session a result uses ----------

test("W1b confirmation 1: loads reads every cached session, so a bad value older than the 8 weeks still gives no number", () => {
  const dir = instance();
  // An older read holds the only squat session (2026-08-01, before the 8-week range), with rpe "11".
  let s = merge(null, "get_planned_workout", { date: TODAY }, text(tday()));
  s = merge(s, "get_workout_history", { since: "2026-07-27", until: "2026-08-09", limit: 10 }, page([squatSession("2026-08-01", "old", { rpe: "11" })]));
  for (const w of W) s = merge(s, "get_workout_history", w, page([]));
  saveSnapshot(dir, s);
  const l = cli(["loads", "--from-snapshot", TODAY, "--now", NOW, "--root", dir], ENV);
  assert.equal(l.code, 0, l.stdout);
  assert.equal(l.json.coverage.status, "failed", JSON.stringify(l.json.coverage));
  assert.match(l.json.coverage.reason, /2026-08-01 Back Squat: sets\[0\]\.rpe/);
  for (const x of l.json.suggestions) assert.equal(x.suggestedWeight, undefined, JSON.stringify(x));
  assert.deepEqual(l.json.update.operations, []);
});

test("W1b confirmation 2: readiness judges an unplanned session against an earlier one, so a bad value there is unknown, never green", () => {
  const dir = instance();
  // 2026-10-13 has no plan: it is judged against the last earlier squat (2026-10-01, rpe "11"),
  // which is before the performance window but inside the 28-day lookback.
  readAll(dir, [squatSession("2026-10-01", "early", { rpe: "11" }), squatSession("2026-10-13", "late", { rpe: 8 })], { "2026-10-13": noDay("2026-10-13") });
  const r = cli(["readiness", "--date", TODAY, "--now", NOW, "--root", dir], ENV);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.performance.state, "unknown", JSON.stringify(r.json.performance));
  assert.match(r.json.performance.reasons.join(" "), /2026-10-01 Back Squat: sets\[0\]\.rpe/);
});
