// Built-ins bootstrap for the coach-harness hooks (docs/contracts.md §20 item 27).
//
// This module imports Node built-ins only, so it loads in a fresh clone before `npm ci`.
// Each hook entry file imports only built-ins modules (this one, and fast-files.ts for
// guard-files). An entry may decide first from the input with built-ins (the guards'
// fast paths); otherwise `bootHook` imports the hook's body (the engine code) with a
// dynamic import(), and the body runs exactly as before. stdin is read once
// (`stdinText`), so the body's readInput() sees the same text. When the body cannot load
// (no node_modules, so no `yaml`), the hook's fallback decides:
//   - no coach.yaml (not set up; docs/contracts.md §18): guard-writes blocks logger mutations;
//     the other hooks allow, or say how to set up;
//   - coach.yaml present: fail closed with PACKAGES_MISSING; guard-files lets
//     `npm ci` / `npm install` through so the install can be repaired.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import module from "node:module";
import { join, resolve } from "node:path";

export const NOT_SET_UP = "coach-harness is not set up yet (no coach.yaml). Run setup first.";
export const PACKAGES_MISSING = "coach-harness packages are missing. Run `npm ci`.";

/**
 * Every Tally mutation. Tests keep it equal to the adapter's mutations
 * (adapters/loggers/tally/adapter.yaml) and check that each settings.json matcher for
 * guard-writes, log-writes and capture-reads selects every one.
 */
export const LOGGER_MUTATIONS = [
  "plan_workout_day",
  "plan_workout_range",
  "update_planned_workout",
  "move_planned_workout",
  "skip_planned_workout",
  "delete_planned_workout",
  "update_user_profile",
  "update_training_limits",
] as const;

/** A logger mutation in every tool-name form (mcp__tally__…, mcp__Tally_Workout__…, mcp__claude_ai_Tally_Workout__…). */
export const LOGGER_MUTATION = new RegExp(`^mcp__.*[Tt]ally.*__(${LOGGER_MUTATIONS.join("|")})$`);

export function isLoggerMutation(toolName: string): boolean {
  return LOGGER_MUTATION.test(toolName);
}

export type RawInput = Record<string, unknown> | null;

export type Fallback = {
  /** The hook input, or null when it is not a JSON object. */
  input: RawInput;
  root: string;
  /** coach.yaml exists at the root. */
  configured: boolean;
  /** Why the body did not load (first line of the error). */
  detail: string;
};

let stdin: string | undefined;

/** The hook input text. stdin is read once; later calls return the same text. Throws when it cannot be read. */
export function stdinText(): string {
  if (stdin === undefined) stdin = readFileSync(0, "utf8");
  return stdin;
}

/** Parses the hook input. Never throws: null when it cannot be read or is not a JSON object. */
export function readRawInput(): RawInput {
  try {
    const raw: unknown = JSON.parse(stdinText());
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The project root: CLAUDE_PROJECT_DIR, else the input's cwd, else the working directory. */
export function hookRoot(input: RawInput): string {
  if (process.env.CLAUDE_PROJECT_DIR) return resolve(process.env.CLAUDE_PROJECT_DIR);
  if (input && typeof input.cwd === "string" && input.cwd !== "") return resolve(input.cwd);
  return process.cwd();
}

export function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

export function deny(reason: string): void {
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}

export function context(event: string, text: string): void {
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/** PACKAGES_MISSING with the load error. */
export function missing(detail: string): string {
  return detail ? `${PACKAGES_MISSING} (${detail})` : PACKAGES_MISSING;
}

function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Exactly `npm ci` or `npm install` (spaces or tabs only: no flag, no newline), optionally
 * preceded by `cd <repo root> && `. The folder may be quoted but holds no `$`, backtick
 * or backslash. A bare command needs the session's cwd (the input's `cwd`, when given)
 * to be the repo root.
 */
export function isRepairCommand(command: string, root: string, cwd?: unknown): boolean {
  const m = /^[ \t]*(?:cd[ \t]+("[^"$`\\\n\r]*"|'[^'\n\r]*'|[^\s"'$`\\;&|<>(){}]+)[ \t]*&&[ \t]*)?npm[ \t]+(?:ci|install)[ \t]*$/.exec(command);
  if (!m) return false;
  if (m[1] === undefined) return typeof cwd !== "string" || cwd === "" || samePath(cwd, root);
  const dir = m[1].replace(/^(["'])(.*)\1$/, "$2");
  return samePath(resolve(root, dir), root);
}

/** An unattended run (as engine/hold.ts unattendedMarker): CLAUDE_CODE_REMOTE or COACH_UNATTENDED is non-empty. */
export function unattendedRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLAUDE_CODE_REMOTE ?? "") !== "" || (env.COACH_UNATTENDED ?? "") !== "";
}

/** The engine's packages are installed: `yaml` resolves from engine/, as the engine imports it. */
export function packagesInstalled(): boolean {
  try {
    module.createRequire(new URL("../../engine/", import.meta.url)).resolve("yaml");
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a hook. `body` is the module that does the work; it reads the input through
 * lib.ts readInput() (stdinText). When it cannot load, `fallback` decides with built-ins
 * only.
 */
export async function bootHook(body: URL, fallback: (f: Fallback) => void): Promise<void> {
  let detail: string;
  try {
    // V8 code cache in $TMPDIR/node-compile-cache, checked against each source's hash
    // (about 40 ms less per call). NODE_DISABLE_COMPILE_CACHE=1 turns it off.
    module.enableCompileCache?.();
  } catch {
    /* no cache: slower, same result */
  }
  try {
    await import(body.href);
    return;
  } catch (e) {
    detail = (e instanceof Error ? e.message : String(e)).split("\n")[0];
  }
  const input = readRawInput();
  const root = hookRoot(input);
  fallback({ input, root, configured: existsSync(join(root, "coach.yaml")), detail });
}
