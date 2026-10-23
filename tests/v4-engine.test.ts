// V4 (setup polish, v0.2.2): one file per week, no source reading, why the plan looks as it
// does, history files by header, and the snapshot's notes, servers and pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { writeBlock } from "../engine/block-files.ts";
import { HELP, HELPER_COMMANDS, SUBHELP } from "../engine/cli-help.ts";
import { isWorkoutHeader, normalizeColumn } from "../engine/cli-setup.ts";
import { whyProblems } from "../engine/lint-methods.ts";
import { parseTemplate } from "../engine/methods.ts";
import { mergeResponse, saveSnapshot } from "../engine/snapshot.ts";
import type { Snapshot } from "../engine/types.ts";
import { cli, instance as e3Instance, REPO, writeJson } from "./e3/helpers.ts";

/** The e3 instance, plus the starting limits file (athlete/limits.md, plain words). */
function instance(edit?: (yaml: string) => string): string {
  const dir = e3Instance(edit);
  writeFileSync(join(dir, "athlete/limits.md"), readFileSync(join(REPO, "templates/athlete/limits.md"), "utf8"));
  return dir;
}

/** Plain names for every template slot pattern (they classify with the shipped taxonomy). */
const EXERCISES: Record<string, { name: string; exerciseId?: string }> = {
  plyometric: { name: "Box Jump" },
  squat: { name: "Barbell Back Squat" },
  horizontal_push: { name: "Bench Press" },
  hinge: { name: "Romanian Deadlift" },
  vertical_pull: { name: "Pull-Up" },
  overhead_press: { name: "Overhead Press" },
  horizontal_pull: { name: "Cable Row" },
  zone2_cardio: { name: "Zone 2 Bike" },
  mobility: { name: "Mobility Flow" },
  lunge: { name: "Walking Lunge" },
  knee_flexion: { name: "Lying Leg Curl" },
  knee_extension: { name: "Leg Extension" },
  lateral_raise: { name: "Lateral Raise" },
  elbow_flexion: { name: "Dumbbell Curl" },
  rear_delt: { name: "Reverse Fly" },
  intervals: { name: "Bike Intervals" },
  breathing: { name: "Box Breathing" },
  carry: { name: "Farmer Carry" },
  rotation: { name: "Cable Woodchop" },
  shrug: { name: "Dumbbell Shrug" },
};

/** A folder with methods/ linked and no coach.yaml (setup before step 6). */
function bare(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-v4-"));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  symlinkSync(join(REPO, "methods"), join(dir, "methods"));
  return dir;
}

const NO_CONFIG = { method: "nine-adaptations", days: 5, emphasis: "strength", units: "lbs", timezone: "America/Los_Angeles", logger: "none" };

function draftOut(dir: string, input: Record<string, unknown>, extra: string[] = []) {
  const p = writeJson(dir, ".tmp/coach/draft.json", input);
  return cli(["block", "draft", "--weeks", "6", "--input", p, "--out", join(dir, ".tmp/coach/b1"), "--root", dir, ...extra]);
}
const readJ = (p: string) => JSON.parse(readFileSync(p, "utf8"));

// ---------- A1: block draft --out ----------

test("A1: block draft --out writes block.json and one week file per week, and prints a summary under 8 KB (6 weeks, 5 days)", () => {
  const dir = bare();
  const r = draftOut(dir, { ...NO_CONFIG, id: "B-001", start: "2026-10-19", exercises: EXERCISES });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(Buffer.byteLength(r.stdout) < 8192, `summary is ${Buffer.byteLength(r.stdout)} bytes`);
  const s = r.json;
  for (const k of ["ready", "unresolved", "warnings", "rule_ids", "capped", "reference", "progression", "why", "weeks"]) assert.ok(k in s, k);
  assert.equal(s.ready, true);
  assert.deepEqual(s.progression, { build_weeks: 5, step: 0.05, deload_weeks: [6] });
  assert.equal(s.weeks.length, 6);
  const files = readdirSync(join(dir, ".tmp/coach/b1")).sort();
  assert.deepEqual(files, ["block.json", "week-1.json", "week-2.json", "week-3.json", "week-4.json", "week-5.json", "week-6.json"]);
  const block = readJ(join(dir, ".tmp/coach/b1/block.json"));
  assert.equal(block.id, "B-001");
  for (const w of s.weeks) {
    const wf = readJ(w.file);
    assert.deepEqual(Object.keys(wf), ["week"]);
    assert.deepEqual(Object.keys(wf.week).sort(), ["days", "kind", "load_factor", "week_start"]);
    assert.equal(wf.week.kind, w.kind);
    assert.equal(wf.week.load_factor, w.load_factor);
    assert.ok(w.sets_by_muscle && typeof w.sets_by_muscle === "object");
  }
  assert.equal(s.weeks[5].kind, "deload");
  assert.equal(s.weeks[5].load_factor, 0.7);
});

test("A1: without --out the output stays the full draft (the week skill and the tests read it)", () => {
  const dir = instance();
  const p = writeJson(dir, "draft.json", { id: "B-001", start: "2026-10-19", exercises: EXERCISES });
  const r = cli(["block", "draft", "--weeks", "6", "--input", p, "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(r.json), ["template", "block", "ready", "unresolved", "weeks", "reference", "capped", "rule_ids", "warnings"]);
  assert.ok(Array.isArray(r.json.weeks[0].days) && r.json.weeks[0].days.length === 4);
});

// ---------- A2: one week file for every command; loads --fill ----------

function history(units: "lbs" | "kg") {
  return {
    units,
    sessions: [
      { date: "2026-10-06", exercises: [{ name: "Romanian Deadlift", sets: [{ weight: units === "kg" ? 60 : 135, reps: 12 }, { weight: units === "kg" ? 60 : 135, reps: 12 }] }] },
      { date: "2026-10-08", exercises: [{ name: "Bench Press", sets: [{ weight: units === "kg" ? 80 : 175, reps: 5 }] }] },
    ],
  };
}

test("A2: the same week file passes through loads --fill, volume and plans write", () => {
  const dir = instance((y) => y.replace("logger: tally", "logger: files"));
  const r = draftOut(dir, { id: "B-001", start: "2026-10-19", exercises: EXERCISES });
  assert.equal(r.code, 0, r.stderr);
  const w1 = r.json.weeks[0].file;
  const h = writeJson(dir, ".tmp/coach/history.json", history("lbs"));
  const fill = cli(["loads", "--input", w1, "--fill", "--history", h, "--root", dir]);
  assert.equal(fill.code, 0, fill.stderr);
  assert.equal(fill.json.history, "file");
  assert.ok(fill.json.filled >= 2, JSON.stringify(fill.json.suggestions));
  const filled = readJ(w1);
  assert.equal(filled.week.kind, "build");
  const rdl = filled.week.days.flatMap((d: any) => d.exercises).find((e: any) => e.name === "Romanian Deadlift");
  assert.ok(rdl.sets.every((s: any) => typeof s.weight === "number" && s.weight > 0), JSON.stringify(rdl));
  const vol = cli(["volume", "--input", w1, "--root", dir]);
  assert.equal(vol.code, 0, vol.stderr);
  assert.deepEqual(vol.json.sets_by_muscle, r.json.weeks[0].sets_by_muscle);
  const pw = cli(["plans", "write", "--input", w1, "--root", dir]);
  assert.equal(pw.code, 0, pw.stderr);
  assert.deepEqual(pw.json.dates, filled.week.days.map((d: any) => d.date));
  const back = cli(["plans", "read", "--week", "2026-10-19", "--root", dir]);
  assert.equal(back.code, 0, back.stderr);
  const csv = readFileSync(join(dir, "plans/2026-W43.csv"), "utf8");
  assert.match(csv, new RegExp(`Romanian Deadlift,\\d+,\\d+,${rdl.sets[0].weight},lbs`));
});

test("A2: a build week and a deload week filled from the same history differ by the deload factor; warm-ups keep their weight", () => {
  const dir = instance();
  const r = draftOut(dir, { id: "B-001", start: "2026-10-19", exercises: EXERCISES });
  const h = writeJson(dir, "h.json", history("lbs"));
  // Make week 5 (build) and week 6 (deload) hold the same exercises with a warm-up in front.
  const w5 = r.json.weeks[4].file;
  const w6 = r.json.weeks[5].file;
  for (const f of [w5, w6]) {
    const wf = readJ(f);
    for (const bench of wf.week.days.flatMap((d: any) => d.exercises).filter((e: any) => e.name === "Bench Press")) bench.sets.unshift({ weight: 45, reps: 10, duration_s: null, warmup: true });
    writeFileSync(f, JSON.stringify(wf));
  }
  const a = cli(["loads", "--input", w5, "--fill", "--history", h, "--root", dir]);
  const b = cli(["loads", "--input", w6, "--fill", "--history", h, "--root", dir]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  const pick = (f: string, name: string) => readJ(f).week.days.flatMap((d: any) => d.exercises.map((e: any, i: number) => ({ ...e, date: d.date, i }))).filter((e: any) => e.name === name);
  const build = pick(w5, "Bench Press");
  const deload = pick(w6, "Bench Press");
  assert.ok(build.length >= 1 && build.length === deload.length);
  // A duplicate exercise on two days is filled on each day (each by its own rep target).
  assert.ok(build.length >= 2, "Bench Press is on two days of the 4-day template");
  for (const e of [...build, ...deload]) assert.ok(e.sets.filter((s: any) => !s.warmup).every((s: any) => typeof s.weight === "number" && s.weight > 0), JSON.stringify(e));
  const bw = build[0].sets.find((s: any) => !s.warmup).weight;
  const dw = deload[0].sets.find((s: any) => !s.warmup).weight;
  assert.equal(dw, Math.max(5, Math.round((bw * 0.7) / 5) * 5), `build ${bw}, deload ${dw}`);
  for (const e of [...build, ...deload]) assert.equal(e.sets[0].weight, 45, "the warm-up keeps its weight");
  // Filling again applies the factor once only.
  cli(["loads", "--input", w6, "--fill", "--history", h, "--root", dir]);
  assert.equal(pick(w6, "Bench Press")[0].sets.find((s: any) => !s.warmup).weight, dw);
});

test("A2: --history wins over the logged weeks, and converts units; an exercise with no suggestion keeps its weight", () => {
  const dir = instance();
  // A logged week in the snapshot says Bench Press 300 lbs; the history file says 80 kg.
  const snap: Snapshot = { version: 1, session_id: "s", captured_at: "2026-10-12T10:00:00Z", timezone: "America/Los_Angeles", days: {}, history: [{ date: "2026-10-09", weightUnit: "lbs", exercises: [{ exerciseId: "", name: "Bench Press", muscle: "", sets: [{ weight: 300, reps: 5, rpe: null }] }] }] };
  saveSnapshot(dir, snap);
  const r = draftOut(dir, { id: "B-001", start: "2026-10-19", exercises: EXERCISES, loads: { "Barbell Back Squat": 185 } });
  const w1 = r.json.weeks[0].file;
  const viaSnap = cli(["loads", "--input", w1, "--fill", "--root", dir]);
  assert.equal(viaSnap.json.history, "logged weeks");
  const benchW = () => readJ(w1).week.days.flatMap((d: any) => d.exercises).find((e: any) => e.name === "Bench Press").sets[0].weight;
  assert.ok(benchW() > 250, `from the logged week: ${benchW()}`);
  const h = writeJson(dir, "h.json", history("kg"));
  const viaFile = cli(["loads", "--input", w1, "--fill", "--history", h, "--root", dir]);
  assert.equal(viaFile.code, 0, viaFile.stderr);
  assert.equal(viaFile.json.units, "lbs");
  assert.ok(benchW() > 170 && benchW() < 200, `80 kg in lbs: ${benchW()}`);
  const squat = readJ(w1).week.days.flatMap((d: any) => d.exercises).find((e: any) => e.name === "Barbell Back Squat");
  assert.equal(squat.sets[0].weight, 185, "no suggestion: the drafted load stays");
  // A malformed history file is an input error.
  const bad = cli(["loads", "--input", w1, "--fill", "--history", writeJson(dir, "bad.json", { sessions: [] }), "--root", dir]);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.error.code, "INPUT_ERROR");
});

test("A2: loads keeps every form it accepts today (an exercise list; a Tally day with update.operations)", () => {
  const dir = instance();
  const list = cli(["loads", "--input", writeJson(dir, "l.json", { exercises: [{ exerciseId: null, name: "Bench Press", muscle: null, unit: "lbs", sets: [{ weight: null, reps: 5 }] }], history: [{ date: "2026-10-01", weightUnit: "lbs", exercises: [{ exerciseId: "", name: "Bench Press", muscle: "", sets: [{ weight: 100, reps: 5, rpe: null }] }] }] }), "--root", dir]);
  assert.equal(list.code, 0, list.stderr);
  assert.ok(list.json.suggestions[0].suggestedWeight > 100);
  const day = { date: "2026-10-19", dayType: "training", dayName: "A", exercises: [{ exerciseId: "Barbell_Bench_Press", name: "Bench Press", suggestedSets: 3, suggestedReps: 5, suggestedWeight: 95 }] };
  saveSnapshot(dir, { version: 1, session_id: "s", captured_at: "2026-10-12T10:00:00Z", timezone: "UTC", days: {}, history: [{ date: "2026-10-01", weightUnit: "lbs", exercises: [{ exerciseId: "Barbell_Bench_Press", name: "Bench Press", muscle: "", sets: [{ weight: 100, reps: 5, rpe: null }] }] }] });
  const t = cli(["loads", "--root", dir], { input: JSON.stringify(day) });
  assert.equal(t.code, 0, t.stderr);
  assert.equal(t.json.update.operations[0].target.exerciseId, "Barbell_Bench_Press");
});

// ---------- A3: tally-days ----------

test("A3: tally-days prints one plan_workout_day input per date, durations included", () => {
  const dir = instance();
  const ex = { ...EXERCISES, squat: { name: "Barbell Back Squat", exerciseId: "Barbell_Squat" } };
  const r = draftOut(dir, { id: "B-001", start: "2026-10-19", exercises: ex, loads: { "Barbell Back Squat": 185 } });
  const t = cli(["tally-days", "--input", r.json.weeks[0].file, "--root", dir]);
  assert.equal(t.code, 0, t.stderr);
  assert.equal(t.json.days.length, 4);
  for (const d of t.json.days) {
    for (const k of ["date", "dayType", "dayName", "exercises", "weightUnit"]) assert.ok(k in d, `${d.date}: ${k}`);
    assert.equal(d.timezone, "America/Los_Angeles");
    for (const e of d.exercises) assert.ok(e.exerciseId && e.name && Number.isInteger(e.suggestedSets) && e.suggestedSets >= 1, JSON.stringify(e));
  }
  const all = t.json.days.flatMap((d: any) => d.exercises);
  const squat = all.find((e: any) => e.name === "Barbell Back Squat");
  assert.deepEqual([squat.exerciseId, squat.suggestedWeight, squat.suggestedReps], ["Barbell_Squat", 185, 5]);
  const bike = all.find((e: any) => e.name === "Zone 2 Bike");
  assert.equal(bike.suggestedDuration, 3600);
  assert.equal(bike.trackingType, "duration");
  assert.ok(!t.json.warnings.some((w: string) => w.startsWith("Barbell Back Squat: no Tally record")), "an exerciseId from search_exercises is not a guess");
  assert.ok(t.json.warnings.some((w: string) => w.startsWith("Box Jump: no Tally record")));
});

// ---------- A4: block write ----------

function blockFile(dir: string, id: string, start = "2026-10-19"): string {
  const r = draftOut(dir, { id, start, exercises: EXERCISES });
  assert.equal(r.code, 0, r.stderr);
  return r.json.block_file;
}

test("A4: block write writes a new block; a block with another id is archived first; the same id rewrites in place", () => {
  const dir = instance();
  const b1 = blockFile(dir, "B-001");
  const w = cli(["block", "write", "--input", b1, "--root", dir]);
  assert.equal(w.code, 0, w.stderr);
  assert.deepEqual([w.json.replaced, w.json.archived], ["new", null]);
  const first = readFileSync(join(dir, "athlete/block.yaml"), "utf8");
  assert.equal(parse(first).id, "B-001");
  // The same id again: in place, no archive.
  const again = cli(["block", "write", "--input", b1, "--root", dir]);
  assert.deepEqual([again.json.replaced, again.json.archived], ["same-id", null]);
  assert.equal(existsSync(join(dir, "athlete/blocks")), false);
  // Another id: B-001 goes to athlete/blocks/B-001.yaml with its exact text.
  const b2 = blockFile(dir, "B-002", "2026-11-30");
  const w2 = cli(["block", "write", "--input", b2, "--root", dir]);
  assert.equal(w2.code, 0, w2.stderr);
  assert.deepEqual([w2.json.replaced, w2.json.archived], ["other-id", "athlete/blocks/B-001.yaml"]);
  assert.equal(readFileSync(join(dir, "athlete/blocks/B-001.yaml"), "utf8"), first);
  assert.equal(parse(readFileSync(join(dir, "athlete/block.yaml"), "utf8")).id, "B-002");
});

test("A4: an archive name that holds other content gets -2; a retry archives nothing new; unsafe ids become safe names", () => {
  const dir = instance();
  mkdirSync(join(dir, "athlete/blocks"), { recursive: true });
  writeFileSync(join(dir, "athlete/blocks/B-001.yaml"), "an older, different B-001\n");
  cli(["block", "write", "--input", blockFile(dir, "B-001"), "--root", dir]);
  const old = readFileSync(join(dir, "athlete/block.yaml"), "utf8");
  const b2 = blockFile(dir, "B-002", "2026-11-30");
  // A failed write: the active block and every archive stay as they were.
  assert.throws(() => writeBlock(dir, readJ(b2), { failBeforeRename: true }), /block.yaml was not changed/);
  assert.equal(readFileSync(join(dir, "athlete/block.yaml"), "utf8"), old);
  assert.deepEqual(readdirSync(join(dir, "athlete/blocks")).sort(), ["B-001.yaml"]);
  assert.ok(!readdirSync(join(dir, "athlete")).some((f) => f.includes(".tmp-")), "no temporary file left");
  // The retry: the same result as a first try.
  const w = cli(["block", "write", "--input", b2, "--root", dir]);
  assert.equal(w.code, 0, w.stderr);
  assert.equal(w.json.archived, "athlete/blocks/B-001-2.yaml");
  assert.equal(readFileSync(join(dir, "athlete/blocks/B-001-2.yaml"), "utf8"), old);
  assert.equal(readFileSync(join(dir, "athlete/blocks/B-001.yaml"), "utf8"), "an older, different B-001\n");
  // An id with path characters never leaves athlete/blocks/.
  writeFileSync(join(dir, "athlete/block.yaml"), old.replace("id: B-001", "id: ../../x y"));
  const w3 = cli(["block", "write", "--input", b2, "--root", dir]);
  assert.equal(w3.code, 0, w3.stderr);
  assert.match(w3.json.archived, /^athlete\/blocks\/_+x_y\.yaml$/);
});

test("A4: block write refuses under the urgent stop and leaves both files unchanged; a malformed block is refused", () => {
  const dir = instance();
  cli(["block", "write", "--input", blockFile(dir, "B-001"), "--root", dir]);
  const before = readFileSync(join(dir, "athlete/block.yaml"), "utf8");
  const b2 = blockFile(dir, "B-002", "2026-11-30");
  writeFileSync(join(dir, "athlete/.urgent-stop"), JSON.stringify({ version: 1, at: "2026-10-12T10:00:00Z", terms: ["chest pain"], sources: ["chat"] }));
  const r = cli(["block", "write", "--input", b2, "--root", dir]);
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, "URGENT_STOP");
  assert.equal(readFileSync(join(dir, "athlete/block.yaml"), "utf8"), before);
  assert.equal(existsSync(join(dir, "athlete/blocks")), false);
  const dir2 = instance();
  const bad = cli(["block", "write", "--input", writeJson(dir2, "b.json", { version: 1, id: "B-1", start: "2026-10-20" }), "--root", dir2]);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.error.code, "BLOCK_INVALID");
  assert.equal(existsSync(join(dir2, "athlete/block.yaml")), false);
});

// ---------- A5: block draft before coach.yaml exists ----------

test("A5: no coach.yaml: the input gives the settings (lbs and kg, two emphases); an error names only what has no source", () => {
  for (const units of ["lbs", "kg"]) {
    const dir = bare();
    const r = draftOut(dir, { ...NO_CONFIG, units, days: 4, id: "B-001", start: "2026-10-19", exercises: EXERCISES, loads: { "Barbell Back Squat": units === "kg" ? 100 : 225 } });
    assert.equal(r.code, 0, r.stderr);
    const deload = readJ(r.json.weeks[5].file).week.days.flatMap((d: any) => d.exercises).find((e: any) => e.name === "Barbell Back Squat");
    assert.equal(deload.unit, units);
    assert.equal(deload.sets[0].weight, units === "kg" ? 70 : 160);
  }
  const dir = bare();
  const strength = draftOut(dir, { ...NO_CONFIG, emphasis: "strength", id: "B-001", start: "2026-10-19", exercises: EXERCISES });
  const size = draftOut(dir, { ...NO_CONFIG, emphasis: "hypertrophy", id: "B-001", start: "2026-10-19", exercises: EXERCISES });
  assert.equal(strength.json.template, "5-day");
  assert.notDeepEqual(strength.json.weeks[0].sets_by_muscle, size.json.weeks[0].sets_by_muscle);
  const missing = draftOut(bare(), { id: "B-001", emphasis: "strength", days: 4 });
  assert.equal(missing.code, 1);
  assert.equal(missing.json.error.code, "MISSING_FILE");
  assert.match(missing.json.error.message, /method .*units .*timezone .*logger/);
  assert.doesNotMatch(missing.json.error.message, /emphasis|days/);
});

test("A5: no coach.yaml and no Tally: a leftover Tally snapshot is ignored; with logger tally it caps week 1", () => {
  const dir = bare();
  // A heavy logged week in a leftover Tally cache would cap week 1 against it.
  const day = (date: string) => ({ date, weightUnit: "lbs" as const, exercises: [{ exerciseId: "", name: "Bench Press", muscle: "", sets: [{ weight: 100, reps: 5, rpe: null }] }] });
  saveSnapshot(dir, { version: 1, session_id: "old", captured_at: "2026-10-12T10:00:00Z", timezone: "UTC", days: {}, history: [day("2026-10-05"), day("2026-10-07"), day("2026-10-09")] });
  const none = draftOut(dir, { ...NO_CONFIG, logger: "none", id: "B-001", start: "2026-10-19", exercises: EXERCISES });
  assert.equal(none.code, 0, none.stderr);
  assert.equal(none.json.reference, null);
  const files = draftOut(dir, { ...NO_CONFIG, logger: "files", id: "B-001", start: "2026-10-19", exercises: EXERCISES });
  assert.equal(files.json.reference, null, "files with no plans/ weeks: no history");
  const tally = draftOut(dir, { ...NO_CONFIG, logger: "tally", id: "B-001", start: "2026-10-19", exercises: EXERCISES });
  assert.ok(tally.json.reference, "logger tally reads the cache");
});

test("A5: with coach.yaml: method, units, timezone and logger come from it; days from --template; emphasis from the input", () => {
  const dir = instance((y) => y.replace("units: lbs", "units: kg"));
  const p = writeJson(dir, "d.json", { id: "B-001", start: "2026-10-19", exercises: EXERCISES, units: "lbs", emphasis: "endurance" });
  const r = cli(["block", "draft", "--weeks", "6", "--template", "3-day", "--input", p, "--out", join(dir, "b"), "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.template, "3-day");
  const block = readJ(r.json.block_file);
  assert.deepEqual(block.template, { days: 3, emphasis: "endurance" });
  const ex = readJ(r.json.weeks[0].file).week.days[0].exercises[0];
  assert.equal(ex.unit, "kg");
});

// ---------- A6: help for every command and subcommand ----------

test("A6: every command in the CLI dispatch list and every subcommand its handlers name has help of one to three lines", () => {
  const src = (f: string) => readFileSync(join(REPO, f), "utf8");
  const helpSrc = src("engine/cli-help.ts");
  const helpers2 = (/return \[([^\]]+)\]\.includes\(cmd\)/.exec(helpSrc)?.[1] ?? "").match(/[a-z-]+/g) ?? [];
  const commands = new Set<string>([...HELPER_COMMANDS, ...helpers2, ...[...src("engine/cli.ts").matchAll(/case "([a-z-]+)":/g)].map((m) => m[1])]);
  assert.ok(commands.size > 30, `found ${commands.size} commands`);
  const lines = (u: string) => u.split("\n").length;
  for (const c of commands) {
    const r = cli(["help", c]);
    assert.equal(r.code, 0, `help ${c}: ${r.stdout}`);
    assert.ok(HELP[c] && lines(r.json.usage) <= 3, `help ${c}`);
  }
  // Subcommands: every literal a handler compares its first word with.
  const handlers = ["engine/cli-core.ts", "engine/cli-oplog.ts", "engine/cli-helpers2.ts", "engine/cli-setup.ts", "engine/cli-plans.ts", "engine/urgent.ts"];
  const subs = new Set<string>();
  for (const f of handlers) for (const m of src(f).matchAll(/(?:sub|positionals\[0\])\s*[!=]==\s*"([a-z-]+)"/g)) subs.add(m[1]);
  assert.ok(subs.has("scan-notes") && subs.has("reset") && subs.has("write"));
  for (const sub of subs) {
    const owners = Object.entries(SUBHELP).filter(([, v]) => sub in v).map(([k]) => k);
    assert.ok(owners.length > 0, `subcommand ${sub} has help`);
    for (const o of owners) {
      const r = cli(["help", o, sub]);
      assert.equal(r.code, 0, `help ${o} ${sub}`);
      assert.equal(r.json.command, `${o} ${sub}`);
      assert.ok(lines(r.json.usage) <= 3);
    }
  }
  // The item from West's run.
  assert.match(cli(["help", "safety", "scan-notes"]).json.usage, /scan-notes --since/);
  assert.match(cli(["help", "block", "draft"]).json.usage, /"logger":"files"/);
});

// ---------- B: why the plan looks as it does ----------

test("B2: why goes from the template YAML through the parser and the draft to the summary", () => {
  const t = parseTemplate(parse(readFileSync(join(REPO, "methods/nine-adaptations/templates/4-day.yaml"), "utf8")), "4-day");
  assert.ok(t.why && t.why.length >= 3 && t.why.length <= 5);
  assert.ok(t.week.every((d) => typeof d.why === "string"));
  const dir = bare();
  const r = draftOut(dir, { ...NO_CONFIG, days: 4, id: "B-001", start: "2026-10-19", exercises: EXERCISES });
  assert.deepEqual(r.json.why.week, t.why);
  assert.deepEqual(r.json.why.days.map((d: any) => d.day), ["mon", "tue", "thu", "fri"]);
  assert.equal(r.json.why.days[0].why, t.week[0].why);
  // A pack may leave the fields out.
  const raw = parse(readFileSync(join(REPO, "methods/nine-adaptations/templates/3-day.yaml"), "utf8"));
  delete raw.why;
  for (const d of raw.week) delete d.why;
  const plain = parseTemplate(raw, "3-day");
  assert.equal(plain.why, undefined);
  assert.deepEqual(whyProblems("3-day", plain), []);
});

test("B3: the lint checks why lines (3 to 5, at most 25 words, no rule ids or code paths)", () => {
  const raw = parse(readFileSync(join(REPO, "methods/nine-adaptations/templates/3-day.yaml"), "utf8"));
  const t = parseTemplate(raw, "3-day");
  assert.deepEqual(whyProblems("3-day", t), []);
  const bad = { ...t, why: ["One line only, see NA-PROG-001."], week: t.week.map((d, i) => (i === 0 ? { ...d, why: Array(30).fill("word").join(" ") } : d)) };
  const p = whyProblems("3-day", bad);
  assert.ok(p.some((x) => /1 lines; give 3 to 5/.test(x)));
  assert.ok(p.some((x) => /no rule ids/.test(x)));
  assert.ok(p.some((x) => /day 1 why: 30 words/.test(x)));
  const lint = cli(["lint-methods", "--pack", "nine-adaptations"]);
  assert.equal(lint.code, 0, JSON.stringify(lint.json?.errors));
});

// ---------- C1: history-files lists likely workout CSVs only ----------

// Headers from public sources (cited in docs/build/reports/V4-setup-polish.md).
const STRONG = "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE";
const HEVY = '"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_kg","reps","distance_km","duration_seconds","rpe"';
const FITBOD = "Date,Exercise,Reps,Weight(kg),Duration(s),Distance(m),Incline,Resistance,isWarmup,Note,multiplier";

test("C1: column names normalize; whole names match, never substrings", () => {
  assert.equal(normalizeColumn(" Weight (kg) "), "weight");
  assert.equal(normalizeColumn('"exercise_title"'), "exercise title");
  assert.equal(normalizeColumn("weight_kg"), "weight");
  assert.equal(normalizeColumn("Duration(s)"), "duration");
  for (const h of [STRONG, HEVY, FITBOD, "Exercise;Reps;Weight", "﻿Exercise Name\tSets"]) assert.ok(isWorkoutHeader(h), h);
  for (const h of ["Exercise Price,Settlement Date,Quantity", "Date,Description,Amount,Balance", "Exercises done,Repsol", "Exercise,Notes"]) assert.ok(!isWorkoutHeader(h), h);
});

test("C1: history-files lists only matching files (the two newest), and never prints a header or a name that does not match", () => {
  const home = mkdtempSync(join(tmpdir(), "coach-home-"));
  const files: [string, string, number][] = [
    ["Downloads/strong_workouts.csv", STRONG + "\n2026-10-01,A,1h,Squat,1,100,5,,,,,\n", 300],
    ["Downloads/hevy.csv", HEVY + "\n", 200],
    ["Desktop/WorkoutExport.csv", FITBOD + "\n", 100],
    ["Desktop/semicolon.csv", "Datum;Exercise;Reps;Weight\n", 400],
    ["Downloads/bom.csv", "﻿Exercise Name,Sets\n", 500],
    ["Downloads/options.csv", "Exercise Price,Settlement Date,Quantity\n", 1],
    ["Downloads/bank-export.csv", "Date,Description,Amount,Balance\n", 2],
    ["Desktop/20260112.csv", "Exercise,Set Order,Weight,Reps\n", 3],
  ];
  for (const [rel, text, age] of files) {
    mkdirSync(join(home, rel, ".."), { recursive: true });
    writeFileSync(join(home, rel), text);
    const t = new Date(Date.now() - age * 60_000);
    utimesSync(join(home, rel), t, t);
  }
  // A symlink to a workout file is skipped.
  symlinkSync(join(home, "Downloads/hevy.csv"), join(home, "Downloads/link.csv"));
  assert.ok(lstatSync(join(home, "Downloads/link.csv")).isSymbolicLink());
  const r = cli(["history-files"], { env: { COACH_HISTORY_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  // The newest two matching: the number-named workout file (3 min) and Fitbod (100 min); the finance files are newer but do not match.
  assert.deepEqual(r.json.files.map((f: any) => `${f.folder}/${f.name}`), ["Desktop/20260112.csv", "Desktop/WorkoutExport.csv"]);
  for (const f of r.json.files) assert.deepEqual(Object.keys(f).sort(), ["folder", "modified", "name", "path"]);
  assert.doesNotMatch(r.stdout, /options|bank-export|Settlement|Exercise Price|link\.csv/);
  // Every format matches when it is among the newest.
  for (const [rel] of files.slice(0, 5)) {
    const solo = mkdtempSync(join(tmpdir(), "coach-home-"));
    mkdirSync(join(solo, rel, ".."), { recursive: true });
    writeFileSync(join(solo, rel), readFileSync(join(home, rel)));
    assert.equal(cli(["history-files"], { env: { COACH_HISTORY_HOME: solo } }).json.files.length, 1, rel);
  }
});

// ---------- F2, F3, F4: notes, servers and pages in the snapshot ----------

const NOW = "2026-10-12T17:00:00.000Z";
const historyResponse = (sessions: unknown[], nextCursor?: string) => [{ type: "text", text: JSON.stringify({ count: sessions.length, sessions, ...(nextCursor ? { nextCursor } : {}) }) }];
const sess = (date: string, name: string, extra: Record<string, unknown> = {}) => ({ date, name, weightUnit: "lbs", exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", sets: [{ weight: 185, reps: 5 }], ...(extra.exNotes ? { notes: extra.exNotes } : {}) }], ...extra });

test("F2: session and exercise notes survive the merge and snapshot validation", () => {
  const snap = mergeResponse(null, { tool: "get_workout_history", input: { since: "2026-09-01" }, response: historyResponse([sess("2026-10-01", "Lower", { notes: "felt strong", exNotes: "left knee ached on the last set", id: "w1", startedAt: "2026-10-01T15:00:00Z" })]), session_id: "s", now: NOW, timezone: "UTC", server: "tally" });
  assert.equal(snap.history[0].notes, "felt strong");
  assert.equal(snap.history[0].exercises[0].notes, "left knee ached on the last set");
  assert.deepEqual([snap.history[0].id, snap.history[0].startedAt, snap.history[0].server, snap.server], ["w1", "2026-10-01T15:00:00Z", "tally", "tally"]);
});

test("F4: pages merge by session identity: same-date sessions across pages, a repeated page, a stopped page chain", () => {
  const m = (prev: Snapshot | null, sessions: unknown[], input: Record<string, unknown>, next?: string) =>
    mergeResponse(prev, { tool: "get_workout_history", input, response: historyResponse(sessions, next), session_id: "s", now: NOW, timezone: "UTC" });
  // Two sessions on one date, split across pages (no ids: date, name and start time).
  let snap = m(null, [sess("2026-10-03", "AM lift", { startedAt: "2026-10-03T07:00:00Z" })], { since: "2026-09-01" }, "c1");
  snap = m(snap, [sess("2026-10-03", "PM run", { startedAt: "2026-10-03T18:00:00Z" }), sess("2026-10-02", "Upper")], { cursor: "c1" });
  assert.deepEqual(snap.history.map((s) => s.name).sort(), ["AM lift", "PM run", "Upper"]);
  assert.equal(snap.history_coverage?.complete, true);
  // A repeated page changes nothing.
  const again = m(snap, [sess("2026-10-03", "PM run", { startedAt: "2026-10-03T18:00:00Z" }), sess("2026-10-02", "Upper")], { cursor: "c1" });
  assert.equal(again.history.length, 3);
  // With ids, the id is the identity; a page with the same session twice keeps one.
  let ids = m(null, [sess("2026-10-03", "A", { id: "x1" }), sess("2026-10-03", "A", { id: "x2" }), sess("2026-10-03", "A", { id: "x1" })], { since: "2026-09-01" });
  assert.equal(ids.history.length, 2);
  // V7: a new first page of the same window is a new generation; it replaces the old one, so x2
  // (gone from the server's answer) leaves (contracts §9a; changed on purpose from V4's "both stay").
  ids = m(ids, [sess("2026-10-03", "A renamed", { id: "x1" })], { since: "2026-09-01" });
  assert.deepEqual(ids.history.map((s) => s.name).sort(), ["A renamed"]);
  // A stopped chain: the first page's sessions stay; the coverage says incomplete.
  const stopped = m(null, [sess("2026-10-05", "Lower")], { since: "2026-09-01" }, "c9");
  assert.equal(stopped.history.length, 1);
  assert.equal(stopped.history_coverage?.complete, false);
});

test("F3: snapshot reset empties the cache", () => {
  const dir = instance();
  saveSnapshot(dir, { version: 1, session_id: "s", captured_at: NOW, timezone: "UTC", days: {}, history: [] });
  const r = cli(["snapshot", "reset", "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.removed, true);
  assert.equal(cli(["snapshot", "show", "--root", dir]).json.exists, false);
  assert.equal(cli(["snapshot", "reset", "--root", dir]).json.removed, false);
});

test("V4b fix 5: a 0.2.1 snapshot (sessions with no id, start time or server) and a new page with the same session count it once", () => {
  // The 0.2.1 shape: historySession kept date, name, weightUnit and exercises only.
  const old: Snapshot = { version: 1, session_id: "s", captured_at: NOW, timezone: "UTC", days: {}, history: [
    { date: "2026-10-01", name: "Lower", weightUnit: "lbs", exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", muscle: "", sets: [{ weight: 185, reps: 5, rpe: null }] }] },
    { date: "2026-09-28", name: "Upper", weightUnit: "lbs", exercises: [] },
  ] };
  const snap = mergeResponse(old, { tool: "get_workout_history", input: { since: "2026-09-30" }, response: historyResponse([sess("2026-10-01", "Lower", { id: "w9", notes: "felt fine" })]), session_id: "s", now: NOW, timezone: "UTC", server: "tally" });
  assert.deepEqual(snap.history.map((h) => `${h.date} ${h.name} ${h.id ?? "-"}`), ["2026-09-28 Upper -", "2026-10-01 Lower w9"]);
});

// ---------- V4b fixes 3 and 6: units and a repeatable fill ----------

const RULES0 = { pack: "none", version: 1, rules: [] } as never;
const histLbs = (name: string, weight: number, reps: number) => [{ date: "2026-10-05", weightUnit: "lbs" as const, exercises: [{ exerciseId: "", name, muscle: "", sets: [{ weight, reps, rpe: null }] }] }];

test("V4b fix 3: a unit change converts every weight, warm-ups included; tally-days prints one unit per day", async () => {
  const { fillWeekLoads, tallyDays } = await import("../engine/week-file.ts");
  const wf: any = { week: { week_start: "2026-10-19", kind: "build", load_factor: 1, days: [{ date: "2026-10-19", dayName: "A", exercises: [
    { exerciseId: null, name: "Bench Press", muscle: null, unit: "kg", sets: [{ weight: 20, reps: 10, duration_s: null, warmup: true }, { weight: 60, reps: 5, duration_s: null }] },
  ] }] } };
  fillWeekLoads(wf, histLbs("Bench Press", 135, 5), RULES0, "lbs", { source: "file" });
  const ex = wf.week.days[0].exercises[0];
  assert.equal(ex.unit, "lbs");
  assert.equal(ex.sets[0].weight, 44, "the 20 kg warm-up is 44 lbs, not 20 lbs");
  assert.equal(ex.sets[1].weight, 140);
  const mixed: any = { week: { days: [{ date: "2026-10-19", dayName: "A", exercises: [
    { exerciseId: "a", name: "Squat", muscle: null, unit: "kg", sets: [{ weight: 50, reps: 5, duration_s: null }] },
    { exerciseId: "b", name: "Row", muscle: null, unit: "lbs", sets: [{ weight: 100, reps: 8, duration_s: null }] },
  ] }] } };
  const t = tallyDays(mixed, "kg");
  assert.equal(t.days[0].weightUnit, "kg");
  assert.deepEqual(t.days[0].exercises.map((e: any) => e.suggestedWeight), [50, 45.5], "100 lbs is 45.5 kg, not 100 kg");
  assert.ok(!t.warnings.some((w) => /mix units/.test(w)));
});

test("V4b fix 6: a second fill with no new history gives the same loads (unequal rep targets)", async () => {
  const { fillWeekLoads } = await import("../engine/week-file.ts");
  const wf: any = { week: { load_factor: 1, days: [{ date: "2026-10-19", exercises: [
    { exerciseId: null, name: "Bench Press", muscle: null, unit: "lbs", sets: [{ weight: null, reps: 5, duration_s: null }, { weight: null, reps: 8, duration_s: null }] },
  ] }] } };
  const h = histLbs("Bench Press", 135, 6);
  fillWeekLoads(wf, h, RULES0, "lbs", { source: "file" });
  const first = wf.week.days[0].exercises[0].sets.map((s: any) => s.weight);
  fillWeekLoads(wf, h, RULES0, "lbs", { source: "file" });
  assert.deepEqual(wf.week.days[0].exercises[0].sets.map((s: any) => s.weight), first);
  assert.deepEqual(first, [135, 135], "8 reps missed at 135 x 6: repeat");
});

test("V4b fix 4: an archive that appears between the check and the write is never overwritten; cleanup removes only this call's file", () => {
  const dir = instance();
  cli(["block", "write", "--input", blockFile(dir, "B-001"), "--root", dir]);
  const old = readFileSync(join(dir, "athlete/block.yaml"), "utf8");
  const b2 = readJ(blockFile(dir, "B-002", "2026-11-30"));
  const other = "another call's archive of B-001\n";
  // Another call writes athlete/blocks/B-001.yaml right before this call creates it.
  const r = writeBlock(dir, b2, { beforeArchiveCreate: (rel) => { if (rel.endsWith("B-001.yaml")) writeFileSync(join(dir, rel), other); } });
  assert.equal(readFileSync(join(dir, "athlete/blocks/B-001.yaml"), "utf8"), other, "not overwritten");
  assert.equal(r.archived, "athlete/blocks/B-001-2.yaml");
  assert.equal(readFileSync(join(dir, "athlete/blocks/B-001-2.yaml"), "utf8"), old);
  // A failed write whose archive was replaced by another call meanwhile: that file stays.
  const dir2 = instance();
  cli(["block", "write", "--input", blockFile(dir2, "B-001"), "--root", dir2]);
  const c = readJ(blockFile(dir2, "B-003", "2026-11-30"));
  let created = "";
  assert.throws(() => writeBlock(dir2, c, { beforeArchiveCreate: (rel) => (created = rel), failBeforeRename: true }));
  assert.equal(existsSync(join(dir2, created)), false, "this call's own archive is removed");
  assert.throws(() => writeBlock(dir2, c, { afterArchiveCreate: (rel) => writeFileSync(join(dir2, rel), other), failBeforeRename: true }));
  assert.equal(readFileSync(join(dir2, created), "utf8"), other, "an archive another call replaced is kept");
});

test("V4b fix 11: the --out summary stays under 8 KB for a ready and an unresolved 6-week, 5-day draft", () => {
  const ready = draftOut(bare(), { ...NO_CONFIG, id: "B-001", start: "2026-10-19", exercises: EXERCISES });
  const open = draftOut(bare(), { ...NO_CONFIG, id: "B-001", start: "2026-10-19" });
  for (const r of [ready, open]) {
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Buffer.byteLength(r.stdout) < 8192, `${Buffer.byteLength(r.stdout)} bytes`);
  }
  assert.equal(open.json.ready, false);
  assert.ok(open.json.unresolved.count > 25, `count ${open.json.unresolved.count}`);
  assert.ok(open.json.unresolved.by_day.mon.includes("1.1 plyometric"), JSON.stringify(open.json.unresolved.by_day.mon));
  assert.deepEqual(ready.json.unresolved, { count: 0, by_day: {} });
});

test("V4b fix 10: a header cut at the 4 KB bound (no line end within it) never matches, even when the cut leaves 'Reps'", () => {
  const home = mkdtempSync(join(tmpdir(), "coach-home-"));
  mkdirSync(join(home, "Downloads"), { recursive: true });
  // "Exercise," + one long column + ",Repsol,…": the 4096th byte ends inside "Repsol", so the cut text ends in ",Reps".
  const filler = "x".repeat(4096 - "Exercise,".length - ",Reps".length);
  const line = `Exercise,${filler},Repsol,Amount,Balance`;
  const cut = Buffer.from(line).subarray(0, 4096).toString();
  assert.ok(cut.endsWith(",Reps"), cut.slice(-20));
  writeFileSync(join(home, "Downloads/long.csv"), line + "\n");
  assert.deepEqual(cli(["history-files"], { env: { COACH_HISTORY_HOME: home } }).json.files, []);
  // A short file with no line end at all is still read.
  writeFileSync(join(home, "Downloads/short.csv"), "Exercise,Reps");
  assert.deepEqual(cli(["history-files"], { env: { COACH_HISTORY_HOME: home } }).json.files.map((f: any) => f.name), ["short.csv"]);
});
