// `hold init`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readHold } from "../../engine/hold.ts";
import { loadGuardFiles } from "../../engine/guard-context.ts";
import { cli, instance, REPO } from "./helpers.ts";

const NOW = "2026-10-14T07:00:00-07:00";

test("hold init on a fresh instance writes the inactive hold the guard accepts", () => {
  const dir = instance();
  writeFileSync(join(dir, "athlete/limits.yaml"), readFileSync(join(REPO, "templates/athlete/limits.yaml")));
  // Before: the guard denies every write (the setup failure that hold init fixes).
  assert.throws(() => loadGuardFiles(dir, NOW), /hold\.yaml is missing/);
  const r = cli(["hold", "init", "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.created, true);
  assert.deepEqual(readHold(dir), { active: false, set_at: null, reason: null, regions: [], set_by: null });
  // After: the guard loads every input.
  assert.equal(loadGuardFiles(dir, NOW).hold?.active, false);
  // The same file as the template.
  assert.deepEqual(readHold(dir), readHold(join(REPO, "templates")));
});

test("hold init with an existing inactive hold changes nothing", () => {
  const dir = instance();
  mkdirSync(join(dir, "athlete"), { recursive: true });
  const text = "# my notes\nactive: false\nset_at: null\nreason: null\nregions: []\nset_by: null\ncleared_at: 2026-10-01T08:00:00-07:00\ncleared_by: user\n";
  writeFileSync(join(dir, "athlete/hold.yaml"), text);
  const r = cli(["hold", "init", "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.created, false);
  assert.equal(readFileSync(join(dir, "athlete/hold.yaml"), "utf8"), text);
});

test("hold init refuses an active hold with exit 3 and leaves it as it is", () => {
  const dir = instance();
  assert.equal(cli(["hold", "set", "--reason", "knee pain 6/10", "--regions", "left-knee", "--root", dir]).code, 0);
  const before = readFileSync(join(dir, "athlete/hold.yaml"), "utf8");
  const r = cli(["hold", "init", "--root", dir]);
  assert.equal(r.code, 3);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.active, true);
  assert.equal(readFileSync(join(dir, "athlete/hold.yaml"), "utf8"), before);
  assert.equal(readHold(dir)?.active, true);
});

test("hold init never overwrites a malformed hold file", () => {
  const dir = instance();
  writeFileSync(join(dir, "athlete/hold.yaml"), "active: maybe\n");
  const r = cli(["hold", "init", "--root", dir]);
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, "HOLD_INVALID");
  assert.equal(readFileSync(join(dir, "athlete/hold.yaml"), "utf8"), "active: maybe\n");
});

test("node engine/hold.ts init works the same way", async () => {
  const dir = instance();
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [join(REPO, "engine/hold.ts"), "init", "--root", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, "athlete/hold.yaml")));
});

test("a hold set while init runs wins; init refuses it and never replaces it", async () => {
  const { initHold, setHold } = await import("../../engine/hold.ts");
  const dir = instance();
  // The race: init finds no file, then `hold set` writes an active hold before init creates its file.
  assert.throws(
    () => initHold(dir, { beforeCreate: () => setHold(dir, { reason: "knee pain 7/10", regions: ["left-knee"], now: "2026-10-14T07:00:00-07:00" }) }),
    (e: unknown) => (e as { code?: string }).code === "HOLD_ACTIVE",
  );
  assert.equal(readHold(dir)?.active, true);
  assert.equal(readHold(dir)?.reason, "knee pain 7/10");
  // No temporary file is left behind.
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(readdirSync(join(dir, "athlete")).filter((f) => f.startsWith("hold.yaml.")), []);
});

test("an inactive hold written meanwhile is kept, not replaced", async () => {
  const { initHold } = await import("../../engine/hold.ts");
  const dir = instance();
  const text = "active: false\nset_at: null\nreason: null\nregions: []\nset_by: null\ncleared_at: 2026-10-01T08:00:00-07:00\ncleared_by: user\n";
  const r = initHold(dir, { beforeCreate: () => writeFileSync(join(dir, "athlete/hold.yaml"), text) });
  assert.equal(r.created, false);
  assert.equal(readFileSync(join(dir, "athlete/hold.yaml"), "utf8"), text);
});
