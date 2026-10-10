// PreToolUse guard for Edit, Write and Bash on protected paths (contracts §0, §10, §17).
// Interactive: ask. Unattended: deny. Active only when coach.yaml exists (an athlete
// instance). Any error: stderr, exit 2.
import { fileGuard } from "../../engine/protect.ts";
import { hookMode, preToolUse, projectRoot, readInput, runHook } from "./lib.ts";

runHook("guard-files", () => {
  const input = readInput();
  const d = fileGuard({ tool_name: String(input.tool_name ?? ""), tool_input: input.tool_input, mode: hookMode(), root: projectRoot() });
  if (d.decision !== "allow") preToolUse(d.decision, d.reason);
});
