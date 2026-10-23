import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { loadConfig, validateConfig, ALL_KINDS } from "./config.ts";
import { CoachError } from "./errors.ts";

const EXAMPLE = new URL("../coach.example.yaml", import.meta.url).pathname;
const base = () => parse(readFileSync(EXAMPLE, "utf8"));

function expectInvalid(raw: unknown, pattern: RegExp) {
  assert.throws(
    () => validateConfig(raw),
    (e: unknown) => e instanceof CoachError && e.code === "CONFIG_INVALID" && pattern.test(e.message),
  );
}

test("the example config loads", () => {
  const cfg = loadConfig(EXAMPLE);
  assert.equal(cfg.athlete.timezone, "America/Los_Angeles");
  assert.equal(cfg.template.days, 4);
  assert.deepEqual(cfg.thresholds, { pain_threshold: 4 }, "0.3.0: the pain threshold is in coach.yaml");
  assert.ok(cfg.approval.auto.includes("annotate"));
});

test("unknown top-level key is an error", () => {
  expectInvalid({ ...base(), colour: "blue" }, /colour: unknown key/);
});

test("unknown nested key is an error", () => {
  const raw = base();
  raw.athlete.age = 40;
  expectInvalid(raw, /athlete\.age: unknown key/);
});

test("unknown threshold key is an error", () => {
  expectInvalid({ ...base(), thresholds: { hrv_z_purple: 1 } }, /thresholds\.hrv_z_purple: unknown key/);
});

test("threshold overrides must be numbers and are kept", () => {
  expectInvalid({ ...base(), thresholds: { hrv_z_amber: "low" } }, /thresholds\.hrv_z_amber: must be a number/);
  const cfg = validateConfig({ ...base(), thresholds: { hrv_z_amber: -1.5 } });
  assert.deepEqual(cfg.thresholds, { hrv_z_amber: -1.5 });
});

test("a kind in both auto and ask is an error", () => {
  const raw = base();
  raw.approval.ask.push("trim_session");
  expectInvalid(raw, /trim_session appears in both auto and ask/);
});

test("a duplicate kind inside one list is an error", () => {
  const raw = base();
  raw.approval.auto.push("trim_session");
  expectInvalid(raw, /duplicate kind trim_session/);
});

test("a hard-rule kind in auto is an error", () => {
  const raw = base();
  raw.approval.ask = raw.approval.ask.filter((k: string) => k !== "new_exercise");
  raw.approval.auto.push("new_exercise");
  expectInvalid(raw, /new_exercise is a hard-rule kind and cannot be in auto/);
});

test("an unknown change kind is an error", () => {
  const raw = base();
  raw.approval.auto.push("yolo");
  expectInvalid(raw, /unknown change kind "yolo"/);
});

test("a kind listed nowhere is treated as ask (fail closed)", () => {
  const raw = base();
  raw.approval.auto = ["trim_session"];
  const cfg = validateConfig(raw);
  assert.deepEqual(cfg.approval.auto, ["trim_session"]);
  assert.ok(cfg.approval.ask.includes("load_progression"));
  assert.equal(cfg.approval.auto.length + cfg.approval.ask.length, ALL_KINDS.length);
});

const badEnums: [string, (r: any) => void, RegExp][] = [
  ["units", (r) => (r.athlete.units = "stone"), /athlete\.units: must be one of lbs \| kg/],
  ["timezone", (r) => (r.athlete.timezone = "Mars/Olympus"), /athlete\.timezone: must be an IANA timezone/],
  ["days", (r) => (r.template.days = 6), /template\.days: must be one of 3 \| 4 \| 5/],
  ["emphasis", (r) => (r.template.emphasis = "bulk"), /template\.emphasis: must be one of/],
  ["wearable", (r) => (r.signals.wearable = "whoop"), /signals\.wearable: must be one of/],
  ["checkin", (r) => (r.signals.checkin = "email"), /signals\.checkin: must be one of/],
  ["mode", (r) => (r.automation.mode = "cron"), /automation\.mode: must be one of/],
  ["weekly day", (r) => (r.automation.weekly.day = "sunday"), /automation\.weekly\.day: must be one of/],
  ["window time", (r) => (r.automation.daily_window.start = "5:07"), /daily_window\.start: must be HH:MM/],
  ["window order", (r) => (r.automation.daily_window.start = "11:00"), /start must be before end/],
  ["verified", (r) => (r.automation.verified = "yes"), /automation\.verified: must be true or false/],
  ["version", (r) => (r.version = 2), /version: must be 1/],
  ["method", (r) => (r.method = "../etc"), /method: must be a folder name/],
];
for (const [name, mutate, pattern] of badEnums) {
  test(`bad enum or format: ${name}`, () => {
    const raw = base();
    mutate(raw);
    expectInvalid(raw, pattern);
  });
}

test("a missing required key is an error", () => {
  const raw = base();
  delete raw.approval;
  expectInvalid(raw, /approval: is required/);
});

test("automation defaults to manual when absent", () => {
  const raw = base();
  delete raw.automation;
  assert.equal(validateConfig(raw).automation.mode, "manual");
});

test("loadConfig reports parse errors and duplicate keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "coach-config-"));
  const p = join(dir, "coach.yaml");
  writeFileSync(p, "version: 1\nversion: 1\n");
  assert.throws(() => loadConfig(p), (e: unknown) => e instanceof CoachError && /cannot parse/.test(e.message));
  assert.throws(() => loadConfig(join(dir, "missing.yaml")), (e: unknown) => e instanceof CoachError && /cannot read/.test(e.message));
});

test("all errors are reported together", () => {
  const raw = base();
  raw.athlete.units = "stone";
  raw.template.days = 9;
  assert.throws(() => validateConfig(raw), (e: unknown) => {
    const m = (e as Error).message;
    return /athlete\.units/.test(m) && /template\.days/.test(m);
  });
});

const badThresholds: [string, Record<string, number>, RegExp][] = [
  ["baseline_days_min 0", { baseline_days_min: 0 }, /thresholds\.baseline_days_min/],
  ["baseline_days_min not whole", { baseline_days_min: 14.5 }, /thresholds\.baseline_days_min/],
  ["baseline_days_min above the window", { baseline_days_min: 43 }, /baseline_days_min/],
  ["hrv_z_amber positive", { hrv_z_amber: 1 }, /thresholds\.hrv_z_amber/],
  ["hrv red above amber", { hrv_z_red: -0.5 }, /hrv_z_red/],
  ["rhr red below amber", { rhr_z_red: 0.5 }, /rhr_z_red/],
  ["sleep ratio above 1", { sleep_ratio_amber: 1.5 }, /thresholds\.sleep_ratio_amber/],
  ["subjective red above amber", { subjective_red: 3 }, /subjective_red/],
  ["infinite expiry", { perf_expiry_days: Infinity }, /thresholds\.perf_expiry_days/],
  ["trim fraction 1", { trim_fraction: 1 }, /thresholds\.trim_fraction/],
];
for (const [name, th, pattern] of badThresholds) {
  test(`A8: out-of-range threshold is an error: ${name}`, () => {
    expectInvalid({ ...base(), thresholds: th }, pattern);
  });
}
