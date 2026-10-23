// V7 test helpers: an athlete repo with a GitHub-style origin served from a local bare repo (a
// fake ssh, as the evals and the pre-push tests do) and a fake `gh` for the visibility lookup.
// Made-up data only.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO = new URL("..", import.meta.url).pathname;
export const GIT_ENV = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR", "COACH_NOW", "FAKE_VIS"].includes(k)));

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A fake gh: prints $FAKE_VIS, or fails when it is unset. */
export function fakeGh(): string {
  const bin = mkdtempSync(join(tmpdir(), "v7-gh-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nif [ -z "$FAKE_VIS" ]; then echo "HTTP 404: Not Found" >&2; exit 1; fi\necho "$FAKE_VIS"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

export type Remote = { bare: string; ssh: string; url: string };

/** A bare repo served as git@github.com:alex/coach.git through a fake ssh. */
export function remote(): Remote {
  const bare = mkdtempSync(join(tmpdir(), "v7-bare-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  const ssh = join(bare, "fake-ssh");
  writeFileSync(ssh, `#!/bin/sh\nfor last; do :; done\ncase "$last" in\n  "git-receive-pack 'alex/coach.git'") exec git receive-pack "${bare}" ;;\n  "git-upload-pack 'alex/coach.git'") exec git upload-pack "${bare}" ;;\nesac\nexit 1\n`);
  chmodSync(ssh, 0o755);
  return { bare, ssh, url: "git@github.com:alex/coach.git" };
}

export const COACH_YAML = (logger = "tally") => readFileSync(join(REPO, "coach.example.yaml"), "utf8").replace(/^logger: tally/m, `logger: ${logger}`);

/** An athlete repo on main with origin = the remote, pushed once. methods/ is linked, not committed. */
export function athleteRepo(r: Remote, logger = "tally"): string {
  const dir = mkdtempSync(join(tmpdir(), "v7-athlete-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.sshCommand", r.ssh);
  writeFileSync(join(dir, ".gitignore"), "athlete/.cache/\n.tmp/\nmethods\nengine\nadapters\nnode_modules\n");
  writeFileSync(join(dir, "coach.yaml"), COACH_YAML(logger));
  mkdirSync(join(dir, "athlete/log"), { recursive: true });
  writeFileSync(join(dir, "athlete/brief.md"), "# Brief\n\n## Preferences\n- likes front squats\n");
  writeFileSync(join(dir, "athlete/limits.md"), "# Injuries and limits\n\nNone yet.\n");
  writeFileSync(join(dir, "README.md"), "athlete repo\n");
  linkEngine(dir);
  // The athlete files are older than any run in a test.
  const hourAgo = new Date(Date.now() - 3_600_000);
  for (const f of ["athlete/brief.md", "athlete/limits.md", "coach.yaml"]) utimesSync(join(dir, f), hourAgo, hourAgo);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "start");
  git(dir, "remote", "add", "origin", r.url);
  git(dir, "push", "-q", "origin", "main");
  git(dir, "branch", "--set-upstream-to=origin/main", "main");
  return dir;
}

/** The engine the pre-push hook runs, linked and ignored (an athlete copy has its own). Call it in each new worktree. */
export function linkEngine(dir: string): void {
  for (const d of ["methods", "engine", "adapters", "node_modules"]) symlinkSync(join(REPO, d), join(dir, d));
}

/** A second clone that pushes a commit to the remote (someone else, or a cloud run). */
export function remoteCommit(r: Remote, file: string, text: string): void {
  const dir = mkdtempSync(join(tmpdir(), "v7-other-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.sshCommand", r.ssh);
  git(dir, "remote", "add", "origin", r.url);
  git(dir, "fetch", "-q", "origin");
  git(dir, "checkout", "-q", "-b", "main", "origin/main", "--force");
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", `remote: ${file}`);
  git(dir, "push", "-q", "origin", "main");
}

export function cliIn(root: string, args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), ...args, "--root", root], { cwd: root, encoding: "utf8", env: { ...CLEAN_ENV, ...GIT_ENV, ...env } as NodeJS.ProcessEnv });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

export function writeJson(dir: string, rel: string, value: unknown): string {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(value, null, 2));
  return p;
}
