// Stop (docs/contracts.md §13): the auto-commit. Git stays the record of every change.
//
// When athlete/, plans/ or coach.yaml has uncommitted changes, it commits exactly those
// paths (git add, then git commit --only), never other staged work, with a plain message,
// and says nothing. A failed commit is one line (a systemMessage). No coach.yaml (the
// template repo, or before setup): it does nothing.
//
// Built-ins only: it needs no engine module, so it runs before `npm ci` too.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The only paths the Stop hook ever commits. */
export const AUTO_COMMIT_PATHS = ["athlete", "plans", "coach.yaml"] as const;

function root(): string {
  if (process.env.CLAUDE_PROJECT_DIR) return resolve(process.env.CLAUDE_PROJECT_DIR);
  try {
    const raw = JSON.parse(readFileSync(0, "utf8")) as { cwd?: unknown };
    if (typeof raw.cwd === "string" && raw.cwd !== "") return resolve(raw.cwd);
  } catch {
    /* no input: the working directory */
  }
  return process.cwd();
}

/**
 * The paths in `git status --porcelain -z` output: "XY <path>\0" per entry, and for a rename
 * or copy "XY <new>\0<old>\0". NUL-delimited, so spaces, quotes and Unicode stay as they are.
 */
function changedFiles(z: string): string[] {
  const fields = z.split("\0");
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const e = fields[i];
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") {
      const from = fields[++i];
      if (from) out.push(from);
    }
  }
  return out;
}

function main(): void {
  const dir = root();
  if (!existsSync(join(dir, "coach.yaml"))) return;
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let status: string;
  try {
    status = git(["status", "--porcelain", "-z", "--untracked-files=all", "--", ...AUTO_COMMIT_PATHS]);
  } catch {
    return; // not a git repository: nothing to record
  }
  const paths = AUTO_COMMIT_PATHS.filter((p) => changedFiles(status).some((f) => f === p || f.startsWith(`${p}/`)));
  // Never run git add or git commit with an empty path list: that would take every change.
  if (paths.length === 0) return;
  try {
    git(["add", "-A", "--", ...paths]);
    const staged = git(["diff", "--cached", "--name-only", "--", ...paths]).split("\n").filter(Boolean);
    if (staged.length === 0) return;
    const what = paths.map((p) => (p === "coach.yaml" ? "coach.yaml" : `${p}/`)).join(", ");
    git(["commit", "-q", "--only", "-m", `coach: update ${what}`, "--", ...paths]);
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    const why = (err.stderr || err.message).trim().split("\n").slice(-1)[0];
    process.stdout.write(JSON.stringify({ systemMessage: `commit-check: the auto-commit of ${paths.join(", ")} failed (${why}).` }) + "\n");
  }
}

main();
process.exitCode = 0;
