import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { allowedSets, isCompleted, nextWeekTargets, referenceWeek, volumeIncreaseViolations } from "./progression.ts";
import { addDays } from "./dates.ts";
import { loadTaxonomy } from "./taxonomy.ts";
import { CoachError } from "./errors.ts";
import type { Block, Rules, WeekLog } from "./types.ts";

const tax = loadTaxonomy({ localPath: null });

const RULES: Rules = {
  pack: "test",
  version: 1,
  rules: [
    { id: "NA-PROG-001", text: "cap", kind: "sourced", severity: "hard", check: { type: "weekly_volume_increase_max", value: 0.1 } },
    { id: "NA-DEL-001", text: "depth", kind: "sourced", severity: "soft", check: { type: "deload_depth", value: { volume: 0.7, load: 0.7 } } },
    { id: "NA-DEL-002", text: "every", kind: "policy", severity: "soft", check: { type: "deload_every_weeks", value: 3 } },
  ],
};

// Week 1 starts Monday 2026-09-07. Weeks: build, build, build, deload, build, test.
const BLOCK: Block = {
  version: 1,
  id: "B-001",
  method: "nine-adaptations",
  template: { days: 4, emphasis: "all-around" },
  start: "2026-09-07",
  weeks: [
    { week: 1, kind: "build", sessions: 4, targets: { quads: 10, glutes: 10 } },
    { week: 2, kind: "build", sessions: 4, targets: { quads: 12, glutes: 11 } },
    { week: 3, kind: "build", sessions: 4, targets: { quads: 20 } },
    { week: 4, kind: "deload", sessions: 4 },
    { week: 5, kind: "build", sessions: 4, targets: { quads: 22 } },
    { week: 6, kind: "test", sessions: 2, targets: { quads: 6 } },
    { week: 7, kind: "build", sessions: 4, targets: { quads: 8, chest: 9 } },
  ],
  days: [],
};
const ws = (week: number) => addDays(BLOCK.start, 7 * (week - 1));

/** A logged week: `sessions` days, each with `setsPerDay` hard sets of `name`. */
function log(week: number, sessions: number, setsPerDay = 5, name = "Leg Extension"): WeekLog {
  return {
    week_start: ws(week),
    days: Array.from({ length: sessions }, (_, i) => ({
      date: addDays(ws(week), i),
      exercises: [{ name, sets: Array.from({ length: setsPerDay }, () => ({ weight: 50, reps: 10 })) }],
    })),
  };
}

describe("referenceWeek", () => {
  test("the reference week skips deload and test weeks", () => {
    const logs = [log(1, 4), log(2, 4), log(3, 4), log(4, 4), log(5, 4), log(6, 2)];
    assert.equal(referenceWeek(BLOCK, logs, addDays(ws(5), 2))?.week_start, ws(3)); // week 4 is a deload
    assert.equal(referenceWeek(BLOCK, logs, addDays(ws(7), 0))?.week_start, ws(5)); // week 6 is a test
  });

  test("a missed week keeps the old reference", () => {
    const logs = [log(1, 4), log(2, 4), log(3, 1)]; // week 3: 1 of 4 sessions
    assert.equal(referenceWeek(BLOCK, logs, ws(4))?.week_start, ws(2));
    // Exactly 50% counts as completed.
    assert.equal(isCompleted(BLOCK, log(3, 2)), true);
    assert.equal(referenceWeek(BLOCK, [log(2, 4), log(3, 2)], ws(4))?.week_start, ws(3));
  });

  test("the current week is never the reference, even when complete", () => {
    assert.equal(referenceWeek(BLOCK, [log(1, 4), log(2, 4)], addDays(ws(2), 6))?.week_start, ws(1));
  });

  test("sessions outside the week are rejected", () => {
    const l = log(3, 4);
    l.days = l.days.map((d, i) => (i < 3 ? { ...d, date: addDays(d.date, -7) } : d));
    assert.throws(() => isCompleted(BLOCK, l), /outside the week/);
  });

  test("no completed build week gives null (bootstrap)", () => {
    assert.equal(referenceWeek(BLOCK, [log(1, 1)], ws(2)), null);
  });

  test("week_start must be a Monday", () => {
    assert.throws(() => referenceWeek(BLOCK, [{ ...log(1, 4), week_start: "2026-09-08" }], ws(3)), CoachError);
  });
});

describe("nextWeekTargets", () => {
  test("bootstrap from block week 1 as planned", () => {
    const t = nextWeekTargets(BLOCK, null, RULES, { week: 2 });
    assert.equal(t.reference.source, "bootstrap");
    assert.equal(t.reference.week_start, ws(1));
    // Week 2 plans quads 12 over a base of 10: +20%, capped at 11. Glutes 11 is fine.
    assert.deepEqual(t.sets, { glutes: 11, quads: 11 });
    assert.deepEqual(t.capped, [{ muscle: "quads", base: 10, planned: 12, allowed: 11 }]);
    assert.deepEqual(t.rule_ids, ["NA-PROG-001"]);
  });

  test("a deload week keeps deload_depth of the reference volume and load", () => {
    const ref = log(3, 4, 5); // 20 quad sets
    const t = nextWeekTargets(BLOCK, ref, RULES, { tax, week: 4 });
    assert.equal(t.kind, "deload");
    assert.deepEqual(t.sets, { quads: 14 });
    assert.equal(t.load_factor, 0.7);
    assert.ok(t.rule_ids.includes("NA-DEL-001"));
  });

  test("the deload-to-build transition returns to the pre-deload level plus one step", () => {
    const logs = [log(3, 4, 5), log(4, 4, 3)]; // week 3: 20 sets; deload week 4: 12 sets
    const ref = referenceWeek(BLOCK, logs, ws(5));
    assert.equal(ref?.week_start, ws(3));
    const t = nextWeekTargets(BLOCK, ref, RULES, { tax, week: 5 });
    // 22 = 20 + 10%: allowed. Measured against the deload week (12) it would cap at 13.
    assert.deepEqual(t.sets, { quads: 22 });
    assert.deepEqual(t.capped, []);
    const tooFar = nextWeekTargets({ ...BLOCK, weeks: BLOCK.weeks.map((w) => (w.week === 5 ? { ...w, targets: { quads: 24 } } : w)) }, ref, RULES, { tax, week: 5 });
    assert.deepEqual(tooFar.sets, { quads: 22 });
  });

  test("a base under 10 sets allows +1", () => {
    const ref = log(5, 4, 2); // 8 quad sets
    const t = nextWeekTargets(BLOCK, ref, RULES, { tax, week: 7 });
    // 8 → 9 is +12.5% but allowed; chest has no base (0) and gets +1 only.
    assert.deepEqual(t.sets, { chest: 1, quads: 8 });
    const t9 = nextWeekTargets({ ...BLOCK, weeks: BLOCK.weeks.map((w) => (w.week === 7 ? { ...w, targets: { quads: 9 } } : w)) }, ref, RULES, { tax, week: 7 });
    assert.deepEqual(t9.sets, { quads: 9 });
    assert.deepEqual(t9.capped, []);
    assert.equal(allowedSets(8, 0.1), 9);
    assert.equal(allowedSets(9, 0.1), 10);
    assert.equal(allowedSets(10, 0.1), 11);
  });

  test("a deload is flagged as due after deload_every_weeks build weeks", () => {
    const b: Block = { ...BLOCK, weeks: BLOCK.weeks.map((w) => (w.week === 4 ? { ...w, kind: "build", targets: { quads: 20 } } : w)) };
    const t = nextWeekTargets(b, log(3, 4, 5), RULES, { tax, week: 4 });
    assert.match(t.warnings.join(" "), /deload due: 3 build weeks in a row/);
  });

  test("a logged reference needs the taxonomy", () => {
    assert.throws(() => nextWeekTargets(BLOCK, log(2, 4), RULES, { week: 3 }), /needs opts\.tax/);
  });

  test("a pack without a cap rule falls back to 10% with a warning", () => {
    const t = nextWeekTargets(BLOCK, null, { pack: "x", version: 1, rules: [] }, { week: 2 });
    assert.deepEqual(t.sets.quads, 11);
    assert.match(t.warnings.join(" "), /no weekly_volume_increase_max rule/);
  });
});

describe("weekly volume cap", () => {
  test("galpin audit 2026-09-26: +8 sets on a 64-set base (+12.5%) is over the 10% cap", () => {
    const v = volumeIncreaseViolations({ quads: 64 }, { quads: 72 }, 0.1);
    assert.equal(v.length, 1);
    assert.equal(v[0].muscle, "quads");
    assert.equal(v[0].allowed, 70);
    assert.equal(v[0].increase_ratio, 0.125);
    // The same step through nextWeekTargets is capped and reported.
    const b: Block = { ...BLOCK, weeks: [{ week: 1, kind: "build", sessions: 4, targets: { quads: 64 } }, { week: 2, kind: "build", sessions: 4, targets: { quads: 72 } }] };
    const t = nextWeekTargets(b, null, RULES, { week: 2 });
    assert.deepEqual(t.sets, { quads: 70 });
    assert.deepEqual(t.capped, [{ muscle: "quads", base: 64, planned: 72, allowed: 70 }]);
  });

  test("an increase inside the cap is not flagged", () => {
    assert.deepEqual(volumeIncreaseViolations({ quads: 64, chest: 8 }, { quads: 70, chest: 9 }, 0.1), []);
  });
});

describe("regressions", () => {
  test("A4: a reference log with sets dated the next Monday cannot raise the base", () => {
    const ref = log(1, 2, 32); // 64 quad sets in week 1
    ref.days.push({ date: ws(2), exercises: [{ name: "Leg Extension", sets: Array.from({ length: 8 }, () => ({ weight: 50, reps: 10 })) }] });
    const b: Block = { ...BLOCK, weeks: [{ week: 1, kind: "build", sessions: 2, targets: { quads: 64 } }, { week: 2, kind: "build", sessions: 2, targets: { quads: 72 } }] };
    assert.throws(() => nextWeekTargets(b, ref, RULES, { tax, week: 2 }), /outside the week/);
    assert.throws(() => isCompleted(b, ref), /outside the week/);
  });

  test("A10: the target week must be given; it is never guessed from the reference", () => {
    assert.throws(() => nextWeekTargets(BLOCK, log(3, 4, 5), RULES, { tax }), /week is required/);
  });
});
