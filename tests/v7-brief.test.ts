// V7 phase 3: today-brief (pre and post), today-write-prep, classify --before-snapshot, and each
// logger end to end through pre, post, write-prep and save (contracts §22b). Made-up data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addDays } from "../engine/dates.ts";
import { planWindows } from "../engine/history-windows.ts";
import { opIdProblem } from "../engine/opid.ts";
import { mergeResponse, saveSnapshot } from "../engine/snapshot.ts";
import type { Snapshot } from "../engine/types.ts";
import { cli, instance, writeJson } from "./e3/helpers.ts";
import { athleteRepo, cliIn, fakeGh, remote } from "./v7-helpers.ts";

const NOW = "2026-10-14T15:00:00.000Z"; // 08:00 in Los Angeles
const TODAY = "2026-10-14";
const SESSION = "s-brief";
const ENV = { env: { CLAUDE_CODE_SESSION_ID: SESSION } };
const W = planWindows(addDays(TODAY, -56), TODAY, 14);

const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];
const SQUAT = { exerciseId: "Barbell_Squat", name: "Back Squat", suggestedSets: 4, suggestedReps: 5, suggestedWeight: 185 };
const SPLIT = { exerciseId: "Dumbbell_Split_Squat", name: "Split Squat", suggestedSets: 3, suggestedReps: 8, repsMax: 10, perSide: true, notes: "slow down" };
const ROW = { exerciseId: "Cable_Row", name: "Cable Row", suggestedSets: 3, suggestedReps: 10 };
const day = (date: string, over: Record<string, unknown> = {}) => ({ date, found: true, version: `v-${date}-1`, updatedAt: "t0", source: "mcp", userModified: false, skipped: false, dayType: "lower", dayName: "Lower A", exercises: [SQUAT, SPLIT, ROW], weightUnit: "lbs", weightUnitSource: "settings", ...over });
const noDay = (date: string) => ({ date, found: false, exercises: [], weightUnit: "lbs", weightUnitSource: "settings" });
const hit = (date: string, id: string, notes?: string) => ({ id, date, name: "Lower A", weightUnit: "lbs", ...(notes ? { notes } : {}), exercises: [{ exerciseId: "Barbell_Squat", name: "Back Squat", sets: [185, 185, 185, 185].map((w) => ({ weight: w, reps: 5, rpe: 7 })) }, { exerciseId: "Dumbbell_Split_Squat", name: "Split Squat", sets: [40, 40, 40].map((w) => ({ weight: w, reps: 9 })) }, { exerciseId: "Cable_Row", name: "Cable Row", sets: [{ weight: 100, reps: 10 }, { weight: 100, reps: 10 }, { weight: 100, reps: 10 }] }] });

function merge(prev: Snapshot | null, tool: string, input: Record<string, unknown>, response: unknown, now = NOW): Snapshot {
  return mergeResponse(prev, { tool, input, response, session_id: SESSION, now, timezone: "America/Los_Angeles", server: "claude_ai_Tally_Workout" });
}

type Reads = { today?: unknown; history?: unknown[]; failToday?: boolean; skipWindow?: number; pastPlanned?: boolean };
/** The reads pre names, as the capture hook would merge them. */
function readAll(dir: string, o: Reads = {}): Snapshot {
  let s: Snapshot | null = null;
  s = merge(s, "get_planned_workout", { date: TODAY }, o.failToday ? [{ type: "text", text: "Error: timeout" }] : text(o.today ?? day(TODAY)));
  s = merge(s, "get_training_context", { historyWeeks: 2 }, text({ today: TODAY, futurePlanned: [{ date: TODAY, dayName: "Lower A", source: "mcp", exerciseCount: 3 }], weightUnit: "lbs", weightUnitSource: "settings" }));
  for (let i = 1; i <= 4; i++) {
    const d = addDays(TODAY, -i);
    s = merge(s, "get_planned_workout", { date: d }, text(d === "2026-10-12" ? day(d) : noDay(d)));
  }
  const sessions = o.history ?? [hit("2026-10-12", "h1")];
  W.forEach((w, i) => {
    if (i === o.skipWindow) return;
    s = merge(s!, "get_workout_history", w, text({ count: 0, sessions: sessions.filter((x: any) => x.date >= w.since && x.date <= w.until) }));
  });
  saveSnapshot(dir, s!);
  return s!;
}

/** 45 mornings of RMSSD HRV: a calm baseline, and 38 ms on each date in `off`. */
function hrv(dir: string, off: string[] = []): void {
  const recs = [];
  for (let i = 45; i >= 0; i--) {
    const date = addDays(TODAY, -i);
    recs.push({ date, source: "oura", observed_at: `${date}T06:30:00-07:00`, complete: true, hrv: { value_ms: off.includes(date) ? 38 : i % 5 === 0 ? 56 : 50, method: "rmssd" } });
  }
  writeJson(dir, "athlete/.cache/signals/oura.json", recs);
}

const pre = (dir: string, env = ENV) => cli(["today-brief", "--stage", "pre", "--now", NOW, "--root", dir], env);
const post = (dir: string, extra: string[] = [], env = ENV) => cli(["today-brief", "--stage", "post", "--now", NOW, ...extra, "--root", dir], env);

// ---------- pre ----------

test("pre: a run, the facts the skill read from files, and every Tally read in one list", () => {
  const dir = instance();
  writeFileSync(join(dir, "athlete/brief.md"), "# Brief\n\n## Preferences\n- likes front squats\n- rep range 8-12 on rows\n\n## History\nnone\n");
  writeFileSync(join(dir, "athlete/limits.md"), "# Injuries and limits\n\nThe coach plans around each line below in every plan. Say \"change my limits\" to change one.\n\n- Low back: hinges at most 6 sets a week and 135 lb. (since 2026-10-01)\n");
  writeJson(dir, `athlete/signals/${TODAY}.json`, { version: 1, date: TODAY, source: "chat", submitted_at: "2026-10-14T06:41:00-07:00", checkin: { overall: 3, pain: [{ region: "left-knee", score: 5 }, { region: "elbow", score: 2 }] } });
  mkdirSync(join(dir, "athlete/log"), { recursive: true });
  writeFileSync(join(dir, "athlete/log/2026-10.md"), "# Operation log 2026-10\n\n## 2026-10-13 07:00 · no-change\n- proposal for the next live session: swap split squats for step-ups\n- proposal for the next live session: ask about left knee\n\n## 2026-10-13 18:00 · today\n- proposal handled: no: ask about left knee\n");
  const r = pre(dir);
  assert.equal(r.code, 0, r.stderr);
  const j = r.json;
  assert.match(j.run_id, /^r-20261014-0800-[0-9a-f]{4}$/);
  assert.deepEqual(j.local, { date: TODAY, time: "08:00", weekday: "wed", timezone: "America/Los_Angeles", now: NOW });
  assert.equal(j.mode, "interactive");
  assert.equal(j.capabilities.opId, true);
  assert.deepEqual(j.pain_threshold, { value: 4, source: "coach.yaml" });
  assert.equal(j.limits_text, "- Low back: hinges at most 6 sets a week and 135 lb. (since 2026-10-01)");
  assert.equal(j.limits_text_truncated, false);
  assert.equal(j.limits, undefined, "0.3.0: no structured limits");
  assert.deepEqual(j.preferences, ["- likes front squats", "- rep range 8-12 on rows"]);
  assert.deepEqual(j.checkin_pain.map((p: any) => [p.region, p.score, p.handled]), [["left-knee", 5, false]]);
  assert.deepEqual(j.proposals.map((p: any) => p.text), ["swap split squats for step-ups"]);
  assert.equal(j.signals_refresh.refreshed, false);
  assert.equal(j.tools.toolsearch, "select:mcp__claude_ai_Tally_Workout__get_planned_workout,mcp__claude_ai_Tally_Workout__get_training_context,mcp__claude_ai_Tally_Workout__get_workout_history,mcp__claude_ai_Tally_Workout__update_planned_workout,mcp__claude_ai_Tally_Workout__plan_workout_day,mcp__claude_ai_Tally_Workout__search_exercises");
  assert.deepEqual(j.reads.slice(0, 6), [
    { tool: "get_planned_workout", args: { date: TODAY } },
    { tool: "get_training_context", args: { historyWeeks: 2 } },
    ...["2026-10-13", "2026-10-12", "2026-10-11", "2026-10-10"].map((d) => ({ tool: "get_planned_workout", args: { date: d } })),
  ]);
  // V7c: atomic 7-day windows over the 8 weeks.
  assert.deepEqual(j.reads.slice(6).map((x: any) => x.args), planWindows(addDays(TODAY, -56), TODAY, 7));
  const runFile = JSON.parse(readFileSync(join(dir, ".tmp/coach/today-run.json"), "utf8"));
  assert.equal(runFile.run_id, j.run_id);
  assert.equal(runFile.session_id, SESSION);
  assert.ok(existsSync(join(dir, `.tmp/coach/today-${j.run_id}-pre.json`)));
  assert.ok(existsSync(join(dir, ".tmp/coach/today-brief-pre.json")));
  // The pain handled line makes it handled.
  writeFileSync(join(dir, "athlete/log/2026-10.md"), readFileSync(join(dir, "athlete/log/2026-10.md"), "utf8") + "- pain handled: left-knee 2026-10-14T06:41:00-07:00\n");
  assert.equal(pre(dir).json.checkin_pain[0].handled, true);
});

test("pre: unattended outside the window exits 4 and starts no run; under the urgent stop, no wearable fetch", () => {
  const dir = instance();
  const out = cli(["today-brief", "--stage", "pre", "--now", "2026-10-14T20:00:00.000Z", "--root", dir], { env: { COACH_UNATTENDED: "1" } });
  assert.equal(out.code, 4);
  assert.equal(out.json.window.inside, false);
  assert.equal(existsSync(join(dir, ".tmp/coach/today-run.json")), false);
  writeJson(dir, "athlete/.urgent-stop", { version: 1, at: NOW, terms: ["chest pain"], sources: ["chat"] });
  const r = pre(dir);
  assert.equal(r.json.urgent.stopped, true);
  assert.equal(r.json.signals_refresh.status, "not_applicable");
});

test("pre skips the reads this session already made in the last 15 minutes", () => {
  const dir = instance();
  readAll(dir);
  const r = pre(dir);
  assert.deepEqual(r.json.reads, [{ tool: "get_training_context", args: { historyWeeks: 2 } }]);
});

// ---------- post ----------

test("post, a calm day: complete coverage, today's day, readiness with report facts, loads with the coach's own bounds; nothing to read", () => {
  const dir = instance();
  hrv(dir);
  const records = JSON.parse(readFileSync(join(dir, "athlete/.cache/signals/oura.json"), "utf8"));
  records[records.length - 1].temperature = { deviation_c: 0.12 };
  writeJson(dir, "athlete/.cache/signals/oura.json", records);
  pre(dir);
  readAll(dir);
  const r = post(dir);
  assert.equal(r.code, 0, r.stderr);
  const j = r.json;
  assert.deepEqual(j.coverage.history, { status: "complete" });
  assert.equal(j.coverage.safety_notes, "complete");
  assert.deepEqual(j.coverage.days, { [TODAY]: "complete", "2026-10-12": "complete" });
  assert.deepEqual(j.urgent, { stopped: false, stop: null, unknown: false });
  assert.equal(j.today_day.status, "found");
  assert.equal(j.today_day.version, `v-${TODAY}-1`);
  assert.equal(j.today_day.protected, false);
  assert.equal(j.already_adjusted.done, false);
  assert.equal(j.limits_check, undefined, "0.3.0: no limits check in post");
  assert.equal(j.readiness.decision, "none", JSON.stringify(j.readiness.decision_reasons) + JSON.stringify(j.readiness.report_facts));
  assert.equal(j.readiness.states.performance, "green");
  assert.match(j.readiness.report_facts.hrv, /^HRV \(rmssd\) 56 ms, z [0-9.]+ \(baseline/);
  assert.equal(j.loads.coverage.status, "complete");
  const squat = j.loads.own_load_bounds.find((b: any) => b.name === "Back Squat");
  assert.equal(squat.planned, 185);
  assert.equal(squat.last_top_set, 185);
  assert.ok(squat.cap >= 185 && squat.choices.includes(185));
  assert.equal(j.adjust.status, "not_applicable");
  assert.deepEqual(j.need_reads, []);
  // The compact output stays small (target under 2,000 tokens; about 4 characters a token).
  assert.ok(r.stdout.length / 4 < 2000, `${Math.round(r.stdout.length / 4)} tokens`);
  // post's file carries the run identity and the log line save --no-change needs.
  const file = JSON.parse(readFileSync(join(dir, `.tmp/coach/today-${j.run_id}-post.json`), "utf8"));
  assert.equal(file.session_id, SESSION);
  assert.match(file.log.readiness_line, /→ none$/);
  const diagnostic = JSON.parse(readFileSync(join(dir, ".tmp/coach/today-brief-post.json"), "utf8"));
  assert.deepEqual(diagnostic.readiness.inputs.records.at(-1).temperature, { deviation_c: 0.12 });
});

test("post on a trim day: the adjust draft is in post (tally_day), loads are held", () => {
  const dir = instance();
  hrv(dir, ["2026-10-12", "2026-10-13", TODAY]);
  pre(dir);
  readAll(dir);
  const j = post(dir).json;
  assert.equal(j.readiness.decision, "trim");
  assert.equal(j.readiness.report_facts.days_of_decline, 3);
  assert.equal(j.loads.status, "not_applicable");
  assert.match(j.loads.reason, /hold_progression/);
  assert.equal(j.adjust.decision, "trim");
  const split = j.adjust.tally_day.exercises.find((e: any) => e.name === "Split Squat");
  assert.equal(split.repsMax, 10, "the rep range is kept");
  assert.equal(split.perSide, true);
  assert.equal(split.notes, "slow down");
});

test("post: the urgent stop with a missing day; an ordinary rest day; a failed read reread once, then given up", () => {
  // The urgent stop, today not read: urgent and coverage still come back; no loads, no adjust.
  const a = instance();
  pre(a);
  writeJson(a, "athlete/.urgent-stop", { version: 1, at: NOW, terms: ["fainting"], sources: ["chat"] });
  let j = post(a).json;
  assert.equal(j.urgent.stopped, true);
  assert.equal(j.today_day.status, "missing");
  assert.ok(j.coverage.history.status);
  assert.match(j.loads.reason, /urgent stop/);
  assert.match(j.adjust.reason, /urgent stop/);
  // A rest day: found false.
  const b = instance();
  pre(b);
  readAll(b, { today: noDay(TODAY) });
  j = post(b).json;
  assert.equal(j.today_day.status, "none");
  assert.match(j.loads.reason, /rest day/);
  // A failed read: post asks for it once, then gives up (safety unknown means no write).
  const c = instance();
  pre(c);
  readAll(c, { failToday: true });
  j = post(c).json;
  assert.equal(j.today_day.status, "failed");
  assert.deepEqual(j.need_reads, [{ tool: "get_planned_workout", args: { date: TODAY } }]);
  assert.match(j.loads.reason, /today's day is failed/);
  j = post(c).json;
  assert.deepEqual(j.need_reads, []);
  assert.deepEqual(j.gave_up, [{ tool: "get_planned_workout", args: { date: TODAY } }]);
});

test("post on incomplete history: urgent unknown, the window to read in need_reads, no loads", () => {
  const dir = instance();
  pre(dir);
  readAll(dir, { skipWindow: 0 });
  const j = post(dir).json;
  assert.equal(j.coverage.safety_notes, "incomplete");
  assert.equal(j.urgent.unknown, true);
  assert.match(j.loads.reason, /safety is unknown/);
  assert.deepEqual(j.need_reads, planWindows(W[0].since, W[0].until, 7).map((args) => ({ tool: "get_workout_history", args })));
});

test("post: an urgent term in a recent note sets the stop (the scan's side effect, unchanged)", () => {
  const dir = instance();
  pre(dir);
  readAll(dir, { history: [hit("2026-10-12", "h1"), hit("2026-10-13", "h2", "chest pain on the last set")] });
  const j = post(dir).json;
  assert.deepEqual(j.safety_notes.urgent_terms, ["chest pain"]);
  assert.equal(j.urgent.stopped, true);
  assert.ok(existsSync(join(dir, "athlete/.urgent-stop")));
  assert.match(j.loads.reason, /urgent stop/);
});

test("post needs pre's run, for today", () => {
  const dir = instance();
  assert.equal(post(dir).json.error.code, "RUN_MISSING");
  writeJson(dir, ".tmp/coach/today-run.json", { run_id: "r-20261013-0800-abcd", session_id: SESSION, local_date: "2026-10-13", started_at: "2026-10-13T15:00:00Z" });
  assert.equal(post(dir).json.error.code, "RUN_STALE");
});

// ---------- today-write-prep ----------

function prep(dir: string, input: unknown, env = ENV) {
  return cli(["today-write-prep", "--input", writeJson(dir, ".tmp/coach/wp.json", input), "--now", NOW, "--root", dir], env);
}
const trimmed = (over: Record<string, unknown> = {}) => ({ date: TODAY, dayType: "lower", dayName: "Lower A", notes: "[coach] Adjusted for recovery (NA-REC-009)", exercises: [{ ...SQUAT, suggestedSets: 3 }, { ...SPLIT, suggestedSets: 2 }, ROW], weightUnit: "lbs", ...over });

test("write-prep: a trim on a coach-written day; update operations keep rep ranges, per-side and notes; the opId checks", () => {
  const dir = instance();
  readAll(dir);
  const r = prep(dir, { after: trimmed(), tool: "update_planned_workout", kind: "trim_session" });
  assert.equal(r.code, 0, r.stderr);
  const j = r.json;
  assert.equal(j.protected, false);
  assert.equal(j.classify.big, false);
  assert.equal(j.limits, undefined, "0.3.0: no limits check in write-prep");
  assert.equal(j.write.approved, undefined);
  const args = j.write.plain.args;
  assert.equal(args.expectedVersion, `v-${TODAY}-1`);
  assert.deepEqual(args.operations, [
    { op: "modify", target: { index: 0 }, fields: { suggestedSets: 3 } },
    { op: "modify", target: { index: 1 }, fields: { suggestedSets: 2 } },
  ]);
  assert.equal(args.notes, "[coach] Adjusted for recovery (NA-REC-009)");
  assert.equal(opIdProblem(args.opId, { tool: "update_planned_workout", args }), null);
  // plan_workout_day: the whole day, every Tally field kept.
  const p = prep(dir, { after: trimmed(), tool: "plan_workout_day", kind: "trim_session" }).json.write.plain.args;
  assert.deepEqual(p.exercises[1], { ...SPLIT, suggestedSets: 2 });
  assert.equal(p.replace, true);
  assert.equal(p.expectedVersion, `v-${TODAY}-1`);
  assert.equal(opIdProblem(p.opId, { tool: "plan_workout_day", args: p }), null);
});

test("write-prep: a protected day gives plain and approved, each with its own opId that passes", () => {
  const dir = instance();
  readAll(dir, { today: day(TODAY, { source: "builder" }) });
  const j = prep(dir, { after: trimmed(), tool: "update_planned_workout", kind: "trim_session" }).json;
  assert.equal(j.protected, true);
  for (const v of ["plain", "approved"]) assert.equal(opIdProblem(j.write[v].args.opId, j.write[v]), null, v);
  assert.equal(j.write.approved.args.overrideUserModified, true);
  assert.notEqual(j.write.plain.args.opId, j.write.approved.args.opId);
});

test("write-prep: an annotation changes notes only; a swap is written as the coach chose it (0.3.0: the coach checks the limits)", () => {
  const dir = instance();
  readAll(dir);
  const note = prep(dir, { after: { ...day(TODAY), notes: "[coach] Readiness note (NA-REC-008)" }, tool: "update_planned_workout", kind: "annotate" }).json;
  assert.deepEqual(note.write.plain.args.operations, [{ op: "modify", target: { index: 0 }, fields: { suggestedSets: 4 } }]);
  assert.equal(note.write.plain.args.notes, "[coach] Readiness note (NA-REC-008)");
  const badNote = prep(dir, { after: trimmed(), tool: "update_planned_workout", kind: "annotate" });
  assert.match(badNote.json.error.message, /annotate write changes notes only/);
  writeFileSync(join(dir, "athlete/limits.md"), "# Injuries and limits\n\n- Knee: no leg press for now. (since 2026-10-01)\n");
  const swap = prep(dir, { after: trimmed({ exercises: [{ exerciseId: "Leg_Press", name: "Leg Press", suggestedSets: 3, suggestedReps: 10 }, { ...SPLIT, suggestedSets: 2 }, ROW] }), tool: "update_planned_workout", kind: "trim_session" }).json;
  assert.equal(swap.limits, undefined);
  assert.deepEqual(swap.write.plain.args.operations.find((o: any) => o.op === "replace"), { op: "replace", target: { index: 0 }, exercise: { exerciseId: "Leg_Press", name: "Leg Press", suggestedSets: 3, suggestedReps: 10 } });
});

test("write-prep: a missing snapshot, a stale read and a malformed input fail with the fix", () => {
  const dir = instance();
  const none = prep(dir, { after: trimmed(), tool: "update_planned_workout", kind: "trim_session" });
  assert.equal(none.json.error.code, "NO_SNAPSHOT");
  assert.match(none.json.error.message, /get_planned_workout \{"date": "2026-10-14"\}/);
  let s: Snapshot | null = merge(null, "get_planned_workout", { date: TODAY }, text(day(TODAY)), "2026-10-14T14:30:00.000Z");
  saveSnapshot(dir, s);
  const stale = prep(dir, { after: trimmed(), tool: "update_planned_workout", kind: "trim_session" });
  assert.equal(stale.json.error.code, "SNAPSHOT_STALE");
  for (const bad of [{}, { after: trimmed(), tool: "delete_planned_workout", kind: "trim_session" }, { after: { date: TODAY, exercises: [] }, tool: "plan_workout_day", kind: "trim_session" }, { after: { date: TODAY, exercises: [{ name: "Squat", sets: [{ reps: 5 }] }] }, tool: "plan_workout_day", kind: "trim_session" }]) {
    const r = prep(dir, bad);
    assert.equal(r.json.error.code, "INPUT_ERROR", JSON.stringify(bad));
    assert.match(r.json.error.message, /expected \{after:/);
  }
  s = merge(null, "get_planned_workout", { date: TODAY }, text(day(TODAY)));
  saveSnapshot(dir, s);
  const other = prep(dir, { after: trimmed({ date: "2026-10-15" }), tool: "update_planned_workout", kind: "trim_session" });
  assert.match(other.json.error.message, /today only/);
});

test("classify --before-snapshot takes before and snapshotDay from one read", () => {
  const dir = instance();
  readAll(dir, { today: day(TODAY, { userModified: true }) });
  const r = cli(["classify", "--before-snapshot", TODAY, "--input", writeJson(dir, ".tmp/coach/c.json", { after: trimmed(), tool: "update_planned_workout", today: TODAY }), "--now", NOW, "--root", dir], ENV);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json.kinds.includes("override_user_day"), JSON.stringify(r.json));
  assert.equal(r.json.big, true);
});

// ---------- each logger end to end: pre, post, write-prep, save ----------

const GH = fakeGh();
const GIT = { PATH: `${GH}:${process.env.PATH}`, FAKE_VIS: "private", CLAUDE_CODE_SESSION_ID: SESSION };

test("logger tally end to end: pre, the reads, post, write-prep, save --no-change", () => {
  const dir = athleteRepo(remote(), "tally");
  const now = new Date().toISOString();
  const p = cliIn(dir, ["today-brief", "--stage", "pre"], GIT);
  assert.equal(p.code, 0, p.stderr);
  // The hook merges each read (here in-process, at the real time).
  let s: Snapshot | null = null;
  const today = p.json.local.date;
  const m = (tool: string, input: any, resp: unknown) => (s = mergeResponse(s, { tool, input, response: resp, session_id: SESSION, now, timezone: "America/Los_Angeles", server: "tally" }));
  for (const rd of p.json.reads) {
    if (rd.tool === "get_planned_workout") m(rd.tool, rd.args, text(rd.args.date === today ? day(today) : noDay(rd.args.date)));
    else if (rd.tool === "get_training_context") m(rd.tool, rd.args, text({ today, futurePlanned: [], weightUnit: "lbs", weightUnitSource: "settings" }));
    else m(rd.tool, rd.args, text({ count: 0, sessions: [] }));
  }
  saveSnapshot(dir, s!);
  const q = cliIn(dir, ["today-brief", "--stage", "post"], GIT);
  assert.equal(q.code, 0, q.stderr);
  assert.equal(q.json.coverage.history.status, "complete");
  assert.equal(q.json.today_day.status, "found");
  const w = cliIn(dir, ["today-write-prep", "--input", writeJson(dir, ".tmp/coach/wp.json", { after: { ...day(today), notes: "[coach] Readiness note (NA-REC-008)", found: undefined }, tool: "update_planned_workout", kind: "annotate" })], GIT);
  assert.equal(w.code, 0, w.stderr);
  assert.ok(w.json.write.plain.args.opId);
  const v = cliIn(dir, ["save", "--run", p.json.run_id, "--message", "today: none", "--no-change", "readiness is fine"], GIT);
  assert.equal(v.json.outcome, "published", JSON.stringify(v.json));
});

test("logger files end to end: no Tally reads, post reads plans/, write-prep gives the plans write input, save", () => {
  const dir = athleteRepo(remote(), "files");
  const p = cliIn(dir, ["today-brief", "--stage", "pre"], GIT);
  assert.equal(p.code, 0, p.stderr);
  assert.deepEqual(p.json.reads, []);
  const today = p.json.local.date;
  const wr = cliIn(dir, ["plans", "write", "--input", writeJson(dir, ".tmp/coach/d.json", { day: { date: today, dayName: "Lower A", exercises: [{ name: "Back Squat", sets: [185, 185, 185].map((w) => ({ weight: w, reps: 5 })) }] } })], GIT);
  assert.equal(wr.code, 0, wr.stderr);
  const q = cliIn(dir, ["today-brief", "--stage", "post"], GIT);
  assert.equal(q.json.coverage.history.status, "complete");
  assert.equal(q.json.today_day.status, "found");
  assert.equal(q.json.today_day.protected, false, "a files day is not protected by source");
  assert.deepEqual(q.json.need_reads, []);
  // V7b finding 5: a files exercise has no id; the write starts from post's write base.
  const base = JSON.parse(readFileSync(join(dir, q.json.today_day.write_base), "utf8"));
  const tally_day = { ...base, notes: "[coach] Adjusted for recovery", exercises: base.exercises.map((e: any) => ({ ...e, suggestedSets: 2 })) };
  const w2 = cliIn(dir, ["today-write-prep", "--input", writeJson(dir, ".tmp/coach/wp.json", { after: tally_day, tool: "plan_workout_day", kind: "trim_session" })], GIT);
  assert.equal(w2.code, 0, w2.stderr);
  assert.deepEqual(w2.json.write.plain, { command: "plans write", input: { tally_day } });
  const v = cliIn(dir, ["save", "--run", p.json.run_id, "--message", "today: none", "--no-change", "fine"], GIT);
  assert.equal(v.json.outcome, "published", JSON.stringify(v.json));
  assert.equal(v.json.mention.mention, false);
});

test("logger other end to end: post takes that tool's evidence; write-prep gives classify only; save", () => {
  const dir = athleteRepo(remote(), "other");
  const p = cliIn(dir, ["today-brief", "--stage", "pre"], GIT);
  assert.deepEqual(p.json.reads, []);
  const today = p.json.local.date;
  const bare = cliIn(dir, ["today-brief", "--stage", "post"], GIT).json;
  assert.equal(bare.urgent.unknown, true, "no evidence: safety unknown");
  assert.equal(bare.today_day.status, "missing");
  const evidence = { history: [{ date: today, notes: "good session", exercises: [{ name: "Back Squat" }] }], history_complete: true, today: { read: "ok", found: true, day: { dayName: "Lower A", exercises: [{ name: "Back Squat" }] } } };
  const q = cliIn(dir, ["today-brief", "--stage", "post", "--input", writeJson(dir, ".tmp/coach/ev.json", evidence)], GIT).json;
  assert.equal(q.urgent.unknown, false, JSON.stringify(q.safety_notes) + JSON.stringify(q.coverage));
  assert.equal(q.coverage.history.status, "complete");
  assert.equal(q.today_day.status, "found");
  assert.match(q.loads.reason, /logger other/);
  const before = { date: today, dayType: "lower", dayName: "Lower A", exercises: [SQUAT] };
  const w = cliIn(dir, ["today-write-prep", "--input", writeJson(dir, ".tmp/coach/wp.json", { before, after: { ...before, exercises: [{ ...SQUAT, suggestedSets: 3 }] }, tool: "plan_workout_day", kind: "trim_session" })], GIT).json;
  assert.equal(w.write, null);
  assert.equal(w.classify.big, false, JSON.stringify(w.classify));
  assert.equal(w.limits, undefined);
  const v = cliIn(dir, ["save", "--run", p.json.run_id, "--message", "today: none", "--no-change", "fine", "--sessions", "1"], GIT);
  assert.equal(v.json.outcome, "published", JSON.stringify(v.json));
});
