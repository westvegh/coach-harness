import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearHold, readHold, setHold, validateHold } from "./hold.ts";
import { CoachError } from "./errors.ts";

const TEMPLATE = new URL("../templates/athlete/hold.yaml", import.meta.url).pathname;
const root = () => mkdtempSync(join(tmpdir(), "coach-hold-"));

test("the template is a valid inactive hold", () => {
  const dir = root();
  mkdirSync(join(dir, "athlete"));
  writeFileSync(join(dir, "athlete/hold.yaml"), readFileSync(TEMPLATE));
  assert.deepEqual(readHold(dir), { active: false, set_at: null, reason: null, regions: [], set_by: null });
});

test("set writes an active hold and extends an existing one", () => {
  const dir = root();
  const a = setHold(dir, { reason: "knee pain 6/10", regions: ["left-knee"], now: "2026-10-12T07:00:00-07:00" });
  assert.equal(a.active, true);
  const b = setHold(dir, { reason: "back pain", regions: ["low-back"], by: "user", now: "2026-10-12T09:00:00-07:00" });
  assert.equal(b.set_at, "2026-10-12T07:00:00-07:00");
  assert.deepEqual(b.regions, ["left-knee", "low-back"]);
  assert.deepEqual(readHold(dir), b);
});

test("set needs a reason", () => {
  assert.throws(() => setHold(root(), { reason: " " }), CoachError);
});

test("clear without approval throws NEEDS_APPROVAL and changes nothing", () => {
  const dir = root();
  setHold(dir, { reason: "pain", now: "2026-10-12T07:00:00-07:00" });
  writeFileSync(join(dir, "athlete/.safety-pending"), "{}");
  assert.throws(() => clearHold(dir, { approved: false, env: {} }), (e: unknown) => e instanceof CoachError && e.code === "NEEDS_APPROVAL");
  assert.equal(readHold(dir)?.active, true);
  assert.ok(existsSync(join(dir, "athlete/.safety-pending")));
});

test("clear with approval deactivates the hold and removes the pending file", () => {
  const dir = root();
  setHold(dir, { reason: "pain", now: "2026-10-12T07:00:00-07:00" });
  writeFileSync(join(dir, "athlete/.safety-pending"), "{}");
  const r = clearHold(dir, { approved: true, now: "2026-10-13T07:00:00-07:00", env: {} });
  assert.equal(r.hold?.active, false);
  assert.equal(r.hold?.cleared_at, "2026-10-13T07:00:00-07:00");
  assert.equal(r.pending_removed, true);
  assert.equal(existsSync(join(dir, "athlete/.safety-pending")), false);
});

test("a malformed hold file throws (the guard denies on it)", () => {
  assert.throws(() => validateHold({ active: "yes" }), /active: must be true or false/);
  assert.throws(() => validateHold({ active: true, regions: [] }), /an active hold needs set_at and reason/);
  assert.throws(() => validateHold({ active: false, colour: 1 }), /colour: unknown key/);
});

for (const marker of ["COACH_UNATTENDED", "CLAUDE_CODE_REMOTE"]) {
  test(`A1: clear fails when ${marker} is set, even with --approved`, () => {
    const dir = root();
    setHold(dir, { reason: "pain", now: "2026-10-12T07:00:00-07:00" });
    writeFileSync(join(dir, "athlete/.safety-pending"), "{}");
    assert.throws(
      () => clearHold(dir, { approved: true, env: { [marker]: "1" } }),
      (e: unknown) => e instanceof CoachError && e.code === "UNATTENDED",
    );
    assert.equal(readHold(dir)?.active, true);
    assert.ok(existsSync(join(dir, "athlete/.safety-pending")));
  });
}
