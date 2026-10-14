// V7 phase 2: `save` (contracts §22b): the log entry once per run, the three git layouts,
// divergent remote commits, failures before the push, retries, the privacy refusals through
// save, and the urgent gate while save works. Made-up data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDate } from "../engine/dates.ts";
import { athleteRepo, cliIn, fakeGh, git, linkEngine, REPO, remote, remoteCommit, writeJson, type Remote } from "./v7-helpers.ts";

const TZ = "America/Los_Angeles";
const GH = fakeGh();
const ENV = { PATH: `${GH}:${process.env.PATH}`, FAKE_VIS: "private" };

const now = () => new Date().toISOString();
const today = () => localDate(now(), TZ);
let seq = 0;
const runId = () => `r-${today().replace(/-/g, "")}-0800-${(0xa000 + seq++).toString(16)}`;
const logOf = (dir: string) => readFileSync(join(dir, "athlete/log", `${today().slice(0, 7)}.md`), "utf8");
const count = (text: string, line: string) => text.split("\n").filter((l) => l === line).length;

/** A post result for the run, as today-brief --stage post writes it. */
function post(dir: string, run: string, over: Record<string, unknown> = {}) {
  writeJson(dir, `.tmp/coach/today-${run}-post.json`, {
    run_id: run,
    session_id: null,
    local_date: today(),
    computed_at: now(),
    stage: "post",
    urgent: { stopped: false },
    log: { readiness_line: "wearable green (HRV 52 ms, z 0.1), subjective unknown (no rating today), performance green (every rep hit) → none", rule_ids: ["NA-REC-008"], decision: "none" },
    ...over,
  });
}

function save(dir: string, run: string, extra: string[] = [], env: Record<string, string | undefined> = ENV) {
  return cliIn(dir, ["save", "--run", run, "--message", `today ${today()}: none (NA-REC-008)`, ...extra], env);
}

const remoteMain = (r: Remote) => git(r.bare, "rev-parse", "refs/heads/main");

test("plain checkout on main: the no-change entry once, commit, push; a second save is nothing to save", () => {
  const r = remote();
  const dir = athleteRepo(r);
  const run = runId();
  post(dir, run);
  const s = save(dir, run, ["--no-change", "a good morning"]);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  assert.equal(s.json.outcome, "published");
  assert.equal(s.json.layout, "main");
  const log = logOf(dir);
  assert.match(log, new RegExp(`## ${today()} \\d{2}:\\d{2} · no-change\\n- trigger: user\\n- readiness: wearable green .* → none\\n- rules: NA-REC-008\\n- change: none \\(a good morning\\)\\n- run: ${run}\\n`));
  assert.equal(remoteMain(r), git(dir, "rev-parse", "HEAD"));
  const again = save(dir, run, ["--no-change", "a good morning"]);
  assert.equal(again.code, 0);
  assert.equal(again.json.outcome, "nothing_to_save");
  assert.equal(count(logOf(dir), `- run: ${run}`), 1);
});

test("a linked worktree on a branch, main checked out in the main checkout: branch and main end on the pushed commit", () => {
  const r = remote();
  const main = athleteRepo(r);
  const wt = join(mkdtempSync(join(tmpdir(), "v7-wt-")), "wt");
  git(main, "worktree", "add", "-q", "-b", "coach", wt);
  linkEngine(wt);
  const run = runId();
  post(wt, run);
  const s = save(wt, run, ["--no-change", "steady"]);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  assert.deepEqual([s.json.outcome, s.json.layout], ["published", "branch"]);
  const head = git(wt, "rev-parse", "HEAD");
  assert.equal(git(main, "rev-parse", "main"), head);
  assert.equal(remoteMain(r), head);
  assert.equal(git(main, "status", "--porcelain"), "", "the main checkout moved cleanly");
});

test("a linked worktree with main not checked out anywhere: main moves as a ref; two saves with a remote commit between them", () => {
  const r = remote();
  const main = athleteRepo(r);
  git(main, "switch", "-q", "-c", "elsewhere");
  const wt = join(mkdtempSync(join(tmpdir(), "v7-wt-")), "wt");
  git(main, "worktree", "add", "-q", "-b", "coach", wt, "main");
  linkEngine(wt);
  const run1 = runId();
  post(wt, run1);
  assert.equal(save(wt, run1, ["--no-change", "first"]).json.outcome, "published");
  // A cloud run pushed a commit in between: the remote and the local main diverge.
  remoteCommit(r, "athlete/log/cloud.md", "cloud run\n");
  const run2 = runId();
  post(wt, run2);
  const s = save(wt, run2, ["--no-change", "second"]);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  assert.equal(s.json.outcome, "published");
  const head = git(wt, "rev-parse", "HEAD");
  assert.equal(remoteMain(r), head);
  assert.equal(git(wt, "rev-parse", "refs/heads/main"), head);
  assert.ok(existsSync(join(wt, "athlete/log/cloud.md")), "the remote commit is in the branch");
  assert.equal(git(wt, "rev-list", "--merges", "--count", "HEAD"), "0", "no merge commit");
});

test("plain main: two saves in a row with a remote commit between them (divergent remote and local commits)", () => {
  const r = remote();
  const dir = athleteRepo(r);
  const run1 = runId();
  post(dir, run1);
  assert.equal(save(dir, run1, ["--no-change", "one"]).json.outcome, "published");
  remoteCommit(r, "athlete/signals/x.json", "{}\n");
  const run2 = runId();
  post(dir, run2);
  const s = save(dir, run2, ["--no-change", "two"]);
  assert.equal(s.json.outcome, "published", JSON.stringify(s.json));
  assert.equal(remoteMain(r), git(dir, "rev-parse", "HEAD"));
  assert.equal(count(logOf(dir), `- run: ${run1}`), 1);
  assert.equal(count(logOf(dir), `- run: ${run2}`), 1);
});

test("a rebase conflict stops before the push: aborted, not published, 'push skipped' logged and committed locally", () => {
  const r = remote();
  const dir = athleteRepo(r);
  // The remote changed the same log file.
  remoteCommit(r, `athlete/log/${today().slice(0, 7)}.md`, "# Operation log\n\n## remote entry\n- run: r-00000000-0000-0000\n");
  const run = runId();
  post(dir, run);
  const before = remoteMain(r);
  const s = save(dir, run, ["--no-change", "conflict"]);
  assert.equal(s.code, 1);
  assert.equal(s.json.outcome, "not_published");
  assert.match(s.json.reason, /rebase onto origin\/main stopped/);
  assert.equal(remoteMain(r), before, "nothing reached the remote");
  assert.equal(existsSync(join(dir, ".git/rebase-merge")) || existsSync(join(dir, ".git/rebase-apply")), false, "the rebase was aborted");
  assert.match(logOf(dir), /- push skipped: the rebase onto origin\/main stopped/);
  assert.equal(git(dir, "status", "--porcelain", "--untracked-files=no"), "", "the push skipped line is committed");
});

test("dirty main (checked out elsewhere) and a detached HEAD stop before the push", () => {
  const r = remote();
  const main = athleteRepo(r);
  const wt = join(mkdtempSync(join(tmpdir(), "v7-wt-")), "wt");
  git(main, "worktree", "add", "-q", "-b", "coach", wt);
  linkEngine(wt);
  writeFileSync(join(main, "README.md"), "edited, not committed\n");
  const run = runId();
  post(wt, run);
  const before = remoteMain(r);
  const s = save(wt, run, ["--no-change", "dirty"]);
  assert.equal(s.json.outcome, "not_published");
  assert.match(s.json.reason, /main was not fast-forwarded: .*uncommitted changes/);
  assert.equal(remoteMain(r), before);
  const det = athleteRepo(remote());
  git(det, "checkout", "-q", "--detach");
  const run2 = runId();
  post(det, run2);
  const d = save(det, run2, ["--no-change", "detached"]);
  assert.equal(d.json.outcome, "not_published");
  assert.match(d.json.reason, /detached HEAD/);
});

test("a failed push is not published; a retry with the same run adds nothing twice and publishes", () => {
  const r = remote();
  const dir = athleteRepo(r);
  writeFileSync(join(r.bare, "hooks/pre-receive"), "#!/bin/sh\necho 'remote: busy' >&2\nexit 1\n");
  spawnSync("chmod", ["+x", join(r.bare, "hooks/pre-receive")]);
  const run = runId();
  post(dir, run);
  const s = save(dir, run, ["--no-change", "retry me"]);
  assert.equal(s.json.outcome, "not_published");
  assert.match(s.json.reason, /git push .* failed/);
  rmSync(join(r.bare, "hooks/pre-receive"));
  post(dir, run); // post runs again (the result is fresh)
  const retry = save(dir, run, ["--no-change", "retry me"]);
  assert.equal(retry.json.outcome, "published", JSON.stringify(retry.json));
  const log = logOf(dir);
  assert.equal(count(log, `- run: ${run}`), 1);
  assert.equal(log.split("\n").filter((l) => l.startsWith("- push skipped:")).length, 1);
  assert.equal(remoteMain(r), git(dir, "rev-parse", "HEAD"));
});

test("a crash between commit and push: the retry finds the entry and only pushes", () => {
  const r = remote();
  const dir = athleteRepo(r);
  const run = runId();
  post(dir, run);
  writeFileSync(join(dir, "athlete/log", `${today().slice(0, 7)}.md`), `# Operation log\n\n## ${today()} 08:00 · no-change\n- change: none (x)\n- run: ${run}\n`);
  git(dir, "add", "athlete");
  git(dir, "commit", "-q", "-m", "today: committed, not pushed");
  const s = save(dir, run, ["--no-change", "x"]);
  assert.equal(s.json.outcome, "published");
  assert.equal(s.json.log.appended, false);
  assert.equal(count(logOf(dir), `- run: ${run}`), 1);
});

test("interleaved runs: each entry once; --input lines are appended exactly, under a heading", () => {
  const r = remote();
  const dir = athleteRepo(r);
  const a = runId();
  const b = runId();
  post(dir, a);
  post(dir, b);
  const input = writeJson(dir, ".tmp/coach/save.json", { lines: ["- proposal for the next live session: ask about left knee"] });
  assert.equal(save(dir, b, ["--input", input]).json.outcome, "published");
  assert.equal(save(dir, a, ["--no-change", "a", "--input", input]).json.outcome, "published");
  assert.equal(save(dir, b, ["--input", input]).json.outcome, "nothing_to_save");
  const log = logOf(dir);
  assert.equal(count(log, `- run: ${a}`), 1);
  assert.equal(count(log, `- run: ${b}`), 1);
  assert.match(log, new RegExp(`· today\\n- proposal for the next live session: ask about left knee\\n- run: ${b}`));
  assert.match(log, new RegExp(`- change: none \\(a\\)\\n- proposal for the next live session: ask about left knee\\n- run: ${a}`));
  const bad = writeJson(dir, ".tmp/coach/bad.json", { lines: "not a list" });
  assert.equal(save(dir, a, ["--input", bad]).json.error.code, "INPUT_ERROR");
});

test("--no-change refuses a missing, foreign, old or outdated post result, and names the fix", () => {
  const r = remote();
  const dir = athleteRepo(r);
  const run = runId();
  const refused = (why: RegExp) => {
    const s = save(dir, run, ["--no-change", "x"]);
    assert.equal(s.json?.error?.code, "POST_STALE", s.stdout);
    assert.match(s.json.error.message, why);
    assert.match(s.json.error.message, /today-brief --stage post again/);
  };
  refused(/no post result/);
  post(dir, run, { run_id: "r-20260101-0000-ffff" });
  refused(/from run r-20260101/);
  post(dir, run, { session_id: "other" });
  const s = cliIn(dir, ["save", "--run", run, "--message", "m", "--no-change", "x"], { ...ENV, CLAUDE_CODE_SESSION_ID: "mine" });
  assert.match(s.json.error.message, /another session/);
  post(dir, run, { local_date: "2026-01-01" });
  refused(/not today/);
  post(dir, run, { computed_at: new Date(Date.now() - 20 * 60_000).toISOString() });
  refused(/minutes old/);
  post(dir, run, { computed_at: new Date(Date.now() - 60_000).toISOString() });
  writeJson(dir, `athlete/signals/${today()}.json`, { version: 1 });
  refused(/signals.*changed after the post result/);
  const later = new Date(Date.now() - 120_000);
  utimesSync(join(dir, `athlete/signals/${today()}.json`), later, later);
  writeFileSync(join(dir, "athlete/.urgent-stop"), JSON.stringify({ version: 1, at: now(), terms: ["fainting"], sources: ["chat"] }));
  utimesSync(join(dir, "athlete/.urgent-stop"), later, later);
  refused(/urgent stop is set/);
});

test("privacy through save: a public, unknown or mismatched destination is refused and nothing is pushed", () => {
  for (const [what, env, fix] of [
    ["public", { ...ENV, FAKE_VIS: "public" }, null],
    ["unknown visibility", { ...ENV, FAKE_VIS: undefined }, null],
    ["a push URL to another repository", ENV, (d: string) => git(d, "remote", "set-url", "--push", "origin", "git@github.com:someone/else.git")],
  ] as const) {
    const r = remote();
    const dir = athleteRepo(r);
    if (fix) fix(dir);
    const run = runId();
    post(dir, run);
    const before = remoteMain(r);
    const s = save(dir, run, ["--no-change", "x"], env as Record<string, string | undefined>);
    assert.equal(s.code, 1, what);
    assert.equal(s.json.outcome, "not_published", what);
    assert.match(s.json.reason, /PUBLIC|cannot look up|not to alex\/coach|do not push/, what);
    assert.equal(remoteMain(r), before, what);
  }
});

test("under the urgent stop, save still saves the log, and the urgent gate still denies a plan write", () => {
  const r = remote();
  const dir = athleteRepo(r);
  writeFileSync(join(dir, "athlete/.urgent-stop"), JSON.stringify({ version: 1, at: now(), terms: ["chest pain"], sources: ["chat"] }));
  git(dir, "add", "athlete/.urgent-stop");
  git(dir, "commit", "-q", "-m", "urgent stop");
  const run = runId();
  const input = writeJson(dir, ".tmp/coach/save.json", { lines: [`## ${today()} 08:00 · no-change`, "- trigger: user", "- rules: none", "- change: none (rest day: urgent stop)"] });
  const s = save(dir, run, ["--input", input]);
  assert.equal(s.json.outcome, "published", JSON.stringify(s.json));
  const gate = spawnSync(process.execPath, [join(REPO, ".claude/hooks/urgent-gate.ts")], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(dir, "plans/2026-W42.csv"), content: "x" } }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  assert.match(gate.stdout, /"permissionDecision":"deny"/);
  const tally = spawnSync(process.execPath, [join(REPO, ".claude/hooks/urgent-gate.ts")], {
    input: JSON.stringify({ tool_name: "mcp__claude_ai_Tally_Workout__update_planned_workout", tool_input: { date: today() } }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  assert.match(tally.stdout, /"permissionDecision":"deny"/);
});

test("logger files in a live session: save runs tally-mention before the commit and returns it", () => {
  const r = remote();
  const dir = athleteRepo(r, "files");
  const run = runId();
  post(dir, run);
  const s = save(dir, run, ["--no-change", "x"]);
  assert.equal(s.json.outcome, "published", JSON.stringify(s.json));
  assert.equal(s.json.mention.mention, false);
  assert.match(s.json.mention.reason, /0 of 3 sessions logged/);
  const unattended = save(dir, runId(), [], { ...ENV, COACH_UNATTENDED: "1" });
  assert.equal(unattended.json.mention, undefined, "never unattended");
});
