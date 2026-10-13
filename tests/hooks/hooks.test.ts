// Hook processes (contracts §9, §10, §13): each hook runs as `node .claude/hooks/<name>.ts`
// with stdin JSON, in a temporary athlete instance. Asserts stdout, stderr and exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSnapshot, SNAPSHOT_RELATIVE } from "../../engine/snapshot.ts";
import { NOW, plannedDay, SESSION, snapDay, snapshot, v } from "../guard/fixtures.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const D = "2026-10-15";
const TALLY = "mcp__claude_ai_Tally_Workout__";
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR", "COACH_NOW"].includes(k)));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

/** A fresh athlete instance: coach.yaml, limits, the method pack, a git repo on main. */
function instance(opts: { coach?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-hooks-"));
  if (opts.coach !== false) cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.example.yaml"));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  cpSync(join(REPO, "templates/athlete/limits.yaml"), join(dir, "athlete/limits.yaml"));
  cpSync(join(REPO, "methods"), join(dir, "methods"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "athlete/.cache/\n");
  git(dir, "init", "-q", "-b", "main");
  // The hooks commit in a child process: give the repo its own identity (CI runners have none).
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@t");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "instance");
  return dir;
}

function hook(name: string, root: string, input: unknown, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(REPO, ".claude/hooks", `${name}.ts`)], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...BASE_ENV, CLAUDE_PROJECT_DIR: root, COACH_NOW: NOW, ...env },
  });
  let json: any = null;
  try {
    json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {
    /* not JSON */
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const trim = { date: D, expectedVersion: v(`r-${D}`, "t0"), operations: [{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 2 } }] };
const pre = (tool: string, tool_input: unknown, extra: Record<string, unknown> = {}) => ({ session_id: SESSION, hook_event_name: "PreToolUse", tool_name: TALLY + tool, tool_input, tool_use_id: "toolu_1", ...extra });
const withSnapshot = (root: string) => saveSnapshot(root, snapshot({ [D]: snapDay(D) }));

// ---------- capture-reads and log-writes ----------

const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];

test("capture-reads: a read builds the snapshot; a malformed snapshot is replaced; non-logger tools are ignored", () => {
  const root = instance();
  const r = hook("capture-reads", root, { session_id: SESSION, tool_name: TALLY + "get_planned_workout", tool_input: { date: D }, tool_response: text(plannedDay(D)) });
  assert.equal(r.code, 0, r.stderr);
  const snap = JSON.parse(readFileSync(join(root, SNAPSHOT_RELATIVE), "utf8"));
  assert.equal(snap.session_id, SESSION);
  assert.equal(snap.days[D].version, v(`r-${D}`, "t0"));
  assert.equal(snap.timezone, "America/Los_Angeles");

  writeFileSync(join(root, SNAPSHOT_RELATIVE), "{");
  const again = hook("capture-reads", root, { session_id: SESSION, tool_name: "mcp__tally__get_planned_workout", tool_input: { date: D }, tool_response: text(plannedDay(D)) });
  assert.equal(again.code, 0);
  assert.match(again.stderr, /replacing a malformed snapshot/);
  assert.equal(JSON.parse(readFileSync(join(root, SNAPSHOT_RELATIVE), "utf8")).days[D].found, true);

  const other = hook("capture-reads", root, { session_id: "x", tool_name: "mcp__github__get_issue", tool_input: {}, tool_response: text({}) });
  assert.equal(other.code, 0);
  assert.equal(JSON.parse(readFileSync(join(root, SNAPSHOT_RELATIVE), "utf8")).session_id, SESSION);
  assert.equal(hook("capture-reads", root, "nope").code, 2);
});


test("log-writes: one log entry with the operation ID, the kind from the submitted opId, who triggered it and the result", () => {
  const root = instance();
  withSnapshot(root);
  const opId = "op-2026-10-15-trim_session-0123456789ab";
  const call = { ...trim, opId };
  const response = text({ date: D, status: "updated", day: plannedDay(D, { updatedAt: "t1", version: v(`r-${D}`, "t1") }), warnings: [] });
  const l = hook("log-writes", root, { ...pre("update_planned_workout", call), hook_event_name: "PostToolUse", tool_response: response });
  assert.equal(l.code, 0, l.stderr);
  assert.match(l.json.hookSpecificOutput.additionalContext, new RegExp(`coach log: ${opId} written`));
  const log = readFileSync(join(root, "athlete/log/2026-10.md"), "utf8");
  assert.match(log, new RegExp(`## 2026-10-14 07:00 · ${opId}`));
  assert.match(log, /- trigger: user/);
  assert.match(log, /- change: update_planned_workout on 2026-10-15 \(trim_session\)/);
  assert.match(log, /- approval: the coach, in a live session/);
  assert.match(log, new RegExp(`- result: written: written \\(version ${v(`r-${D}`, "t1")}\\)`));
  assert.equal(existsSync(join(root, "athlete/.cache/verdicts")), false, "no guard verdicts in v0.2");

  // No opId: an unclassified entry with a computed ID. A conflict and an unparsable response are reconciled too.
  const c = hook("log-writes", root, { ...pre("update_planned_workout", trim), tool_use_id: "toolu_2", tool_response: text({ date: D, status: "skipped", code: "version_conflict", reason: "x" }) }, { COACH_UNATTENDED: "1" });
  assert.match(c.json.hookSpecificOutput.additionalContext, /op-2026-10-15-unclassified-[0-9a-f]{12} conflict/);
  const u = hook("log-writes", root, { ...pre("update_planned_workout", trim), tool_use_id: "toolu_3", tool_response: [{ type: "text", text: "timeout" }] });
  assert.match(u.json.hookSpecificOutput.additionalContext, /uncertain/);
  const log2 = readFileSync(join(root, "athlete/log/2026-10.md"), "utf8");
  assert.match(log2, /- trigger: scheduled run \(mac\)/);
  assert.match(log2, /- approval: the coach, in an unattended run/);
  assert.equal((log2.match(/^## /gm) ?? []).length, 3);
  rmSync(join(root, "coach.yaml"));
  assert.equal(hook("log-writes", root, { ...pre("update_planned_workout", trim), tool_response: response }).code, 2);
});

// ---------- session-context ----------

const sessionContext = (root: string, env: Record<string, string> = {}) => {
  const r = hook("session-context", root, { session_id: SESSION, hook_event_name: "SessionStart", source: "startup" }, env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.hookSpecificOutput.hookEventName, "SessionStart");
  return r.json.hookSpecificOutput.additionalContext as string;
};
const writeLimits = (root: string) =>
  writeFileSync(
    join(root, "athlete/limits.yaml"),
    "version: 1\npain_threshold: 4\nlimits:\n  - { id: L-001, region: left-knee, rule: ban, patterns: [loaded_deep_knee_flexion], source: athlete, since: '2026-10-01' }\n  - { id: L-002, region: left-shoulder, rule: cap, patterns: [overhead_press], max_sets_per_week: 6, build_back: true, source: athlete, since: '2026-10-01' }\n",
  );

test("V2: session-context reads the v0.2 setup state lines (setup: <part> done|stopped)", () => {
  const root = instance();
  mkdirSync(join(root, "athlete/log"), { recursive: true });
  writeFileSync(join(root, "athlete/log/setup.md"), "setup: checks done 2026-10-12 08:00 (tally none)\nsetup: basics done 2026-10-12 08:01 (lbs, 4, 60, full gym)\nnote: something else\n");
  assert.match(sessionContext(root), /Setup progress: setup: basics done 2026-10-12 08:01 \(lbs, 4, 60, full gym\)\./);
  writeFileSync(join(root, "athlete/log/setup.md"), "setup: health stopped 2026-10-12 08:03 (urgent stop)\n");
  assert.match(sessionContext(root), /Setup progress: setup: health stopped 2026-10-12 08:03 \(urgent stop\)\./);
});

test("session-context: today, the limits summary, setup progress, due items; no hold or pending wording; no coach.yaml", () => {
  const root = instance();
  writeLimits(root);
  mkdirSync(join(root, "athlete/log"), { recursive: true });
  writeFileSync(join(root, "athlete/log/setup.md"), "setup: step 3 done 2026-10-12 08:00\nsetup: step 4 done 2026-10-12 08:10\n");
  const ctx = sessionContext(root);
  assert.match(ctx, /today is 2026-10-14 \(wed\)/);
  assert.match(ctx, /Limits \(follow them in every plan\): L-001 left-knee: ban \(loaded_deep_knee_flexion\); L-002 left-shoulder: cap 6 sets\/week, build back \(overhead_press\)\./);
  assert.match(ctx, /Setup progress: setup: step 4 done 2026-10-12 08:10\./);
  // V6 D: a check-in is never due.
  assert.match(ctx, /Due: the daily run/);
  assert.doesNotMatch(ctx, /check-in/);
  assert.doesNotMatch(ctx, /HOLD|SAFETY FIRST|URGENT|proposal/i);

  const fresh = instance({ coach: false });
  assert.match(sessionContext(fresh), /no coach.yaml yet/);

  writeFileSync(join(root, "athlete/limits.yaml"), "limits: [\n");
  assert.match(sessionContext(root), /WARNING: athlete\/limits\.yaml does not load/);
});

test("session-context: the urgent stop comes first, with the urgent-care text and the clear question", () => {
  const root = instance();
  writeFileSync(join(root, "athlete/.urgent-stop"), JSON.stringify({ version: 1, at: "2026-10-14T06:00:00-07:00", terms: ["chest pain"], sources: ["chat"] }));
  const ctx = sessionContext(root);
  const lines = ctx.split("\n");
  assert.match(lines[1], /^URGENT STOP since 2026-10-14T06:00:00-07:00 \(terms: chest pain; sources: chat\)/);
  assert.match(ctx, /call your local emergency number/);
  assert.match(ctx, /urgent clear --reason clinician/);
  assert.match(ctx, /Never clear it on your own reading/);
});

test("legacy: an urgent hold becomes the urgent stop (committed), then the migration question; removing the files never clears it", () => {
  const root = instance();
  writeFileSync(join(root, "athlete/hold.yaml"), "active: true\nset_at: '2026-10-13T08:00:00-07:00'\nreason: urgent warning sign reported\nregions: []\nset_by: safety-agent\nurgent: true\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "old hold");
  const ctx = sessionContext(root);
  const stop = JSON.parse(readFileSync(join(root, "athlete/.urgent-stop"), "utf8"));
  assert.deepEqual(stop.sources, ["legacy"]);
  assert.deepEqual(stop.terms, ["other urgent sign"]);
  assert.match(git(root, "log", "-1", "--format=%s"), /urgent stop \(legacy\)/);
  assert.match(ctx, /URGENT STOP/);
  assert.match(ctx, /Old safety files: an active urgent hold \(no regions\) \(athlete\/hold\.yaml\)/);
  assert.match(ctx, /Remove them\? A\) Yes, B\) Show them first/);
  assert.ok(ctx.indexOf("URGENT STOP") < ctx.indexOf("Old safety files"), "the stop is stated before the question");
  // The athlete says yes: the old files go; the stop stays.
  rmSync(join(root, "athlete/hold.yaml"));
  const after = sessionContext(root);
  assert.match(after, /URGENT STOP/);
  assert.doesNotMatch(after, /Old safety files/);
});

test("legacy: urgent terms in the pending file become the urgent stop; ordinary pain terms only ask the question", () => {
  const root = instance();
  writeFileSync(join(root, "athlete/.safety-pending"), JSON.stringify({ at: "2026-10-14T06:00:00-07:00", terms: ["fainting", "pain", "region:left-knee"], source: "prompt" }));
  const ctx = sessionContext(root);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "athlete/.urgent-stop"), "utf8")).terms, ["fainting"]);
  assert.match(ctx, /URGENT STOP .*terms: fainting/);

  const plain = instance();
  writeFileSync(join(plain, "athlete/.safety-pending"), JSON.stringify({ at: "2026-10-14T06:00:00-07:00", terms: ["pain", "region:left-knee"], source: "prompt" }));
  writeFileSync(join(plain, "athlete/hold.yaml"), "active: true\nset_at: '2026-10-13T08:00:00-07:00'\nreason: left knee pain\nregions: [left-knee]\nset_by: safety-agent\n");
  const c2 = sessionContext(plain);
  assert.equal(existsSync(join(plain, "athlete/.urgent-stop")), false, "ordinary pain is no urgent stop");
  assert.doesNotMatch(c2, /URGENT STOP/);
  assert.match(c2, /Old safety files: an active hold \(regions: left-knee\); a pending safety check \(1 term\(s\)\)/);
  assert.match(c2, /Remove them\?/);
});

test("legacy: a cleared urgent event is not converted again", () => {
  const root = instance();
  writeFileSync(join(root, "athlete/.safety-pending"), JSON.stringify({ at: "2026-10-13T06:00:00-07:00", terms: ["fainting"], source: "prompt" }));
  mkdirSync(join(root, "athlete/log"), { recursive: true });
  writeFileSync(join(root, "athlete/log/urgent-clearances.jsonl"), JSON.stringify({ date: "2026-10-13", at: "2026-10-13T09:00:00-07:00", terms: ["fainting"], sources: ["legacy"], reason: "clinician" }) + "\n");
  sessionContext(root);
  assert.equal(existsSync(join(root, "athlete/.urgent-stop")), false);
});

test("session-context installs the pre-push hook when it is missing (a fresh clone), and leaves it when it is there", () => {
  const root = instance();
  const hookPath = join(root, ".git/hooks/pre-push");
  rmSync(hookPath, { force: true });
  const ctx = sessionContext(root);
  assert.match(ctx, /the pre-push hook was missing; it is installed now/);
  assert.equal(readFileSync(hookPath, "utf8"), readFileSync(join(REPO, "git-hooks/pre-push"), "utf8"));
  assert.doesNotMatch(sessionContext(root), /pre-push hook was missing/);
  // Not in an athlete copy (no coach.yaml): nothing is installed.
  const bare = instance({ coach: false });
  rmSync(join(bare, ".git/hooks/pre-push"), { force: true });
  sessionContext(bare);
  assert.equal(existsSync(join(bare, ".git/hooks/pre-push")), false);
});

// ---------- commit-check (the auto-commit) ----------

test("commit-check: commits only athlete/, plans/ and coach.yaml, never other staged work, and says nothing", () => {
  const root = instance();
  assert.equal(hook("commit-check", root, { session_id: SESSION, stop_hook_active: false }).stdout, "");
  mkdirSync(join(root, "athlete/log"), { recursive: true });
  mkdirSync(join(root, "plans"), { recursive: true });
  writeFileSync(join(root, "athlete/log/2026-10.md"), "x\n");
  writeFileSync(join(root, "plans/2026-W42.csv"), "date,day\n");
  writeFileSync(join(root, "coach.yaml"), readFileSync(join(root, "coach.yaml"), "utf8") + "\n");
  // Other work, staged and unstaged, stays out of the commit.
  writeFileSync(join(root, "notes.txt"), "mine\n");
  writeFileSync(join(root, "staged.txt"), "staged\n");
  git(root, "add", "staged.txt");
  // The ignored cache never counts.
  mkdirSync(join(root, "athlete/.cache"), { recursive: true });
  writeFileSync(join(root, "athlete/.cache/x.json"), "{}");
  const r = hook("commit-check", root, { session_id: SESSION, stop_hook_active: false });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "", "silent on success");
  const files = git(root, "show", "--name-only", "--format=%s", "HEAD").trim().split("\n");
  assert.match(files[0], /^coach: update athlete\/, plans\/, coach\.yaml$/);
  assert.deepEqual(files.slice(1).filter(Boolean).sort(), ["athlete/log/2026-10.md", "coach.yaml", "plans/2026-W42.csv"]);
  const status = git(root, "status", "--porcelain");
  assert.match(status, /^A  staged\.txt$/m, "staged work stays staged");
  assert.match(status, /^\?\? notes\.txt$/m);
  assert.equal(hook("commit-check", root, { session_id: SESSION }).stdout, "", "clean: silent");
});

test("commit-check: a failed commit is one line; no coach.yaml does nothing", () => {
  const root = instance();
  mkdirSync(join(root, "athlete/log"), { recursive: true });
  writeFileSync(join(root, "athlete/log/2026-10.md"), "x\n");
  // A pre-commit hook that refuses every commit.
  writeFileSync(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\necho no >&2\nexit 1\n");
  chmodSync(join(root, ".git/hooks/pre-commit"), 0o755);
  const r = hook("commit-check", root, { session_id: SESSION });
  assert.equal(r.code, 0);
  assert.match(r.json.systemMessage, /^commit-check: the auto-commit of athlete failed/);
  assert.equal(r.stdout.trim().split("\n").length, 1);

  const dev = instance({ coach: false });
  mkdirSync(join(dev, "athlete/log"), { recursive: true });
  writeFileSync(join(dev, "athlete/log/x.md"), "x\n");
  assert.equal(hook("commit-check", dev, { session_id: SESSION }).stdout, "");
  assert.match(git(dev, "status", "--porcelain"), /athlete\//, "nothing committed without coach.yaml");
});

test("V1b fix 6: the auto-commit reads NUL-delimited status: spaces, Unicode and a rename are committed; unrelated changes stay unstaged", () => {
  const root = instance();
  mkdirSync(join(root, "athlete/log"), { recursive: true });
  writeFileSync(join(root, "athlete/log/old name.md"), "a\n");
  writeFileSync(join(root, "notes.txt"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  // Changes the hook must commit: a name with spaces, a Unicode name, a rename.
  writeFileSync(join(root, "athlete/log/my notes.md"), "x\n");
  mkdirSync(join(root, "plans"), { recursive: true });
  writeFileSync(join(root, "plans/séance über.csv"), "date\n");
  git(root, "mv", "athlete/log/old name.md", "athlete/log/new name.md");
  // Unrelated changes: one unstaged, one untracked. They must stay as they are.
  writeFileSync(join(root, "notes.txt"), "mine\n");
  writeFileSync(join(root, "draft.txt"), "draft\n");
  const r = hook("commit-check", root, { session_id: SESSION, stop_hook_active: false });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "");
  const committed = git(root, "-c", "core.quotepath=false", "show", "--name-status", "--format=", "HEAD").trim().split("\n").sort();
  assert.deepEqual(committed, ["A\tathlete/log/my notes.md", "A\tplans/séance über.csv", "R100\tathlete/log/old name.md\tathlete/log/new name.md"].sort());
  const status = git(root, "status", "--porcelain");
  assert.match(status, /^ M notes\.txt$/m, "the unrelated edit stays unstaged");
  assert.match(status, /^\?\? draft\.txt$/m, "the untracked file stays untracked");
  assert.doesNotMatch(status, /athlete|plans/);
});

test("V1b fix 6: only changes outside the three paths: the hook runs no git add and commits nothing", () => {
  const root = instance();
  writeFileSync(join(root, "notes.txt"), "mine\n");
  const head = git(root, "rev-parse", "HEAD");
  assert.equal(hook("commit-check", root, { session_id: SESSION }).stdout, "");
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.match(git(root, "status", "--porcelain"), /^\?\? notes\.txt$/m);
});

test("V1b fix 8: session-context finds the pre-push hook in a linked worktree and under an absolute core.hooksPath", () => {
  const root = instance();
  sessionContext(root); // installs it in the main checkout
  const wt = join(mkdtempSync(join(tmpdir(), "coach-wt-")), "wt");
  git(root, "worktree", "add", "-q", "-b", "side", wt);
  // The worktree shares the hooks folder (an absolute path from git): already installed.
  assert.doesNotMatch(sessionContext(wt), /pre-push hook was missing/);
  // An absolute custom hooks folder: installed once, then found.
  const hooksDir = mkdtempSync(join(tmpdir(), "coach-hooks-dir-"));
  git(root, "config", "core.hooksPath", hooksDir);
  assert.match(sessionContext(root), /pre-push hook was missing; it is installed now/);
  assert.equal(readFileSync(join(hooksDir, "pre-push"), "utf8"), readFileSync(join(REPO, "git-hooks/pre-push"), "utf8"));
  assert.doesNotMatch(sessionContext(root), /pre-push hook was missing/);
});

test("V1b fix 8: a pre-push hook with the right content but no execute bit is installed again", () => {
  const root = instance();
  sessionContext(root);
  const hookPath = join(root, ".git/hooks/pre-push");
  chmodSync(hookPath, 0o644);
  assert.match(sessionContext(root), /pre-push hook was missing; it is installed now/);
  assert.notEqual(statSync(hookPath).mode & 0o111, 0);
});
