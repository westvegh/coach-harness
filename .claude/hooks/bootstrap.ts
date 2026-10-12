// Built-ins bootstrap for the coach-harness hooks (docs/contracts.md §20 item 27).
//
// This module imports Node built-ins only, so it loads in a fresh clone before `npm ci`.
// Each hook entry file imports only built-ins modules (this one). `bootHook` imports the
// hook's body (the engine code) with a dynamic import(), and the body runs exactly as
// before. stdin is read once (`stdinText`), so the body's readInput() sees the same text.
// When the body cannot load (no node_modules, so no `yaml`), the hook's fallback decides:
//   - no coach.yaml (not set up): the hooks allow, or say how to set up;
//   - coach.yaml present: they report PACKAGES_MISSING (run `npm ci`).
// The two built-ins-only hooks (urgent-gate, commit-check) need no body at all.
import { existsSync, readFileSync } from "node:fs";
import module from "node:module";
import { join, resolve } from "node:path";

export const NOT_SET_UP = "coach-harness is not set up yet (no coach.yaml). Run setup first.";
export const PACKAGES_MISSING = "coach-harness packages are missing. Run `npm ci`.";

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

export function context(event: string, text: string): void {
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/** PACKAGES_MISSING with the load error. */
export function missing(detail: string): string {
  return detail ? `${PACKAGES_MISSING} (${detail})` : PACKAGES_MISSING;
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
