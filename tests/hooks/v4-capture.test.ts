// V4 F2/F3: the whole path from the capture-reads hook to the note scan, with two Tally servers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname;
const NOW = "2026-10-12T17:00:00.000Z";
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR", "COACH_NOW"].includes(k)));
const LIVE = "mcp__claude_ai_Tally_Workout__";
const SAMPLE = "mcp__tally__";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** An athlete instance before setup's coach.yaml (or with one, given its text), on a git repo. */
function instance(coach?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-v4cap-"));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  cpSync(join(REPO, "methods"), join(dir, "methods"), { recursive: true });
  if (coach) writeFileSync(join(dir, "coach.yaml"), coach);
  writeFileSync(join(dir, ".gitignore"), "athlete/.cache/\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@t");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "instance");
  return dir;
}

function capture(root: string, tool: string, input: unknown, response: unknown) {
  const r = spawnSync(process.execPath, [join(REPO, ".claude/hooks/capture-reads.ts")], {
    input: JSON.stringify({ session_id: "s1", hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: response }),
    encoding: "utf8",
    env: { ...BASE_ENV, CLAUDE_PROJECT_DIR: root, COACH_NOW: NOW },
  });
  assert.equal(r.status, 0, r.stderr);
}

function engine(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), ...args, "--root", root], { encoding: "utf8", env: { ...BASE_ENV } });
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];
const history = (sessions: unknown[]) => text({ count: sessions.length, sessions });
const ctx = (unit: "lbs" | "kg") => text({ today: "2026-10-12", futurePlanned: [], weightUnit: unit, weightUnitSource: "settings" });
const session = (date: string, name: string, notes?: string, exNotes?: string) => ({
  date,
  name,
  weightUnit: "lbs",
  ...(notes ? { notes } : {}),
  exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", sets: [{ weight: 185, reps: 5 }], ...(exNotes ? { notes: exNotes } : {}) }],
});

// The sample account: 3 sessions, no notes. The live account: 4 sessions, notes.
const SAMPLE_SESSIONS = [session("2026-10-01", "Sample A"), session("2026-10-03", "Sample B"), session("2026-10-05", "Sample C")];
const LIVE_SESSIONS = [session("2026-10-02", "Lower", "left knee sore after squats"), session("2026-10-04", "Upper"), session("2026-10-06", "Lower", undefined, "shoulder pain on the press"), session("2026-10-08", "Run")];

test("F2/F3: two servers; after the account question, snapshot reset and the chosen server's reads, the scan sees only its sessions and notes", () => {
  const root = instance();
  // Setup's silent checks read both servers (West's run: the sample account was read last).
  capture(root, LIVE + "get_workout_history", { since: "2026-08-17" }, history(LIVE_SESSIONS));
  capture(root, SAMPLE + "get_workout_history", { since: "2026-08-17" }, history(SAMPLE_SESSIONS));
  // V4b: the snapshot keeps one server; the last server read (the sample account) replaced the first.
  const last = engine(root, "safety", "scan-notes", "--since", "2026-08-17", "--dry-run");
  assert.equal(last.json.server, "tally");
  assert.equal(last.json.sessions, 3);
  // The account question picks the live account: reset, then read it again.
  assert.equal(engine(root, "snapshot", "reset").json.removed, true);
  capture(root, LIVE + "get_training_context", { timezone: "UTC" }, ctx("kg"));
  capture(root, LIVE + "get_workout_history", { since: "2026-08-17" }, history(LIVE_SESSIONS));
  const snap = JSON.parse(readFileSync(join(root, "athlete/.cache/snapshot.json"), "utf8"));
  assert.equal(snap.server, "claude_ai_Tally_Workout");
  assert.equal(snap.weightUnit, "kg", "units from the chosen account");
  const scan = engine(root, "safety", "scan-notes", "--since", "2026-08-17", "--dry-run");
  assert.equal(scan.code, 0, scan.stderr);
  assert.equal(scan.json.server, "claude_ai_Tally_Workout");
  assert.equal(scan.json.sessions, 4);
  assert.deepEqual(scan.json.matches.map((m: any) => [m.date, m.where]), [["2026-10-02", "session"], ["2026-10-06", "exercise"]]);
});

test("F2: an urgent term in a captured note writes the urgent stop", () => {
  const root = instance();
  capture(root, LIVE + "get_workout_history", { since: "2026-08-17" }, history([session("2026-10-09", "Run", "had chest pain on the last interval")]));
  const scan = engine(root, "safety", "scan-notes", "--since", "2026-08-17");
  assert.equal(scan.code, 0, scan.stderr);
  assert.deepEqual(scan.json.urgent_terms, ["chest pain"]);
  assert.ok(existsSync(join(root, "athlete/.urgent-stop")));
});

test("V4b fix 1: a cloud-style tool name is captured even when coach.yaml names the local prefix", () => {
  const coach = readFileSync(join(REPO, "coach.example.yaml"), "utf8").replace("  verified: false", `  verified: false\n  tool_prefix: ${LIVE}`);
  const root = instance(coach);
  capture(root, "mcp__Tally_Workout__get_workout_history", { since: "2026-08-17" }, history(LIVE_SESSIONS));
  const snap = JSON.parse(readFileSync(join(root, "athlete/.cache/snapshot.json"), "utf8"));
  assert.equal(snap.history.length, 4);
  assert.equal(snap.server, "Tally_Workout");
});

test("V4b fix 1: two servers read in turn: only the last one's sessions and days remain; a forgotten reset still ends with the chosen server", () => {
  const root = instance();
  const day = (date: string, name: string) => text({ date, found: true, version: "v1", source: "mcp", userModified: false, skipped: false, dayName: name, exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", suggestedSets: 3 }] });
  capture(root, SAMPLE + "get_planned_workout", { date: "2026-10-13" }, day("2026-10-13", "Sample day"));
  capture(root, SAMPLE + "get_workout_history", { since: "2026-08-17" }, history(SAMPLE_SESSIONS));
  // No reset: the chosen server's reads start a new snapshot.
  capture(root, LIVE + "get_training_context", { timezone: "UTC" }, ctx("kg"));
  capture(root, LIVE + "get_workout_history", { since: "2026-08-17" }, history(LIVE_SESSIONS));
  const snap = JSON.parse(readFileSync(join(root, "athlete/.cache/snapshot.json"), "utf8"));
  assert.equal(snap.server, "claude_ai_Tally_Workout");
  assert.deepEqual(Object.keys(snap.days), []);
  assert.deepEqual(snap.history.map((h: any) => h.name).sort(), ["Lower", "Lower", "Run", "Upper"]);
  assert.equal(snap.weightUnit, "kg");
  const scan = engine(root, "safety", "scan-notes", "--since", "2026-08-17", "--dry-run");
  assert.equal(scan.json.server, "claude_ai_Tally_Workout");
  assert.equal(scan.json.sessions, 4);
});

test("F3: two servers with the same data: the sessions count once; a failed read leaves the snapshot unchanged", () => {
  const root = instance();
  capture(root, LIVE + "get_workout_history", { since: "2026-08-17" }, history(LIVE_SESSIONS));
  capture(root, SAMPLE + "get_workout_history", { since: "2026-08-17" }, history(LIVE_SESSIONS));
  const snap = JSON.parse(readFileSync(join(root, "athlete/.cache/snapshot.json"), "utf8"));
  assert.equal(snap.history.length, 4);
  const before = snap.history;
  capture(root, LIVE + "get_workout_history", { since: "2026-08-17" }, { isError: true, content: [{ type: "text", text: "upstream error" }] });
  const after = JSON.parse(readFileSync(join(root, "athlete/.cache/snapshot.json"), "utf8"));
  assert.deepEqual(after.history, before);
});
