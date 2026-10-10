// CLI subcommands for the guard. Wired into engine/cli.ts in one block.
//
//   node engine/cli.ts classify --exercise "<name>" [--id <exerciseId>] [--muscle <m>]
//   node engine/cli.ts classify --input <file.json>     ({before, after, tool, today?, volume?})
//   node engine/cli.ts validate --tool <name> --args <file.json> [--mode interactive|unattended] [--session <id>] [--now <instant>]
//   (proposals list lives in the `proposals` case, engine/cli-helpers.ts, with the approval status added)
//   node engine/cli.ts install-git-hooks
//   node engine/cli.ts prepush-check [--remote origin]   (exit 1: do not push; contracts §23)
//   node engine/cli.ts push [--branch <name>]            (install hooks, check, push origin; exit 1: nothing pushed)
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { classifyChange } from "./classify.ts";
import { loadConfig } from "./config.ts";
import { localDate } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { guardInputFrom, loadGuardFiles, readApprovedBlock } from "./guard-context.ts";
import { unattendedMarker } from "./hold.ts";
import { loadRules } from "./methods.ts";
import { githubRepo, lookupVisibility } from "./prepush.ts";
import { loadSnapshot } from "./snapshot.ts";
import { classify, loadTaxonomy } from "./taxonomy.ts";
import { guard } from "./validate.ts";
import type { LoggerTool } from "./logger.ts";
import type { Rules } from "./types.ts";

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CoachError("INPUT_ERROR", `cannot read ${path}: ${(e as Error).message}`);
  }
}

function opts(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: "string" },
      input: { type: "string" },
      exercise: { type: "string" },
      id: { type: "string" },
      muscle: { type: "string" },
      tool: { type: "string" },
      args: { type: "string" },
      mode: { type: "string" },
      session: { type: "string" },
      now: { type: "string" },
      remote: { type: "string" },
      branch: { type: "string" },
    },
  });
}

function cmdClassify(argv: string[]): number {
  const { values } = opts(argv);
  const root = resolve(values.root ?? ".");
  const tax = loadTaxonomy({ root });
  if (values.exercise) {
    out(classify({ name: values.exercise, exerciseId: values.id ?? null, muscle: values.muscle ?? null }, tax));
    return 0;
  }
  if (!values.input) throw new CoachError("USAGE", "classify needs --exercise <name> or --input <file.json>");
  const input = readJson(values.input) as Record<string, any>;
  const config = loadConfig(join(root, "coach.yaml"));
  const rules = loadRules(join(root, "methods", config.method)) as unknown as Rules;
  const snap = loadSnapshot(root);
  const today = typeof input.today === "string" ? input.today : localDate(new Date().toISOString(), config.athlete.timezone);
  out(
    classifyChange(input.before ?? null, input.after ?? null, {
      block: readApprovedBlock(root),
      history: snap?.history ?? [],
      tool: String(input.tool ?? "plan_workout_day") as LoggerTool,
      snapshotDay: input.snapshotDay ?? null,
      tax,
      rules,
      config,
      today,
      ...(input.volume ? { volume: input.volume } : {}),
    }),
  );
  return 0;
}

/** Previews the guard's verdict for a call. The session defaults to the snapshot's. */
function cmdValidate(argv: string[]): number {
  const { values } = opts(argv);
  const root = resolve(values.root ?? ".");
  if (!values.tool || !values.args) throw new CoachError("USAGE", "validate needs --tool <name> --args <file.json>");
  const now = values.now ?? new Date().toISOString();
  const mode = values.mode ?? (unattendedMarker(process.env) ? "unattended" : "interactive");
  if (mode !== "interactive" && mode !== "unattended") throw new CoachError("USAGE", "--mode must be interactive | unattended");
  const files = loadGuardFiles(root, now);
  const session_id = values.session ?? files.snapshot?.session_id ?? "none";
  const verdict = guard(guardInputFrom(files, { tool: values.tool, args: readJson(isAbsolute(values.args) ? values.args : resolve(values.args)), mode, now, session_id }));
  out({ ...verdict, mode, session_id, approval_warnings: files.approvals.warnings });
  return 0;
}


/** Copies git-hooks/pre-push into the repo's hooks folder. A different existing hook is kept as a backup. */
function installGitHooks(root: string): { installed: string; backup: string | null } {
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
 * The check before an automated push (contracts §23). A fresh clone has no git hooks, so
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
 * The only push of an unattended run (contracts §23): install the git hooks, run the
 * pre-push check, then push one local branch (the current branch by default) to the
 * same-name branch on origin: `git push --no-follow-tags [-u] origin
 * refs/heads/<b>:refs/heads/<b>`. The explicit pair leaves no destination to
 * remote.origin.push, and --no-follow-tags overrides push.followTags. Every push URL of
 * origin (`git remote get-url --all --push`, insteadOf rules applied) must name the
 * repository the check looked up. A failed check exits 1 and pushes nothing.
 */
function cmdPush(argv: string[]): number {
  const { values } = opts(argv);
  const root = resolve(values.root ?? ".");
  const gitOut = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let branch = values.branch;
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
  if (!check.ok) {
    out({ ok: false, pushed: false, branch, hooks, check, reason: check.reason });
    return 1;
  }
  let pushUrls: string[];
  try {
    pushUrls = gitOut(["remote", "get-url", "--all", "--push", "origin"]).split("\n").filter(Boolean);
  } catch {
    pushUrls = [];
  }
  const other = pushUrls.find((u) => githubRepo(u)?.toLowerCase() !== check.repo?.toLowerCase());
  if (pushUrls.length === 0 || other !== undefined) {
    const reason = `origin pushes to ${other ?? "no URL"}, not to ${check.repo}, the repository the check looked up; do not push`;
    out({ ok: false, pushed: false, branch, hooks, check, push_urls: pushUrls, reason });
    return 1;
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
    out({ ok: false, pushed: false, branch, hooks, check, reason: `git ${args.join(" ")} failed: ${(err.stderr ?? err.message).trim().split("\n").slice(-3).join(" | ")}` });
    return 1;
  }
  out({ ok: true, pushed: true, branch, set_upstream: !upstream, argv: ["git", ...args], hooks, check });
  return 0;
}

/** Runs a guard subcommand. Returns null when `cmd` is not one of them. */
export function guardCommand(cmd: string | undefined, argv: string[]): number | null {
  switch (cmd) {
    case "classify":
      return cmdClassify(argv);
    case "validate":
      return cmdValidate(argv);
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
