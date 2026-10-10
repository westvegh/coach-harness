// Smoke tests: `cli.ts signals` and `cli.ts checkin` run as real processes and print JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname;
const CLI = join(REPO, "engine/cli.ts");
const NOW = "2026-10-10T08:00:00-07:00";

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: "utf8" });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stderr: r.stderr };
}

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-cli-signals-"));
  mkdirSync(join(dir, "athlete/signals"), { recursive: true });
  return dir;
}

test("checkin then signals", () => {
  const dir = root();
  writeFileSync(join(dir, "athlete/signals/2026-10-10.json"), readFileSync(new URL("./fixtures/shortcut/2026-10-10.json", import.meta.url)));
  const c = cli(["checkin", "--root", dir, "--date", "2026-10-10", "--sleep-quality", "2", "--energy", "3", "--soreness", "4", "--stress", "2", "--pain", "left-knee:3,low-back:1", "--now", NOW]);
  assert.equal(c.code, 0, c.stderr);
  assert.equal(c.json.action, "merged");
  assert.deepEqual(c.json.file.checkin.pain, [{ region: "left-knee", score: 3 }, { region: "low-back", score: 1 }]);

  const s = cli(["signals", "--root", dir, "--from", "2026-10-04", "--to", "2026-10-10", "--now", NOW]);
  assert.equal(s.code, 0, s.stderr);
  assert.deepEqual(s.json.records.map((r: { source: string }) => r.source), ["apple-health-shortcut", "chat"]);
  assert.deepEqual(s.json.warnings, []);
});

test("usage errors exit 2 with JSON", () => {
  const dir = root();
  const noTo = cli(["signals", "--root", dir, "--from", "2026-10-01"]);
  assert.equal(noTo.code, 2);
  assert.equal(noTo.json.error.code, "USAGE");
  const badScale = cli(["checkin", "--root", dir, "--date", "2026-10-10", "--sleep-quality", "6", "--energy", "3", "--soreness", "4", "--stress", "2"]);
  assert.equal(badScale.code, 2);
  assert.match(badScale.json.error.message, /sleep-quality/);
  const badPain = cli(["checkin", "--root", dir, "--date", "2026-10-10", "--sleep-quality", "3", "--energy", "3", "--soreness", "3", "--stress", "3", "--pain", "knee"]);
  assert.equal(badPain.code, 2);
});
