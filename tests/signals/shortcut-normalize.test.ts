// The Shortcut signal file: schema validation and the mapping to DayRecord (contracts §5, §11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalize, validateSignalFile } from "../../adapters/signals/apple-health-shortcut/normalize.ts";
import { CoachError } from "../../engine/errors.ts";

const NOW = "2026-10-10T08:00:00-07:00";
const FULL = JSON.parse(readFileSync(new URL("./fixtures/shortcut/2026-10-10.json", import.meta.url), "utf8"));

function file(patch: Record<string, unknown> = {}, drop: string[] = []): Record<string, unknown> {
  const f: Record<string, unknown> = { ...structuredClone(FULL), ...patch };
  for (const k of drop) delete f[k];
  return f;
}

function invalid(raw: unknown, re: RegExp, opts: Parameters<typeof normalize>[1] = { now: NOW }) {
  assert.throws(
    () => normalize(raw, opts),
    (e: unknown) => e instanceof CoachError && e.code === "SIGNAL_INVALID" && re.test(e.message),
  );
}

test("valid full file → one complete record with every block", () => {
  const recs = normalize(FULL, { now: NOW, expectDate: "2026-10-10" });
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0], {
    date: "2026-10-10",
    source: "apple-health-shortcut",
    observed_at: "2026-10-10T06:17:00-07:00",
    complete: true,
    sleep: { duration_min: 412, start_at: "2026-10-09T23:05:00-07:00", end_at: "2026-10-10T06:17:00-07:00" },
    hrv: { value_ms: 41.8, method: "sdnn" },
    rhr: { bpm: 54 },
    subjective: { sleep_quality: 3, energy: 4, soreness: 2, stress: 3, pain: [{ region: "left-knee", score: 2 }] },
    // V6 A.6: when the check-in was answered, so pain is handled once per check-in.
    checkin_at: FULL.submitted_at,
  });
});

test("temperature: kept on the source record, including temperature alone", () => {
  for (const deviation_c of [-5, 0, 0.12, 5]) {
    const temperature = { deviation_c };
    const full = normalize(file({ temperature }), { now: NOW });
    assert.deepEqual(full[0].temperature, temperature);
    const alone = normalize(file({ temperature }, ["sleep", "hrv", "rhr", "checkin"]), { now: NOW });
    assert.deepEqual(alone, [{ date: FULL.date, source: FULL.source, observed_at: FULL.submitted_at, complete: false, temperature }]);
  }
});

test("temperature: malformed blocks are rejected", () => {
  for (const temperature of [null, [], {}, { deviation_c: null }, { deviation_c: "x" }, { deviation_c: Number.NaN }, { deviation_c: Infinity }, { deviation_c: -6 }, { deviation_c: 9 }]) {
    invalid(file({ temperature }), /\$\.temperature/);
  }
});

test("missing optional blocks", () => {
  // No check-in: wearable only.
  const noCheckin = normalize(file({}, ["checkin"]), { now: NOW });
  assert.equal(noCheckin[0].subjective, undefined);
  assert.equal(noCheckin[0].complete, true);

  // No sleep: incomplete, observed_at falls back to submitted_at.
  const noSleep = normalize(file({}, ["sleep"]), { now: NOW });
  assert.equal(noSleep[0].complete, false);
  assert.equal(noSleep[0].observed_at, FULL.submitted_at);
  assert.equal(noSleep[0].sleep, undefined);

  // Check-in only.
  const checkinOnly = normalize(file({}, ["sleep", "hrv", "rhr"]), { now: NOW });
  assert.equal(checkinOnly.length, 1);
  assert.equal(checkinOnly[0].complete, false);
  assert.ok(checkinOnly[0].subjective);

  // Header only: nothing to report.
  assert.deepEqual(normalize(file({}, ["sleep", "hrv", "rhr", "checkin"]), { now: NOW }), []);

  // No pain list, and an empty one, both mean no pain. V6 B.3: the empty list is kept ("no pain now").
  const c = { ...FULL.checkin };
  delete c.pain;
  assert.equal(normalize(file({ checkin: c }), { now: NOW })[0].subjective!.pain, undefined);
  assert.deepEqual(normalize(file({ checkin: { ...c, pain: [] } }), { now: NOW })[0].subjective!.pain, []);
});

test("wrong types are rejected with the path", () => {
  invalid(file({ version: 2 }), /\$\.version: must be 1/);
  invalid(file({ sleep: { ...FULL.sleep, duration_min: "412" } }), /\$\.sleep\.duration_min: must be a number/);
  invalid(file({ checkin: { ...FULL.checkin, energy: 6 } }), /\$\.checkin\.energy: must be 5 or less/);
  invalid(file({ checkin: { ...FULL.checkin, energy: 2.5 } }), /\$\.checkin\.energy: must be an integer/);
  invalid(file({ rhr: "54" }), /\$\.rhr: must be an object/);
  invalid(file({ hrv: { value_ms: 41.8, method: "sdnn", extra: 1 } }), /\$\.hrv\.extra: is not allowed/);
  invalid(file({ steps: 9000 }), /\$\.steps: is not allowed/);
  invalid(file({ date: "2026-02-30" }), /not a calendar date/);
  invalid(file({ submitted_at: "2026-10-10 06:41" }), /submitted_at: does not match/);
  invalid(file({ checkin: { ...FULL.checkin, pain: [{ region: "Left Knee", score: 2 }] } }), /pain\[0\]\.region: does not match/);
  invalid(file({ checkin: { ...FULL.checkin, pain: [{ region: "left-knee", score: 11 }] } }), /pain\[0\]\.score: must be 10 or less/);
  invalid(file({}, ["submitted_at"]), /\$\.submitted_at: is required/);
  invalid([], /\$: must be an object/);
  invalid(file({ sleep: { ...FULL.sleep, start_at: FULL.sleep.end_at } }), /start_at must be before/);
});

test("a future submitted_at or sleep end is rejected", () => {
  invalid(file({ submitted_at: "2026-10-10T09:00:00-07:00" }), /submitted_at .* is in the future/);
  invalid(file({ sleep: { ...FULL.sleep, end_at: "2026-10-10T08:30:00-07:00" } }), /sleep\.end_at .* is in the future/);
  // The same file is fine once now is later.
  assert.equal(normalize(file({ submitted_at: "2026-10-10T09:00:00-07:00" }), { now: "2026-10-10T09:00:00-07:00" }).length, 1);
});

test("HRV method: sdnn unless the file says rmssd; anything else is rejected", () => {
  assert.equal(normalize(file({ hrv: { value_ms: 40 } }), { now: NOW })[0].hrv!.method, "sdnn");
  assert.equal(normalize(file({ hrv: { value_ms: 40, method: "rmssd" } }), { now: NOW })[0].hrv!.method, "rmssd");
  invalid(file({ hrv: { value_ms: 40, method: "RMSSD" } }), /\$\.hrv\.method: must be one of/);
  invalid(file({ hrv: { value_ms: 40, method: "pnn50" } }), /\$\.hrv\.method: must be one of/);
});

test("the file date must match the file name", () => {
  invalid(FULL, /does not match its file name \(2026-10-11\)/, { now: NOW, expectDate: "2026-10-11" });
});

test("a chat check-in merged into a Shortcut file becomes its own record", () => {
  const recs = normalize(file({ checkin: { ...FULL.checkin, source: "chat", submitted_at: "2026-10-10T07:30:00-07:00" } }), { now: NOW });
  assert.equal(recs.length, 2);
  assert.equal(recs[0].source, "apple-health-shortcut");
  assert.equal(recs[0].subjective, undefined);
  assert.deepEqual(
    { source: recs[1].source, observed_at: recs[1].observed_at, complete: recs[1].complete, energy: recs[1].subjective?.energy },
    { source: "chat", observed_at: "2026-10-10T07:30:00-07:00", complete: false, energy: 4 },
  );
});

test("validateSignalFile returns the typed file", () => {
  const f = validateSignalFile(FULL, { now: NOW });
  assert.equal(f.hrv?.samples, 6);
});
