// The pre-push check, run by git-hooks/pre-push:
//   node engine/prepush.ts <remote name> <remote url>   (stdin: git's ref lines)
// - The destination's visibility comes from `gh api repos/<owner>/<repo>` (REST: GraphQL
//   is blocked in Claude Code sessions, spike #14). A failed lookup denies the push.
// - A public destination: any commit reachable from a pushed SHA that touches athlete/
//   denies the push (nothing is excluded, paths are NUL-delimited).
//   (templates/athlete/ is outside athlete/ and is fine.)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type PushCheck = { ok: boolean; reason: string; visibility?: string; commits?: string[] };

const ZERO = /^0+$/;

/** owner/repo of a GitHub remote URL, or null. */
export function githubRepo(url: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env });
}

export function lookupVisibility(repo: string, cwd: string, env?: NodeJS.ProcessEnv): string {
  const out = run("gh", ["api", `repos/${repo}`, "--jq", ".visibility"], cwd, env).trim().toLowerCase();
  if (!["public", "private", "internal"].includes(out)) throw new Error(`unexpected visibility ${JSON.stringify(out)}`);
  return out;
}

/**
 * Every commit reachable from the pushed SHAs. Nothing is excluded: cached
 * remote-tracking refs can belong to another repository than the push URL. Throws when
 * a SHA cannot be listed.
 */
export function pushedCommits(cwd: string, refLines: string): string[] {
  const out = new Set<string>();
  for (const line of refLines.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [, localSha] = line.split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // a delete sends no commits
    for (const c of run("git", ["rev-list", localSha], cwd).split("\n").filter(Boolean)) out.add(c);
  }
  return [...out];
}

/** Paths under athlete/ that a commit touches. NUL-delimited, so no name is quoted. */
export function athleteFiles(cwd: string, commit: string): string[] {
  return run("git", ["diff-tree", "-z", "--no-commit-id", "--name-only", "-r", "--root", "-m", commit], cwd)
    .split("\0")
    .filter((p) => p.startsWith("athlete/"));
}

export function prePush(input: { cwd: string; remote: string; url: string; refLines: string; env?: NodeJS.ProcessEnv }): PushCheck {
  const repo = githubRepo(input.url);
  if (!repo) return { ok: false, reason: `cannot look up the visibility of ${input.url} (not a GitHub URL); push denied` };
  let visibility: string;
  try {
    visibility = lookupVisibility(repo, input.cwd, input.env);
  } catch (e) {
    return { ok: false, reason: `cannot look up the visibility of ${repo} with gh (${(e as Error).message.split("\n")[0]}); push denied` };
  }
  if (visibility !== "public") return { ok: true, reason: `${repo} is ${visibility}`, visibility };
  let commits: string[];
  try {
    commits = pushedCommits(input.cwd, input.refLines);
  } catch (e) {
    return { ok: false, reason: `cannot list the pushed commits (${(e as Error).message.split("\n")[0]}); push denied`, visibility };
  }
  const bad = commits.filter((c) => athleteFiles(input.cwd, c).length > 0);
  if (bad.length > 0) {
    return { ok: false, reason: `${repo} is PUBLIC and ${bad.length} pushed commit(s) touch athlete/ (${bad.map((c) => c.slice(0, 8)).join(", ")}); push denied`, visibility, commits: bad };
  }
  return { ok: true, reason: `${repo} is public; no pushed commit touches athlete/`, visibility };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [remote = "", url = ""] = process.argv.slice(2);
  let refLines = "";
  try {
    refLines = readFileSync(0, "utf8");
  } catch {
    /* no stdin */
  }
  const r = prePush({ cwd: process.cwd(), remote, url, refLines });
  process.stderr.write(`coach-harness pre-push: ${r.reason}\n`);
  process.exitCode = r.ok ? 0 : 1;
}
