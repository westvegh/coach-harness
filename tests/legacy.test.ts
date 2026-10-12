// v0.1 safety files at the first v0.2 session (engine/legacy.ts, contracts §24): a file that
// exists but cannot be read gives the conservative result, an urgent stop; malformed YAML or
// JSON does too, separately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyLegacy } from "../engine/legacy.ts";

const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "coach-legacy-"));
  mkdirSync(join(dir, "athlete"));
  return dir;
};

test("V1b fix 5: an unreadable hold file (a folder) is urgent, and the report says it cannot be read", () => {
  const dir = root();
  mkdirSync(join(dir, "athlete/hold.yaml"));
  const r = classifyLegacy(dir);
  assert.deepEqual(r.urgent, ["other urgent sign"]);
  assert.deepEqual(r.files, ["athlete/hold.yaml"]);
  assert.match(r.summary[0], /a hold file that cannot be read \(EISDIR\)/);
});

test("V1b fix 5: an unreadable pending file (no permission) is urgent", { skip: process.getuid?.() === 0 }, () => {
  const dir = root();
  writeFileSync(join(dir, "athlete/.safety-pending"), JSON.stringify({ at: "2026-10-12T07:00:00Z", terms: ["pain"], source: "prompt" }));
  chmodSync(join(dir, "athlete/.safety-pending"), 0o000);
  try {
    const r = classifyLegacy(dir);
    assert.deepEqual(r.urgent, ["other urgent sign"]);
    assert.match(r.summary[0], /a pending safety file that cannot be read \(EACCES\)/);
  } finally {
    chmodSync(join(dir, "athlete/.safety-pending"), 0o600);
  }
});

test("malformed YAML and JSON (readable files) are urgent too, with their own wording", () => {
  const dir = root();
  writeFileSync(join(dir, "athlete/hold.yaml"), "active: [\n");
  writeFileSync(join(dir, "athlete/.safety-pending"), "{not json");
  const r = classifyLegacy(dir);
  assert.deepEqual(r.urgent, ["other urgent sign"]);
  assert.deepEqual(r.summary, ["a hold file that does not parse", "a pending safety file that does not parse"]);
});
