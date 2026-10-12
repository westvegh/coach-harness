// Privacy (contracts §10a): athlete data never goes to a public repository. Wired into
// engine/cli.ts in one block.
//
//   node engine/cli.ts install-git-hooks
//   node engine/cli.ts prepush-check [--remote origin]   (exit 1: do not push)
//   node engine/cli.ts push [--branch <name>]            (install hooks, check, push origin; exit 1: nothing pushed)
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CoachError } from "./errors.ts";
import { githubRepo, lookupVisibility } from "./prepush.ts";

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function opts(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: "string" },
      remote: { type: "string" },
      branch: { type: "string" },
    },
  });
}

/** Copies git-hooks/pre-push into the repo's hooks folder. A different existing hook is kept as a backup. */
export function installGitHooks(root: string): { installed: string; backup: string | null } {
  const src = join(import.meta.dirname, "..", "git-hooks", "pre-push");
  let hooksDir: string;
  try {
    hooksDir = resolve(root, execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
  } catch {
    throw new CoachError("GIT_ERROR", `not a git repository: ${root}`);
  }
  mkdirSync(hooksDir, { recursive: true });
  const dest = join(hooksDir, "pre-push");
  let backup: string | null = null;
  if (existsSync(dest) && readFileSync(dest, "utf8") !== readFileSync(src, "utf8")) {
    backup = `${dest}.bak-${Date.now()}`;
    renameSync(dest, backup);
  }
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  return { installed: dest, backup };
}

function cmdInstallGitHooks(argv: string[]): number {
  const { values } = opts(argv);
  out(installGitHooks(resolve(values.root ?? ".")));
  return 0;
}

export type PrepushResult = { ok: boolean; remote: string; reason: string; hook_installed?: boolean; repo?: string; visibility?: string };

/**
 * The check before a push (privacy, contracts §10a). A fresh clone has no git hooks, so
 * `push` installs them first. ok only when the pre-push hook in the hooks folder git uses
 * equals git-hooks/pre-push and the remote is a GitHub repository that `gh api` reports as
 * private or internal. A missing hook, a failed lookup or a public remote: not ok.
 */
export function prepushCheck(root: string, remote = "origin"): PrepushResult {
  const gitOut = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const fail = (reason: string, extra: Partial<PrepushResult> = {}): PrepushResult => ({ ok: false, remote, ...extra, reason: `${reason}; do not push` });
  let hook: string;
  try {
    hook = resolve(root, gitOut(["rev-parse", "--git-path", "hooks/pre-push"]));
  } catch {
    return fail(`not a git repository: ${root}`);
  }
  const src = join(import.meta.dirname, "..", "git-hooks", "pre-push");
  let installed = false;
  try {
    installed = readFileSync(hook, "utf8") === readFileSync(src, "utf8") && (statSync(hook).mode & 0o111) !== 0;
  } catch {
    installed = false;
  }
  if (!installed) return fail(`the pre-push hook is not installed at ${hook}: run node engine/cli.ts install-git-hooks`, { hook_installed: false });
  let url: string;
  try {
    url = gitOut(["remote", "get-url", remote]);
  } catch {
    return fail(`no remote ${remote}`, { hook_installed: true });
  }
  const repo = githubRepo(url);
  if (!repo) return fail(`${remote} is not a GitHub repository (${url}); its visibility cannot be checked`, { hook_installed: true });
  let visibility: string;
  try {
    visibility = lookupVisibility(repo, root);
  } catch (e) {
    return fail(`cannot look up the visibility of ${repo} with gh (${(e as Error).message.split("\n")[0]})`, { hook_installed: true, repo });
  }
  if (visibility === "public") return fail(`${repo} is PUBLIC; athlete data never goes to a public repository`, { hook_installed: true, repo, visibility });
  return { ok: true, remote, hook_installed: true, repo, visibility, reason: `${repo} is ${visibility} and the pre-push hook is installed` };
}

function cmdPrepushCheck(argv: string[]): number {
  const { values } = opts(argv);
  const r = prepushCheck(resolve(values.root ?? "."), values.remote ?? "origin");
  out(r);
  return r.ok ? 0 : 1;
}

const BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9._\/-]*$/;

/**
 * The trusted push (privacy, contracts §10a): install the git hooks, run the
 * pre-push check, then push one local branch (the current branch by default) to the
 * same-name branch on origin: `git push --no-follow-tags [-u] origin
 * refs/heads/<b>:refs/heads/<b>`. The explicit pair leaves no destination to
 * remote.origin.push, and --no-follow-tags overrides push.followTags. Every push URL of
 * origin (`git remote get-url --all --push`, insteadOf rules applied) must name the
 * repository the check looked up. A failed check exits 1 and pushes nothing.
 */
export type PushResult = { ok: boolean; pushed: boolean; branch?: string; reason?: string; [k: string]: unknown };

export function pushBranch(root: string, branchArg?: string): PushResult {
  const gitOut = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let branch = branchArg;
  if (branch === undefined) {
    try {
      branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {
      throw new CoachError("GIT_ERROR", `not a git repository: ${root}`);
    }
  }
  if (branch === "HEAD" || !BRANCH_RE.test(branch) || branch.includes("..") || branch.startsWith("refs/")) throw new CoachError("USAGE", `push needs a branch name, got ${JSON.stringify(branch)}`);
  const ref = `refs/heads/${branch}`;
  try {
    gitOut(["show-ref", "--verify", "--quiet", ref]);
  } catch {
    throw new CoachError("USAGE", `push needs a local branch: ${ref} does not exist`);
  }
  const hooks = installGitHooks(root);
  const check = prepushCheck(root, "origin");
  if (!check.ok) return { ok: false, pushed: false, branch, hooks, check, reason: check.reason };
  let pushUrls: string[];
  try {
    pushUrls = gitOut(["remote", "get-url", "--all", "--push", "origin"]).split("\n").filter(Boolean);
  } catch {
    pushUrls = [];
  }
  const other = pushUrls.find((u) => githubRepo(u)?.toLowerCase() !== check.repo?.toLowerCase());
  if (pushUrls.length === 0 || other !== undefined) {
    const reason = `origin pushes to ${other ?? "no URL"}, not to ${check.repo}, the repository the check looked up; do not push`;
    return { ok: false, pushed: false, branch, hooks, check, push_urls: pushUrls, reason };
  }
  let upstream = true;
  try {
    gitOut(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{u}`]);
  } catch {
    upstream = false;
  }
  const args = ["push", "--no-follow-tags", ...(upstream ? [] : ["-u"]), "origin", `${ref}:${ref}`];
  try {
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { ok: false, pushed: false, branch, hooks, check, reason: `git ${args.join(" ")} failed: ${(err.stderr ?? err.message).trim().split("\n").slice(-3).join(" | ")}` };
  }
  return { ok: true, pushed: true, branch, set_upstream: !upstream, argv: ["git", ...args], hooks, check };
}

function cmdPush(argv: string[]): number {
  const { values } = opts(argv);
  const r = pushBranch(resolve(values.root ?? "."), values.branch);
  out(r);
  return r.ok ? 0 : 1;
}

/** Runs a git subcommand. Returns null when `cmd` is not one of them. */
export function gitCommand(cmd: string | undefined, argv: string[]): number | null {
  switch (cmd) {
    case "install-git-hooks":
      return cmdInstallGitHooks(argv);
    case "prepush-check":
      return cmdPrepushCheck(argv);
    case "push":
      return cmdPush(argv);
    default:
      return null;
  }
}
