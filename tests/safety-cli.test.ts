// CLI tests for `safety detect` and `safety scan-notes` (v0.2: pain is reported; only an urgent term writes the urgent stop).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const CLI = join(REPO, "engine/cli.ts");
const ATTENDED = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDE_CODE_REMOTE" && k !== "COACH_UNATTENDED"));

function cli(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: "utf8", env: { ...ATTENDED, ...extraEnv } });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-safety-cli-"));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  return dir;
}
test("safety detect prints the matcher result and writes nothing", () => {
  const r = cli(["safety", "detect", "--text", "my right knee hurts"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { urgent: [], pain: ["hurt"], regions: ["right-knee"] });
  assert.equal(cli(["safety", "detect"]).code, 2);
});

test("safety scan-notes reads the snapshot history and reports pain notes; it writes no file for pain", () => {
  const dir = tempRoot();
  mkdirSync(join(dir, "athlete/.cache"));
  const snapshot = {
    version: 1, session_id: "s", captured_at: "2026-10-12T07:00:00Z", timezone: "UTC", days: {},
    history: [
      { date: "2026-10-09", notes: "elbow sore", exercises: [] },
      { date: "2026-10-11", notes: "great session", exercises: [{ exerciseId: "x", name: "Deadlift", notes: "low back tweaked", sets: [] }] },
    ],
  };
  writeFileSync(join(dir, "athlete/.cache/snapshot.json"), JSON.stringify(snapshot));
  const r = cli(["safety", "scan-notes", "--since", "2026-10-10", "--now", "2026-10-12T07:00:00Z", "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.matches.length, 1);
  assert.equal(r.json.matches[0].date, "2026-10-11");
  assert.deepEqual(r.json.matches[0].regions, ["low-back"]);
  assert.deepEqual(r.json.urgent_terms, []);
  assert.equal(r.json.urgent_stop, null);
  assert.equal(existsSync(join(dir, "athlete/.safety-pending")), false);
  assert.equal(existsSync(join(dir, "athlete/.urgent-stop")), false);
});

test("safety scan-notes needs --since, and is a no-op without a snapshot", () => {
  const dir = tempRoot();
  assert.equal(cli(["safety", "scan-notes", "--root", dir]).code, 2);
  const r = cli(["safety", "scan-notes", "--since", "2026-10-10", "--root", dir]);
  assert.deepEqual(r.json, { matches: [], urgent_terms: [], urgent_stop: null });
});
