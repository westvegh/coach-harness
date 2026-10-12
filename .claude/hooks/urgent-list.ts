// The urgent gate's lists (docs/contracts.md §10), shared by .claude/hooks/urgent-gate.ts and
// the tests. Built-ins only.
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The plan mutation suffixes (tests keep them equal to the Tally adapter's mutations). */
export const PLAN_MUTATIONS = [
  "plan_workout_day",
  "plan_workout_range",
  "update_planned_workout",
  "move_planned_workout",
  "skip_planned_workout",
  "delete_planned_workout",
  "update_user_profile",
  "update_training_limits",
] as const;

/** The settings.json matcher: a mutation on any MCP server, and the file tools. */
export const URGENT_GATE_MATCHER = `^(mcp__.+__(${PLAN_MUTATIONS.join("|")})|Edit|Write|MultiEdit)$`;

export const MUTATION = new RegExp(`^mcp__.+__(${PLAN_MUTATIONS.join("|")})$`);
export const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

export const DENY_REASON =
  "URGENT STOP: an urgent warning sign is recorded (athlete/.urgent-stop). No training change is allowed. Give the urgent-care text. The stop clears only when the athlete says, in a live session, that a clinician has seen them or that it was a false alarm (the safety skill's clear question, then node engine/cli.ts urgent clear --reason clinician|false-alarm).";

/** The real path of `p`: its deepest existing ancestor resolved through symlinks, plus the rest. */
function real(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      tail.push(basename(cur));
      cur = up;
    }
  }
}

/**
 * True when `filePath` is under <root>/plans. The file (lexical and real path) is compared
 * with <root>/plans (lexical and real path), so a `plans` symlink to an outside folder, a
 * second alias to that folder, and a symlinked root all count. A file that does not exist
 * yet resolves through its deepest existing ancestor. Case is ignored (macOS file systems).
 */
export function underPlans(rootDir: string, filePath: string, cwd?: string): boolean {
  const abs = resolve(isAbsolute(filePath) ? filePath : resolve(cwd ?? rootDir, filePath));
  const plans = join(resolve(rootDir), "plans");
  const bases = [plans, real(plans), join(real(resolve(rootDir)), "plans")];
  for (const base of bases) {
    for (const f of [abs, real(abs)]) {
      const rel = relative(base.toLowerCase(), f.toLowerCase());
      if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return true;
    }
  }
  return false;
}
