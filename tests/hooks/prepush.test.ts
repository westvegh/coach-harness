// git-hooks/pre-push and `cli.ts install-git-hooks`: a destination-specific visibility
// check through a fake `gh` on PATH, in a temporary git repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubRepo } from "../../engine/prepush.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
}

/** A fake gh: `gh api repos/<o>/<r> --jq .visibility` prints $FAKE_VIS, or fails when it is unset. */
function fakeGh(): string {
  const bin = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${log}"\nif [ -z "$FAKE_VIS" ]; then echo "HTTP 404: Not Found" >&2; exit 1; fi\necho "$FAKE_VIS"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

/** A repo whose engine/ and git-hooks/ come from this checkout (the hook runs engine/prepush.ts). */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-push-"));
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "templates/athlete"), { recursive: true });
  writeFileSync(join(dir, "templates/athlete/limits.yaml"), "x\n");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function runHook(dir: string, bin: string, vis: string | null, url: string, lines: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: `${bin}:${process.env.PATH}` };
  delete env.FAKE_VIS;
  if (vis) env.FAKE_VIS = vis;
  // The hook script resolves engine/prepush.ts from the repo top level; point it at this checkout.
  const r = spawnSync(process.execPath, [join(REPO, "engine/prepush.ts"), "origin", url], { cwd: dir, input: lines, encoding: "utf8", env });
  return { code: r.status, stderr: r.stderr };
}

const ZERO = "0".repeat(40);
const URL_ = "https://github.com/alex/coach.git";

test("githubRepo parses https, ssh and scp-style URLs", () => {
  assert.equal(githubRepo("https://github.com/alex/coach.git"), "alex/coach");
  assert.equal(githubRepo("git@github.com:alex/coach.git"), "alex/coach");
  assert.equal(githubRepo("ssh://git@github.com/alex/coach"), "alex/coach");
  assert.equal(githubRepo("https://x-access-token:abc@github.com/alex/coach"), "alex/coach");
  assert.equal(githubRepo("/tmp/bare.git"), null);
});

test("public destination: a pushed commit that touches athlete/ is denied; templates/athlete is fine", () => {
  const dir = repo();
  const bin = fakeGh();
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "templates/athlete/limits.yaml"), "y\n");
  git(dir, "commit", "-q", "-am", "template");
  const clean = git(dir, "rev-parse", "HEAD");
  assert.equal(runHook(dir, bin, "public", URL_, `refs/heads/main ${clean} refs/heads/main ${base}\n`).code, 0);
  mkdirSync(join(dir, "athlete/log"), { recursive: true });
  writeFileSync(join(dir, "athlete/log/2026-10.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "log");
  writeFileSync(join(dir, "README.md"), "y\n");
  git(dir, "commit", "-q", "-am", "readme");
  const head = git(dir, "rev-parse", "HEAD");
  const r = runHook(dir, bin, "public", URL_, `refs/heads/main ${head} refs/heads/main ${base}\n`);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /alex\/coach is PUBLIC and 1 pushed commit\(s\) touch athlete data/);
  // A new branch (remote sha zero): every commit not on the remote counts.
  assert.equal(runHook(dir, bin, "public", URL_, `refs/heads/main ${head} refs/heads/x ${ZERO}\n`).code, 1);
  // The same push to a private destination is fine.
  assert.equal(runHook(dir, bin, "private", URL_, `refs/heads/main ${head} refs/heads/main ${base}\n`).code, 0);
  // An internal (enterprise) destination is checked like a public one.
  const internal = runHook(dir, bin, "internal", URL_, `refs/heads/main ${head} refs/heads/main ${base}\n`);
  assert.equal(internal.code, 1);
  assert.match(internal.stderr, /alex\/coach is INTERNAL and 1 pushed commit\(s\) touch athlete data/);
  assert.equal(runHook(dir, bin, "internal", URL_, `refs/heads/main ${clean} refs/heads/main ${base}\n`).code, 0);
  assert.match(readFileSync(join(bin, "calls.log"), "utf8"), /api repos\/alex\/coach --jq \.visibility/);
});

test("a failed lookup or a non-GitHub URL denies the push", () => {
  const dir = repo();
  const bin = fakeGh();
  const head = git(dir, "rev-parse", "HEAD");
  const failed = runHook(dir, bin, null, URL_, `refs/heads/main ${head} refs/heads/main ${ZERO}\n`);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /cannot look up the visibility of alex\/coach/);
  const local = runHook(dir, bin, "private", "/tmp/elsewhere.git", `refs/heads/main ${head} refs/heads/main ${ZERO}\n`);
  assert.equal(local.code, 1);
  assert.match(local.stderr, /not a GitHub URL/);
  // A pushed SHA that cannot be listed: deny on a public destination.
  const unknown = runHook(dir, bin, "public", URL_, `refs/heads/main ${"1".repeat(40)} refs/heads/main ${ZERO}\n`);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /cannot list the pushed commits/);
});

test("install-git-hooks installs the hook, and a real git push runs it", () => {
  const dir = repo();
  // The installed hook runs <toplevel>/engine/prepush.ts (node built-ins only).
  mkdirSync(join(dir, "engine"));
  execFileSync("cp", [join(REPO, "engine/prepush.ts"), join(dir, "engine/prepush.ts")]);
  const r = spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), "install-git-hooks", "--root", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const hookPath = JSON.parse(r.stdout).installed;
  assert.ok(existsSync(hookPath));
  assert.equal(readFileSync(hookPath, "utf8"), readFileSync(join(REPO, "git-hooks/pre-push"), "utf8"));
  // A push to a local bare repo: not a GitHub URL, so the lookup fails and the push is denied.
  const bare = mkdtempSync(join(tmpdir(), "coach-bare-"));
  git(bare, "init", "-q", "--bare");
  const push = spawnSync("git", ["push", bare, "main"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /coach-harness pre-push: cannot look up the visibility/);
  // Installing again over a different hook keeps a backup.
  writeFileSync(hookPath, "#!/bin/sh\nexit 0\n");
  const again = JSON.parse(spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), "install-git-hooks", "--root", dir], { encoding: "utf8" }).stdout);
  assert.ok(again.backup && existsSync(again.backup));
});

test("cached origin refs do not hide commits from a public destination", () => {
  const dir = repo();
  const bin = fakeGh();
  mkdirSync(join(dir, "athlete"), { recursive: true });
  writeFileSync(join(dir, "athlete/limits.yaml"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "athlete data");
  const head = git(dir, "rev-parse", "HEAD");
  // origin's cached refs already hold the commit, but origin's push URL now points at a public repo.
  git(dir, "update-ref", "refs/remotes/origin/main", head);
  const r = runHook(dir, bin, "public", URL_, `refs/heads/main ${head} refs/heads/new ${ZERO}\n`);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /touch athlete data/);
});

test("a non-ASCII athlete file name is caught (NUL-delimited paths)", () => {
  const dir = repo();
  const bin = fakeGh();
  const base = git(dir, "rev-parse", "HEAD");
  mkdirSync(join(dir, "athlete"), { recursive: true });
  writeFileSync(join(dir, "athlete/é.txt"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "accented");
  const head = git(dir, "rev-parse", "HEAD");
  const r = runHook(dir, bin, "public", URL_, `refs/heads/main ${head} refs/heads/main ${base}\n`);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /1 pushed commit\(s\) touch athlete data/);
});

// ---------- launch review finding 4: fresh clones have no hooks; prepush-check gates every automated push ----------

function prepushCheck(dir: string, bin: string, vis: string | null) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: `${bin}:${process.env.PATH}` };
  delete env.FAKE_VIS;
  if (vis) env.FAKE_VIS = vis;
  const r = spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), "prepush-check", "--root", dir], { cwd: dir, encoding: "utf8", env });
  return { code: r.status, json: JSON.parse(r.stdout) };
}

test("launch review finding 4: a fresh clone has no pre-push hook, and prepush-check refuses until install-git-hooks runs", () => {
  const origin = repo();
  const dir = mkdtempSync(join(tmpdir(), "coach-clone-"));
  git(dir, "clone", "-q", origin, ".");
  git(dir, "remote", "set-url", "origin", URL_);
  const bin = fakeGh();
  const hookPath = join(dir, ".git/hooks/pre-push");
  assert.equal(existsSync(hookPath), false, "git does not clone the hooks folder (the premise)");
  const before = prepushCheck(dir, bin, "private");
  assert.equal(before.code, 1);
  assert.equal(before.json.hook_installed, false);
  assert.match(before.json.reason, /install-git-hooks.*do not push/);
  // install-git-hooks is idempotent: a second run keeps one hook and no backup.
  for (let i = 0; i < 2; i++) {
    const r = spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), "install-git-hooks", "--root", dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).backup, null);
  }
  const ok = prepushCheck(dir, bin, "private");
  assert.equal(ok.code, 0, JSON.stringify(ok.json));
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.repo, "alex/coach");
  // A public repo, a failed lookup or a non-GitHub remote: no push.
  const pub = prepushCheck(dir, bin, "public");
  assert.equal(pub.code, 1);
  assert.match(pub.json.reason, /PUBLIC/);
  const internal = prepushCheck(dir, bin, "internal");
  assert.equal(internal.code, 1);
  assert.match(internal.json.reason, /INTERNAL; athlete data goes only to a private repository/);
  assert.equal(prepushCheck(dir, bin, null).code, 1);
  git(dir, "remote", "set-url", "origin", "/tmp/elsewhere.git");
  assert.equal(prepushCheck(dir, bin, "private").code, 1);
  // A changed hook does not count as installed.
  git(dir, "remote", "set-url", "origin", URL_);
  writeFileSync(hookPath, "#!/bin/sh\nexit 0\n");
  assert.equal(prepushCheck(dir, bin, "private").json.hook_installed, false);
});

test("the routine prompt and the skills push only through node engine/cli.ts push, which checks first", async () => {
  const { routinePrompt } = await import("../../engine/automation.ts");
  for (const kind of ["daily", "weekly"] as const) {
    for (const where of ["cloud", "mac"] as const) {
      const p = routinePrompt(kind, where);
      assert.match(p, /If node_modules is missing, run npm ci first\./);
      assert.match(p, /Push only with node engine\/cli\.ts push/);
      assert.doesNotMatch(p, /\bgit push\b/, p);
    }
  }
  const skill = (n: string) => readFileSync(join(REPO, ".claude/skills", n, "SKILL.md"), "utf8");
  for (const n of ["today", "week", "block", "limits", "setup"]) {
    const s = skill(n);
    assert.match(s, /node engine\/cli\.ts push/, n);
    // No skill tells the model to run a raw push.
    assert.doesNotMatch(s.replace(/[Nn]ever run `git push` yourself[^\n]*/g, ""), /`git push[ `]/, `${n}: a raw git push`);
  }
  assert.match(skill("setup"), /install-git-hooks[\s\S]*prepush-check[\s\S]*ok: true/);
  assert.match(readFileSync(join(REPO, "CLAUDE.md"), "utf8"), /`git pull --rebase`, then `node engine\/cli\.ts push`/);
});

test("V3b fix 1: a raw git push of a plans/ or a coach.yaml commit to a public destination is refused by the hook", () => {
  for (const [path, text] of [["plans/2026-W43.csv", "date,day,exercise\n"], ["coach.yaml", "version: 1\n"]] as const) {
    const dir = repo();
    mkdirSync(join(dir, "engine"));
    execFileSync("cp", [join(REPO, "engine/prepush.ts"), join(dir, "engine/prepush.ts")]);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "engine");
    assert.equal(spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), "install-git-hooks", "--root", dir], { encoding: "utf8" }).status, 0);
    // A GitHub URL served by a fake ssh from a local bare repo, as the evals do.
    const bare = mkdtempSync(join(tmpdir(), "coach-bare-"));
    git(bare, "init", "-q", "--bare", "-b", "main");
    const ssh = join(bare, "fake-ssh");
    writeFileSync(ssh, `#!/bin/sh\nfor last; do :; done\ncase "$last" in\n  "git-receive-pack 'alex/coach.git'") exec git receive-pack "${bare}" ;;\n  "git-upload-pack 'alex/coach.git'") exec git upload-pack "${bare}" ;;\nesac\nexit 1\n`);
    chmodSync(ssh, 0o755);
    git(dir, "config", "core.sshCommand", ssh);
    git(dir, "remote", "add", "origin", "git@github.com:alex/coach.git");
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", `add ${path}`);
    const env = { ...process.env, ...GIT_ENV, PATH: `${fakeGh()}:${process.env.PATH}`, FAKE_VIS: "public" };
    const push = spawnSync("git", ["push", "origin", "main"], { cwd: dir, encoding: "utf8", env });
    assert.notEqual(push.status, 0, `${path}: ${push.stderr}`);
    assert.match(push.stderr, /PUBLIC and 1 pushed commit\(s\) touch athlete data/, path);
    // The same push to a private destination goes through.
    const ok = spawnSync("git", ["push", "origin", "main"], { cwd: dir, encoding: "utf8", env: { ...env, FAKE_VIS: "private" } });
    assert.equal(ok.status, 0, `${path}: ${ok.stderr}`);
  }
});
