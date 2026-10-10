// PreToolUse guard for Edit, Write and Bash on protected paths (docs/contracts.md §0,
// §10, §17 and §20 item 27). Built-ins entry; the engine rules are in guard-files.body.ts.
//   - no coach.yaml: allow with no engine import (the guard is inactive, §18);
//   - coach.yaml, packages installed: fast-files.ts (loaded with a dynamic import after the
//     code cache is on) allows what is certainly allowed (and read-only Bash); anything else
//     goes to the engine;
//   - coach.yaml, engine cannot load: deny everything except the exact `npm ci` /
//     `npm install` repair. The fast path does not run in this state.
// Input that is not a JSON object goes to the body, which exits 2 (HOOK_INPUT).
import { existsSync } from "node:fs";
import module from "node:module";
import { join } from "node:path";
import { bootHook, deny, hookRoot, isRepairCommand, missing, packagesInstalled, readRawInput, unattendedRun, type RawInput } from "./bootstrap.ts";

/**
 * Engine cannot load in an athlete instance: only the repair command passes, and unattended
 * only in the foreground (as the engine's run_in_background rule).
 */
function repairOnly(input: RawInput, root: string, detail: string): void {
  const toolInput = input?.tool_input;
  const bash = input?.tool_name === "Bash" && toolInput !== null && typeof toolInput === "object" ? (toolInput as { command?: unknown; run_in_background?: unknown }) : undefined;
  if (bash?.run_in_background === true && unattendedRun()) return deny("guard-files: an unattended run never runs Bash in the background (contracts §23)");
  if (typeof bash?.command === "string" && isRepairCommand(bash.command, root, input?.cwd)) return;
  deny(missing(detail));
}

async function main(): Promise<void> {
  const input = readRawInput();
  if (input !== null) {
    const root = hookRoot(input);
    if (!existsSync(join(root, "coach.yaml"))) return;
    if (!packagesInstalled()) return repairOnly(input, root, "the yaml package does not resolve");
    // The fast path loads after the V8 code cache is on (as bootHook does): parsing it
    // fresh each call costs about 10 ms.
    try {
      module.enableCompileCache?.();
    } catch {
      /* no cache: slower, same result */
    }
    const { fastFileDecision } = await import("./fast-files.ts");
    if (fastFileDecision(input.tool_name, input.tool_input, root) === "allow") return;
  }
  await bootHook(new URL("./guard-files.body.ts", import.meta.url), ({ input, root, configured, detail }) => {
    if (configured) repairOnly(input, root, detail);
  });
}

await main();
