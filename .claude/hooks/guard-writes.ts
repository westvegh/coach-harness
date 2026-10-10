// PreToolUse guard for logger mutations (docs/contracts.md §7 and §20 item 27).
// Built-ins entry; the engine rules are in guard-writes.body.ts.
//   - no coach.yaml: decided with no engine import. A logger mutation is blocked (exit 2,
//     MISSING_FILE, docs/contracts.md §18); any other tool is allowed;
//   - coach.yaml: the engine guard; when it cannot load, every call is denied.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bootHook, deny, hookRoot, isLoggerMutation, missing, NOT_SET_UP, readRawInput } from "./bootstrap.ts";

function block(message: string): void {
  process.stderr.write(`guard-writes: ${message}\n`);
  process.exitCode = 2;
}

async function main(): Promise<void> {
  const input = readRawInput();
  if (input !== null && !existsSync(join(hookRoot(input), "coach.yaml"))) {
    const tool = input.tool_name;
    if (typeof tool !== "string" || tool === "") return block("HOOK_INPUT: tool_name is missing");
    if (isLoggerMutation(tool)) block(`MISSING_FILE: coach.yaml is missing; the guard denies every logger write without it. ${NOT_SET_UP}`);
    return;
  }
  await bootHook(new URL("./guard-writes.body.ts", import.meta.url), ({ input, configured, detail }) => {
    if (configured) return deny(missing(detail));
    // Not a JSON object, and no coach.yaml: the tool is unknown, so fail closed.
    if (input === null) return block("HOOK_INPUT: the hook input must be a JSON object");
  });
}

await main();
