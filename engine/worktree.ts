// A coaching copy opened in a git worktree on another branch (v0.2, contracts §24 "A copy in a
// worktree"). Setup works on the worktree's branch and, at the end, fast-forwards `main` to it
// (`worktree ff-main`), so a cloud run that clones main sees the setup. The update runs against
// the main checkout (`update --root <main checkout>`), then the worktree's branch fast-forwards
// to the new main (`worktree ff-branch`). Never a merge commit, never a force: fast-forward only,
// and only when the checkout it changes is clean. Built-ins only.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { CoachError } from "./errors.ts";

export const MAIN_BRANCH = "main";

export type WorktreeStatus = {
  /** True inside a git work tree. */
  git: boolean;
  /** True when this checkout is a linked worktree (not the main checkout). */
  worktree: boolean;
  /** The branch checked out here (null: detached HEAD or not git). */
  branch: string | null;
  /** The main checkout's folder (the first `git worktree list` entry). */
  main_checkout: string | null;
  /** The branch checked out in the main checkout. */
  main_checkout_branch: string | null;
  /** Where `main` is checked out, if anywhere. */
  main_checked_out_at: string | null;
  /** No tracked change and no untracked file (outside .gitignore) here. */
  clean: boolean | null;
  /** The same for the main checkout. */
  main_clean: boolean | null;
  /** Commits on this branch that main lacks, and on main that this branch lacks. */
  ahead: number | null;
  behind: number | null;
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

type Entry = { path: string; branch: string | null };

/** `git worktree list --porcelain`: the main checkout first. */
function worktrees(root: string): Entry[] {
  const text = tryGit(root, ["worktree", "list", "--porcelain"]);
  if (text === null) return [];
  const out: Entry[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    out.push({ path, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null });
  }
  return out;
}

function isClean(dir: string): boolean | null {
  const s = tryGit(dir, ["status", "--porcelain", "--untracked-files=normal"]);
  return s === null ? null : s === "";
}

export function worktreeStatus(rootArg: string): WorktreeStatus {
  const root = resolve(rootArg);
  const top = tryGit(root, ["rev-parse", "--show-toplevel"]);
  if (top === null) return { git: false, worktree: false, branch: null, main_checkout: null, main_checkout_branch: null, main_checked_out_at: null, clean: null, main_clean: null, ahead: null, behind: null };
  const list = worktrees(root);
  const main = list[0] ?? { path: top, branch: null };
  const head = tryGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const linked = real(top) !== real(main.path);
  const at = list.find((e) => e.branch === MAIN_BRANCH)?.path ?? null;
  let ahead: number | null = null;
  let behind: number | null = null;
  if (head && head !== MAIN_BRANCH && tryGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${MAIN_BRANCH}`]) !== null) {
    const counts = tryGit(root, ["rev-list", "--left-right", "--count", `refs/heads/${head}...refs/heads/${MAIN_BRANCH}`]);
    if (counts) [ahead, behind] = counts.split(/\s+/).map(Number);
  }
  return {
    git: true,
    worktree: linked,
    branch: head,
    main_checkout: main.path,
    main_checkout_branch: main.branch,
    main_checked_out_at: at,
    clean: isClean(root),
    main_clean: linked ? isClean(main.path) : isClean(root),
    ahead,
    behind,
  };
}

export type SyncResult = { ok: boolean; changed: boolean; skipped?: string; reason?: string; from?: string; to?: string; status: WorktreeStatus };

/**
 * Fast-forwards `main` to this worktree's branch. Where main is checked out, that checkout must
 * be clean (`git -C <it> merge --ff-only <branch>`); where it is not checked out, the ref moves
 * with `git fetch . <branch>:main`, which refuses anything but a fast-forward. Skipped (ok) when
 * this checkout is on main or main already has every commit.
 */
export function ffMain(rootArg: string): SyncResult {
  const root = resolve(rootArg);
  const st = worktreeStatus(root);
  if (!st.git) throw new CoachError("GIT_ERROR", `not a git repository: ${root}`);
  if (!st.branch) return { ok: false, changed: false, reason: "this checkout has no branch (detached HEAD)", status: st };
  if (st.branch === MAIN_BRANCH) return { ok: true, changed: false, skipped: "this checkout is on main", status: st };
  if (st.ahead === null) return { ok: false, changed: false, reason: "there is no local main branch", status: st };
  if (st.ahead === 0) return { ok: true, changed: false, skipped: "main already has every commit of this branch", status: st };
  if (st.behind !== null && st.behind > 0) return { ok: false, changed: false, reason: `main has ${st.behind} commit(s) this branch lacks: not a fast-forward`, status: st };
  const from = tryGit(root, ["rev-parse", `refs/heads/${MAIN_BRANCH}`]) ?? undefined;
  try {
    if (st.main_checked_out_at) {
      if (isClean(st.main_checked_out_at) !== true) return { ok: false, changed: false, reason: `${st.main_checked_out_at} has uncommitted changes: main was not moved`, status: st };
      git(st.main_checked_out_at, ["merge", "--ff-only", "--quiet", `refs/heads/${st.branch}`]);
    } else {
      git(root, ["fetch", "--quiet", ".", `refs/heads/${st.branch}:refs/heads/${MAIN_BRANCH}`]);
    }
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { ok: false, changed: false, reason: (err.stderr || err.message).trim().split("\n").slice(-2).join(" | "), status: st };
  }
  return { ok: true, changed: true, from, to: tryGit(root, ["rev-parse", `refs/heads/${MAIN_BRANCH}`]) ?? undefined, status: worktreeStatus(root) };
}

/** Fast-forwards this worktree's branch to `main` (after an update ran on the main checkout). This checkout must be clean. */
export function ffBranch(rootArg: string): SyncResult {
  const root = resolve(rootArg);
  const st = worktreeStatus(root);
  if (!st.git) throw new CoachError("GIT_ERROR", `not a git repository: ${root}`);
  if (!st.branch) return { ok: false, changed: false, reason: "this checkout has no branch (detached HEAD)", status: st };
  if (st.branch === MAIN_BRANCH) return { ok: true, changed: false, skipped: "this checkout is on main", status: st };
  if (st.behind === null) return { ok: false, changed: false, reason: "there is no local main branch", status: st };
  if (st.behind === 0) return { ok: true, changed: false, skipped: "this branch already has every commit of main", status: st };
  if (st.clean !== true) return { ok: false, changed: false, reason: "this checkout has uncommitted changes: commit them first", status: st };
  const from = tryGit(root, ["rev-parse", "HEAD"]) ?? undefined;
  try {
    git(root, ["merge", "--ff-only", "--quiet", `refs/heads/${MAIN_BRANCH}`]);
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { ok: false, changed: false, reason: (err.stderr || err.message).trim().split("\n").slice(-2).join(" | "), status: st };
  }
  return { ok: true, changed: true, from, to: tryGit(root, ["rev-parse", "HEAD"]) ?? undefined, status: worktreeStatus(root) };
}

/** Where `worktree main-checkout` puts a temporary checkout of main (gitignored, inside this checkout). */
export const TEMP_MAIN_CHECKOUT = ".tmp/coach/main-checkout";

export type MainCheckout = { ok: boolean; path?: string; temporary?: boolean; reason?: string };

/**
 * The folder where `main` is checked out, for `update --root` (V2b fix 8): the worktree that has
 * main checked out (`main_checked_out_at`, which need not be the main checkout), else a new
 * temporary worktree of main at .tmp/coach/main-checkout. It never switches the branch of any
 * existing checkout.
 */
export function mainCheckout(rootArg: string): MainCheckout {
  const root = resolve(rootArg);
  const st = worktreeStatus(root);
  if (!st.git) throw new CoachError("GIT_ERROR", `not a git repository: ${root}`);
  if (tryGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${MAIN_BRANCH}`]) === null) return { ok: false, reason: "there is no local main branch" };
  if (st.main_checked_out_at) return { ok: true, path: st.main_checked_out_at, temporary: false };
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  const path = resolve(top, TEMP_MAIN_CHECKOUT);
  try {
    git(root, ["worktree", "add", "--quiet", path, MAIN_BRANCH]);
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { ok: false, reason: (err.stderr || err.message).trim().split("\n").slice(-2).join(" | ") };
  }
  return { ok: true, path, temporary: true };
}

/**
 * Removes the temporary checkout of main, and only that one: `git worktree remove` without
 * --force, so a checkout with changes is refused and kept. Nothing to remove is ok.
 */
export function removeTempCheckout(rootArg: string): { ok: boolean; removed: boolean; path: string; reason?: string } {
  const root = resolve(rootArg);
  const top = tryGit(root, ["rev-parse", "--show-toplevel"]);
  if (top === null) throw new CoachError("GIT_ERROR", `not a git repository: ${root}`);
  const path = resolve(top, TEMP_MAIN_CHECKOUT);
  const listed = worktrees(root).some((e) => real(e.path) === real(path));
  if (!listed) return { ok: true, removed: false, path };
  try {
    git(root, ["worktree", "remove", path]);
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { ok: false, removed: false, path, reason: (err.stderr || err.message).trim().split("\n").slice(-2).join(" | ") };
  }
  return { ok: true, removed: true, path };
}
