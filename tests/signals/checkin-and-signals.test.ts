// Chat check-ins (adapters/signals/checkin/write.ts) and the signal loader (engine/signals.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize } from "../../adapters/signals/apple-health-shortcut/normalize.ts";
import { signalPath, writeCheckin } from "../../adapters/signals/checkin/write.ts";
import { CoachError } from "../../engine/errors.ts";
import { loadSignals } from "../../engine/signals.ts";
import type { DayRecord } from "../../engine/types.ts";

const NOW = "2026-10-10T08:00:00-07:00";
const SHORTCUT = readFileSync(new URL("./fixtures/shortcut/2026-10-10.json", import.meta.url), "utf8");
const ANSWERS = { sleep_quality: 2 as const, energy: 2 as const, soreness: 4 as const, stress: 3 as const };

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-signals-"));
  mkdirSync(join(dir, "athlete/signals"), { recursive: true });
  return dir;
}

function readFile(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("checkin: no file → a new chat file", () => {
  const dir = root();
  const r = writeCheckin({ root: dir, date: "2026-10-10", answers: { ...ANSWERS, pain: [{ region: "low-back", score: 3 }] }, now: NOW });
  assert.equal(r.action, "created");
  assert.equal(r.replaced, null);
  const f = readFile(signalPath(dir, "2026-10-10"));
  assert.equal(f.source, "chat");
  assert.equal(f.checkin.source, "chat");
  assert.deepEqual(f.checkin.pain, [{ region: "low-back", score: 3 }]);
  const recs = normalize(f, { now: NOW });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].source, "chat");
  assert.equal(recs[0].complete, false, "complete only when sleep is present (contracts §11)");
  assert.equal(recs[0].subjective!.energy, 2);
});

test("checkin: a Shortcut file → merged; wearable data and both sources kept", () => {
  const dir = root();
  writeFileSync(signalPath(dir, "2026-10-10"), SHORTCUT);
  const r = writeCheckin({ root: dir, date: "2026-10-10", answers: ANSWERS, now: NOW });
  assert.equal(r.action, "merged");
  assert.deepEqual(r.replaced, { source: "apple-health-shortcut", submitted_at: "2026-10-10T06:41:12-07:00" });
  const f = readFile(signalPath(dir, "2026-10-10"));
  const orig = JSON.parse(SHORTCUT);
  assert.equal(f.source, "apple-health-shortcut");
  assert.equal(f.submitted_at, orig.submitted_at);
  assert.deepEqual([f.sleep, f.hrv, f.rhr], [orig.sleep, orig.hrv, orig.rhr]);
  assert.equal(f.checkin.source, "chat");
  const recs = normalize(f, { now: NOW });
  assert.deepEqual(recs.map((x) => x.source), ["apple-health-shortcut", "chat"]);
});

test("checkin: a second chat check-in replaces the first", () => {
  const dir = root();
  writeCheckin({ root: dir, date: "2026-10-10", answers: ANSWERS, now: "2026-10-10T07:00:00-07:00" });
  const r = writeCheckin({ root: dir, date: "2026-10-10", answers: { ...ANSWERS, energy: 5 }, now: NOW });
  assert.equal(r.action, "merged");
  assert.equal(r.replaced?.source, "chat");
  const f = readFile(signalPath(dir, "2026-10-10"));
  assert.equal(f.checkin.energy, 5);
  assert.equal(f.submitted_at, NOW);
});

test("checkin: refuses to merge into an invalid file, and rejects bad answers", () => {
  const dir = root();
  writeFileSync(signalPath(dir, "2026-10-10"), JSON.stringify({ ...JSON.parse(SHORTCUT), hrv: { value_ms: "x" } }));
  assert.throws(() => writeCheckin({ root: dir, date: "2026-10-10", answers: ANSWERS, now: NOW }), (e: unknown) => e instanceof CoachError && e.code === "SIGNAL_INVALID");
  writeFileSync(signalPath(dir, "2026-10-10"), "{not json");
  assert.throws(() => writeCheckin({ root: dir, date: "2026-10-10", answers: ANSWERS, now: NOW }), /cannot read/);
  assert.throws(() => writeCheckin({ root: root(), date: "2026-10-10", answers: { ...ANSWERS, energy: 7 as never }, now: NOW }), /energy: must be 5 or less/);
  assert.throws(() => writeCheckin({ root: root(), date: "10/10/2026", answers: ANSWERS, now: NOW }), /YYYY-MM-DD/);
});

function oura(date: string, complete: boolean, observed_at: string, hrv = 40): DayRecord {
  return { date, source: "oura", observed_at, complete, hrv: { value_ms: hrv, method: "rmssd" } };
}

test("signals: Shortcut files and the Oura cache load side by side, sources never merged", () => {
  const dir = root();
  writeFileSync(signalPath(dir, "2026-10-10"), SHORTCUT);
  writeCheckin({ root: dir, date: "2026-10-09", answers: ANSWERS, now: "2026-10-09T07:00:00-07:00" });
  mkdirSync(join(dir, "athlete/.cache/signals"), { recursive: true });
  writeFileSync(
    join(dir, "athlete/.cache/signals/oura.json"),
    JSON.stringify([
      oura("2026-10-08", true, "2026-10-08T06:00:00-07:00"),
      oura("2026-10-10", true, "2026-10-10T06:31:12-07:00", 39),
      oura("2026-10-11", true, "2026-10-11T06:00:00-07:00"),
    ]),
  );
  const r = loadSignals({ root: dir, from: "2026-10-09", to: "2026-10-10", now: NOW });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(
    r.records.map((x) => [x.date, x.source, x.hrv?.method ?? null]),
    [
      ["2026-10-09", "chat", null],
      ["2026-10-10", "apple-health-shortcut", "sdnn"],
      ["2026-10-10", "oura", "rmssd"],
    ],
  );
});

test("signals: one record per source and date, the complete one preferred, then the latest", () => {
  const dir = root();
  mkdirSync(join(dir, "athlete/.cache/signals"), { recursive: true });
  writeFileSync(
    join(dir, "athlete/.cache/signals/oura.json"),
    JSON.stringify([
      oura("2026-10-10", true, "2026-10-10T06:00:00-07:00", 41),
      oura("2026-10-10", false, "2026-10-10T07:00:00-07:00", 50),
      oura("2026-10-09", true, "2026-10-09T06:00:00-07:00", 41),
      oura("2026-10-09", true, "2026-10-09T06:30:00-07:00", 45),
    ]),
  );
  const r = loadSignals({ root: dir, from: "2026-10-09", to: "2026-10-10", now: NOW });
  assert.deepEqual(r.records.map((x) => [x.date, x.hrv!.value_ms]), [["2026-10-09", 45], ["2026-10-10", 41]]);
});

test("signals: bad files are skipped with warnings, not thrown", () => {
  const dir = root();
  writeFileSync(signalPath(dir, "2026-10-09"), "{oops");
  writeFileSync(signalPath(dir, "2026-10-10"), JSON.stringify({ ...JSON.parse(SHORTCUT), date: "2026-10-11" }));
  writeFileSync(join(dir, "athlete/signals/notes.json"), "{}");
  mkdirSync(join(dir, "athlete/.cache/signals"), { recursive: true });
  writeFileSync(join(dir, "athlete/.cache/signals/oura.json"), JSON.stringify([oura("2026-10-10", true, "2026-10-10T09:00:00-07:00"), { date: "2026-10-10" }]));
  writeFileSync(join(dir, "athlete/.cache/signals/other.json"), JSON.stringify({ not: "an array" }));
  const r = loadSignals({ root: dir, from: "2026-10-01", to: "2026-10-31", now: NOW });
  assert.deepEqual(r.records, []);
  assert.equal(r.warnings.length, 5, r.warnings.join("\n"));
  assert.ok(r.warnings.some((w) => /2026-10-10\.json skipped: .*does not match its file name/.test(w)));
  assert.ok(r.warnings.some((w) => /oura\.json\[0\] skipped: observed_at .* is in the future/.test(w)));
});

test("signals: an empty repo gives no records; bad ranges are usage errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "coach-signals-empty-"));
  assert.deepEqual(loadSignals({ root: dir, from: "2026-10-01", to: "2026-10-02", now: NOW }).records, []);
  assert.throws(() => loadSignals({ root: dir, from: "2026-10-03", to: "2026-10-02" }), (e: unknown) => e instanceof CoachError && e.code === "USAGE");
  assert.throws(() => loadSignals({ root: dir, from: "yesterday", to: "2026-10-02" }), (e: unknown) => e instanceof CoachError && e.code === "USAGE");
});

test("signals: malformed cached records become per-record warnings; the rest still load", () => {
  const dir = root();
  mkdirSync(join(dir, "athlete/.cache/signals"), { recursive: true });
  const ok = oura("2026-10-10", true, "2026-10-10T06:00:00-07:00");
  const base = { date: "2026-10-09", source: "oura", observed_at: "2026-10-09T06:00:00-07:00", complete: true };
  const bad = [
    { ...base, hrv: null },
    { ...base, sleep: null },
    { ...base, rhr: null },
    { ...base, subjective: null },
    { ...base, hrv: { value_ms: "41", method: "rmssd" } },
    { ...base, hrv: { value_ms: 41 } },
    { ...base, rhr: { bpm: -3 } },
    { ...base, sleep: { duration_min: 400, start_at: "yesterday", end_at: "2026-10-09T06:00:00-07:00" } },
    { ...base, subjective: { sleep_quality: 9, energy: 3, soreness: 3, stress: 3 } },
    { ...base, subjective: { sleep_quality: 3, energy: 3, soreness: 3, stress: 3, pain: [{ region: 4, score: 2 }] } },
    { ...base, vendor_score: "high" },
    { ...base, complete: "yes" },
  ];
  writeFileSync(join(dir, "athlete/.cache/signals/oura.json"), JSON.stringify([...bad, ok]));
  const r = loadSignals({ root: dir, from: "2026-10-09", to: "2026-10-10", now: NOW });
  assert.deepEqual(r.records, [ok]);
  assert.equal(r.warnings.length, bad.length, r.warnings.join("\n"));
  bad.forEach((_, i) => assert.ok(r.warnings.some((w) => w.includes(`oura.json[${i}] skipped`)), `warning for record ${i}`));
});
