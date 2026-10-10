// safety-detect (UserPromptSubmit; docs/contracts.md §10 and §13).
//
// Runs the trusted matcher on the user's message (`prompt` in the hook input), without the
// task notifications Claude Code passes through this event for background tasks:
//   - urgent match → writes athlete/.safety-pending and adds a "SAFETY FIRST (urgent)" context;
//   - pain match (not negated) → writes the pending file and adds a "SAFETY FIRST" context;
//   - no match → no output.
// Only matched term names are stored, never the message.
//
// Register it with `"onFailure": "continue"` and `"timeout": 10`: blocking a message on a hook
// crash would lock the user out. The guard still denies training writes while a pending file
// exists, so on any failure this hook writes a pending file if it can, and always exits 0.
//
// This file is a bootstrap: it imports Node built-ins only. The engine modules load with a
// dynamic import inside the try block, so a module that fails to load still reaches the
// crash path and its `detector-error` pending file. Exception (docs/contracts.md
// §20 item 27): when the engine cannot load and there is no coach.yaml (not set up, no
// athlete), the hook writes no pending file and only asks Claude to check for pain by hand.
//
//   { "type": "command", "command": "node .claude/hooks/safety-detect.ts", "timeout": 10, "onFailure": "continue" }
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import module from "node:module";
import { dirname, join, resolve } from "node:path";

type HookInput = { prompt?: unknown; cwd?: unknown };
type Detection = { urgent: string[]; pain: string[]; regions: string[] };

const PENDING_RELATIVE = "athlete/.safety-pending";
const SAFETY_MODULE = new URL("../../engine/safety.ts", import.meta.url).href;
const TEXT_MODULE = new URL("../../engine/safety-text.ts", import.meta.url).href;
const NOT_LOADED =
  "SAFETY: the pain and red-flag detector could not run (packages are not installed). Ask about pain and red flags before any plan.";

function projectRoot(input: HookInput | null): string {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv) return resolve(fromEnv);
  if (input && typeof input.cwd === "string") return resolve(input.cwd);
  return process.cwd();
}

function emit(context: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }) + "\n");
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The crash-path pending write, with built-ins only. Keeps the terms of a valid existing
 * pending file; replaces a malformed one. Returns an error message, or null on success.
 */
function writeFallbackPending(root: string, terms: string[]): string | null {
  try {
    const p = join(root, PENDING_RELATIVE);
    let prev: string[] = [];
    if (existsSync(p)) {
      try {
        const old = JSON.parse(readFileSync(p, "utf8"));
        if (Array.isArray(old?.terms)) prev = old.terms.filter((t: unknown) => typeof t === "string");
      } catch {
        prev = [];
      }
    }
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), terms: [...new Set([...prev, ...terms])], source: "prompt" }, null, 2) + "\n");
    renameSync(tmp, p);
    return null;
  } catch (e) {
    return message(e);
  }
}

function contextFor(d: Detection, terms: string, texts: { URGENT_CARE_TEXT: string; PAIN_TEXT: string }, writeError: string | null): string {
  const pendingLine = writeError
    ? `The pending safety file could not be written (${writeError}). Treat this exactly as if it were pending.`
    : "athlete/.safety-pending is written; training writes stay blocked until the user clears it interactively.";
  if (d.urgent.length > 0) {
    return [
      `SAFETY FIRST (urgent). The user's message matched urgent warning signs: ${terms}.`,
      "Stop all training talk now. Do not plan, adjust or write any training. Reply first with this urgent-care text, in your own warm words but keeping every instruction:",
      texts.URGENT_CARE_TEXT,
      "Then run the `safety` agent. Never diagnose. Never give medication, supplement, hormone or peptide advice.",
      pendingLine,
    ].join("\n");
  }
  return [
    `SAFETY FIRST. The user's message matched pain or injury terms: ${terms}.`,
    "Before anything else, run the `safety` agent. Make no training change until it has finished. Relay its questions to the user.",
    "Pain guidance for the reply:",
    texts.PAIN_TEXT,
    "Never diagnose. Never give medication, supplement, hormone or peptide advice.",
    pendingLine,
  ].join("\n");
}

/**
 * The athlete's own words: the prompt without Claude Code's task notifications (the
 * <task-notification>…</task-notification> blocks it passes through UserPromptSubmit for
 * background-task results, such as an agent's report). Text outside a closed block is
 * still scanned; an unclosed block is scanned too (fail toward safety).
 */
function athleteWords(prompt: string): string {
  return prompt.replace(/<task-notification\b[^>]*>[\s\S]*?<\/task-notification>/g, " ");
}

async function run(): Promise<void> {
  let input: HookInput | null = null;
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    const prompt = athleteWords(typeof input?.prompt === "string" ? input.prompt : "");
    if (prompt.trim() === "") return;
    let safety;
    let texts;
    try {
      try {
        module.enableCompileCache?.();
      } catch {
        /* no cache: slower, same result */
      }
      safety = await import(SAFETY_MODULE);
      texts = await import(TEXT_MODULE);
    } catch (e) {
      // Not set up: no athlete, so no pending file (it would block setup's first steps).
      if (!existsSync(join(projectRoot(input), "coach.yaml"))) return emit(NOT_LOADED);
      throw e;
    }
    const d: Detection = safety.detect(prompt);
    if (!safety.isMatch(d)) return;
    const terms: string[] = safety.pendingTerms(d);
    let writeError: string | null = null;
    try {
      safety.writePending(projectRoot(input), { terms, source: "prompt" });
    } catch (e) {
      writeError = message(e);
    }
    emit(contextFor(d, terms.join(", "), texts, writeError));
  } catch (e) {
    // A crash must not block the message. Fail toward safety where possible.
    const writeError = writeFallbackPending(projectRoot(input), ["detector-error"]);
    try {
      emit(
        [
          "SAFETY FIRST. The safety detector failed on this message, so it may have missed a pain or urgent term.",
          "Before any training change, ask the user whether they have pain, an injury or any warning sign, and run the `safety` agent if they do.",
          writeError ? `The pending safety file could not be written (${writeError}).` : "athlete/.safety-pending is written (term: detector-error).",
          `Detector error: ${message(e)}`,
        ].join("\n"),
      );
    } catch {
      /* nothing more can be done; the message goes through */
    }
  }
}

await run().catch(() => {});
process.exitCode = 0;
