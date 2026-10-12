// safety-detect (UserPromptSubmit; docs/contracts.md §10 and §13).
//
// Runs the trusted matcher on the user's message (`prompt` in the hook input), without the
// task notifications Claude Code passes through this event for background tasks. Only
// urgent warning signs make it act (v0.2): the model notices ordinary pain without a word
// list.
//   - urgent match → writes athlete/.urgent-stop (term names, source and time, never the
//     message), commits it in an athlete copy, and adds an "URGENT STOP" context that tells
//     the coach to give the urgent-care text and push now with `node engine/cli.ts push`;
//   - no urgent match → no output.
//
// Register it with `"onFailure": "continue"` and `"timeout": 10`: blocking a message on a hook
// crash would lock the user out. On a crash the context asks the coach to check the message
// for urgent signs itself (and run `node engine/cli.ts urgent set` for one); it writes no file.
//
// This file is a bootstrap: it imports Node built-ins only. The engine modules load with a
// dynamic import inside the try block, so a module that fails to load still reaches the
// crash path.
//
//   { "type": "command", "command": "node .claude/hooks/safety-detect.ts", "timeout": 10, "onFailure": "continue" }
import { existsSync, readFileSync } from "node:fs";
import module from "node:module";
import { join, resolve } from "node:path";

type HookInput = { prompt?: unknown; cwd?: unknown };

const SAFETY_MODULE = new URL("../../engine/safety.ts", import.meta.url).href;
const URGENT_MODULE = new URL("../../engine/urgent.ts", import.meta.url).href;
const TEXT_MODULE = new URL("../../engine/safety-text.ts", import.meta.url).href;
const NOT_LOADED =
  "SAFETY: the urgent warning-sign detector could not run (packages are not installed). Check the message for urgent warning signs (chest pain, fainting, new numbness or weakness) yourself before any plan.";

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
 * The athlete's own words: the prompt without Claude Code's task notifications (the
 * <task-notification>…</task-notification> blocks it passes through UserPromptSubmit for
 * background-task results, such as an agent's report). Text outside a closed block is
 * still scanned; an unclosed block is scanned too (fail toward safety).
 */
function athleteWords(prompt: string): string {
  return prompt.replace(/<task-notification\b[^>]*>[\s\S]*?<\/task-notification>/g, " ");
}

type Recorded = { written: boolean; committed: boolean; error: string | null; commitNote: string | null };

function contextFor(terms: string[], urgentCareText: string, r: Recorded): string {
  const fileLine = !r.written
    ? `athlete/.urgent-stop could not be written (${r.error}). Run \`node engine/cli.ts urgent set --term "${terms[0]}" --source chat\` now: it writes, commits and pushes the stop.`
    : r.committed
      ? "athlete/.urgent-stop is written and committed. Push it now, before anything else: `node engine/cli.ts push` (a cloud run must see it)."
      : `athlete/.urgent-stop is written${r.commitNote ? ` (not committed: ${r.commitNote})` : ""}. Commit it and push it now: \`node engine/cli.ts commit --message "urgent stop"\`, then \`node engine/cli.ts push\`.`;
  return [
    `URGENT STOP. The athlete's message matched urgent warning signs: ${terms.join(", ")}.`,
    "Make no training change: the urgent gate denies every plan write while the stop exists. Reply first with this urgent-care text, in your own warm words but keeping every instruction:",
    urgentCareText,
    fileLine,
    "The stop clears only when the athlete says, in a live session, that a clinician has seen them or that it was a false alarm (the `safety` skill's clear question). Never diagnose. Never give medication, supplement, hormone or peptide advice.",
  ].join("\n");
}

async function run(): Promise<void> {
  let input: HookInput | null = null;
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    const prompt = athleteWords(typeof input?.prompt === "string" ? input.prompt : "");
    if (prompt.trim() === "") return;
    let safety;
    let urgent;
    let texts;
    try {
      try {
        module.enableCompileCache?.();
      } catch {
        /* no cache: slower, same result */
      }
      safety = await import(SAFETY_MODULE);
      urgent = await import(URGENT_MODULE);
      texts = await import(TEXT_MODULE);
    } catch (e) {
      if (!existsSync(join(projectRoot(input), "coach.yaml"))) return emit(NOT_LOADED);
      throw e;
    }
    const terms: string[] = safety.detect(prompt).urgent;
    if (terms.length === 0) return;
    const root = projectRoot(input);
    const r: Recorded = { written: false, committed: false, error: null, commitNote: null };
    try {
      urgent.writeStop(root, { terms, source: "chat" });
      r.written = true;
      // Commit only in an athlete copy (coach.yaml): never in the template repo itself.
      if (existsSync(join(root, "coach.yaml"))) {
        // Every call reconciles: an earlier stop left uncommitted is committed now.
        const c = urgent.commitPaths(root, [urgent.URGENT_RELATIVE], "urgent stop (chat)");
        r.committed = c.committed;
        r.commitNote = c.reason ?? null;
      } else r.commitNote = "no coach.yaml yet";
    } catch (e) {
      r.error = message(e);
    }
    emit(contextFor(terms, texts.URGENT_CARE_TEXT, r));
  } catch (e) {
    // A crash must not block the message.
    try {
      emit(
        [
          "SAFETY: the urgent warning-sign detector failed on this message, so it may have missed one.",
          "Check the message yourself. For an urgent warning sign (chest pain, fainting, new numbness or weakness, severe shortness of breath, a sudden severe headache), give the urgent-care text and run `node engine/cli.ts urgent set --term <name> --source chat`.",
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
