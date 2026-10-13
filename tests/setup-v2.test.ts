// V2: the engine side of setup v2 and Tally optional (contracts §1, §12a, §22a, §24):
// the logger default for existing Tally copies, the Tally mention once, the worktree
// fast-forwards, the allow rule for the detected Tally server, the starting files and the
// coach-paths commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { cli, instance, REPO } from "./e3/helpers.ts";
import { validateConfig } from "../engine/config.ts";
import { writePlan } from "../engine/plans-files.ts";
import { TALLY_MENTION_TEXT } from "../engine/cli-setup.ts";

const example = () => parse(readFileSync(join(REPO, "coach.example.yaml"), "utf8"));

// ---------- coach.yaml: logger, tally_mentioned, consent ----------

test("config: an existing v0.1 Tally copy stays on Tally with no edit to coach.yaml", () => {
  // v0.1 required `logger: tally` and wrote logger_health_notes explicitly.
  const v01 = { ...example(), logger: "tally", consent: { logger_health_notes: false }, automation: { ...example().automation, tool_prefix: "mcp__tally__" } };
  const cfg = validateConfig(v01);
  assert.equal(cfg.logger, "tally");
  assert.equal(cfg.consent.logger_health_notes, false, "an explicit no stays a no");
  assert.equal(cfg.tally_mentioned, false);
  // The key gets a default in code: a copy with a recorded Tally prefix stays on Tally …
  const { logger: _l, ...noKey } = v01;
  assert.equal(validateConfig(noKey).logger, "tally");
  // … and a copy with no Tally record plans in files.
  const { tool_prefix: _t, ...auto } = v01.automation;
  assert.equal(validateConfig({ ...noKey, automation: auto }).logger, "files");
});

test("config: logger is tally | files | other; tally_mentioned is a boolean; detailed logger notes default to yes", () => {
  for (const l of ["tally", "files", "other"]) assert.equal(validateConfig({ ...example(), logger: l }).logger, l);
  assert.throws(() => validateConfig({ ...example(), logger: "notion" }), /logger: must be one of tally \| files \| other/);
  assert.throws(() => validateConfig({ ...example(), tally_mentioned: "yes" }), /tally_mentioned: must be true or false/);
  assert.equal(validateConfig({ ...example(), tally_mentioned: true }).tally_mentioned, true);
  const { consent: _c, ...noConsent } = example();
  assert.equal(validateConfig(noConsent).consent.logger_health_notes, true);
  assert.equal(validateConfig({ ...example(), consent: {} }).consent.logger_health_notes, true);
  assert.match(readFileSync(join(REPO, "coach.example.yaml"), "utf8"), /^logger: tally +# tally \| files \| other/m);
});

// ---------- the Tally mention ----------

const DAY = (date: string) => ({ date, dayName: "Lower A", exercises: [{ name: "Back Squat", sets: [{ weight: 185, reps: 5 }] }] });

test("Tally mention (files): nothing before the third logged session, the line once at the third, never again", () => {
  const dir = instance((y) => y.replace(/^logger: .*$/m, "logger: files # where plans live"));
  writePlan(dir, [DAY("2026-10-05"), DAY("2026-10-07"), DAY("2026-10-09"), DAY("2026-10-12")], "lbs");
  const before = readFileSync(join(dir, "coach.yaml"), "utf8");
  for (const [i, d] of ["2026-10-05", "2026-10-07"].entries()) {
    assert.equal(cli(["plans", "done", "--date", d, "--as-planned", "--root", dir]).code, 0);
    const r = cli(["tally-mention", "--root", dir]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.mention, false);
    assert.equal(r.json.logged_sessions, i + 1);
  }
  assert.equal(readFileSync(join(dir, "coach.yaml"), "utf8"), before, "coach.yaml is untouched before the third session");
  cli(["plans", "done", "--date", "2026-10-09", "--as-planned", "--root", dir]);
  const third = cli(["tally-mention", "--root", dir]);
  assert.equal(third.json.mention, true);
  assert.equal(third.json.text, TALLY_MENTION_TEXT);
  assert.match(third.json.text, /Say 'switch to Tally' to try it\./);
  const after = readFileSync(join(dir, "coach.yaml"), "utf8");
  assert.match(after, /^tally_mentioned: true$/m);
  assert.match(after, /logger: files # where plans live/, "comments are kept");
  // Never again, also after more sessions.
  cli(["plans", "done", "--date", "2026-10-12", "--as-planned", "--root", dir]);
  for (let i = 0; i < 2; i++) {
    const again = cli(["tally-mention", "--root", dir]);
    assert.equal(again.json.mention, false);
    assert.match(again.json.reason, /already mentioned/);
  }
  assert.equal(validateConfig(parse(readFileSync(join(dir, "coach.yaml"), "utf8"))).tally_mentioned, true);
});

test("Tally mention: logger other counts the sessions the coach read; logger tally never mentions", () => {
  const other = instance((y) => y.replace(/^logger: .*$/m, "logger: other"));
  assert.equal(cli(["tally-mention", "--root", other]).code, 2, "other needs --sessions");
  assert.equal(cli(["tally-mention", "--sessions", "2", "--root", other]).json.mention, false);
  assert.equal(cli(["tally-mention", "--sessions", "3", "--root", other]).json.mention, true);
  assert.equal(cli(["tally-mention", "--sessions", "9", "--root", other]).json.mention, false);
  const tally = instance();
  const t = cli(["tally-mention", "--root", tally]);
  assert.equal(t.json.mention, false);
  assert.doesNotMatch(readFileSync(join(tally, "coach.yaml"), "utf8"), /^tally_mentioned/m);
});

// ---------- worktrees ----------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" } }).trim();
}

/** A main checkout on main with one commit, and a linked worktree on branch `coach`. */
function repoWithWorktree(): { main: string; wt: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "coach-wt-")));
  const main = join(base, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "README.md"), "x\n");
  git(main, "add", "README.md");
  git(main, "commit", "-q", "-m", "init");
  const wt = join(base, "wt");
  git(main, "worktree", "add", "-q", "-b", "coach", wt);
  return { main, wt };
}

test("worktree: status names the main checkout; ff-main fast-forwards main in the main checkout when it is clean", () => {
  const { main, wt } = repoWithWorktree();
  const st = cli(["worktree", "status", "--root", wt]);
  assert.equal(st.code, 0, st.stderr);
  assert.equal(st.json.worktree, true);
  assert.equal(st.json.branch, "coach");
  assert.equal(st.json.main_checkout, main);
  assert.equal(st.json.main_checked_out_at, main);
  // Nothing to do yet.
  assert.equal(cli(["worktree", "ff-main", "--root", wt]).json.skipped, "main already has every commit of this branch");
  // Setup commits on the branch; ff-main moves main and the main checkout's files.
  writeFileSync(join(wt, "coach.yaml"), "version: 1\n");
  git(wt, "add", "coach.yaml");
  git(wt, "commit", "-q", "-m", "setup");
  const ff = cli(["worktree", "ff-main", "--root", wt]);
  assert.equal(ff.code, 0, ff.stdout);
  assert.equal(ff.json.changed, true);
  assert.equal(git(main, "rev-parse", "main"), git(wt, "rev-parse", "HEAD"));
  assert.ok(existsSync(join(main, "coach.yaml")), "the main checkout has the file");
  // On main itself there is nothing to do.
  assert.equal(cli(["worktree", "ff-main", "--root", main]).json.skipped, "this checkout is on main");
});

test("worktree: ff-main refuses a dirty main checkout and a diverged main; never a merge commit", () => {
  const { main, wt } = repoWithWorktree();
  writeFileSync(join(wt, "a.txt"), "a\n");
  git(wt, "add", "a.txt");
  git(wt, "commit", "-q", "-m", "a");
  writeFileSync(join(main, "README.md"), "edited\n");
  const dirty = cli(["worktree", "ff-main", "--root", wt]);
  assert.equal(dirty.code, 1);
  assert.match(dirty.json.reason, /uncommitted changes: main was not moved/);
  git(main, "commit", "-q", "-am", "diverge");
  const diverged = cli(["worktree", "ff-main", "--root", wt]);
  assert.equal(diverged.code, 1);
  assert.match(diverged.json.reason, /not a fast-forward/);
  assert.equal(git(main, "log", "--oneline").split("\n").length, 2, "no merge commit");
});

test("worktree: main not checked out anywhere moves by fast-forward only", () => {
  const { main, wt } = repoWithWorktree();
  git(main, "switch", "-q", "-c", "other");
  writeFileSync(join(wt, "a.txt"), "a\n");
  git(wt, "add", "a.txt");
  git(wt, "commit", "-q", "-m", "a");
  const ff = cli(["worktree", "ff-main", "--root", wt]);
  assert.equal(ff.code, 0, ff.stdout);
  assert.equal(git(main, "rev-parse", "main"), git(wt, "rev-parse", "HEAD"));
});

test("worktree: after an update on the main checkout, ff-branch fast-forwards the worktree branch (clean only)", () => {
  const { main, wt } = repoWithWorktree();
  writeFileSync(join(main, "engine.ts"), "new\n");
  git(main, "add", "engine.ts");
  git(main, "commit", "-q", "-m", "update: coach-harness");
  writeFileSync(join(wt, "scratch.txt"), "x\n");
  const dirty = cli(["worktree", "ff-branch", "--root", wt]);
  assert.equal(dirty.code, 1);
  assert.match(dirty.json.reason, /uncommitted changes/);
  execFileSync("rm", [join(wt, "scratch.txt")]);
  const ff = cli(["worktree", "ff-branch", "--root", wt]);
  assert.equal(ff.code, 0, ff.stdout);
  assert.equal(git(wt, "rev-parse", "HEAD"), git(main, "rev-parse", "main"));
  assert.ok(existsSync(join(wt, "engine.ts")));
});

test("update takes --root <main checkout>: it checks the main checkout, not the worktree", () => {
  const { main, wt } = repoWithWorktree();
  // No manifest in this toy repo: the refusal names the main checkout's state, proving --root is used.
  const r = cli(["update", "--check", "--root", main], { cwd: wt });
  assert.notEqual(r.code, 0);
  assert.equal(r.json.error.code, "NO_MANIFEST");
});

// ---------- allow-server, init-athlete, commit, setup-check ----------

test("allow-server: writes mcp__<server> into .claude/settings.local.json, merging with what is there", () => {
  const dir = mkdtempSync(join(tmpdir(), "coach-allow-"));
  const first = cli(["allow-server", "--server", "claude_ai_Tally_Workout", "--root", dir]);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.json, { file: ".claude/settings.local.json", rule: "mcp__claude_ai_Tally_Workout", added: true });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".claude/settings.local.json"), "utf8")), { permissions: { allow: ["mcp__claude_ai_Tally_Workout"] } });
  // The athlete's own settings stay.
  const own = { permissions: { allow: ["Bash(ls)"], deny: ["Read(.env)"] }, hooks: { Stop: [] }, model: "opus" };
  writeFileSync(join(dir, ".claude/settings.local.json"), JSON.stringify(own));
  cli(["allow-server", "--server", "tally", "--root", dir]);
  const again = cli(["allow-server", "--server", "tally", "--root", dir]);
  assert.equal(again.json.added, false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".claude/settings.local.json"), "utf8")), { ...own, permissions: { allow: ["Bash(ls)", "mcp__tally"], deny: ["Read(.env)"] } });
  // A bad name or a file that does not parse changes nothing.
  assert.equal(cli(["allow-server", "--server", "tally__get_x; rm", "--root", dir]).code, 2);
  writeFileSync(join(dir, ".claude/settings.local.json"), "{ not json");
  const bad = cli(["allow-server", "--server", "tally", "--root", dir]);
  assert.equal(bad.json.error.code, "SETTINGS_INVALID");
  assert.equal(readFileSync(join(dir, ".claude/settings.local.json"), "utf8"), "{ not json");
});

test("init-athlete: copies the starting files once and never overwrites", () => {
  const dir = mkdtempSync(join(tmpdir(), "coach-init-"));
  execFileSync("cp", ["-R", join(REPO, "templates"), join(dir, "templates")]);
  const r = cli(["init-athlete", "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.created.sort(), ["athlete/baselines.json", "athlete/block.yaml", "athlete/brief.md", "athlete/limits.yaml"]);
  assert.ok(existsSync(join(dir, "athlete/log")));
  writeFileSync(join(dir, "athlete/brief.md"), "mine\n");
  const again = cli(["init-athlete", "--root", dir]);
  assert.equal(again.json.created.length, 0);
  assert.equal(readFileSync(join(dir, "athlete/brief.md"), "utf8"), "mine\n");
});

test("commit: commits athlete/, plans/ and coach.yaml only, never other staged work", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coach-commit-")));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", "README.md");
  git(dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  mkdirSync(join(dir, "plans"));
  writeFileSync(join(dir, "plans/2026-W42.csv"), "date\n");
  writeFileSync(join(dir, "coach.yaml"), "version: 1\n");
  writeFileSync(join(dir, "README.md"), "staged\n");
  git(dir, "add", "README.md");
  const r = cli(["commit", "--message", "setup: athlete files and week 1", "--root", dir], { env: { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.committed, true);
  assert.deepEqual(git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["coach.yaml", "plans/2026-W42.csv"]);
  assert.equal(git(dir, "diff", "--cached", "--name-only"), "README.md", "the staged README stays staged");
  assert.equal(cli(["commit", "--root", dir]).code, 2);
});

test("setup-check: one silent command with the versions, timezone, name, worktree and progress; unattended is a problem", () => {
  const dir = instance();
  mkdirSync(join(dir, "athlete/log"), { recursive: true });
  writeFileSync(join(dir, "athlete/log/setup.md"), "setup: basics done 2026-10-12 08:00\nsetup: goal done 2026-10-12 08:01\n");
  const r = cli(["setup-check", "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  for (const k of ["mode", "node", "claude", "npm_ci_needed", "timezone", "name", "coach_yaml", "setup_progress", "worktree", "problems"]) assert.ok(k in r.json, k);
  assert.equal(r.json.mode, "interactive");
  assert.equal(r.json.node.ok, true);
  assert.equal(r.json.setup_progress, "setup: goal done 2026-10-12 08:01");
  assert.equal(r.json.worktree.git, false);
  const un = cli(["setup-check", "--root", dir], { env: { COACH_UNATTENDED: "1" } });
  assert.deepEqual(un.json.problems, ["setup needs an interactive session"]);
});

// ---------- V2b fix round ----------

import { session, snapshot } from "./guard/fixtures.ts";
import { writeJson } from "./e3/helpers.ts";

test("V2b fix 4: a disconnected tool: logger set files switches coach.yaml, and the engine then reads the files", () => {
  const dir = instance((y) => y.replace(/^logger: .*$/m, "logger: other # a tool I use"));
  writePlan(dir, [DAY("2026-10-12")], "lbs");
  cli(["plans", "done", "--date", "2026-10-12", "--as-planned", "--root", dir]);
  // Under other, the engine does not read the files (they are not the record yet).
  assert.deepEqual(cli(["weeks", "--from", "2026-10-12", "--to", "2026-10-18", "--root", dir]).json.logs[0].days, []);
  const set = cli(["logger", "set", "files", "--root", dir]);
  assert.equal(set.code, 0, set.stderr);
  assert.deepEqual(set.json, { logger: "files", previous: "other", changed: true });
  const yaml = readFileSync(join(dir, "coach.yaml"), "utf8");
  assert.match(yaml, /^logger: files # a tool I use$/m, "the comment is kept");
  assert.equal(cli(["weeks", "--from", "2026-10-12", "--to", "2026-10-18", "--root", dir]).json.logs[0].days.length, 1);
  assert.equal(cli(["tally-mention", "--root", dir]).json.logged_sessions, 1, "the mention counts the files now");
  assert.equal(cli(["logger", "set", "files", "--root", dir]).json.changed, false);
  assert.equal(cli(["logger", "set", "notion", "--root", dir]).code, 2);
});

test("V2b fix 4: after a switch from Tally to other, the Tally cache is not read (no snapshot unless evidence is passed)", () => {
  const dir = instance();
  writeJson(dir, "athlete/.cache/snapshot.json", snapshot({}, { history: [session("2026-10-06", [{ name: "Squat", sets: 3, weight: 185, reps: 5 }])], history_coverage: { captured_at: "2026-10-13T15:00:00Z", complete: true, since: "2026-10-01", until: "2026-10-13" } }));
  assert.equal(cli(["weeks", "--from", "2026-10-05", "--to", "2026-10-11", "--root", dir]).json.logs[0].days.length, 1, "Tally reads its cache");
  assert.equal(cli(["logger", "set", "other", "--root", dir]).code, 0);
  const weeks = cli(["weeks", "--from", "2026-10-05", "--to", "2026-10-11", "--root", dir]);
  assert.deepEqual(weeks.json.logs[0].days, []);
  assert.ok(weeks.json.warnings.some((w: string) => /no snapshot/.test(w)));
  const loads = cli(["loads", "--from-snapshot", "2026-10-13", "--root", dir]);
  assert.equal(loads.json.error.code, "NO_SNAPSHOT");
  assert.match(loads.json.error.message, /pass the day as --input/);
  // Evidence passed as a file still works.
  const input = writeJson(dir, ".tmp/coach/loads.json", { exercises: [{ name: "Squat", sets: [{ weight: 185, reps: 5 }] }], history: [session("2026-10-06", [{ name: "Squat", sets: 3, weight: 185, reps: 5 }])] });
  assert.equal(cli(["loads", "--input", input, "--root", dir]).code, 0);
});

const GIT_ENV = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };

test("V2b fix 9: commit: nothing to commit exits 0 and says so; a failed commit exits nonzero", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coach-commit9-")));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "coach.yaml"), "version: 1\n");
  git(dir, "add", "coach.yaml");
  git(dir, "commit", "-q", "-m", "init");
  const nothing = cli(["commit", "--message", "x", "--root", dir], { env: GIT_ENV });
  assert.equal(nothing.code, 0);
  assert.equal(nothing.json.ok, true);
  assert.equal(nothing.json.committed, false);
  assert.equal(nothing.json.reason, "nothing to commit");
  // A pre-commit hook that refuses: the commit fails, and so does the command.
  writeFileSync(join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\necho refused >&2\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(dir, "coach.yaml"), "version: 1\n# changed\n");
  const failed = cli(["commit", "--message", "x", "--root", dir], { env: GIT_ENV });
  assert.equal(failed.code, 1);
  assert.equal(failed.json.ok, false);
  assert.match(failed.json.reason, /refused/);
  // Not a repository: fails too.
  assert.equal(cli(["commit", "--message", "x", "--root", mkdtempSync(join(tmpdir(), "coach-norepo-"))]).code, 1);
});

test("V2b fix 10: tally-mention before the commit: its coach.yaml change goes into the commit", () => {
  const dir = instance((y) => y.replace(/^logger: .*$/m, "logger: files"));
  git(dir, "init", "-q", "-b", "main");
  writePlan(dir, [DAY("2026-10-05"), DAY("2026-10-07"), DAY("2026-10-09")], "lbs");
  for (const d of ["2026-10-05", "2026-10-07", "2026-10-09"]) cli(["plans", "done", "--date", d, "--as-planned", "--root", dir]);
  assert.equal(cli(["tally-mention", "--root", dir]).json.mention, true);
  const c = cli(["commit", "--message", "today 2026-10-09: none", "--root", dir], { env: GIT_ENV });
  assert.equal(c.code, 0, JSON.stringify(c.json));
  assert.match(git(dir, "show", "HEAD:coach.yaml"), /^tally_mentioned: true$/m);
  assert.equal(git(dir, "status", "--porcelain", "--", "coach.yaml", "plans", "athlete"), "");
});

test("V2b fix 5: history-files offers the two newest CSV files in ~/Downloads and ~/Desktop only", () => {
  const home = mkdtempSync(join(tmpdir(), "coach-home-"));
  for (const [rel, age] of [["Downloads/strong.csv", 30], ["Desktop/hevy_export.CSV", 10], ["Downloads/old.csv", 900], ["Downloads/notes.txt", 1], ["Documents/other.csv", 1], ["Downloads/sub/deep.csv", 1]] as const) {
    mkdirSync(join(home, rel, ".."), { recursive: true });
    // V4: only files whose header looks like a workout export are listed.
    writeFileSync(join(home, rel), "Date,Exercise,Reps\n");
    const t = new Date(Date.now() - age * 60_000);
    utimesSync(join(home, rel), t, t);
  }
  const r = cli(["history-files"], { env: { HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.files.map((f: { name: string; folder: string }) => `${f.folder}/${f.name}`), ["Desktop/hevy_export.CSV", "Downloads/strong.csv"]);
  assert.deepEqual(cli(["history-files"], { env: { HOME: mkdtempSync(join(tmpdir(), "coach-empty-")) } }).json.files, []);
  // The evals point COACH_HISTORY_HOME at an empty folder, so no real file name reaches a run.
  assert.deepEqual(cli(["history-files"], { env: { HOME: home, COACH_HISTORY_HOME: mkdtempSync(join(tmpdir(), "coach-empty-")) } }).json.files, []);
});
