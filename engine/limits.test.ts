import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { limitsHash, loadLimits, validateLimits } from "./limits.ts";
import { parse } from "yaml";
const validateLimitsFromYaml = (text: string) => parse(text);
import { CoachError } from "./errors.ts";
import type { Taxonomy } from "./types.ts";

const TEMPLATE = new URL("../templates/athlete/limits.yaml", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "coach-limits-"));
let n = 0;
function file(text: string): string {
  const p = join(dir, `limits-${n++}.yaml`);
  writeFileSync(p, text);
  return p;
}

const tax: Taxonomy = {
  version: 1,
  regions: ["knee", "left-knee", "low-back"],
  patterns: {
    squat: { loads: ["knee"], muscles: ["quads"], recovery: false },
    loaded_deep_knee_flexion: { loads: ["knee"], muscles: [], recovery: false },
    hinge: { loads: ["low-back"], muscles: ["hamstrings"], recovery: false },
  },
  keywords: {},
  exercises: {},
};

const EXAMPLE = `version: 1
pain_threshold: 4
limits:
  - id: L-001
    region: left-knee
    rule: ban
    patterns: [loaded_deep_knee_flexion]
    exercises: ["Barbell Back Squat"]
    allow: ["Box Squat"]
    note: "No deep squats under load"
    source: athlete
    since: 2026-10-09
  - id: L-002
    region: low-back
    rule: cap
    patterns: [hinge]
    max_load: { value: 135, unit: lbs }
    max_sets_per_week: 6
    note: "Hinge capped while rehabbing"
    source: clinician-reported
    since: 2026-10-01
`;

function expectInvalid(raw: unknown, pattern: RegExp, t?: Taxonomy) {
  assert.throws(
    () => validateLimits(raw, t),
    (e: unknown) => e instanceof CoachError && e.code === "LIMITS_INVALID" && pattern.test(e.message),
  );
}
const one = (l: Record<string, unknown>) => ({
  version: 1,
  pain_threshold: 4,
  limits: [{ id: "L-001", region: "knee", rule: "ban", patterns: ["squat"], source: "athlete", since: "2026-10-09", ...l }],
});

test("the template loads: no limits, pain threshold 4", () => {
  const l = loadLimits(TEMPLATE);
  assert.deepEqual(l, { version: 1, pain_threshold: 4, limits: [] });
});

test("the contract example loads with the taxonomy", () => {
  const l = loadLimits(file(EXAMPLE), tax);
  assert.equal(l.limits.length, 2);
  assert.equal(l.limits[0].since, "2026-10-09");
  assert.deepEqual(l.limits[1].max_load, { value: 135, unit: "lbs" });
  assert.deepEqual(l.limits[1].allow, []);
});

test("validation errors", () => {
  expectInvalid(one({ id: "L-1" }), /id: must look like L-001/);
  expectInvalid({ ...one({}), limits: [one({}).limits[0], one({}).limits[0]] }, /duplicate id L-001/);
  expectInvalid(one({ rule: "maybe" }), /rule: must be ban \| cap/);
  expectInvalid(one({ patterns: [], exercises: [] }), /needs patterns or exercises/);
  expectInvalid(one({ rule: "cap" }), /a cap needs max_load or max_sets_per_week/);
  expectInvalid(one({ max_sets_per_week: 3 }), /a ban cannot carry/);
  expectInvalid(one({ rule: "cap", max_load: { value: 100, unit: "stone" } }), /max_load: must be/);
  expectInvalid(one({ rule: "cap", max_sets_per_week: 2.5 }), /max_sets_per_week: must be a whole number/);
  expectInvalid(one({ source: "doctor" }), /source: must be athlete \| clinician-reported/);
  expectInvalid(one({ since: "yesterday" }), /since: must be a date/);
  expectInvalid(one({ colour: "red" }), /colour: unknown key/);
  expectInvalid({ ...one({}), pain_threshold: 11 }, /pain_threshold: must be a number from 0 to 10/);
  expectInvalid({ version: 1, pain_threshold: 4 }, /limits: must be a list/);
});

test("with a taxonomy, regions and patterns must be known", () => {
  expectInvalid(one({ region: "elbow" }), /unknown region elbow/, tax);
  expectInvalid(one({ patterns: ["moonwalk"] }), /unknown pattern moonwalk/, tax);
  assert.doesNotThrow(() => validateLimits(one({ region: "elbow" })));
});

test("limitsHash is stable across key order, comments and flow style", () => {
  const reordered = `# reordered
limits:
  - since: 2026-10-09
    source: athlete
    note: "No deep squats under load"
    allow: ["Box Squat"]
    exercises: ["Barbell Back Squat"]
    patterns: [loaded_deep_knee_flexion]
    rule: ban
    region: left-knee
    id: L-001
  - { since: 2026-10-01, source: clinician-reported, note: "Hinge capped while rehabbing", max_sets_per_week: 6, max_load: { unit: lbs, value: 135 }, patterns: [hinge], rule: cap, region: low-back, id: L-002 }
pain_threshold: 4
version: 1
`;
  const a = limitsHash(file(EXAMPLE));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(limitsHash(file(reordered)), a);
});

test("limitsHash changes when a value changes", () => {
  assert.notEqual(limitsHash(file(EXAMPLE)), limitsHash(file(EXAMPLE.replace("135", "155"))));
});

test("limitsHash on a missing file throws", () => {
  assert.throws(() => limitsHash(join(dir, "nope.yaml")), CoachError);
});

test("A8: a non-finite max_load is rejected", () => {
  expectInvalid(validateLimitsFromYaml(`version: 1
pain_threshold: 4
limits:
  - { id: L-002, region: low-back, rule: cap, patterns: [hinge], max_load: { value: .inf, unit: lbs }, source: athlete, since: 2026-10-01 }
`), /max_load: must be/);
  expectInvalid({ ...one({}), pain_threshold: Number.NaN }, /pain_threshold/);
});

test("build_back: a cap may build back; a ban may not; the value must be true or false", () => {
  const base = { version: 1, pain_threshold: 4 };
  const cap = { id: "L-001", region: "left-shoulder", rule: "cap", patterns: ["overhead_press"], max_sets_per_week: 6, source: "athlete", since: "2026-10-12" };
  assert.equal(validateLimits({ ...base, limits: [{ ...cap, build_back: true }] }).limits[0].build_back, true);
  assert.equal("build_back" in validateLimits({ ...base, limits: [cap] }).limits[0], false);
  assert.throws(() => validateLimits({ ...base, limits: [{ ...cap, build_back: "yes" }] }), /build_back: must be true or false/);
  assert.throws(() => validateLimits({ ...base, limits: [{ id: "L-002", region: "knee", rule: "ban", patterns: ["squat"], build_back: true, source: "athlete", since: "2026-10-12" }] }), /only a cap can build back/);
});
