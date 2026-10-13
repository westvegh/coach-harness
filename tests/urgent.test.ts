// The urgent stop end to end (contracts §10, v0.2 rule 1): every trigger route writes
// athlete/.urgent-stop, and the urgent gate then denies a plan write on any MCP server and an
// edit under plans/. `urgent clear` needs a live session and a reason, and writes the
// clearance record the note scan honors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR", "COACH_NOW"].includes(k)));
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });

/** An athlete copy: coach.yaml, limits, a git repo on main (no remote: the push is reported, not made). */
function instance(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-urgent-"));
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  cpSync(join(REPO, "templates/athlete/limits.yaml"), join(dir, "athlete/limits.yaml"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@t");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function cli(root: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), ...args, "--root", root], { encoding: "utf8", env: { ...BASE_ENV, ...GIT_ENV, ...env } });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stderr: r.stderr };
}

function hook(name: string, root: string, input: unknown) {
  const r = spawnSync(process.execPath, [join(REPO, ".claude/hooks", `${name}.ts`)], { input: JSON.stringify(input), encoding: "utf8", env: { ...BASE_ENV, ...GIT_ENV, CLAUDE_PROJECT_DIR: root } });
  let json: any = null;
  try {
    json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {
    /* not JSON */
  }
  return { code: r.status, stdout: r.stdout, json };
}

const gate = (root: string, tool: string, tool_input: unknown = { date: "2026-10-15" }) => hook("urgent-gate", root, { session_id: "s", hook_event_name: "PreToolUse", tool_name: tool, tool_input });
const denied = (r: ReturnType<typeof gate>) => r.code === 0 && r.json?.hookSpecificOutput?.permissionDecision === "deny";
const tallyWrite = "mcp__claude_ai_Tally_Workout__update_planned_workout";
const stop = (root: string) => JSON.parse(readFileSync(join(root, "athlete/.urgent-stop"), "utf8"));

test("route 1, chat: safety-detect writes the stop, then a Tally write is denied", () => {
  const root = instance();
  assert.ok(!denied(gate(root, tallyWrite)), "no stop: allowed");
  hook("safety-detect", root, { session_id: "s", hook_event_name: "UserPromptSubmit", cwd: root, prompt: "I got chest pain on the bike" });
  assert.deepEqual(stop(root).sources, ["chat"]);
  assert.ok(denied(gate(root, tallyWrite)));
});

test("route 2, check-in: checkin --urgent writes and commits the stop, then a Tally write is denied", () => {
  const root = instance();
  const r = cli(root, ["checkin", "--date", "2026-10-14", "--sleep-quality", "3", "--energy", "3", "--soreness", "2", "--stress", "2", "--urgent", "fainting"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([stop(root).terms, stop(root).sources], [["fainting"], ["checkin"]]);
  assert.equal(r.json.urgent_stop.commit.committed, true);
  assert.equal(r.json.urgent_stop.push.pushed, false, "no remote: the push is reported, not made");
  assert.equal(git(root, "log", "-1", "--format=%s").trim(), "urgent stop (checkin)");
  assert.ok(denied(gate(root, tallyWrite)));
  // An unknown term is refused before anything is written.
  const other = instance();
  const bad = cli(other, ["checkin", "--date", "2026-10-14", "--sleep-quality", "3", "--energy", "3", "--soreness", "2", "--stress", "2", "--urgent", "my knee"]);
  assert.equal(bad.code, 2);
  assert.equal(existsSync(join(other, "athlete/signals/2026-10-14.json")), false);
  assert.equal(existsSync(join(other, "athlete/.urgent-stop")), false);
});

test("route 3, a note: scan-notes writes the stop for an urgent note, then a Tally write is denied; a cleared note does not stop again; a newer one does", () => {
  const root = instance();
  const history = join(root, "history.json");
  writeFileSync(history, JSON.stringify([{ date: "2026-10-10", notes: "felt chest tightness on the last set", exercises: [] }, { date: "2026-10-11", notes: "knee a bit sore", exercises: [] }]));
  const r = cli(root, ["safety", "scan-notes", "--since", "2026-10-07", "--input", history]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.urgent_terms, ["chest pain"]);
  assert.equal(r.json.matches.length, 2, "the pain note is reported too, for the coach's question");
  assert.deepEqual(stop(root).sources, ["note"]);
  assert.ok(denied(gate(root, tallyWrite)));

  // The athlete says it was a false alarm: the clearance record skips that note next time.
  assert.equal(cli(root, ["urgent", "clear", "--reason", "false-alarm", "--now", "2026-10-12T09:00:00-07:00"]).code, 0);
  assert.ok(!denied(gate(root, tallyWrite)));
  const again = cli(root, ["safety", "scan-notes", "--since", "2026-10-07", "--input", history]);
  assert.deepEqual(again.json.urgent_terms, []);
  assert.equal(existsSync(join(root, "athlete/.urgent-stop")), false);
  // A new event after the clearance stops again.
  writeFileSync(history, JSON.stringify([{ date: "2026-10-10", notes: "felt chest tightness", exercises: [] }, { date: "2026-10-13", notes: "chest pain again today", exercises: [] }]));
  assert.deepEqual(cli(root, ["safety", "scan-notes", "--since", "2026-10-07", "--input", history]).json.urgent_terms, ["chest pain"]);
  assert.ok(denied(gate(root, tallyWrite)));
  // --dry-run reports and writes nothing.
  const dry = instance();
  writeFileSync(join(dry, "h.json"), JSON.stringify([{ date: "2026-10-10", notes: "I fainted", exercises: [] }]));
  assert.deepEqual(cli(dry, ["safety", "scan-notes", "--since", "2026-10-07", "--input", join(dry, "h.json"), "--dry-run"]).json.urgent_terms, ["fainting"]);
  assert.equal(existsSync(join(dry, "athlete/.urgent-stop")), false);
});

test("route 4, urgent set: writes, commits and tries to push the stop, then a Tally write is denied", () => {
  const root = instance();
  const r = cli(root, ["urgent", "set", "--term", "sudden severe headache", "--source", "answer"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.commit.committed, true);
  assert.equal(r.json.push.pushed, false);
  assert.match(r.json.push.reason, /no remote origin/);
  assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), ["athlete/.urgent-stop"]);
  assert.ok(denied(gate(root, tallyWrite)));
  // Term names only, from the list (or "other urgent sign"); the legacy source is not for set.
  assert.equal(cli(root, ["urgent", "set", "--term", "my chest hurts", "--source", "chat"]).code, 2);
  assert.equal(cli(root, ["urgent", "set", "--term", "other urgent sign", "--source", "legacy"]).code, 2);
  assert.equal(cli(root, ["urgent", "set", "--term", "other urgent sign", "--source", "chat"]).code, 0);
  assert.deepEqual(stop(root).terms, ["sudden severe headache", "other urgent sign"]);
});

test("the gate: any server name (no 'tally' needed), every mutation suffix, Edit/Write/MultiEdit under plans/ only; reads and other files pass", () => {
  const root = instance();
  cli(root, ["urgent", "set", "--term", "fainting", "--source", "chat"]);
  for (const server of ["mcp__google_sheets__", "mcp__notion__", "mcp__tally__", "mcp__claude_ai_Tally_Workout__"]) {
    for (const t of ["plan_workout_day", "plan_workout_range", "update_planned_workout", "move_planned_workout", "skip_planned_workout", "delete_planned_workout", "update_user_profile", "update_training_limits"]) {
      assert.ok(denied(gate(root, server + t)), server + t);
    }
  }
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    assert.ok(denied(gate(root, tool, { file_path: join(root, "plans/2026-W42.csv") })), `${tool} plans/`);
    assert.ok(denied(gate(root, tool, { file_path: join(root, "Plans/2026-W42.csv") })), `${tool} Plans/ (case)`);
    assert.ok(!denied(gate(root, tool, { file_path: join(root, "athlete/log/2026-10.md") })), `${tool} outside plans/`);
  }
  assert.ok(denied(gate(root, "Write", { file_path: "plans/x.csv" })), "a relative path from the project root");
  assert.ok(denied(gate(root, "Write", {})), "a file tool with no path fails closed");
  assert.ok(!denied(gate(root, "mcp__tally__get_planned_workout")), "a read");
  assert.ok(!denied(gate(root, "Bash", { command: "ls" })), "Bash");
});

test("urgent clear: refused unattended and without a reason; with one it writes the record (no symptom text), removes the stop and commits", () => {
  const root = instance();
  cli(root, ["urgent", "set", "--term", "chest pain", "--source", "chat"]);
  for (const env of [{ COACH_UNATTENDED: "1" }, { CLAUDE_CODE_REMOTE: "true" }] as Record<string, string>[]) {
    const r = cli(root, ["urgent", "clear", "--reason", "clinician"], env);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, "UNATTENDED");
  }
  for (const args of [[], ["--reason", "feels fine"]]) {
    const r = cli(root, ["urgent", "clear", ...args]);
    assert.equal(r.code, 2);
    assert.equal(r.json.error.code, "USAGE");
  }
  assert.ok(existsSync(join(root, "athlete/.urgent-stop")), "still stopped");
  const ok = cli(root, ["urgent", "clear", "--reason", "clinician", "--now", "2026-10-14T10:00:00-07:00"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(existsSync(join(root, "athlete/.urgent-stop")), false);
  const lines = readFileSync(join(root, "athlete/log/urgent-clearances.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ date: "2026-10-14", at: "2026-10-14T10:00:00-07:00", terms: ["chest pain"], sources: ["chat"], reason: "clinician" }]);
  assert.equal(git(root, "log", "-1", "--format=%s").trim(), "urgent stop cleared (clinician)");
  assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort(), ["athlete/.urgent-stop", "athlete/log/urgent-clearances.jsonl"]);
  const status = cli(root, ["urgent", "status"]);
  assert.equal(status.json.stopped, false);
  assert.equal(status.json.clearances.length, 1);
  // Nothing to clear: no record.
  assert.equal(cli(root, ["urgent", "clear", "--reason", "false-alarm"]).json.cleared, false);
});

test("a stop file that cannot be read still stops", () => {
  const root = instance();
  writeFileSync(join(root, "athlete/.urgent-stop"), "{not json");
  assert.ok(denied(gate(root, tallyWrite)));
  assert.deepEqual(cli(root, ["urgent", "status"]).json.stop.terms, ["unreadable stop file"]);
});

test("V1b fix 1: the gate sees through path aliases: a plans symlink to an outside folder, a second alias to it, a symlinked root, files not yet written", () => {
  const root = realpathSync(instance());
  cli(root, ["urgent", "set", "--term", "fainting", "--source", "chat"]);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "coach-plans-outside-")));
  symlinkSync(outside, join(root, "plans"));
  const alias = join(realpathSync(mkdtempSync(join(tmpdir(), "coach-alias-"))), "plans-alias");
  symlinkSync(outside, alias);
  const linkedRoot = join(realpathSync(mkdtempSync(join(tmpdir(), "coach-rootlink-"))), "root");
  symlinkSync(root, linkedRoot);
  const write = (projectDir: string, file_path: string) => {
    const r = spawnSync(process.execPath, [join(REPO, ".claude/hooks/urgent-gate.ts")], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path, content: "x" } }), encoding: "utf8", env: { ...BASE_ENV, CLAUDE_PROJECT_DIR: projectDir } });
    return r.status === 0 && /"permissionDecision":"deny"/.test(r.stdout);
  };
  for (const [what, dir, f] of [
    ["through the plans link", root, join(root, "plans/2026-W42.csv")],
    ["the outside folder itself", root, join(outside, "2026-W42.csv")],
    ["a second alias to the outside folder", root, join(alias, "2026-W42.csv")],
    ["a file not yet written, in a new subfolder", root, join(alias, "new/sub/2026-W43.csv")],
    ["a symlinked root, the real path", linkedRoot, join(root, "plans/2026-W42.csv")],
    ["a symlinked root, the link path", linkedRoot, join(linkedRoot, "plans/2026-W42.csv")],
    ["a symlinked root, the outside folder", linkedRoot, join(outside, "x.csv")],
  ] as const) {
    assert.ok(write(dir, f), what);
  }
  for (const f of [join(root, "athlete/log/2026-10.md"), join(outside + "-other", "x.csv"), join(root, "plansx/x.csv")]) assert.ok(!write(root, f), f);
});

test("V1b fix 2: an urgent check-in writes the stop before the signal file is read: parse, validation and write failures still stop", () => {
  const args = ["checkin", "--date", "2026-10-14", "--sleep-quality", "3", "--energy", "3", "--soreness", "2", "--stress", "2", "--urgent", "fainting"];
  const signal = (root: string) => join(root, "athlete/signals/2026-10-14.json");
  const cases: [string, (root: string) => void][] = [
    ["a signal file that does not parse", (root) => {
      mkdirSync(join(root, "athlete/signals"), { recursive: true });
      writeFileSync(signal(root), "{not json");
    }],
    ["a signal file that fails validation", (root) => {
      mkdirSync(join(root, "athlete/signals"), { recursive: true });
      writeFileSync(signal(root), JSON.stringify({ version: 1, date: "2026-10-14", source: "nope", submitted_at: "2026-10-14T06:00:00Z" }));
    }],
    ["a signal file that cannot be written", (root) => {
      mkdirSync(join(root, "athlete/signals"), { recursive: true });
      chmodSync(join(root, "athlete/signals"), 0o500);
    }],
  ];
  for (const [what, damage] of cases) {
    const root = instance();
    damage(root);
    try {
      const r = cli(root, args);
      assert.equal(r.code, 1, `${what}: the check-in itself fails`);
      assert.deepEqual(stop(root).terms, ["fainting"], what);
      assert.equal(git(root, "log", "-1", "--format=%s").trim(), "urgent stop (checkin)", `${what}: committed`);
      assert.ok(denied(gate(root, tallyWrite)), `${what}: a plan write is denied`);
    } finally {
      chmodSync(join(root, "athlete/signals"), 0o700);
    }
  }
});

/** A GitHub origin over a fake ssh (a local bare repo) and a fake gh whose visibility answer the test sets. */
function githubOrigin(root: string): { remote: string; env: Record<string, string> } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coach-origin-")));
  const remote = join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "fake-ssh"), `#!/bin/sh\nfor last; do :; done\ncase "$last" in\n  "git-receive-pack 'o/athlete.git'") exec git receive-pack ${JSON.stringify(remote)} ;;\n  "git-upload-pack 'o/athlete.git'") exec git upload-pack ${JSON.stringify(remote)} ;;\nesac\nexit 1\n`);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nif [ "$FAKE_VIS" = private ]; then echo private; exit 0; fi\necho "HTTP 401" >&2\nexit 1\n`);
  chmodSync(join(bin, "fake-ssh"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  // The installed pre-push hook runs <root>/engine/prepush.ts: link the engine in (untracked).
  symlinkSync(join(REPO, "engine"), join(root, "engine"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  git(root, "remote", "add", "origin", "git@github.com:o/athlete.git");
  git(root, "config", "core.sshCommand", join(bin, "fake-ssh"));
  return { remote, env: { PATH: `${bin}:${process.env.PATH}` } };
}

test("V1b fix 4: a failed push is retried on the next call (urgent set, check-in, clear); an uncommitted stop is committed", () => {
  const root = instance();
  const { remote, env } = githubOrigin(root);
  const remoteLog = () => execFileSync("git", ["--git-dir", remote, "log", "--format=%s", "main"], { encoding: "utf8" }).trim();
  // The visibility lookup fails: committed, not pushed.
  const first = cli(root, ["urgent", "set", "--term", "fainting", "--source", "chat"], env);
  assert.equal(first.json.commit.committed, true);
  assert.equal(first.json.push.pushed, false);
  assert.throws(() => remoteLog(), "nothing reached the remote");
  // The same call again (no content change): the stop is pushed now.
  const retry = cli(root, ["urgent", "set", "--term", "fainting", "--source", "chat"], { ...env, FAKE_VIS: "private" });
  assert.equal(retry.json.changed, false);
  assert.equal(retry.json.push.pushed, true, JSON.stringify(retry.json));
  assert.match(remoteLog(), /urgent stop \(chat\)/);
  // Already pushed: no push is attempted.
  assert.equal(cli(root, ["urgent", "set", "--term", "fainting", "--source", "chat"], { ...env, FAKE_VIS: "private" }).json.push, null);

  // A stop left uncommitted (a hook could not commit) is committed and pushed by the next call.
  writeFileSync(join(root, "athlete/.urgent-stop"), JSON.stringify({ version: 1, at: "2026-10-14T06:00:00Z", terms: ["fainting", "chest pain"], sources: ["chat"] }));
  const fix = cli(root, ["urgent", "set", "--term", "chest pain", "--source", "chat"], { ...env, FAKE_VIS: "private" });
  assert.equal(fix.json.commit.committed, true);
  assert.equal(fix.json.push.pushed, true);
  assert.equal(git(root, "status", "--porcelain", "--", "athlete/.urgent-stop").trim(), "");

  // The check-in route: a failed push, then a retry pushes.
  const ci = ["checkin", "--date", "2026-10-14", "--sleep-quality", "3", "--energy", "3", "--soreness", "2", "--stress", "2", "--urgent", "new numbness"];
  assert.equal(cli(root, ci, env).json.urgent_stop.push.pushed, false);
  assert.equal(cli(root, ci, { ...env, FAKE_VIS: "private" }).json.urgent_stop.push.pushed, true);

  // urgent clear: committed, push fails; the next clear (nothing left to clear) pushes it.
  const clear = cli(root, ["urgent", "clear", "--reason", "false-alarm"], env);
  assert.equal(clear.json.cleared, true);
  assert.equal(clear.json.push.pushed, false);
  const again = cli(root, ["urgent", "clear", "--reason", "false-alarm"], { ...env, FAKE_VIS: "private" });
  assert.equal(again.json.cleared, false);
  assert.equal(again.json.push.pushed, true, JSON.stringify(again.json));
  assert.match(remoteLog().split("\n")[0], /urgent stop cleared \(false-alarm\)/);
});

test("commit: a plan file removed with git rm is committed (the folder is gone from the disk and the index)", () => {
  const root = instance();
  mkdirSync(join(root, "plans"), { recursive: true });
  writeFileSync(join(root, "plans/2026-W43.csv"), "date,day,exercise\n");
  git(root, "add", "plans");
  git(root, "commit", "-q", "-m", "week 1");
  git(root, "rm", "-q", "plans/2026-W43.csv");
  writeFileSync(join(root, "athlete/brief.md"), "# Brief\n");
  const r = cli(root, ["commit", "--message", "logger is tally"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.committed, true);
  assert.equal(git(root, "status", "--porcelain"), "", "nothing left staged or changed");
  assert.equal(git(root, "ls-tree", "-r", "--name-only", "HEAD", "--", "plans"), "", "HEAD has no plan file");
  assert.match(git(root, "ls-tree", "-r", "--name-only", "HEAD", "--", "athlete"), /athlete\/brief\.md/);
  rmSync(root, { recursive: true, force: true });
});
