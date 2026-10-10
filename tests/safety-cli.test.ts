// CLI tests for safety: `hold set|clear|clear-pending|status` in every mode, and `safety`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

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
const PENDING = { at: "2026-10-12T07:00:00-07:00", terms: ["hurt", "region:left-knee"], source: "prompt" };
const putPending = (dir: string) => writeFileSync(join(dir, "athlete/.safety-pending"), JSON.stringify(PENDING));
const holdFile = (dir: string) => parse(readFileSync(join(dir, "athlete/hold.yaml"), "utf8"));

test("hold set writes active, set_at, reason, regions and set_by", () => {
  const dir = tempRoot();
  const r = cli(["hold", "set", "--reason", "knee pain 6/10", "--regions", "left-knee", "--now", "2026-10-12T07:00:00-07:00", "--root", dir]);
  assert.equal(r.code, 0);
  assert.deepEqual(holdFile(dir), { active: true, set_at: "2026-10-12T07:00:00-07:00", reason: "knee pain 6/10", regions: ["left-knee"], set_by: "safety-agent" });
});

for (const marker of ["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED"]) {
  test(`hold set is allowed in an unattended run (${marker})`, () => {
    const dir = tempRoot();
    assert.equal(cli(["hold", "set", "--reason", "pain", "--root", dir], { [marker]: "1" }).code, 0);
    assert.equal(holdFile(dir).active, true);
  });

  for (const sub of ["clear", "clear-pending"]) {
    test(`hold ${sub} --approved exits 3 in an unattended run (${marker}) and changes nothing`, () => {
      const dir = tempRoot();
      cli(["hold", "set", "--reason", "pain", "--root", dir]);
      putPending(dir);
      const r = cli(["hold", sub, "--approved", "--root", dir], { [marker]: "true" });
      assert.equal(r.code, 3);
      assert.deepEqual([r.json.ok, r.json.needs_approval, r.json.unattended], [false, true, true]);
      assert.equal(holdFile(dir).active, true);
      assert.ok(existsSync(join(dir, "athlete/.safety-pending")));
    });
  }
}

for (const sub of ["clear", "clear-pending"]) {
  test(`hold ${sub} without --approved exits 3 (interactive) and changes nothing`, () => {
    const dir = tempRoot();
    cli(["hold", "set", "--reason", "pain", "--root", dir]);
    putPending(dir);
    const r = cli(["hold", sub, "--root", dir]);
    assert.equal(r.code, 3);
    assert.deepEqual([r.json.needs_approval, r.json.unattended], [true, false]);
    assert.equal(holdFile(dir).active, true);
    assert.ok(existsSync(join(dir, "athlete/.safety-pending")));
  });
}

test("hold clear --approved (interactive) clears the hold and the pending file", () => {
  const dir = tempRoot();
  cli(["hold", "set", "--reason", "pain", "--root", dir]);
  putPending(dir);
  const r = cli(["hold", "clear", "--approved", "--by", "user", "--now", "2026-10-13T07:00:00-07:00", "--root", dir]);
  assert.equal(r.code, 0);
  assert.equal(r.json.pending_removed, true);
  assert.equal(holdFile(dir).active, false);
  assert.equal(holdFile(dir).cleared_by, "user");
  assert.equal(existsSync(join(dir, "athlete/.safety-pending")), false);
});

test("hold clear-pending --approved (interactive) removes only the pending file", () => {
  const dir = tempRoot();
  cli(["hold", "set", "--reason", "pain", "--root", dir]);
  putPending(dir);
  const r = cli(["hold", "clear-pending", "--approved", "--root", dir]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { ok: true, pending_removed: true });
  assert.equal(existsSync(join(dir, "athlete/.safety-pending")), false);
  assert.equal(holdFile(dir).active, true);
  assert.equal(cli(["hold", "clear-pending", "--approved", "--root", dir]).json.pending_removed, false);
});

test("hold status prints the hold and the pending file", () => {
  const dir = tempRoot();
  assert.deepEqual(cli(["hold", "status", "--root", dir]).json, { ok: true, hold: null, pending: null, urgent: false });
  cli(["hold", "set", "--reason", "pain", "--regions", "low-back", "--root", dir]);
  putPending(dir);
  const r = cli(["hold", "status", "--root", dir], { COACH_UNATTENDED: "1" });
  assert.equal(r.code, 0);
  assert.equal(r.json.hold.active, true);
  assert.deepEqual(r.json.hold.regions, ["low-back"]);
  assert.deepEqual(r.json.pending, PENDING);
});

test("hold status fails on a malformed pending file", () => {
  const dir = tempRoot();
  writeFileSync(join(dir, "athlete/.safety-pending"), JSON.stringify({ at: "2026-10-12T07:00:00Z", terms: [], source: "prompt", text: "x" }));
  const r = cli(["hold", "status", "--root", dir]);
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, "PENDING_INVALID");
});

test("node engine/hold.ts clear-pending works directly with the same rule", () => {
  const dir = tempRoot();
  putPending(dir);
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(REPO, "engine/hold.ts"), ...args], { cwd: dir, encoding: "utf8", env: { ...ATTENDED, ...env } });
  assert.equal(run(["clear-pending"]).status, 3);
  assert.equal(run(["clear-pending", "--approved"], { CLAUDE_CODE_REMOTE: "true" }).status, 3);
  assert.equal(run(["clear-pending", "--approved"]).status, 0);
  assert.equal(existsSync(join(dir, "athlete/.safety-pending")), false);
});

test("safety detect prints the matcher result and writes nothing", () => {
  const r = cli(["safety", "detect", "--text", "my right knee hurts"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { urgent: [], pain: ["hurt"], regions: ["right-knee"] });
  assert.equal(cli(["safety", "detect"]).code, 2);
});

test("safety scan-notes reads the snapshot history and writes the pending file (source session-notes)", () => {
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
  const dry = cli(["safety", "scan-notes", "--since", "2026-10-10", "--dry-run", "--root", dir]);
  assert.equal(dry.code, 0);
  assert.equal(dry.json.matches.length, 1);
  assert.equal(dry.json.pending_written, false);
  assert.equal(existsSync(join(dir, "athlete/.safety-pending")), false);
  const r = cli(["safety", "scan-notes", "--since", "2026-10-10", "--now", "2026-10-12T07:00:00Z", "--root", dir]);
  assert.equal(r.json.matches[0].date, "2026-10-11");
  const p = JSON.parse(readFileSync(join(dir, "athlete/.safety-pending"), "utf8"));
  assert.equal(p.source, "session-notes");
  assert.deepEqual(p.terms, ["tweak", "rolled or twisted", "region:low-back"]);
});

test("safety scan-notes needs --since, and is a no-op without a snapshot", () => {
  const dir = tempRoot();
  assert.equal(cli(["safety", "scan-notes", "--root", dir]).code, 2);
  const r = cli(["safety", "scan-notes", "--since", "2026-10-10", "--root", dir]);
  assert.deepEqual(r.json, { matches: [], pending_written: false, pending: null });
});
