import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readiness } from "./readiness.ts";
import { addDays } from "./dates.ts";
import { CoachError } from "./errors.ts";
import type { DayRecord, Readiness, ReadinessInput, SessionPerf } from "./types.ts";

const TZ = "America/Los_Angeles";
const TODAY = "2026-10-12";
const NOW = "2026-10-12T07:00:00-07:00";
const SRC = "apple-health-shortcut";

type Opts = { n?: number; hrv?: (i: number) => number; rhr?: (i: number) => number; method?: "rmssd" | "sdnn"; source?: string; today?: string };

/** n baseline days before `today`. HRV 46..54 (mean 50), RHR 54..56 (mean 55). */
function history(o: Opts = {}): DayRecord[] {
  const { n = 45, method = "sdnn", source = SRC, today = TODAY } = o;
  const hrv = o.hrv ?? ((i) => 50 + ((i % 5) - 2) * 2);
  const rhr = o.rhr ?? ((i) => 55 + ((i % 3) - 1));
  return Array.from({ length: n }, (_, k) => {
    const date = addDays(today, -(k + 1));
    return {
      date,
      source,
      observed_at: `${date}T06:30:00-07:00`,
      complete: true,
      sleep: { duration_min: 450, start_at: `${addDays(date, -1)}T23:00:00-07:00`, end_at: `${date}T06:30:00-07:00` },
      hrv: { value_ms: hrv(k), method },
      rhr: { bpm: rhr(k) },
    };
  });
}

function todayRecord(p: Partial<DayRecord> & { hrv_ms?: number; rhr_bpm?: number; sleep_min?: number; end_at?: string } = {}): DayRecord {
  const end = p.end_at ?? `${TODAY}T06:30:00-07:00`;
  return {
    date: TODAY,
    source: SRC,
    observed_at: end,
    complete: true,
    sleep: { duration_min: p.sleep_min ?? 450, start_at: `2026-10-11T23:00:00-07:00`, end_at: end },
    hrv: { value_ms: p.hrv_ms ?? 50, method: p.hrv?.method ?? "sdnn" },
    rhr: { bpm: p.rhr_bpm ?? 55 },
  };
}

function checkin(sleep_quality: number, energy: number, soreness: number, stress: number, date = TODAY): DayRecord {
  return {
    date,
    source: "checkin",
    observed_at: `${date}T06:45:00-07:00`,
    complete: true,
    subjective: { sleep_quality, energy, soreness, stress } as DayRecord["subjective"],
  };
}

const GOOD_CHECKIN = () => checkin(4, 4, 2, 2); // mean 4
const LOW_CHECKIN = () => checkin(2, 2, 4, 4); // mean 2: amber
const AWFUL_CHECKIN = () => checkin(1, 1, 5, 5); // mean 1: red

function session(date: string, p: Partial<SessionPerf> = {}): SessionPerf {
  return { date, planned_sets: 20, completed_sets: 20, reps_shortfall_ratio: 0, top_set_dropped: false, ...p };
}
const GOOD_SESSION = () => session(addDays(TODAY, -1));
const BAD = { reps_shortfall_ratio: 0.25 };

function run(records: DayRecord[], sessions: SessionPerf[] = [], extra: Partial<ReadinessInput> = {}): Readiness {
  return readiness({ today: TODAY, now: NOW, tz: TZ, records, sessions, sleep_target_min: 480, ...extra });
}

describe("wearable baselines", () => {
  test("calibration: under 28 valid days (4 weeks) means calibrating and unknown", () => {
    const r27 = run([...history({ n: 27 }), todayRecord({ hrv_ms: 30 })]);
    assert.equal(r27.wearable.calibrating, true);
    assert.equal(r27.wearable.state, "unknown");
    assert.match(r27.wearable.reasons.join(" "), /calibrating: 27\/28/);
    const r28 = run([...history({ n: 28 }), todayRecord()]);
    assert.equal(r28.wearable.calibrating, false);
    assert.equal(r28.wearable.state, "green");
  });

  test("only the baseline window counts (days older than 42 are ignored)", () => {
    const old = history({ n: 60 }).slice(42); // days 43..60 before today
    const r = run([...old, ...history({ n: 10 }), todayRecord()]);
    assert.equal(r.wearable.calibrating, true);
  });

  test("zero variance falls back to percent change", () => {
    const flat = history({ hrv: () => 50, rhr: () => 55 });
    // −8%: green under the percent rule. A z-score would divide by zero.
    assert.equal(run([...flat, todayRecord({ hrv_ms: 46 })]).wearable.state, "green");
    const amber = run([...flat, todayRecord({ hrv_ms: 44 })]); // −12%
    assert.equal(amber.wearable.state, "amber");
    assert.match(amber.wearable.reasons.join(" "), /percent rule/);
    assert.equal(run([...flat, todayRecord({ hrv_ms: 39 })]).wearable.state, "red"); // −22%
    assert.equal(run([...flat, todayRecord({ rhr_bpm: 58 })]).wearable.state, "amber"); // +5.5%
    assert.equal(run([...flat, todayRecord({ rhr_bpm: 61 })]).wearable.state, "red"); // +10.9%
  });

  test("z-scores: HRV low and RHR high", () => {
    const h = history();
    assert.equal(run([...h, todayRecord({ hrv_ms: 46 })]).wearable.state, "amber"); // z ≈ −1.4
    assert.equal(run([...h, todayRecord({ hrv_ms: 43 })]).wearable.state, "red"); // z ≈ −2.4
    assert.equal(run([...h, todayRecord({ hrv_ms: 60 })]).wearable.state, "green"); // high HRV is good
    assert.equal(run([...h, todayRecord({ rhr_bpm: 56 })]).wearable.state, "amber"); // z ≈ 1.2
  });

  test("HRV methods are never mixed", () => {
    // 45 days of SDNN at about 50, then an RMSSD reading: no RMSSD baseline exists.
    const r = run([...history({ method: "sdnn" }), todayRecord({ hrv_ms: 30, hrv: { value_ms: 30, method: "rmssd" } })]);
    assert.equal(r.wearable.calibrating, true);
    assert.match(r.wearable.reasons.join(" "), /0\/28 valid days of RMSSD/);
    // RMSSD history at about 30 plus SDNN history at about 60 on the same dates (SDNN read
    // later each morning): today's RMSSD 30 is normal. A mixed baseline (mean about 45)
    // would score it amber or worse.
    const rm = history({ method: "rmssd", hrv: (i) => 30 + ((i % 5) - 2), n: 30 });
    const sd = history({ method: "sdnn", hrv: (i) => 60 + ((i % 5) - 2), n: 30 }).map((x) => ({ ...x, observed_at: x.observed_at.replace("06:30", "06:40") }));
    const both = run([...rm, ...sd, todayRecord({ hrv: { value_ms: 30, method: "rmssd" }, hrv_ms: 30 })]);
    assert.equal(both.wearable.state, "green");
  });

  test("baselines are per source", () => {
    const r = run([...history({ source: "oura" }), todayRecord()]);
    assert.equal(r.wearable.calibrating, true);
  });
});

describe("freshness", () => {
  test("a sleep that ended before 18:00 on the previous day does not count", () => {
    const r = run([...history(), todayRecord({ end_at: "2026-10-11T17:30:00-07:00" })]);
    assert.equal(r.wearable.state, "unknown");
    assert.match(r.wearable.reasons.join(" "), /ended before 18:00 on 2026-10-11/);
    // 18:30 on the previous day still counts (for example, after a night shift).
    assert.equal(run([...history(), todayRecord({ end_at: "2026-10-11T18:30:00-07:00" })]).wearable.state, "green");
  });

  test("a future end_at is rejected, with the reason", () => {
    const r = run([...history(), todayRecord({ end_at: "2026-10-12T08:00:00-07:00" })]);
    assert.equal(r.wearable.state, "unknown");
    assert.match(r.wearable.reasons.join(" "), /rejected apple-health-shortcut record: (observed_at|sleep\.end_at) is after now/);
  });

  test("DST: the 18:00 cut-off uses the previous day's offset across the US fall-back", () => {
    // 2026-11-01 is the fall-back date. 18:00 on 2026-10-31 is PDT (−07:00) = 01:00Z.
    const today = "2026-11-01";
    const now = "2026-11-01T07:00:00-08:00";
    const h = history({ today });
    const rec = (end: string): DayRecord => ({ ...todayRecord({ end_at: end }), date: today });
    const at = (end: string) => readiness({ today, now, tz: TZ, records: [...h, rec(end)], sessions: [], sleep_target_min: 480 });
    // 18:30 PDT = 01:30Z: after the cut-off. Using today's PST offset would put the cut-off at 02:00Z.
    assert.equal(at("2026-10-31T18:30:00-07:00").wearable.state, "green");
    assert.equal(at("2026-10-31T17:30:00-07:00").wearable.state, "unknown");
    // Calendar-day expiry is not shifted by the extra hour.
    const p = readiness({ today, now, tz: TZ, records: [], sessions: [session("2026-10-28")], sleep_target_min: 480 });
    assert.equal(p.performance.state, "green");
  });
});

describe("subjective", () => {
  test("soreness and stress are inverted", () => {
    // Raw 4,4,1,1 → oriented 4,4,5,5 = 4.5: green. Without inversion the mean is 2.5.
    const r = run([checkin(4, 4, 1, 1)]);
    assert.equal(r.subjective.state, "green");
    assert.equal(run([LOW_CHECKIN()]).subjective.state, "amber");
    assert.equal(run([AWFUL_CHECKIN()]).subjective.state, "red");
  });

  test("any scale at 1 makes it amber, after inversion", () => {
    // Mean 3.75 is green, but energy is 1.
    assert.equal(run([checkin(4, 1, 1, 1)]).subjective.state, "amber");
    // Soreness 5 is the worst value (oriented 1): mean 4, amber.
    assert.equal(run([checkin(5, 5, 5, 1)]).subjective.state, "amber");
  });

  test("valid only for today", () => {
    const r = run([checkin(1, 1, 5, 5, addDays(TODAY, -1))]);
    assert.equal(r.subjective.state, "unknown");
  });

  test("pain comes from today's check-in", () => {
    const c = checkin(4, 4, 2, 2);
    c.subjective!.pain = [{ region: "left-knee", score: 5 }];
    assert.deepEqual(run([c]).pain, [{ region: "left-knee", score: 5 }]);
  });
});

describe("performance", () => {
  test("expiry after perf_expiry_days", () => {
    assert.equal(run([], [session(addDays(TODAY, -5), BAD)]).performance.state, "unknown");
    assert.equal(run([], [session(addDays(TODAY, -4), BAD)]).performance.state, "amber");
  });

  test("once-only: an older session is ignored once a newer one exists", () => {
    const r = run([], [session(addDays(TODAY, -3), BAD), session(addDays(TODAY, -1))]);
    assert.equal(r.performance.state, "green");
    assert.deepEqual(r.performance.sessions_used, [addDays(TODAY, -1)]);
  });

  test("two amber sessions in a row make red", () => {
    const r = run([], [session(addDays(TODAY, -3), BAD), session(addDays(TODAY, -1), { rpe_drift: 1.5 })]);
    assert.equal(r.performance.state, "red");
    assert.deepEqual(r.performance.sessions_used, [addDays(TODAY, -1), addDays(TODAY, -3)]);
  });

  test("missed sets and a dropped top set are amber", () => {
    assert.equal(run([], [session(addDays(TODAY, -1), { completed_sets: 15 })]).performance.state, "amber");
    assert.equal(run([], [session(addDays(TODAY, -1), { top_set_dropped: true })]).performance.state, "amber");
    assert.equal(run([], [session(addDays(TODAY, -1), { reps_shortfall_ratio: 0.1, rpe_drift: 1 })]).performance.state, "green");
  });

  test("a future session is ignored", () => {
    assert.equal(run([], [session(addDays(TODAY, 1), BAD)]).performance.state, "unknown");
  });
});

describe("decision table: patterns, not single days", () => {
  // A calm baseline: its noise only ever moves the good way, so it has no off-mornings of its own.
  const calmHrv = (i: number) => (i % 5 === 0 ? 56 : 50);
  const calmRhr = (i: number) => (i % 3 === 0 ? 52 : 55);
  const base = history({ hrv: calmHrv, rhr: calmRhr });
  /** The calm history with HRV `low` on the `k` mornings before today (i = 0 is yesterday). */
  const offBefore = (k: number, o: { low?: number; n?: number } = {}) => history({ n: o.n, hrv: (i) => (i < k ? (o.low ?? 42) : calmHrv(i)), rhr: calmRhr });
  const RULES = {
    single_day_ids: ["R-ONE"],
    short_pattern: { mornings: 3, ids: ["R-SHORT"] },
    long_pattern: { days: 7, ids: ["R-LONG"] },
    program_change: { categories: 3, ids: ["R-TRIAD"] },
    aversion: { max: 1, ids: ["R-AVERSION"] },
  };

  test("one off morning is a note, never a change (a red HRV alone)", () => {
    const r = run([...base, todayRecord({ hrv_ms: 43 })], [GOOD_SESSION()], { readiness_rules: RULES });
    assert.equal(r.wearable.state, "red");
    assert.equal(r.pattern.off_mornings.hrv, 1);
    assert.equal(r.decision, "note");
    assert.equal(r.hold_progression, false);
    assert.deepEqual(r.rule_ids, ["R-ONE"]);
    assert.match(r.decision_reasons.join(" "), /one day is not a pattern/);
  });
  test("one red check-in, or two categories off on one day, is still a note", () => {
    assert.equal(run([...base, todayRecord(), AWFUL_CHECKIN()], [GOOD_SESSION()]).decision, "note");
    const two = run([...base, todayRecord(), LOW_CHECKIN()], [session(addDays(TODAY, -1), BAD)]);
    assert.equal(two.decision, "note");
    assert.equal(two.hold_progression, false);
  });
  test("nothing off gives none", () => {
    const r = run([...base, todayRecord(), GOOD_CHECKIN()], [GOOD_SESSION()]);
    assert.equal(r.decision, "none");
    assert.deepEqual(r.rule_ids, []);
  });
  test("2 off-mornings in a row is a note; 3 is the short pattern: trim and hold progression", () => {
    const two = run([...offBefore(1), todayRecord({ hrv_ms: 43 })], [], { readiness_rules: RULES });
    assert.equal(two.pattern.days_of_decline, 2);
    assert.equal(two.decision, "note");
    const three = run([...offBefore(2), todayRecord({ hrv_ms: 43 })], [], { readiness_rules: RULES });
    assert.deepEqual(three.pattern.off_mornings, { hrv: 3, rhr: 0, either: 3 });
    assert.equal(three.pattern.short, true);
    assert.equal(three.decision, "trim");
    assert.equal(three.hold_progression, true);
    assert.deepEqual(three.rule_ids, ["R-SHORT"]);
    assert.deepEqual(three.pattern.mornings.slice(-3).map((m) => m.hrv), ["off", "off", "off"]);
  });
  test("resting HR above its band counts too; a morning counts when either signal is off", () => {
    const rhrHigh = history({ hrv: calmHrv, rhr: (i) => (i < 2 ? 60 : calmRhr(i)) });
    const r = run([...rhrHigh, todayRecord({ rhr_bpm: 60 })]);
    assert.equal(r.pattern.off_mornings.rhr, 3);
    assert.equal(r.decision, "trim");
    // HRV off yesterday, RHR off today and the day before: 3 for either, 1 for each alone.
    const mixed = history({ hrv: (i) => (i === 0 ? 42 : calmHrv(i)), rhr: (i) => (i === 1 ? 60 : calmRhr(i)) });
    const m = run([...mixed, todayRecord({ rhr_bpm: 60 })]);
    assert.deepEqual(m.pattern.off_mornings, { hrv: 0, rhr: 1, either: 3 });
    assert.equal(m.decision, "trim");
  });
  test("a missing morning is unknown, not off: it ends the run", () => {
    const gap = offBefore(2).filter((x) => x.date !== addDays(TODAY, -1));
    const r = run([...gap, todayRecord({ hrv_ms: 43 })]);
    assert.equal(r.pattern.mornings.at(-2)!.hrv, "unknown");
    assert.equal(r.pattern.days_of_decline, 1);
    assert.equal(r.decision, "note");
  });
  test("a calibrating baseline gives no pattern", () => {
    const r = run([...offBefore(2, { n: 20 }), todayRecord({ hrv_ms: 43 })]);
    assert.equal(r.wearable.calibrating, true);
    assert.equal(r.pattern.days_of_decline, 0);
    assert.equal(r.decision, "none");
  });
  test("the short pattern with a red check-in or red performance is a recovery day", () => {
    const rec = run([...offBefore(2), todayRecord({ hrv_ms: 43 }), AWFUL_CHECKIN()], [], { readiness_rules: RULES });
    assert.equal(rec.decision, "recovery");
    assert.equal(rec.hold_progression, true);
    const perf = run([...offBefore(2), todayRecord({ hrv_ms: 43 })], [session(addDays(TODAY, -3), BAD), session(addDays(TODAY, -1), BAD)]);
    assert.equal(perf.performance.state, "red");
    assert.equal(perf.decision, "recovery");
  });
  test("aversion (want to train 1) is a recovery day, even on a green day", () => {
    const c = checkin(4, 4, 2, 2);
    c.subjective!.want_to_train = 1;
    const r = run([...base, todayRecord(), c], [GOOD_SESSION()], { readiness_rules: RULES });
    assert.equal(r.aversion, true);
    assert.equal(r.decision, "recovery");
    assert.equal(r.hold_progression, true);
    assert.deepEqual(r.rule_ids, ["R-AVERSION"]);
    c.subjective!.want_to_train = 2;
    assert.equal(run([...base, todayRecord(), c], [GOOD_SESSION()]).decision, "none");
    // The pack's line moves it.
    assert.equal(run([...base, todayRecord(), c], [GOOD_SESSION()], { readiness_rules: { aversion: { max: 2, ids: [] } } }).decision, "recovery");
  });
  test("the long pattern with all three kinds of evidence proposes a deload; physiology alone stays a trim", () => {
    const long = [...offBefore(6), todayRecord({ hrv_ms: 43 })];
    const alone = run([...long, GOOD_CHECKIN()], [GOOD_SESSION()], { readiness_rules: RULES });
    assert.equal(alone.pattern.long, true);
    assert.equal(alone.pattern.days_of_decline, 7);
    assert.equal(alone.deload_signal, false);
    assert.equal(alone.decision, "trim");
    const all = run([...long, LOW_CHECKIN()], [session(addDays(TODAY, -1), BAD)], { readiness_rules: RULES });
    assert.equal(all.deload_signal, true);
    assert.equal(all.decision, "propose_deload");
    assert.equal(all.hold_progression, true);
    assert.deepEqual(all.rule_ids, ["R-LONG", "R-TRIAD"]);
    // 6 mornings is not the long pattern.
    assert.equal(run([...offBefore(5), todayRecord({ hrv_ms: 43 }), LOW_CHECKIN()], [session(addDays(TODAY, -1), BAD)]).decision, "trim");
    // Aversion on that day is a recovery day, and the deload signal stays visible for the week run.
    const c = checkin(2, 2, 4, 4);
    c.subjective!.want_to_train = 1;
    const av = run([...long, c], [session(addDays(TODAY, -1), BAD)]);
    assert.equal(av.decision, "recovery");
    assert.equal(av.deload_signal, true);
  });
});

describe("input errors", () => {
  test("malformed temperature throws READINESS_INPUT", () => {
    for (const temperature of [null, [], {}, { deviation_c: null }, { deviation_c: "x" }, { deviation_c: Number.NaN }, { deviation_c: Infinity }, { deviation_c: -6 }, { deviation_c: 9 }]) {
      assert.throws(() => run([{ ...todayRecord(), temperature } as DayRecord]), (e: unknown) => e instanceof CoachError && e.code === "READINESS_INPUT" && /temperature/.test(e.message));
    }
  });

  test("bad input throws CoachError", () => {
    assert.throws(() => run([], [], { today: "12/10/2026" }), CoachError);
    assert.throws(() => run([], [], { now: "2026-10-12T07:00:00" }), CoachError); // no offset
    assert.throws(() => run([], [], { tz: "Mars/Olympus" }), CoachError);
    assert.throws(() => run([checkin(0, 4, 2, 2)]), /subjective\.sleep_quality: must be a whole number from 1 to 5/);
    assert.throws(() => run([], [], { thresholds: { nope: 1 } as never }), /thresholds\.nope: unknown threshold/);
  });
});

describe("regressions", () => {
  test("temperature is shown, not scored, in baseline and current records", () => {
    const records = [...history(), todayRecord({ hrv_ms: 30 }), checkin(2, 2, 4, 4)];
    for (const deviation_c of [-5, 0, 0.21, 5]) {
      assert.deepEqual(run(records.map((r) => ({ ...r, temperature: { deviation_c } }))), run(records));
    }
  });

  const flat = (n = 30) => history({ n, hrv: () => 50, rhr: () => 55 });

  test("A3: a later sleep-only record does not hide a red HRV", () => {
    const hrvOnly: DayRecord = { date: TODAY, source: SRC, observed_at: `${TODAY}T06:30:00-07:00`, complete: true, hrv: { value_ms: 25, method: "sdnn" } };
    const sleepOnly: DayRecord = {
      date: TODAY, source: SRC, observed_at: `${TODAY}T06:45:00-07:00`, complete: true,
      sleep: { duration_min: 450, start_at: "2026-10-11T23:00:00-07:00", end_at: `${TODAY}T06:45:00-07:00` },
    };
    const r = run([...flat(), hrvOnly, sleepOnly]);
    assert.equal(r.wearable.state, "red");
  });

  test("A6: a sleep-only record with no history is calibrating, not amber", () => {
    const sleepOnly: DayRecord = {
      date: TODAY, source: SRC, observed_at: `${TODAY}T06:30:00-07:00`, complete: true,
      sleep: { duration_min: 300, start_at: "2026-10-11T23:00:00-07:00", end_at: `${TODAY}T06:30:00-07:00` },
    };
    const r = run([sleepOnly]);
    assert.equal(r.wearable.state, "unknown");
    assert.equal(r.wearable.calibrating, true);
  });

  test("A6: incomplete records are not valid baseline days", () => {
    const r = run([...history({ n: 30 }).map((x) => ({ ...x, complete: false })), todayRecord({ hrv_ms: 20 })]);
    assert.equal(r.wearable.calibrating, true);
    assert.equal(r.wearable.state, "unknown");
  });

  test("A7: two copies of one session are one observation (amber, not red)", () => {
    const s = session(TODAY, { completed_sets: 15 });
    assert.equal(run([], [s, { ...s }]).performance.state, "amber");
  });

  test("A7: an expired older session cannot make red", () => {
    const r = run([], [session(TODAY, { completed_sets: 15 }), session("2026-01-15", { completed_sets: 15 })]);
    assert.equal(r.performance.state, "amber");
    assert.deepEqual(r.performance.sessions_used, [TODAY]);
  });

  test("A8: out-of-range thresholds in the input are rejected", () => {
    assert.throws(() => run([...flat(), todayRecord()], [], { thresholds: { baseline_days_min: 0 } }), /baseline_days_min/);
    assert.throws(() => run([], [], { thresholds: { hrv_z_amber: Number.NaN } }), /hrv_z_amber/);
  });

  test("A9: an all-zero HRV baseline is not green", () => {
    const zeros = history({ n: 30, hrv: () => 0 });
    const today = todayRecord({ hrv_ms: 0 });
    delete today.rhr;
    delete today.sleep;
    const r = run([...zeros.map((x) => ({ ...x, rhr: undefined, sleep: undefined })), today]);
    assert.notEqual(r.wearable.state, "green");
  });
});
