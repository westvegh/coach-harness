// readiness --date. Each past session is judged against its
// own plan; missing evidence is unknown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { validateConfig } from "../../engine/config.ts";
import { addDays } from "../../engine/dates.ts";
import { judgeSession, readinessForDate } from "../../engine/readiness-date.ts";
import { readYamlFile } from "../../engine/yaml-file.ts";
import { config, rules, snapDay, snapshot } from "../guard/fixtures.ts";
import { cli, instance, REPO, writeJson } from "./helpers.ts";
import type { SnapshotSession } from "../../engine/types.ts";

const TODAY = "2026-10-14";
const NOW = "2026-10-14T07:00:00-07:00";

/** 35 nights of sleep before today (480 min), then `todayMin` last night. */
function sleepCache(dir: string, todayMin: number): void {
  const recs = [];
  for (let i = 35; i >= 0; i--) {
    const date = addDays(TODAY, -i);
    const prev = addDays(date, -1);
    const min = i === 0 ? todayMin : 480;
    recs.push({ date, source: "oura", observed_at: `${date}T06:30:00-07:00`, complete: true, sleep: { duration_min: min, start_at: `${prev}T22:30:00-07:00`, end_at: `${date}T06:30:00-07:00` } });
  }
  writeJson(dir, "athlete/.cache/signals/oura.json", recs);
}

const squatPlan = { exerciseId: "Barbell_Squat", name: "Squat", suggestedSets: 4, suggestedReps: 5, suggestedWeight: 225, rpe: 7 };
const lightSquatPlan = { ...squatPlan, suggestedSets: 2, suggestedReps: 3 };

function logged(date: string, sets: { weight: number; reps: number; rpe: number | null }[]): SnapshotSession {
  return { date, weightUnit: "lbs", exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", muscle: "Quads", sets }] };
}

const COVERAGE = { captured_at: NOW, complete: true, since: "2026-08-19", until: TODAY };

test("judgeSession: shortfall against the bottom of the rep target, RPE drift, top set", () => {
  const plan = snapDay("2026-10-13", { exercises: [squatPlan] });
  const j = judgeSession(logged("2026-10-13", [{ weight: 225, reps: 5, rpe: 8 }, { weight: 225, reps: 4, rpe: 9 }, { weight: 215, reps: 3, rpe: 9 }]), plan, "lbs");
  assert.deepEqual(j.perf, { date: "2026-10-13", planned_sets: 4, completed_sets: 3, reps_shortfall_ratio: 0.2, rpe_drift: 1.667, top_set_dropped: false });
  const dropped = judgeSession(logged("2026-10-13", [{ weight: 205, reps: 5, rpe: null }]), plan, "lbs");
  assert.equal(dropped.perf?.top_set_dropped, true);
  assert.equal(dropped.perf?.rpe_drift, undefined, "no RPE pairs: drift unknown, not 0");
  assert.ok(dropped.notes.some((n) => /RPE drift unknown/.test(n)));
});

test("each session is judged against its own plan, never today's", () => {
  const dir = instance();
  // Yesterday's plan was a light day: 2 × 3. The athlete did exactly that.
  // Today's plan is 4 × 5. Judged against today's plan, yesterday would look like a 50% shortfall.
  const snap = snapshot(
    {
      "2026-10-13": snapDay("2026-10-13", { exercises: [lightSquatPlan] }),
      [TODAY]: snapDay(TODAY, { exercises: [squatPlan] }),
    },
    { history: [logged("2026-10-13", [{ weight: 225, reps: 3, rpe: 7 }, { weight: 225, reps: 3, rpe: 7 }])], history_coverage: COVERAGE },
  );
  const r = readinessForDate({ root: dir, date: TODAY, now: NOW, config: config(), rules: rules(), snapshot: snap });
  assert.equal(r.performance.state, "green", r.performance.reasons.join("; "));
  assert.deepEqual(r.inputs.sessions, [{ date: "2026-10-13", planned_sets: 2, completed_sets: 2, reps_shortfall_ratio: 0, rpe_drift: 0, top_set_dropped: false }]);
});

test("a session without its plan is unknown, and an older session never stands in for it", () => {
  const dir = instance();
  const snap = snapshot(
    { "2026-10-11": snapDay("2026-10-11", { exercises: [squatPlan] }) },
    {
      history: [
        logged("2026-10-11", [{ weight: 225, reps: 5, rpe: 7 }, { weight: 225, reps: 5, rpe: 7 }, { weight: 225, reps: 5, rpe: 7 }, { weight: 225, reps: 5, rpe: 7 }]),
        logged("2026-10-13", [{ weight: 225, reps: 2, rpe: 10 }]),
      ],
      history_coverage: COVERAGE,
    },
  );
  const r = readinessForDate({ root: dir, date: TODAY, now: NOW, config: config(), rules: rules(), snapshot: snap });
  assert.equal(r.performance.state, "unknown");
  assert.match(r.performance.reasons.join(" "), /no plan for 2026-10-13/);
  assert.deepEqual(r.inputs.sessions, []);
  assert.equal(r.inputs.sessions_judged[0].plan, "missing");
});

test("no history read: performance unknown with the reason", () => {
  const dir = instance();
  const r = readinessForDate({ root: dir, date: TODAY, now: NOW, config: config(), rules: rules(), snapshot: snapshot({}, { history_coverage: undefined }) });
  assert.equal(r.performance.state, "unknown");
  assert.match(r.performance.reasons[0], /no workout history read/);
});

test("the sleep target comes from coach.yaml athlete.sleep_target_min (default 480)", () => {
  const dir = instance();
  sleepCache(dir, 400);
  const snap = snapshot({}, { history_coverage: COVERAGE });
  const def = readinessForDate({ root: dir, date: TODAY, now: NOW, config: config(), rules: rules(), snapshot: snap });
  assert.equal(def.inputs.sleep_target_min, 480);
  assert.equal(def.wearable.state, "amber", def.wearable.reasons.join("; "));
  const raw = readYamlFile(join(REPO, "coach.example.yaml")) as Record<string, any>;
  const cfg = validateConfig({ ...raw, athlete: { ...raw.athlete, sleep_target_min: 420 } });
  const own = readinessForDate({ root: dir, date: TODAY, now: NOW, config: cfg, rules: rules(), snapshot: snap });
  assert.equal(own.inputs.sleep_target_min, 420);
  assert.equal(own.wearable.state, "green", own.wearable.reasons.join("; "));
  // The pack's readiness checks reach the engine with their rule IDs.
  assert.deepEqual(own.inputs.readiness_rules, {
    single_day_ids: ["NA-REC-008"],
    short_pattern: { mornings: 3, ids: ["NA-REC-009"] },
    long_pattern: { days: 7, ids: ["NA-REC-011"] },
    program_change: { categories: 3, ids: ["NA-REC-003"] },
    aversion: { max: 1, ids: ["NA-REC-012"] },
  });
});

test("coach.yaml rejects a sleep target outside 240-720 minutes", () => {
  const raw = readYamlFile(join(REPO, "coach.example.yaml")) as Record<string, any>;
  for (const bad of [120, 800, 7.5, "8h"]) {
    assert.throws(() => validateConfig({ ...raw, athlete: { ...raw.athlete, sleep_target_min: bad } }), /sleep_target_min/);
  }
  assert.equal(validateConfig(raw).athlete.sleep_target_min, 480);
});

test("CLI: readiness --date prints the readiness JSON plus the inputs it used", () => {
  const dir = instance();
  sleepCache(dir, 400);
  writeJson(dir, "athlete/signals/2026-10-14.json", { version: 1, date: TODAY, source: "apple-health-shortcut", submitted_at: "2026-10-14T06:41:12-07:00", checkin: { sleep_quality: 2, energy: 2, soreness: 4, stress: 4 } });
  writeJson(dir, "athlete/.cache/snapshot.json", snapshot({}, { history_coverage: COVERAGE }));
  const r = cli(["readiness", "--date", TODAY, "--now", NOW, "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.date, TODAY);
  assert.equal(r.json.wearable.state, "amber");
  assert.equal(r.json.subjective.state, "amber");
  // Two categories off on one day, with no run of off-mornings: a note (NA-REC-008).
  assert.equal(r.json.decision, "note");
  assert.deepEqual(r.json.rule_ids, ["NA-REC-008"]);
  assert.equal(r.json.inputs.sleep_target_min, 480);
  assert.ok(r.json.inputs.records.length >= 21);
  // The --input form is unchanged.
  const old = cli(["readiness", "--input", writeJson(dir, "in.json", { ...r.json.inputs, signals_warnings: undefined, sessions_judged: undefined, notes: undefined }), "--root", dir]);
  assert.equal(old.code, 0, old.stderr);
  assert.equal(old.json.decision, "note");
  // A future date is refused.
  assert.equal(cli(["readiness", "--date", "2026-10-15", "--now", NOW, "--root", dir]).code, 2);
});

test("a past date sees only what was known by the end of that day", () => {
  const dir = instance();
  sleepCache(dir, 400);
  const r = cli(["readiness", "--date", "2026-10-13", "--now", NOW, "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.inputs.now, "2026-10-14T06:59:59.999Z");
  assert.ok(r.json.inputs.records.every((x: { date: string }) => x.date <= "2026-10-13"));
});

test("missing planned or logged measurements give no SessionPerf", () => {
  // The reviewer's input: a planned squat with no set count, reps or weight; one logged set with nothing.
  const bare = snapDay("2026-10-13", { exercises: [{ exerciseId: "Barbell_Squat", name: "Squat" }] });
  const j = judgeSession({ date: "2026-10-13", weightUnit: "lbs", exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", muscle: "", sets: [{ weight: null, reps: null, rpe: null }] }] }, bare, "lbs");
  assert.equal(j.perf, undefined);
  assert.ok(j.notes.some((n) => /no set count/.test(n)));
  assert.ok(j.notes.some((n) => /no rep target/.test(n)));
  // A full plan, but a logged set without reps.
  const noReps = judgeSession(logged("2026-10-13", [{ weight: 225, reps: null as never, rpe: 7 }]), snapDay("2026-10-13", { exercises: [squatPlan] }), "lbs");
  assert.equal(noReps.perf, undefined);
  // A planned weight, but no logged weight.
  const noWeight = judgeSession(logged("2026-10-13", [{ weight: null as never, reps: 5, rpe: 7 }]), snapDay("2026-10-13", { exercises: [squatPlan] }), "lbs");
  assert.equal(noWeight.perf, undefined);
  // In readiness: performance unknown, not green.
  const dir = instance();
  const snap = snapshot({ "2026-10-13": bare }, { history: [{ date: "2026-10-13", weightUnit: "lbs", exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", muscle: "", sets: [{ weight: null, reps: null, rpe: null }] }] }], history_coverage: COVERAGE });
  const r = readinessForDate({ root: dir, date: TODAY, now: NOW, config: config(), rules: rules(), snapshot: snap });
  assert.equal(r.performance.state, "unknown");
  assert.deepEqual(r.inputs.sessions, []);
});

test("incomplete, old or short history coverage makes performance unknown", () => {
  const dir = instance();
  const days = { "2026-10-13": snapDay("2026-10-13", { exercises: [lightSquatPlan] }) };
  const history = [logged("2026-10-13", [{ weight: 225, reps: 3, rpe: 7 }, { weight: 225, reps: 3, rpe: 7 }])];
  const run = (cov: object) => readinessForDate({ root: dir, date: TODAY, now: NOW, config: config(), rules: rules(), snapshot: snapshot(days, { history, history_coverage: cov as never }) });
  assert.equal(run(COVERAGE).performance.state, "green");
  const cases: [object, RegExp][] = [
    [{ ...COVERAGE, complete: false }, /incomplete/],
    [{ ...COVERAGE, captured_at: "2026-10-14T06:00:00-07:00" }, /read 60 minutes ago/],
    [{ ...COVERAGE, since: "2026-10-12" }, /starts 2026-10-12/],
    [{ ...COVERAGE, until: "2026-10-13" }, /ends 2026-10-13/],
  ];
  for (const [cov, why] of cases) {
    const r = run(cov);
    assert.equal(r.performance.state, "unknown", JSON.stringify(cov));
    assert.match(r.performance.reasons[0], why);
    assert.deepEqual(r.inputs.sessions, []);
  }
});

// ---------- the morning pattern (NA-REC-008 to NA-REC-012) ----------

/** 45 mornings of RMSSD HRV before and on today: a calm baseline (50, with 56 every fifth day), and 38 ms (off) on each date in `off`. */
function hrvCache(dir: string, off: string[], skip: string[] = []): void {
  const recs = [];
  for (let i = 45; i >= 0; i--) {
    const date = addDays(TODAY, -i);
    if (skip.includes(date)) continue;
    recs.push({ date, source: "oura", observed_at: `${date}T06:30:00-07:00`, complete: true, hrv: { value_ms: off.includes(date) ? 38 : i % 5 === 0 ? 56 : 50, method: "rmssd" } });
  }
  writeJson(dir, "athlete/.cache/signals/oura.json", recs);
}

const at = (dir: string, snap = snapshot({})) => readinessForDate({ root: dir, date: TODAY, now: NOW, config: config(), rules: rules(), snapshot: snap });
const days = (n: number) => Array.from({ length: n }, (_, i) => addDays(TODAY, -i));

test("pattern: one off morning, wherever it falls, is a note; progression runs", () => {
  for (const off of [[TODAY], ["2026-10-12"]]) {
    const dir = instance();
    hrvCache(dir, off);
    const r = at(dir);
    assert.equal(r.decision, off[0] === TODAY ? "note" : "none", r.decision_reasons.join("; "));
    assert.equal(r.hold_progression, false);
  }
});

test("pattern: 3 off-mornings in a row trim and hold progression [NA-REC-009]; 2 do not", () => {
  const dir = instance();
  hrvCache(dir, days(2));
  assert.equal(at(dir).decision, "note");
  hrvCache(dir, days(3));
  const r = at(dir);
  assert.deepEqual(r.pattern.off_mornings, { hrv: 3, rhr: 0, either: 3 });
  assert.equal(r.decision, "trim");
  assert.equal(r.hold_progression, true);
  assert.deepEqual(r.rule_ids, ["NA-REC-009"]);
});

test("pattern: a missing morning is unknown, not off, and ends the run", () => {
  const dir = instance();
  hrvCache(dir, days(3), ["2026-10-13"]);
  const r = at(dir);
  assert.equal(r.pattern.mornings.at(-2)!.hrv, "unknown");
  assert.equal(r.pattern.days_of_decline, 1);
  assert.equal(r.decision, "note");
});

test("pattern: the long pattern with a low check-in and a performance drop proposes a deload [NA-REC-011, NA-REC-003]", () => {
  const dir = instance();
  hrvCache(dir, days(7));
  writeJson(dir, "athlete/signals/2026-10-14.json", { version: 1, date: TODAY, source: "chat", submitted_at: "2026-10-14T06:41:12-07:00", checkin: { sleep_quality: 2, energy: 2, soreness: 4, stress: 4 } });
  const short = (d: string) => logged(d, [{ weight: 225, reps: 3, rpe: 9 }, { weight: 225, reps: 3, rpe: 9 }, { weight: 225, reps: 3, rpe: 9 }, { weight: 225, reps: 3, rpe: 9 }]);
  const snap = snapshot({ "2026-10-13": snapDay("2026-10-13", { exercises: [squatPlan] }) }, { history: [short("2026-10-13")], history_coverage: COVERAGE });
  const r = at(dir, snap);
  assert.equal(r.pattern.days_of_decline, 7);
  assert.equal(r.performance.state, "amber");
  assert.equal(r.deload_signal, true);
  assert.equal(r.decision, "propose_deload");
  assert.deepEqual(r.rule_ids, ["NA-REC-011", "NA-REC-003"]);
});

test("aversion: want to train 1 is a recovery day [NA-REC-012]", () => {
  const dir = instance();
  hrvCache(dir, []);
  assert.equal(cli(["checkin", "--date", TODAY, "--sleep-quality", "4", "--energy", "4", "--soreness", "2", "--stress", "2", "--want-to-train", "1", "--now", NOW, "--root", dir]).code, 0);
  const r = at(dir);
  assert.equal(r.aversion, true);
  assert.equal(r.decision, "recovery");
  assert.deepEqual(r.rule_ids, ["NA-REC-012"]);
  assert.match(r.subjective.reasons.join(" "), /want to train 1\/5/);
  // The item is optional, and only 1 to 5 is accepted. V6 B.3 (changed on purpose): a later
  // check-in that leaves the item out keeps it (the writer merges by group); only
  // --want-to-train none clears it.
  assert.equal(cli(["checkin", "--date", TODAY, "--sleep-quality", "4", "--energy", "4", "--soreness", "2", "--stress", "2", "--now", NOW, "--root", dir]).code, 0);
  assert.equal(at(dir).aversion, true);
  assert.equal(cli(["checkin", "--date", TODAY, "--want-to-train", "none", "--now", NOW, "--root", dir]).code, 0);
  assert.equal(at(dir).aversion, false);
  assert.equal(cli(["checkin", "--date", TODAY, "--sleep-quality", "4", "--energy", "4", "--soreness", "2", "--stress", "2", "--want-to-train", "0", "--now", NOW, "--root", dir]).code, 2);
});

test("CLI: readiness --date prints the pattern, the decision and hold_progression", () => {
  const dir = instance();
  hrvCache(dir, days(3));
  const r = cli(["readiness", "--date", TODAY, "--now", NOW, "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.decision, "trim");
  assert.equal(r.json.hold_progression, true);
  assert.equal(r.json.pattern.days_of_decline, 3);
  assert.equal(r.json.pattern.mornings.length, 7);
  assert.ok(r.json.decision_reasons.length > 0);
});
