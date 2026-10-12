// Shared helpers for the coach-harness hooks (contracts §7, §13). Every hook reads its
// JSON from stdin. A guard hook that throws prints the reason to stderr and exits 2
// (a block); settings.json also sets onFailure: "block" for the guard hooks.
import { CoachError } from "../../engine/errors.ts";
import { unattendedMarker } from "../../engine/mode.ts";
import { isPlainObject } from "../../engine/yaml-file.ts";
import { readRawInput, stdinText } from "./bootstrap.ts";

export type HookInput = Record<string, unknown> & {
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
};

export function readInput(): HookInput {
  let text: string;
  try {
    text = stdinText();
  } catch (e) {
    throw new CoachError("HOOK_INPUT", `cannot read the hook input: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new CoachError("HOOK_INPUT", `the hook input is not JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(raw)) throw new CoachError("HOOK_INPUT", "the hook input must be a JSON object");
  return raw as HookInput;
}

/** The project root: CLAUDE_PROJECT_DIR, else the input's cwd, else the working directory (docs/contracts.md §20 item 27). */
export function projectRoot(): string {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const cwd = readRawInput()?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}

/** contracts §7: unattended when CLAUDE_CODE_REMOTE or COACH_UNATTENDED is set. */
export function hookMode(): "interactive" | "unattended" {
  return unattendedMarker(process.env) ? "unattended" : "interactive";
}

/** `now` for the guard: COACH_NOW (tests only), else the clock. */
export function hookNow(): string {
  return process.env.COACH_NOW || new Date().toISOString();
}

export function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

export function preToolUse(decision: "ask" | "deny", reason: string): void {
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });
}

export function context(event: string, text: string): void {
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/** Runs a hook body. Any throw: the reason on stderr, exit 2. */
export function runHook(name: string, body: () => void): void {
  try {
    body();
  } catch (e) {
    const msg = e instanceof CoachError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    process.stderr.write(`${name}: ${msg}\n`);
    process.exitCode = 2;
  }
}
