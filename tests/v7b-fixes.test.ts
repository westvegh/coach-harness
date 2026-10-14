// V7b fix round (the final review of main..1fcd9d5, 13 findings). Each test fails on 1fcd9d5; a
// race or an ordering runs both arrival orders. Finding 13 is in evals/scenarios/speed.test.ts.
// Made-up data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localDate } from "../engine/dates.ts";
import { historyCoverage, planWindows } from "../engine/history-windows.ts";
import { mergeResponse, saveSnapshot } from "../engine/snapshot.ts";
import { openProposals } from "../engine/today-brief.ts";
import type { Snapshot } from "../engine/types.ts";
import { cli, instance, REPO, writeJson } from "./e3/helpers.ts";
import { athleteRepo, cliIn, fakeGh, git, remote } from "./v7-helpers.ts";

const NOW = "2026-10-14T15:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const TODAY = "2026-10-14";
const SESSION = "s-v7b";
const ENV = { env: { CLAUDE_CODE_SESSION_ID: SESSION } };
const W = planWindows("2026-08-19", TODAY, 14);
const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];
const page = (sessions: unknown[], nextCursor?: string) => text({ count: sessions.length, sessions, ...(nextCursor ? { nextCursor } : {}) });
const sess = (date: string, id: string, notes?: string) => ({ id, date, name: `S ${id}`, weightUnit: "lbs", ...(notes ? { notes } : {}), exercises: [{ exerciseId: "Barbell_Squat", name: "Back Squat", sets: [{ weight: 185, reps: 5 }] }] });
function merge(prev: Snapshot | null, input: Record<string, unknown>, response: unknown, batch?: string | null, tool = "get_workout_history", now = NOW): Snapshot {
  return mergeResponse(prev, { tool, input, response, session_id: SESSION, now, timezone: "America/Los_Angeles", server: "tallymock", ...(batch !== undefined ? { batch } : {}) });
}
const cov = (s: Snapshot) => historyCoverage(s, W[0].since, W[0].until, NOW_MS);

const SQUAT = { exerciseId: "Barbell_Squat", name: "Back Squat", suggestedSets: 4, suggestedReps: 5, suggestedWeight: 185 };
const SPLIT = { exerciseId: "Dumbbell_Split_Squat", name: "Split Squat", suggestedSets: 3, suggestedReps: 8, repsMax: 10, perSide: true, notes: "slow down" };
const ROW = { exerciseId: "Cable_Row", name: "Cable Row", suggestedSets: 3, suggestedReps: 10 };
const day = (over: Record<string, unknown> = {}) => ({ date: TODAY, found: true, version: "v-1", updatedAt: "t0", source: "mcp", userModified: false, skipped: false, dayType: "lower", dayName: "Lower A", notes: "keep", exercises: [SQUAT, SPLIT, ROW], weightUnit: "lbs", weightUnitSource: "settings", ...over });
const prep = (dir: string, input: unknown) => cli(["today-write-prep", "--input", writeJson(dir, ".tmp/coach/wp.json", input), "--now", NOW, "--root", dir], ENV);
const limitsWith = (yaml: string) => `version: 1\npain_threshold: 4\nlimits:\n${yaml}`;

// ---------- 1: units ----------

test("finding 1: the limits check reads the final day in the unit the write sends (both directions)", () => {
  const cap = (value: number, unit: string) => limitsWith(`  - id: L-001\n    region: knee\n    rule: cap\n    patterns: [squat]\n    exercises: []\n    allow: []\n    max_load: { value: ${value}, unit: ${unit} }\n    source: athlete\n    since: 2026-10-01\n`);
  // coach.yaml lbs, the write in kg: 80 kg is about 176 lb, over a 100 lb cap.
  const a = instance();
  writeFileSync(join(a, "athlete/limits.yaml"), cap(100, "lbs"));
  saveSnapshot(a, merge(null, { date: TODAY }, text(day()), undefined, "get_planned_workout"));
  const kg = prep(a, { after: { date: TODAY, dayType: "lower", dayName: "Lower A", exercises: [{ ...SQUAT, suggestedWeight: 80 }, SPLIT, ROW], weightUnit: "kg" }, tool: "update_planned_workout", kind: "load_progression" }).json;
  assert.equal(kg.write.plain.args.weightUnit, "kg");
  assert.equal(kg.limits.ok, false, "80 kg is over a 100 lb cap");
  // coach.yaml kg, the write in lbs: 250 lb is over a 100 kg (about 220 lb) cap; 200 lb is under it.
  const b = instance((y) => y.replace(/units: lbs/, "units: kg"));
  writeFileSync(join(b, "athlete/limits.yaml"), cap(100, "kg"));
  saveSnapshot(b, merge(null, { date: TODAY }, text(day({ weightUnit: "kg" })), undefined, "get_planned_workout"));
  const over = prep(b, { after: { date: TODAY, dayType: "lower", dayName: "Lower A", exercises: [{ ...SQUAT, suggestedWeight: 250 }, SPLIT, ROW], weightUnit: "lbs" }, tool: "update_planned_workout", kind: "load_progression" }).json;
  assert.equal(over.limits.ok, false, "250 lb is over a 100 kg cap");
  const under = prep(b, { after: { date: TODAY, dayType: "lower", dayName: "Lower A", exercises: [{ ...SQUAT, suggestedWeight: 200 }, SPLIT, ROW], weightUnit: "lbs" }, tool: "update_planned_workout", kind: "load_progression" }).json;
  assert.equal(under.limits.ok, true, "200 lb is under a 100 kg cap");
});

// ---------- 2 and 12: generations and the page limit ----------

test("finding 2: a continuation sent with the refresh is the old read, in either arrival order; a later message's page is this generation's", () => {
  const start = () => {
    let s = merge(null, W[0], page([sess("2026-10-13", "old-first")], "c1"), "msg-1");
    s = merge(s, W[0], page([sess("2026-10-13", "new-first")], "c1"), "msg-2"); // the refresh, same cursor
    return s;
  };
  const oldTail = () => page([sess("2026-10-02", "old-tail")]);
  const newTail = () => page([sess("2026-10-03", "new-tail", "chest pain on the last set")]);
  const cont = { ...W[0], cursor: "c1" };
  // The new continuation first (a later message), then the old one (sent with the refresh).
  let a = merge(start(), cont, newTail(), "msg-3");
  a = merge(a, cont, oldTail(), "msg-2");
  // The old one first, then the new one.
  let b = merge(start(), cont, oldTail(), "msg-2");
  b = merge(b, cont, newTail(), "msg-3");
  for (const [name, s] of [["new then old", a], ["old then new", b]] as const) {
    assert.equal(cov(s).status, "complete", name);
    assert.deepEqual(s.history.map((x) => x.id), ["new-tail", "new-first"], name);
  }
  // A page whose message is not known is data, not coverage.
  const c = merge(start(), cont, newTail(), null);
  assert.notEqual(cov(c).status, "complete");
});

test("finding 2: the capture hook binds a history page to its message through the transcript", () => {
  const dir = instance();
  const transcript = join(dir, "transcript.jsonl");
  const asst = (id: string, tools: string[]) => JSON.stringify({ type: "assistant", message: { id, content: tools.map((t) => ({ type: "tool_use", id: t, name: "mcp__tallymock__get_workout_history", input: {} })) } });
  writeFileSync(transcript, [asst("msg-1", ["tu-1"]), asst("msg-2", ["tu-2", "tu-3"]), asst("msg-3", ["tu-4"])].join("\n") + "\n");
  const hook = (tu: string, input: unknown, response: unknown) => {
    const r = spawnSync(process.execPath, [join(REPO, ".claude/hooks/capture-reads.ts")], {
      input: JSON.stringify({ session_id: SESSION, hook_event_name: "PostToolUse", tool_name: "mcp__tallymock__get_workout_history", tool_use_id: tu, transcript_path: transcript, tool_input: input, tool_response: response }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, COACH_NOW: NOW },
    });
    assert.equal(r.status, 0, r.stderr);
  };
  hook("tu-1", W[0], page([sess("2026-10-13", "old-first")], "c1"));
  hook("tu-2", W[0], page([sess("2026-10-13", "new-first")], "c1")); // the refresh, in msg-2
  hook("tu-4", { ...W[0], cursor: "c1" }, page([sess("2026-10-03", "new-tail")])); // msg-3: lands first
  hook("tu-3", { ...W[0], cursor: "c1" }, page([sess("2026-10-02", "old-tail")])); // msg-2: the old read, late
  const snap = JSON.parse(readFileSync(join(dir, "athlete/.cache/snapshot.json"), "utf8"));
  assert.deepEqual(snap.history.map((x: any) => x.id), ["new-tail", "new-first"]);
  assert.equal(snap.history_orphans, 1);
});

test("finding 12: a replay of an earlier page keeps the page-limit failure until a new first page", () => {
  let s = merge(null, W[0], page([], "c0"));
  for (let i = 0; i < 10; i++) s = merge(s, { ...W[0], cursor: `c${i}` }, page([], i < 9 ? `c${i + 1}` : undefined));
  assert.equal(cov(s).status, "failed", "11 pages");
  s = merge(s, { ...W[0], cursor: "c0" }, page([sess("2026-10-05", "p2")])); // page 2 again, now terminal
  assert.equal(cov(s).status, "failed", "the replay does not clear it");
  s = merge(s, W[0], page([]));
  assert.equal(cov(s).status, "complete", "a new first page does");
});

// ---------- 9: proposals ----------

test("finding 9: a proposal made again after an earlier one was handled is open", () => {
  const dir = instance();
  mkdirSync(join(dir, "athlete/log"), { recursive: true });
  writeFileSync(join(dir, "athlete/log/2026-10.md"), "# Operation log 2026-10\n\n## 2026-10-10 07:00 · today\n- proposal for the next live session: ask about knee\n\n## 2026-10-11 07:00 · today\n- proposal handled: no: ask about knee\n\n## 2026-10-13 07:00 · today\n- proposal for the next live session: ask about knee\n");
  assert.deepEqual(openProposals(dir).map((p) => [p.text, p.entry]), [["ask about knee", "2026-10-13 07:00 · today"]]);
  writeFileSync(join(dir, "athlete/log/2026-10.md"), readFileSync(join(dir, "athlete/log/2026-10.md"), "utf8") + "\n## 2026-10-14 07:00 · today\n- proposal handled: yes: ask about knee\n");
  assert.deepEqual(openProposals(dir), []);
});

// ---------- 5, 6, 7: the write base ----------

function post(dir: string) {
  return cli(["today-brief", "--stage", "post", "--now", NOW, "--root", dir], ENV);
}
function readAll(dir: string, today = day()): void {
  let s: Snapshot | null = null;
  s = merge(s, { date: TODAY }, text(today), undefined, "get_planned_workout");
  s = merge(s, { historyWeeks: 2 }, text({ today: TODAY, futurePlanned: [], weightUnit: "lbs", weightUnitSource: "settings" }), undefined, "get_training_context");
  for (const d of ["2026-10-13", "2026-10-12", "2026-10-11", "2026-10-10"]) s = merge(s, { date: d }, text({ date: d, found: false, exercises: [] }), undefined, "get_planned_workout");
  for (const w of W) s = merge(s, w, page([]));
  saveSnapshot(dir, s!);
}

test("finding 6: post gives a lossless write base; edits and adjust's day keep ids, rep ranges, per-side and notes", () => {
  const dir = instance();
  cli(["today-brief", "--stage", "pre", "--now", NOW, "--root", dir], ENV);
  readAll(dir);
  const p = post(dir).json;
  const baseFile = p.today_day.write_base;
  assert.match(baseFile, /^\.tmp\/coach\/today-r-\d{8}-\d{4}-[0-9a-f]{4}-day\.json$/);
  const base = JSON.parse(readFileSync(join(dir, baseFile), "utf8"));
  assert.deepEqual(base.exercises, [SQUAT, SPLIT, ROW], "every Tally field kept");
  // annotate: notes only.
  const note = prep(dir, { edit: { notes: "keep\n[coach] Readiness note" }, tool: "update_planned_workout", kind: "annotate" }).json;
  assert.deepEqual(note.write.plain.args.operations, [{ op: "modify", target: { index: 0 }, fields: { suggestedSets: 4 } }]);
  assert.equal(note.write.plain.args.notes, "keep\n[coach] Readiness note");
  // a load change: only the weight.
  const load = prep(dir, { edit: { exercises: [{ index: 0, set: { suggestedWeight: 195 } }] }, tool: "update_planned_workout", kind: "load_progression" }).json;
  assert.deepEqual(load.write.plain.args.operations, [{ op: "modify", target: { index: 0 }, fields: { suggestedWeight: 195 } }]);
  // a whole-day write from the base keeps every field.
  const whole = prep(dir, { after: { ...base, exercises: base.exercises.map((e: any) => ({ ...e, suggestedSets: e.suggestedSets - 1 })) }, tool: "plan_workout_day", kind: "trim_session" }).json;
  assert.deepEqual(whole.write.plain.args.exercises[1], { ...SPLIT, suggestedSets: 2 });
  // a trim through an edit keeps the split squat's other fields.
  const trim = prep(dir, { edit: { exercises: [{ index: 1, set: { suggestedSets: 2 } }] }, tool: "plan_workout_day", kind: "trim_session" }).json;
  assert.deepEqual(trim.write.plain.args.exercises, [SQUAT, { ...SPLIT, suggestedSets: 2 }, ROW]);
});

test("finding 7: an annotation changes notes only: a changed unit, day name or exercise is refused", () => {
  const dir = instance();
  readAll(dir);
  const stored = { date: TODAY, dayType: "lower", dayName: "Lower A", exercises: [SQUAT, SPLIT, ROW], weightUnit: "lbs" };
  const ok = prep(dir, { after: { ...stored, notes: "keep\n[coach] note" }, tool: "plan_workout_day", kind: "annotate" }).json;
  assert.equal(ok.write.plain.args.weightUnit, "lbs");
  assert.equal(ok.write.plain.args.dayName, "Lower A");
  for (const [what, after] of [
    ["unit", { ...stored, weightUnit: "kg", notes: "x" }],
    ["day name", { ...stored, dayName: "Upper", notes: "x" }],
    ["exercises", { ...stored, exercises: [SQUAT, ROW], notes: "x" }],
  ] as const) {
    const r = prep(dir, { after, tool: "plan_workout_day", kind: "annotate" });
    assert.equal(r.json?.error?.code, "INPUT_ERROR", what);
    assert.match(r.json.error.message, /annotate write changes notes only/, what);
  }
  assert.match(prep(dir, { edit: { exercises: [{ index: 0, set: { suggestedSets: 1 } }] }, tool: "update_planned_workout", kind: "annotate" }).json.error.message, /notes only/);
});

const GH = fakeGh();
const GIT = { PATH: `${GH}:${process.env.PATH}`, FAKE_VIS: "private", CLAUDE_CODE_SESSION_ID: SESSION };

test("finding 5: a files day (exercises with no id) gets a prepared write, and the read-back shows it", () => {
  const dir = athleteRepo(remote(), "files");
  const p = cliIn(dir, ["today-brief", "--stage", "pre"], GIT).json;
  const today = p.local.date;
  cliIn(dir, ["plans", "write", "--input", writeJson(dir, ".tmp/coach/d.json", { day: { date: today, dayName: "Lower A", exercises: [{ name: "Back Squat", sets: [185, 185, 185, 185].map((w) => ({ weight: w, reps: 5 })) }, { name: "Cable Row", sets: [{ reps: 10 }, { reps: 10 }, { reps: 10 }] }] } })], GIT);
  const q = cliIn(dir, ["today-brief", "--stage", "post"], GIT).json;
  const base = JSON.parse(readFileSync(join(dir, q.today_day.write_base), "utf8"));
  assert.equal(base.exercises[0].exerciseId, "");
  const after = { ...base, notes: "[coach] Adjusted for recovery", exercises: base.exercises.map((e: any) => ({ ...e, suggestedSets: e.suggestedSets - 1 })) };
  const w = cliIn(dir, ["today-write-prep", "--input", writeJson(dir, ".tmp/coach/wp.json", { after, tool: "plan_workout_day", kind: "trim_session" })], GIT);
  assert.equal(w.code, 0, w.stdout + w.stderr);
  const wr = cliIn(dir, ["plans", "write", "--input", writeJson(dir, ".tmp/coach/today.json", w.json.write.plain.input)], GIT);
  assert.equal(wr.code, 0, wr.stdout);
  const back = cliIn(dir, ["plans", "read", "--week", today], GIT).json.days.find((d: any) => d.date === today);
  assert.deepEqual(back.exercises.map((e: any) => [e.name, e.sets.length]), [["Back Squat", 3], ["Cable Row", 2]]);
  // An annotation through an edit on a files day.
  const n = cliIn(dir, ["today-write-prep", "--input", writeJson(dir, ".tmp/coach/wp.json", { edit: { notes: "[coach] Readiness note" }, tool: "plan_workout_day", kind: "annotate" })], GIT);
  assert.equal(n.code, 0, n.stdout);
});

// ---------- 8, 10, 11: save ----------

const runId = (date: string, k: number) => `r-${date.replace(/-/g, "")}-0800-${(0xd000 + k).toString(16)}`;
const realToday = () => localDate(new Date().toISOString(), "America/Los_Angeles");
const postFile = (dir: string, run: string) =>
  writeJson(dir, `.tmp/coach/today-${run}-post.json`, { run_id: run, session_id: null, local_date: realToday(), computed_at: new Date().toISOString(), stage: "post", urgent: { stopped: false }, log: { readiness_line: "wearable green (x), subjective unknown (y), performance green (z) → none", rule_ids: [], decision: "none" } });
const logOf = (dir: string, date: string) => readFileSync(join(dir, "athlete/log", `${date.slice(0, 7)}.md`), "utf8");

test("finding 8: safety lines saved with --part safety stay when the run ends early, and do not block the run's own entry", () => {
  const dir = athleteRepo(remote());
  const run = runId(realToday(), 1);
  const safety = writeJson(dir, ".tmp/coach/safety.json", { lines: ["- pain handled: left-knee 2026-10-14T06:41:00-07:00"] });
  const s = cliIn(dir, ["save", "--run", run, "--part", "safety", "--message", "safety", "--input", safety], GIT);
  assert.equal(s.json.outcome, "published", s.stdout);
  // The already-adjusted exit runs no other save: the line is in the log, committed and pushed.
  assert.match(logOf(dir, realToday()), new RegExp(`- pain handled: left-knee .*\\n- run: ${run} safety\\n`));
  // A later save of the same run still writes its own entry, once.
  postFile(dir, run);
  const fin = cliIn(dir, ["save", "--run", run, "--message", "today", "--no-change", "fine"], GIT);
  assert.equal(fin.json.log.appended, true, fin.stdout);
  const again = cliIn(dir, ["save", "--run", run, "--part", "safety", "--message", "safety", "--input", safety], GIT);
  assert.equal(again.json.log.appended, false);
  const lines = logOf(dir, realToday()).split("\n");
  assert.equal(lines.filter((l) => l === `- run: ${run}`).length, 1);
  assert.equal(lines.filter((l) => l === `- run: ${run} safety`).length, 1);
});

test("finding 10: a no-change entry logged before midnight, push failed: the retry the next day publishes it, no post needed", () => {
  const r = remote();
  const dir = athleteRepo(r);
  const run = runId(realToday(), 2);
  postFile(dir, run);
  writeFileSync(join(r.bare, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(r.bare, "hooks/pre-receive"), 0o755);
  assert.equal(cliIn(dir, ["save", "--run", run, "--message", "today", "--no-change", "fine"], GIT).json.outcome, "not_published");
  rmSync(join(r.bare, "hooks/pre-receive"));
  rmSync(join(dir, `.tmp/coach/today-${run}-post.json`));
  const tomorrow = new Date(Date.now() + 24 * 3_600_000).toISOString();
  const retry = cliIn(dir, ["save", "--run", run, "--message", "today", "--no-change", "fine", "--now", tomorrow], GIT);
  assert.equal(retry.json?.outcome, "published", retry.stdout);
  assert.equal(retry.json.log.appended, false);
  assert.equal(git(r.bare, "rev-parse", "refs/heads/main"), git(dir, "rev-parse", "HEAD"));
});

test("finding 11: a commit one push URL took, then the remote moved on: published, not 'nothing reached the remote'", () => {
  const r = remote();
  const dir = athleteRepo(r);
  // The remote takes the push, then a cloud run adds a commit on top at once.
  writeFileSync(
    join(r.bare, "hooks/post-receive"),
    `#!/bin/sh\nread old new ref\nexport GIT_AUTHOR_NAME=c GIT_AUTHOR_EMAIL=c@example.com GIT_COMMITTER_NAME=c GIT_COMMITTER_EMAIL=c@example.com\nc=$(echo cloud | git commit-tree "$new^{tree}" -p "$new")\ngit update-ref refs/heads/main "$c"\n`,
  );
  chmodSync(join(r.bare, "hooks/post-receive"), 0o755);
  git(dir, "remote", "set-url", "--add", "--push", "origin", "git@github.com:alex/coach.git");
  git(dir, "remote", "set-url", "--add", "--push", "origin", "ssh://git@github.com/alex/coach.git");
  const lines = writeJson(dir, ".tmp/coach/s.json", { lines: ["- proposal for the next live session: x"] });
  const s = cliIn(dir, ["save", "--run", runId(realToday(), 3), "--message", "today", "--input", lines], GIT);
  assert.equal(s.json.published, true, s.stdout);
  assert.equal(s.json.outcome, "published", s.stdout);
  assert.doesNotMatch(logOf(dir, realToday()), /push skipped/);
});

// ---------- 3, 4, 8: the skill ----------

test("findings 3, 4 and 8 (as changed in V7c): a known urgent stop at once; pain after post's note scan and before safety unknown; one save marker per event", () => {
  const skill = readFileSync(join(REPO, ".claude/skills/today/SKILL.md"), "utf8");
  const step2 = skill.slice(skill.indexOf("2. **Safety, the reads"), skill.indexOf("3. **Today's day.**"));
  const at = (s: string) => {
    const i = step2.indexOf(s);
    assert.ok(i >= 0, s);
    return i;
  };
  assert.ok(at("pre's `urgent.stopped: true` at once, before any read") < at("**The reads.**"));
  assert.ok(at("a stop pre knows needs no read for this") < at("**The reads.**"));
  assert.ok(at("**The reads.**") < at("Then run `node engine/cli.ts today-brief --stage post`"));
  assert.ok(at("Then run `node engine/cli.ts today-brief --stage post`") < at("**Pain from today's check-in.**"), "pain waits for the note scan");
  assert.ok(at("**Pain from today's check-in.**") < at("**Pain notes**"));
  assert.ok(at("**Pain notes**") < at("**Safety unknown**"));
  assert.match(step2, /Tell it whether it may change planned days: only when post's `urgent\.unknown` is false and no urgent stop is set/);
  assert.match(step2, /node engine\/cli\.ts save --run <run_id> --part safety-<region>-<checkin_at> --message "safety <today>" --input \.tmp\/coach\/safety\.json/);
  assert.match(step2, /--part safety-<region>-note-<date>/);
  assert.match(step2, /With safety unknown \(below\) the trim is a training write, so it is not made/);
  assert.match(step2, /Never follow a `nextCursor`/);
  const safety = readFileSync(join(REPO, ".claude/skills/safety/SKILL.md"), "utf8");
  assert.match(safety, /This step's plan writes run only with complete coverage and no urgent stop\./);
  assert.doesNotMatch(skill, /`today_day` with your change/);
  assert.match(skill, /Never build `after` from the short `today_day` exercises/);
});

