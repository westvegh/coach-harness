// V6 (docs/build/briefs/V6-data-first-check-in.md): a data-first check-in, the coach
// recommends, a miss counts at its weight, Oura connect with the saved sign-in, and
// performance for sessions with no plan. Every fixture is made up; every temp folder is removed.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize } from "../adapters/signals/apple-health-shortcut/normalize.ts";
import { writeCheckin } from "../adapters/signals/checkin/write.ts";
import { fetchOura, needsSignIn, SIGN_IN_ERROR_CODES } from "../adapters/signals/oura/fetch.ts";
import { CoachError } from "../engine/errors.ts";
import { addDays } from "../engine/dates.ts";
import { suggestLoads, type SessionHistory } from "../engine/loads.ts";
import { readiness } from "../engine/readiness.ts";
import { judgeUnplanned, readinessForDate } from "../engine/readiness-date.ts";
import { loadSignals } from "../engine/signals.ts";
import { loadTaxonomy } from "../engine/taxonomy.ts";
import type { DayRecord, ExerciseEntry, HistorySet, Rules, SessionPerf, SnapshotSession } from "../engine/types.ts";
import { config, emptyDay, rules, snapDay, snapshot } from "./guard/fixtures.ts";

const REPO = new URL("..", import.meta.url).pathname;
const TODAY = "2026-10-14";
const NOW = "2026-10-14T07:00:00-07:00";
const TZ = "America/Los_Angeles";
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR", "COACH_NOW"].includes(k)));

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A temp athlete copy: coach.yaml (with edits), limits, methods linked; optionally a git repo. */
function copy(opts: { git?: boolean; edit?: (y: string) => string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-v6-"));
  temps.push(dir);
  const yaml = readFileSync(join(REPO, "coach.example.yaml"), "utf8");
  writeFileSync(join(dir, "coach.yaml"), opts.edit ? opts.edit(yaml) : yaml);
  mkdirSync(join(dir, "athlete/.cache"), { recursive: true });
  cpSync(join(REPO, "templates/athlete/limits.yaml"), join(dir, "athlete/limits.yaml"));
  symlinkSync(join(REPO, "methods"), join(dir, "methods"));
  if (opts.git) {
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, env: { ...process.env, ...GIT_ENV } });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "init");
  }
  return dir;
}

function cli(root: string, args: string[]) {
  const r = spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), ...args, "--root", root], { encoding: "utf8", env: { ...BASE_ENV, ...GIT_ENV } });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stderr: r.stderr };
}

function writeJson(dir: string, rel: string, v: unknown): void {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2));
}

const signalFile = (dir: string, date = TODAY) => join(dir, "athlete/signals", `${date}.json`);
const readSignal = (dir: string, date = TODAY) => JSON.parse(readFileSync(signalFile(dir, date), "utf8"));

// ---------- B.3: the check-in block, through every entry point ----------

const PAIN = [{ region: "left-knee", score: 3 }];
const VALID: [string, Record<string, unknown>][] = [
  ["overall alone", { overall: 3 }],
  ["overall with want and pain", { overall: 4, want_to_train: 2, pain: PAIN }],
  ["pain only", { pain: PAIN }],
  ["want only", { want_to_train: 2 }],
  ["the four scales (the Shortcut)", { sleep_quality: 3, energy: 4, soreness: 2, stress: 3 }],
  ["an empty pain list counts as a field", { pain: [] }],
];
const INVALID: [string, Record<string, unknown>, RegExp][] = [
  ["three scales only", { sleep_quality: 3, energy: 4, soreness: 2 }, /four scales go together/],
  ["overall with the four scales", { overall: 3, sleep_quality: 3, energy: 4, soreness: 2, stress: 3 }, /cannot both be set/],
  ["overall 0", { overall: 0 }, /overall/],
  ["overall 6", { overall: 6 }, /overall/],
  ["an empty block", {}, /needs at least one of/],
];

const fileWith = (checkin: Record<string, unknown>) => ({ version: 1, date: TODAY, source: "chat", submitted_at: "2026-10-14T06:41:12-07:00", checkin });
const recordWith = (subjective: Record<string, unknown>): DayRecord => ({ date: TODAY, source: "chat", observed_at: "2026-10-14T06:41:12-07:00", complete: false, subjective: subjective as DayRecord["subjective"] });
const run = (records: DayRecord[], sessions: SessionPerf[] = []) => readiness({ today: TODAY, now: NOW, tz: TZ, records, sessions, sleep_target_min: 480 });

describe("B.3: the check-in block through every entry point", () => {
  test("a daily file (the normalizer)", () => {
    for (const [what, c] of VALID) assert.ok(normalize(fileWith(c), { now: NOW })[0].subjective, what);
    for (const [what, c, why] of INVALID) assert.throws(() => normalize(fileWith(c), { now: NOW }), why, what);
  });

  test("a cached record (the loader): a bad block is a per-record warning", () => {
    const dir = copy();
    const list = [...VALID, ...INVALID].map(([, c], i) => ({ ...recordWith(c), source: `src${i}` }));
    writeJson(dir, "athlete/.cache/signals/test.json", list);
    const r = loadSignals({ root: dir, from: TODAY, to: TODAY, now: NOW });
    assert.equal(r.records.length, VALID.length, r.warnings.join("\n"));
    assert.equal(r.warnings.length, INVALID.length);
    for (const [, , why] of INVALID) assert.ok(r.warnings.some((w) => why.test(w)), String(why));
  });

  test("direct readiness input", () => {
    for (const [what, c] of VALID) assert.doesNotThrow(() => run([recordWith(c)]), what);
    for (const [what, c, why] of INVALID) {
      assert.throws(() => run([recordWith(c)]), (e: unknown) => e instanceof CoachError && e.code === "READINESS_INPUT" && why.test(e.message), what);
    }
  });

  test("the CLI", () => {
    const dir = copy();
    const ok = (args: string[]) => cli(dir, ["checkin", "--date", TODAY, "--now", NOW, ...args]);
    assert.equal(ok(["--overall", "3"]).code, 0);
    assert.equal(ok(["--overall", "4", "--want-to-train", "2", "--pain", "left-knee:3"]).code, 0);
    assert.equal(ok(["--pain", "left-knee:3"]).code, 0);
    assert.equal(ok(["--want-to-train", "2"]).code, 0);
    const bad = [
      ["--sleep-quality", "3", "--energy", "4", "--soreness", "2"],
      ["--overall", "3", "--sleep-quality", "3", "--energy", "4", "--soreness", "2", "--stress", "3"],
      ["--overall", "0"],
      ["--overall", "6"],
      [],
    ];
    for (const args of bad) {
      const r = ok(args);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    }
    assert.match(ok([]).stderr, /needs at least one of --overall, the four scales, --want-to-train, --pain or --urgent/);
  });

  test("--urgent alone writes and commits the stop, and no signal file", () => {
    const dir = copy({ git: true });
    const r = cli(dir, ["checkin", "--date", TODAY, "--now", NOW, "--urgent", "fainting"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.action, "unchanged");
    assert.ok(existsSync(join(dir, "athlete/.urgent-stop")));
    assert.equal(existsSync(signalFile(dir)), false);
    assert.equal(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim(), "urgent stop (checkin)");
  });
});

// ---------- B.3: the writer merge and clearing ----------

const at = (min: number) => `2026-10-14T06:${String(min).padStart(2, "0")}:00-07:00`;
const SCALES = { sleep_quality: 3 as const, energy: 4 as const, soreness: 2 as const, stress: 3 as const };

describe("B.3: the writer merges by group", () => {
  test("a rating replaces a rating in both directions; replaced names the earlier answer", () => {
    const dir = copy();
    writeCheckin({ root: dir, date: TODAY, answers: SCALES, now: at(10) });
    const r = writeCheckin({ root: dir, date: TODAY, answers: { overall: 2 }, now: at(20) });
    assert.deepEqual(r.replaced, { source: "chat", submitted_at: at(10) });
    assert.deepEqual(readSignal(dir).checkin, { overall: 2, source: "chat", submitted_at: at(20) });
    writeCheckin({ root: dir, date: TODAY, answers: SCALES, now: at(30) });
    assert.deepEqual(readSignal(dir).checkin, { ...SCALES, source: "chat", submitted_at: at(30) });
  });

  test("a pain-only answer after a Shortcut check-in keeps the scales", () => {
    const dir = copy();
    writeJson(dir, `athlete/signals/${TODAY}.json`, { version: 1, date: TODAY, source: "apple-health-shortcut", submitted_at: at(5), rhr: { bpm: 54 }, checkin: { ...SCALES, want_to_train: 4 } });
    const r = writeCheckin({ root: dir, date: TODAY, answers: { pain: PAIN }, now: at(15) });
    assert.deepEqual(r.replaced, { source: "apple-health-shortcut", submitted_at: at(5) });
    const f = readSignal(dir);
    assert.deepEqual(f.checkin, { ...SCALES, want_to_train: 4, pain: PAIN, source: "chat", submitted_at: at(15) });
    assert.deepEqual(f.rhr, { bpm: 54 });
    assert.equal(f.source, "apple-health-shortcut");
  });

  test("--pain none stores pain: [] and readiness reports no pain (daily file and loader)", () => {
    const dir = copy();
    assert.equal(cli(dir, ["checkin", "--date", TODAY, "--now", at(10), "--overall", "4", "--pain", "left-knee:6"]).code, 0);
    assert.deepEqual(run(loadSignals({ root: dir, from: TODAY, to: TODAY, now: NOW }).records).pain, [{ region: "left-knee", score: 6 }]);
    const r = cli(dir, ["checkin", "--date", TODAY, "--now", at(20), "--pain", "none"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readSignal(dir).checkin, { overall: 4, pain: [], source: "chat", submitted_at: at(20) });
    const loaded = loadSignals({ root: dir, from: TODAY, to: TODAY, now: NOW });
    assert.deepEqual(loaded.records[0].subjective!.pain, []);
    assert.deepEqual(run(loaded.records).pain, []);
  });

  test("--want-to-train none on a want-only block removes the block", () => {
    const dir = copy();
    writeCheckin({ root: dir, date: TODAY, answers: { want_to_train: 1 }, now: at(10) });
    const r = writeCheckin({ root: dir, date: TODAY, answers: { want_to_train: null }, now: at(20) });
    assert.equal(r.action, "merged");
    assert.equal(readSignal(dir).checkin, undefined);
    assert.deepEqual(loadSignals({ root: dir, from: TODAY, to: TODAY, now: NOW }).records, []);
  });

  test("a clear with no earlier answer writes nothing and says so", () => {
    const dir = copy();
    for (const answers of [{ pain: null }, { want_to_train: null }]) {
      const r = writeCheckin({ root: dir, date: TODAY, answers, now: at(10) });
      assert.equal(r.action, "unchanged");
      assert.match(r.note!, /nothing to clear/);
      assert.equal(existsSync(signalFile(dir)), false);
    }
    // A block with no want_to_train: nothing to clear either.
    writeCheckin({ root: dir, date: TODAY, answers: { overall: 3 }, now: at(10) });
    assert.equal(writeCheckin({ root: dir, date: TODAY, answers: { want_to_train: null }, now: at(20) }).action, "unchanged");
    assert.equal(readSignal(dir).checkin.submitted_at, at(10));
  });

  test("a clear in a file with wearable data keeps the wearable data", () => {
    const dir = copy();
    const sleep = { start_at: "2026-10-13T23:00:00-07:00", end_at: "2026-10-14T06:30:00-07:00", duration_min: 440 };
    writeJson(dir, `athlete/signals/${TODAY}.json`, { version: 1, date: TODAY, source: "apple-health-shortcut", submitted_at: at(35), sleep, hrv: { value_ms: 40 }, checkin: { want_to_train: 1 } });
    writeCheckin({ root: dir, date: TODAY, answers: { want_to_train: null }, now: at(40) });
    const f = readSignal(dir);
    assert.equal(f.checkin, undefined);
    assert.deepEqual([f.sleep, f.hrv], [sleep, { value_ms: 40 }]);
  });

  test("a same-day correction from aversion to just tired gives no recovery", () => {
    const dir = copy();
    writeCheckin({ root: dir, date: TODAY, answers: { overall: 3, want_to_train: 1 }, now: at(10) });
    const load = () => run(loadSignals({ root: dir, from: TODAY, to: TODAY, now: NOW }).records);
    assert.equal(load().decision, "recovery");
    writeCheckin({ root: dir, date: TODAY, answers: { want_to_train: null }, now: at(20) });
    const r = load();
    assert.equal(r.aversion, false);
    assert.notEqual(r.decision, "recovery");
    assert.equal(r.subjective.state, "green");
  });
});

// ---------- B.3: the state ----------

test("B.3 state: overall 1 red, 2 amber, 3 and 5 green; no rating is unknown and still reports pain and want", () => {
  const cases: [number, string, RegExp][] = [
    [1, "red", /feels wrecked \(1\/5\)/],
    [2, "amber", /feels run down \(2\/5\)/],
    [3, "green", /feels okay \(3\/5\)/],
    [5, "green", /feels great \(5\/5\)/],
  ];
  for (const [n, state, why] of cases) {
    const r = run([recordWith({ overall: n })]);
    assert.equal(r.subjective.state, state, String(n));
    assert.match(r.subjective.reasons.join(" "), why);
  }
  const r = run([recordWith({ want_to_train: 2, pain: PAIN })]);
  assert.equal(r.subjective.state, "unknown");
  assert.match(r.subjective.reasons.join(" "), /no rating today/);
  assert.match(r.subjective.reasons.join(" "), /want to train 2\/5/);
  assert.deepEqual(r.pain, PAIN);
  assert.match(run([]).subjective.reasons.join(" "), /no check-in for today/);
});

// ---------- B.3: decisions ----------

/** 45 calm mornings (RMSSD HRV 50, 56 every fifth day; RHR 55 ± 1), the last `off` of them (today included) at 38 ms. */
function mornings(off: number): DayRecord[] {
  return Array.from({ length: 46 }, (_, k) => {
    const i = 45 - k;
    const date = addDays(TODAY, -i);
    return { date, source: "oura", observed_at: `${date}T06:30:00-07:00`, complete: true, hrv: { value_ms: i < off ? 38 : i % 5 === 0 ? 56 : 50, method: "rmssd" as const }, rhr: { bpm: 55 + ((i % 3) - 1) } };
  });
}
const sessionPerf = (date: string, bad: boolean): SessionPerf => ({ date, planned_sets: 20, completed_sets: 20, reps_shortfall_ratio: bad ? 0.25 : 0, top_set_dropped: false });
const AMBER_PERF = [sessionPerf(addDays(TODAY, -1), true)];
const RED_PERF = [sessionPerf(addDays(TODAY, -1), true), sessionPerf(addDays(TODAY, -3), true)];

describe("B.3 decisions", () => {
  test("a short-pattern day with amber performance: no rating → trim; overall 1 → recovery; overall 3 → trim", () => {
    const base = mornings(3);
    const none = run(base, AMBER_PERF);
    assert.equal(none.pattern.days_of_decline, 3);
    assert.equal(none.performance.state, "amber");
    assert.equal(none.subjective.state, "unknown");
    assert.equal(none.decision, "trim");
    assert.equal(run([...base, recordWith({ overall: 1 })], AMBER_PERF).decision, "recovery");
    assert.equal(run([...base, recordWith({ overall: 3 })], AMBER_PERF).decision, "trim");
  });

  test("a long-pattern day with overall 2: amber performance → propose_deload; red performance → recovery with deload_signal", () => {
    const base = [...mornings(7), recordWith({ overall: 2 })];
    const amber = run(base, AMBER_PERF);
    assert.equal(amber.pattern.long, true);
    assert.equal(amber.decision, "propose_deload");
    const red = run(base, RED_PERF);
    assert.equal(red.performance.state, "red");
    assert.equal(red.decision, "recovery");
    assert.equal(red.deload_signal, true);
  });
});

// ---------- A.4: the readiness reasons carry the values ----------

test("A.4: the wearable reasons give the HRV and resting HR values, not only the z-score", () => {
  const r = run(mornings(1));
  const text = r.wearable.reasons.join("; ");
  assert.match(text, /HRV \(rmssd\) 38 ms, z -?\d+(\.\d+)? \(baseline \d+(\.\d+)? ± \d+(\.\d+)?\)/);
  assert.match(text, /RHR 5\d bpm, z -?\d+(\.\d+)? \(baseline/);
});

// ---------- J: a miss counts at the weight it happened ----------

const tax = loadTaxonomy({ localPath: null });
const capRules: Rules = { pack: "t", version: 1, rules: [{ id: "NA-PROG-003", text: "cap", kind: "policy", severity: "hard", check: { type: "top_set_jump_max", value: 0.1 } }] };
const ROW: ExerciseEntry = { name: "Seated Cable Row", sets: Array.from({ length: 3 }, () => ({ reps: 10 })) };
const sets = (weight: number | null, reps: number[], rpe: number | null = 8): HistorySet[] => reps.map((r) => ({ weight, reps: r, rpe }));
type Logged = [string, HistorySet[], ("lbs" | "kg")?];
const rowHistory = (entries: Logged[]): SessionHistory =>
  entries.map(([date, s, unit]) => ({ date, weightUnit: unit ?? "lbs", exercises: [{ exerciseId: "seated_cable_row", name: "Seated Cable Row", muscle: "Lats", sets: s }] }));
const suggest = (entries: Logged[], ex: ExerciseEntry = ROW, opts: Parameters<typeof suggestLoads>[4] = { tax }) => suggestLoads([ex], rowHistory(entries), capRules, "lbs", opts)[0];

describe("J: loads", () => {
  test("a miss at 60, then a miss at 55 → 55 (the base said 50)", () => {
    const s = suggest([["2026-10-12", sets(55, [12, 12, 9])], ["2026-10-08", sets(60, [10, 8, 8])]]);
    assert.equal(s.suggestedWeight, 55);
    assert.match(s.reason, /missed at 55 after a miss at 60 lbs: repeat 55/);
  });

  test("a miss at 55, then a miss at 60 → the drop from 60; one miss → repeat; a hit → the step up", () => {
    assert.equal(suggest([["2026-10-12", sets(60, [10, 8, 8])], ["2026-10-08", sets(55, [12, 12, 9])]]).suggestedWeight, 55); // 57 rounds down to 55
    assert.match(suggest([["2026-10-12", sets(60, [10, 8, 8])], ["2026-10-08", sets(55, [12, 12, 9])]]).reason, /twice in a row[^\n]*−5%/);
    assert.equal(suggest([["2026-10-12", sets(55, [12, 12, 9])], ["2026-10-08", sets(55, [10, 10, 10])]]).suggestedWeight, 55);
    assert.equal(suggest([["2026-10-12", sets(60, [10, 10, 10])]]).suggestedWeight, 65);
  });

  test("mixed units: equal after conversion → the drop; lighter after conversion → repeat", () => {
    // 25 kg is 55 lbs with Tally's conversion.
    const equal = suggest([["2026-10-12", sets(55, [12, 12, 9])], ["2026-10-08", sets(25, [10, 8, 8]), "kg"]]);
    assert.equal(equal.suggestedWeight, 50);
    // 27.5 kg is 61 lbs: the last session (55 lbs) is lighter.
    const lighter = suggest([["2026-10-12", sets(55, [12, 12, 9])], ["2026-10-08", sets(27.5, [10, 8, 8]), "kg"]]);
    assert.equal(lighter.suggestedWeight, 55);
  });

  test("an RPE-only miss at a lighter weight → repeat; a session with no usable weight is skipped", () => {
    assert.equal(suggest([["2026-10-12", sets(55, [10, 10, 10], 9.5)], ["2026-10-08", sets(60, [10, 8, 8])]]).suggestedWeight, 55);
    assert.equal(suggest([["2026-10-12", sets(55, [12, 12, 9])], ["2026-10-10", sets(null, [10, 10, 10])], ["2026-10-08", sets(60, [10, 8, 8])]]).suggestedWeight, 55);
  });

  test("bodyweight-only history → no suggestion; a cluster with the same pattern → the cluster rule", () => {
    const bw = suggest([["2026-10-12", sets(null, [10, 8, 8])], ["2026-10-08", sets(null, [10, 8, 8])]]);
    assert.equal(bw.suggestedWeight, undefined);
    assert.match(bw.reason, /no logged weighted set/);
    const clusters = [{ name: "Seated Cable Row", mini_sets: 3, reps: 10, rm: 12 }];
    const cl = suggest([["2026-10-12", sets(55, [10, 9, 9])], ["2026-10-08", sets(60, [10, 8, 8])]], ROW, { tax, clusters, date: TODAY });
    assert.equal(cl.suggestedWeight, 55);
    assert.match(cl.reason, /^cluster: 28 of 30 reps at 55 lbs on 2026-10-12 → repeat/);
  });
});

// ---------- L: performance for a session with no plan ----------

const COVERAGE = { captured_at: NOW, complete: true, since: "2026-08-19", until: TODAY };
const squat = (date: string, weight: number, reps: number[], rpe: number | null = 8, extra: HistorySet[] = []): SnapshotSession => ({
  date,
  weightUnit: "lbs",
  exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", muscle: "Quads", sets: [...extra, ...reps.map((r) => ({ weight, reps: r, rpe }))] }],
});
const forDate = (dir: string, snap: ReturnType<typeof snapshot>) => readinessForDate({ root: dir, date: TODAY, now: NOW, config: config(), rules: rules(), snapshot: snap });

describe("L: a session with no plan", () => {
  test("read with no plan and a lower top set than last time → amber, top set dropped", () => {
    const dir = copy();
    const snap = snapshot({ "2026-10-13": emptyDay() }, { history: [squat("2026-10-13", 205, [5, 5, 5]), squat("2026-10-09", 225, [5, 5, 5])], history_coverage: COVERAGE });
    const r = forDate(dir, snap);
    assert.equal(r.performance.state, "amber", r.performance.reasons.join("; "));
    assert.match(r.performance.reasons.join(" "), /top set dropped/);
    assert.equal(r.inputs.sessions_judged[0].plan, "none");
    assert.deepEqual(r.inputs.sessions[0], { date: "2026-10-13", planned_sets: 3, completed_sets: 3, reps_shortfall_ratio: 0, rpe_drift: 0, top_set_dropped: true });
  });

  test("the same top set → green; fewer reps at the same weight → dropped; warm-ups left out", () => {
    const dir = copy();
    const same = snapshot({ "2026-10-13": emptyDay() }, { history: [squat("2026-10-13", 225, [5, 5, 5], 8, [{ weight: 315, reps: 1, rpe: null, warmup: true }]), squat("2026-10-09", 225, [5, 5, 5])], history_coverage: COVERAGE });
    assert.equal(forDate(dir, same).performance.state, "green");
    const fewer = judgeUnplanned(squat("2026-10-13", 225, [4, 4, 4], 9), [squat("2026-10-09", 225, [5, 5, 5], 8)]);
    assert.equal(fewer.perf?.top_set_dropped, true);
    assert.equal(fewer.perf?.rpe_drift, 1);
  });

  test("an exercise with no earlier session is not judged; a date not read is unknown as today", () => {
    const dir = copy();
    const noEarlier = forDate(dir, snapshot({ "2026-10-13": emptyDay() }, { history: [squat("2026-10-13", 205, [5, 5, 5])], history_coverage: COVERAGE }));
    assert.equal(noEarlier.performance.state, "unknown");
    assert.match(noEarlier.performance.reasons.join(" "), /session 2026-10-13 not judged: no plan and no earlier session to compare/);
    const notRead = forDate(dir, snapshot({}, { history: [squat("2026-10-13", 205, [5, 5, 5]), squat("2026-10-09", 225, [5, 5, 5])], history_coverage: COVERAGE }));
    assert.equal(notRead.performance.state, "unknown");
    assert.match(notRead.performance.reasons.join(" "), /no plan for 2026-10-13 in the snapshot: read it with get_planned_workout/);
    // An earlier session older than 28 days does not count.
    const old = judgeUnplanned(squat("2026-10-13", 205, [5, 5, 5]), [squat("2026-09-14", 225, [5, 5, 5])]);
    assert.equal(old.perf, undefined);
  });

  test("a planned session is still judged against its own plan", () => {
    const dir = copy();
    const plan = { exerciseId: "Barbell_Squat", name: "Squat", suggestedSets: 3, suggestedReps: 5, suggestedWeight: 225, rpe: 8 };
    const snap = snapshot({ "2026-10-13": snapDay("2026-10-13", { exercises: [plan] }) }, { history: [squat("2026-10-13", 225, [5, 5, 5]), squat("2026-10-09", 245, [5, 5, 5])], history_coverage: COVERAGE });
    const r = forDate(dir, snap);
    assert.equal(r.performance.state, "green");
    assert.equal(r.inputs.sessions_judged[0].plan, "found");
  });

  test("the files logger: a logged row with no planned columns is a session with no plan", () => {
    const dir = copy({ edit: (y) => y.replace(/^logger: tally/m, "logger: files") });
    const header = "date,day,exercise,sets,reps,load,unit,notes,done_sets,done_reps,done_load,felt\n";
    mkdirSync(join(dir, "plans"), { recursive: true });
    writeFileSync(join(dir, "plans", "2026-W41.csv"), `${header}2026-10-09,Lower,Squat,3,5,225,lbs,,3,5,225,\n`);
    writeFileSync(join(dir, "plans", "2026-W42.csv"), `${header}2026-10-13,,Squat,,,,,,3,5,205,\n`);
    const r = cli(dir, ["readiness", "--date", TODAY, "--now", NOW]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.performance.state, "amber", JSON.stringify(r.json.performance));
    assert.match(r.json.performance.reasons.join(" "), /top set dropped/);
    assert.equal(r.json.inputs.sessions_judged[0].plan, "none");
  });
});

// ---------- K: Oura connect with the saved sign-in ----------

describe("K: the fetch's sign-in codes", () => {
  test("the sign-in codes, and nothing else, ask for a sign-in", () => {
    assert.deepEqual([...SIGN_IN_ERROR_CODES].sort(), ["OURA_NOT_AUTHORIZED", "OURA_REAUTH", "OURA_TOKEN_STORE", "OURA_UNAUTHORIZED"]);
    for (const c of ["OURA_NOT_CONFIGURED", "OURA_NETWORK", "OURA_TIMEOUT", "OURA_RATE_LIMIT", "OURA_HTTP", "OURA_FORBIDDEN", "OURA_KEYCHAIN", "OURA_LOCKED", "USAGE", "INTERNAL"]) assert.equal(needsSignIn(c), false, c);
  });

  test("the fetch's real errors map: no tokens and a 401 ask for a sign-in; a rate limit does not", async () => {
    const dir = copy();
    const store = (tokens: string | null) => {
      const m = new Map<string, string>([["client_id", "id"], ["client_secret", "secret"]]);
      if (tokens) m.set("tokens", tokens);
      return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) };
    };
    const lock = { dir: join(dir, ".lock") };
    const valid = JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 3600_000, token_type: "bearer", saved_at: new Date().toISOString() });
    const code = async (s: ReturnType<typeof store>, status: number) => {
      try {
        await fetchOura({ root: dir, days: 3, tz: TZ, deps: { store: s, lock, fetch: (async () => new Response("{}", { status })) as typeof fetch } as never });
        return "ok";
      } catch (e) {
        return (e as CoachError).code;
      }
    };
    const none = await code(store(null), 200);
    assert.equal(none, "OURA_NOT_AUTHORIZED");
    assert.equal(needsSignIn(none), true);
    const unauthorized = await code(store(valid), 401);
    assert.equal(unauthorized, "OURA_UNAUTHORIZED");
    assert.equal(needsSignIn(unauthorized), true);
    const limited = await code(store(valid), 429);
    assert.equal(limited, "OURA_RATE_LIMIT");
    assert.equal(needsSignIn(limited), false);
  });

  test("the CLI prints sign_in_needed with the error (no network)", () => {
    const r = spawnSync(process.execPath, [join(REPO, "adapters/signals/oura/fetch.ts"), "--days", "0", "--tz", TZ], { encoding: "utf8", env: BASE_ENV });
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error.code, "USAGE");
    assert.equal(out.sign_in_needed, false);
  });
});

// ---------- D: the hook ----------

function sessionContext(root: string): string {
  const r = spawnSync(process.execPath, [join(REPO, ".claude/hooks/session-context.ts")], {
    input: JSON.stringify({ session_id: "s", hook_event_name: "SessionStart", source: "startup" }),
    encoding: "utf8",
    env: { ...BASE_ENV, ...GIT_ENV, CLAUDE_PROJECT_DIR: root, COACH_NOW: NOW },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
}

test("D: today's check-in is never in the due line", () => {
  const dir = copy({ git: true });
  // With a check-in file and without one.
  assert.doesNotMatch(sessionContext(dir), /check-in/);
  writeJson(dir, `athlete/signals/${TODAY}.json`, fileWith({ overall: 3 }));
  const ctx = sessionContext(dir);
  assert.match(ctx, /Due: |Nothing is due\./);
  assert.doesNotMatch(ctx, /check-in/);
});

// ---------- skills and CLAUDE.md (A, B, C, I) ----------

const skill = (name: string) => readFileSync(join(REPO, ".claude/skills", name, "SKILL.md"), "utf8");
const claudeMd = readFileSync(join(REPO, "CLAUDE.md"), "utf8");
/** The numbered steps of a skill's "## Steps" section. */
function steps(name: string): Map<number, string> {
  const body = skill(name);
  const sec = body.slice(body.indexOf("## Steps"), body.indexOf("\n## ", body.indexOf("## Steps") + 3));
  const out = new Map<number, string>();
  const parts = sec.split(/\n(?=\d+\. \*\*)/);
  for (const p of parts) {
    const m = /^(\d+)\. /.exec(p);
    if (m) out.set(Number(m[1]), p);
  }
  return out;
}
const inOrder = (text: string, parts: string[], what: string) => {
  let at = -1;
  for (const p of parts) {
    const i = text.indexOf(p, at + 1);
    assert.ok(i > at, `${what}: "${p}" in order`);
    at = i;
  }
};

describe("C: the check-in skill", () => {
  const ci = skill("check-in");
  test("no four-scale form and no daily warning-sign question; records only clear words; runs today", () => {
    assert.doesNotMatch(ci, /Sleep quality: "1 very bad|four scales and the want-to-train item|Ask about pain directly, every time|Any of these now\? A\) chest pain/);
    assert.doesNotMatch(ci, /Adjust today's session now\?/);
    const record = steps("check-in").get(3)!;
    assert.match(record, /Record only what they said, and only what is clear\. Ask nothing else\./);
    assert.match(record, /Unclear words \(for example "slept badly", "a bit tired"\): record nothing/);
    assert.match(record, /"wrecked" 1, "run down" 2, "okay" or "fine" 3, "good" 4, "great" 5/);
    assert.match(steps("check-in").get(6)!, /Run the `today` skill/);
  });
  test("keeps the pain follow-up options and --urgent", () => {
    const record = steps("check-in").get(3)!;
    for (const q of ["Where? A) knee", "Which side? A) left", "How bad, from 0 (none) to 10 (worst)? A) 0-1"]) assert.ok(record.includes(q), q);
    assert.match(steps("check-in").get(4)!, /\[--urgent <term>,\.\.\.\]/);
    assert.match(steps("check-in").get(4)!, /\[--overall <n>\]/);
  });
});

describe("A, B, I: the today skill", () => {
  const t = skill("today");
  test("A.5: urgent, then pain, then the already-adjusted check, then proposals", () => {
    inOrder(t.slice(t.indexOf("## Steps")), ["**Urgent stop**", "**Pain from today's check-in.**", "Already adjusted?", "**Proposals for the live session**"], "today");
  });
  test("A.6: pain from today's check-in goes to safety, once per check-in", () => {
    const s2 = steps("today").get(2)!;
    assert.match(s2, /node engine\/cli\.ts signals --from <today> --to <today>/);
    assert.match(s2, /"- pain handled: <region> <checkin_at>"/);
    assert.match(s2, /Interactive: run the `safety` skill for that region now, before anything else/);
    assert.match(s2, /Unattended: avoid loading the region today[^\n]*"- proposal for the next live session: ask about <region>"/);
  });
  test("A.3: the urgent stop is an exception to the report", () => {
    assert.match(steps("today").get(2)!, /Under the urgent stop there is no report format: no verdict first, no line limit, no closing invitation, and no "How do you feel today\?" question\./);
  });
  test("A.7: already adjusted, interactive: a report only, with either logger", () => {
    const s3 = steps("today").get(3)!;
    assert.match(s3, /\*\*Already adjusted, interactive: a report only\*\* \(with any logger: the `oplog` check above, or the files-logger `\[coach\]` line check\)/);
    assert.match(s3, /Skip the "How do you feel today\?" question, the proposals, every plan write, the no-change log entry, `tally-mention`, the commit and the push\. The report changes no tracked file\./);
    assert.match(t, /Step 3: read today with `node engine\/cli\.ts plans read --week <today>`[^\n]*interactive, give the report only/);
  });
  test("B.1 and B.2: one question, on a trim with no rating, interactive only, once", () => {
    const s6 = steps("today").get(6)!;
    assert.match(s6, /\*\*The one question\*\* \(interactive only\)\. Ask it only when `decision` is `trim` and there is no rating for today \(`subjective\.state` is `unknown`\)/);
    assert.match(s6, /not when the decision is already `recovery`, not on `none` or `note` days, not when the wearable is missing or calibrating, not on a rest day/);
    assert.match(s6, /"How do you feel today\?", and four options: "Good", "Okay", "Run down", "Wrecked"/);
    assert.match(s6, /node engine\/cli\.ts checkin --date <today> --overall <n>/);
    assert.match(s6, /Do not ask again after the rerun\./);
  });
  test("A.2: the report order and the closing line", () => {
    const s10 = steps("today").get(10)!;
    inOrder(s10, ["**The verdict, first:**", "**Why**", "**Today's session**", "**The closing line**", "`openInTally`"], "today step 10");
    assert.match(s10, /"Train as planned"[^\n]*"Train, a little lighter"[^\n]*"Recovery day"[^\n]*"Rest day"/);
    assert.match(s10, /"Tell me if anything hurts or feels off, or if you want to change something\."/);
    assert.match(s10, /"Tell me if anything hurts, or if your sleep, food or drinks were different this week\."/);
    assert.match(s10, /"No recovery data is connected\. Say 'connect my Oura' or 'connect my Apple Watch' to add it\."/);
    assert.doesNotMatch(t, /Sleep, eating or drinking different this week\? A\)/);
  });
  test("I.2: consent is one question for the whole list", () => {
    const s7 = steps("today").get(7)!;
    assert.match(s7, /"Apply these\? A\) Yes, B\) Change something, C\) Not now"/);
    assert.match(s7, /A: write the whole list\. For a protected day, pass `overrideUserModified: true` with `expectedVersion`, for this approved write only\./);
    assert.match(s7, /B: the athlete says what to change in their own words\. Apply nothing yet\. Show the revised list and ask the same question again\./);
    assert.match(s7, /C: write nothing\. Log "- proposal for the next live session: <the list>"\./);
    assert.match(s7, /Unattended: a protected day gets no write at all \(no override, no note\)/);
    assert.doesNotMatch(t, /Unattended: annotate only/);
  });
  test("I.1 and I.3: the coach recommends and may choose its own load within the bounds", () => {
    assert.match(steps("today").get(7)!, /Never ask the athlete to choose between the coach's own options \(no "Which weight today\? 40 \/ 45 \/ 50"\)/);
    const s8 = steps("today").get(8)!;
    assert.match(s8, /a weight the athlete logged for that exercise in the last 4 weeks, or today's planned weight/);
    assert.match(s8, /not above the higher of the engine's suggestion and the last logged top-set weight/);
  });
});

test("I.1 and I.2 in CLAUDE.md", () => {
  assert.match(claudeMd, /\*\*The coach recommends\.\*\* When the coach has a training-prescription choice to make[^\n]*It never asks the athlete to choose between its own options for a prescription/);
  assert.match(claudeMd, /"Apply these\? A\) Yes, B\) Change something, C\) Not now"/);
  assert.match(claudeMd, /\*\*The coach's own load\.\*\*/);
});

test("K: recovery-data tries the saved sign-in first", () => {
  const s3 = steps("recovery-data").get(3)!;
  inOrder(s3, ["Run `node adapters/signals/oura/fetch.ts --days 50`", "**It succeeds:** skip the sign-in", "`sign_in_needed: true`", "`! node adapters/signals/oura/auth.ts`", "`sign_in_needed: false`", "say the error in one line"], "recovery-data step 3");
  assert.match(steps("recovery-data").get(5)!, /"Say 'check in' in the morning for today's report\."/);
});

/** I.5, in test form: each kept question, its skill and its class. A prescription choice outside `today` is listed, not changed. */
const QUESTIONS: [string, string, string][] = [
  ["today", "Apply these? A) Yes, B) Change something, C) Not now", "consent"],
  ["today", "How do you feel today?", "athlete fact"],
  ["today", "Other proposals", "consent (one list after the report)"],
  ["check-in", "Not wanting to train at all, or just tired?", "athlete fact"],
  ["check-in", "Where? A) knee", "athlete fact"],
  ["safety", "how should the coach handle it?", "safety screen"],
  ["safety", "Has a clinician seen you about it?", "safety screen"],
  ["week", "A) make next week a deload week, B) plan a new block, C) keep the plan", "prescription choice (week, program level; unchanged)"],
  ["week", "A) yes, write it, B) change it, C) skip it", "consent (week; unchanged)"],
  ["block", "A) yes, write the block and week 1, B) change something, C) not now", "consent (block; unchanged)"],
  ["limits", "Write this change? A) yes, B) change it, C) no", "consent"],
  ["update", "A) keep my version, B) take the template's version", "update conflict"],
  ["recovery-data", "Which recovery data do you have?", "athlete fact"],
  ["automation", "How should the daily and weekly runs start?", "optional action"],
];

test("I.5: the question table matches the skills; no skill asks to pick a weight", () => {
  for (const [name, q] of QUESTIONS) assert.ok(skill(name).includes(q), `${name}: ${q}`);
  for (const name of ["today", "check-in", "week", "block", "log", "audit"]) assert.doesNotMatch(skill(name), /Which weight today\? A\)|weight today\? 1\./, name);
});

// ---------- upgrade: old four-scale chat check-ins and Shortcut files ----------

test("upgrade: old four-scale chat check-ins and Shortcut files load and give the base readiness", () => {
  const dir = copy();
  // A Shortcut morning with a merged chat check-in (two records), and an old chat-only file.
  writeJson(dir, "athlete/signals/2026-10-13.json", { version: 1, date: "2026-10-13", source: "chat", submitted_at: "2026-10-13T06:50:00-07:00", checkin: { sleep_quality: 4, energy: 4, soreness: 2, stress: 2, want_to_train: 4 } });
  writeJson(dir, `athlete/signals/${TODAY}.json`, {
    version: 1,
    date: TODAY,
    source: "apple-health-shortcut",
    submitted_at: "2026-10-14T06:41:12-07:00",
    sleep: { start_at: "2026-10-13T23:05:00-07:00", end_at: "2026-10-14T06:17:00-07:00", duration_min: 412 },
    hrv: { value_ms: 41.8 },
    rhr: { bpm: 54 },
    checkin: { sleep_quality: 2, energy: 2, soreness: 4, stress: 4, pain: [{ region: "left-knee", score: 2 }], source: "chat", submitted_at: "2026-10-14T06:55:00-07:00" },
  });
  const loaded = loadSignals({ root: dir, from: "2026-10-01", to: TODAY, now: NOW });
  assert.deepEqual(loaded.warnings, []);
  const r = run(loaded.records);
  // The values the base (0.2.4) gives for the same files.
  assert.equal(r.subjective.state, "amber");
  assert.deepEqual(r.subjective.reasons, ["check-in mean 2"]);
  assert.deepEqual(r.pain, [{ region: "left-knee", score: 2 }]);
  assert.equal(r.wearable.state, "unknown");
  assert.equal(r.decision, "note");
  assert.equal(r.aversion, false);
});

// ---------- V6b fix round (docs/build/briefs/V6b-fix-round.md) ----------

describe("V6b fix round", () => {
  test("fix 1: a correction for one region keeps the other regions; --pain none only for no pain at all", () => {
    const record = steps("check-in").get(3)!;
    assert.match(record, /\*\*Pain is one list for the day\.\*\* A new `--pain` replaces today's whole list, so read today's check-in first with `node engine\/cli\.ts signals --from <today> --to <today>`/);
    assert.match(record, /A correction for one region \("the knee is fine now"\): pass `--pain` with the remaining regions only[^\n]*Never `--pain none` for one region\./);
    assert.match(record, /`--pain none` only when the athlete says there is no pain now at all, for every region\./);
    assert.doesNotMatch(record, /"the knee is fine now"\) clears or replaces that answer the same way: `--want-to-train none`, `--pain none`/);
    // The engine side: re-recording the remaining region keeps it, and the cleared one is gone.
    const dir = copy();
    writeCheckin({ root: dir, date: TODAY, answers: { pain: [{ region: "left-knee", score: 5 }, { region: "low-back", score: 3 }] }, now: at(10) });
    writeCheckin({ root: dir, date: TODAY, answers: { pain: [{ region: "low-back", score: 3 }] }, now: at(20) });
    assert.deepEqual(run(loadSignals({ root: dir, from: TODAY, to: TODAY, now: NOW }).records).pain, [{ region: "low-back", score: 3 }]);
  });

  test("fix 2: the most recent earlier session decides; one without a usable top set means not judged, never an older stand-in", () => {
    const noReps: SnapshotSession = { date: "2026-10-11", weightUnit: "lbs", exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", muscle: "Quads", sets: [{ weight: 225, reps: null, rpe: null }] }] };
    const j = judgeUnplanned(squat("2026-10-13", 205, [5, 5, 5]), [noReps, squat("2026-10-09", 225, [5, 5, 5])]);
    assert.equal(j.perf, undefined, "not a drop against the older session");
    assert.ok(j.notes.some((n) => /the last session \(2026-10-11\) has no work set with reps, not judged/.test(n)), j.notes.join("; "));
    const dir = copy();
    const r = forDate(dir, snapshot({ "2026-10-13": emptyDay() }, { history: [squat("2026-10-13", 205, [5, 5, 5]), noReps, squat("2026-10-09", 225, [5, 5, 5])], history_coverage: COVERAGE }));
    assert.equal(r.performance.state, "unknown");
  });

  test("fix 3: plans read and the snapshot agree on a day with only unplanned rows; the logged rows stay", async () => {
    const { filesSnapshot } = await import("../engine/plans-files.ts");
    const dir = copy({ edit: (y) => y.replace(/^logger: tally/m, "logger: files") });
    const header = "date,day,exercise,sets,reps,load,unit,notes,done_sets,done_reps,done_load,felt\n";
    mkdirSync(join(dir, "plans"), { recursive: true });
    writeFileSync(join(dir, "plans", "2026-W42.csv"), `${header}2026-10-12,Lower,Squat,3,5,225,lbs,,3,5,225,\n2026-10-13,,Squat,,,,,,3,5,205,\n`);
    const r = cli(dir, ["plans", "read", "--week", "2026-10-13"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.days.map((d: any) => d.date), ["2026-10-12"]);
    assert.deepEqual(r.json.unplanned_logged, ["2026-10-13"]);
    assert.deepEqual(r.json.logged.map((d: any) => d.date), ["2026-10-12", "2026-10-13"]);
    const snap = filesSnapshot(dir, { units: "lbs", timezone: TZ, now: NOW });
    assert.equal(snap.days["2026-10-12"].found, true);
    assert.equal(snap.days["2026-10-13"].found, false);
    assert.ok(snap.history.some((h) => h.date === "2026-10-13"));
    assert.match(skill("today"), /A date in `unplanned_logged` \(logged rows with no sets, reps or load planned\) has no planned session either: it is a rest day with logged work\. Plan nothing on it and write no plan/);
  });

  test("fix 5: checkin_at must be an instant and not in the future; a cached record without it uses observed_at", () => {
    const dir = copy();
    const base = recordWith({ overall: 3 });
    writeJson(dir, "athlete/.cache/signals/test.json", [
      { ...base, source: "bad", checkin_at: "this morning" },
      { ...base, source: "future", checkin_at: "2026-10-14T09:00:00-07:00" },
      { ...base, source: "old" },
    ]);
    const r = loadSignals({ root: dir, from: TODAY, to: TODAY, now: NOW });
    assert.deepEqual(r.records.map((x) => [x.source, x.checkin_at]), [["old", base.observed_at]]);
    assert.ok(r.warnings.some((w) => /\[0\] skipped: .*checkin_at/.test(w)), r.warnings.join("\n"));
    assert.ok(r.warnings.some((w) => /\[1\] skipped: checkin_at 2026-10-14T09:00:00-07:00 is in the future/.test(w)), r.warnings.join("\n"));
    assert.throws(() => run([{ ...base, checkin_at: "this morning" }]), /checkin_at must be an ISO 8601 instant/);
    assert.throws(() => run([{ ...base, checkin_at: "2026-10-14T09:00:00-07:00" }]), /checkin_at 2026-10-14T09:00:00-07:00 is after now/);
    assert.match(readFileSync(join(REPO, "docs/contracts.md"), "utf8"), /An older cached record without it: the loader sets\s+\/\/ it to the record's observed_at/);
  });
});

test("V6b fix 4: pending proposals join the one consent question; never one question per proposal", () => {
  const s4 = steps("today").get(4)!;
  assert.doesNotMatch(skill("today"), /A\) Yes, do it, B\) Not now/);
  assert.match(s4, /\*\*A change to today's session:\*\* it joins the step 7 list\. The step 7 consent question covers it/);
  assert.match(s4, /\*\*"Ask about <region>":\*\* run the `safety` skill for that region now/);
  assert.match(s4, /\*\*Anything else\*\* \(for example the week run's program change\): keep it for step 10\. All of them are offered once, in one list, after the report\./);
  assert.match(steps("today").get(7)!, /A protected day \(step 3\), a big change, or a step 4 proposal for today: before any write/);
  assert.match(steps("today").get(10)!, /\*\*Other proposals\*\*[^\n]*"Apply these\? A\) Yes, B\) Change something, C\) Not now"[^\n]*Never one question per proposal\./);
});
