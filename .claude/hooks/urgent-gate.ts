// urgent-gate (PreToolUse; docs/contracts.md §10). The only gate in v0.2.
//
// While athlete/.urgent-stop exists, it denies:
//   - every MCP tool whose name ends in a plan mutation suffix, whatever the server's name
//     (mcp__<any server>__plan_workout_day, …);
//   - every Edit, Write or MultiEdit under plans/ (the files logger).
// Everything else is allowed. Without the stop file it allows everything at once.
//
// Built-ins only: it runs before `npm ci` too. Register it with `"onFailure": "block"`, so a
// crash blocks the call instead of letting a plan write through:
//   { "matcher": "<URGENT_GATE_MATCHER in urgent-list.ts>", "hooks": [{ "type": "command",
//     "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/urgent-gate.ts\"", "timeout": 10, "onFailure": "block" }] }
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DENY_REASON, FILE_TOOLS, MUTATION, underPlans } from "./urgent-list.ts";

function root(input: Record<string, unknown> | null): string {
  if (process.env.CLAUDE_PROJECT_DIR) return resolve(process.env.CLAUDE_PROJECT_DIR);
  if (input && typeof input.cwd === "string" && input.cwd !== "") return resolve(input.cwd);
  return process.cwd();
}

function deny(): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENY_REASON } }) + "\n");
}

function main(): void {
  let text = "";
  try {
    text = readFileSync(0, "utf8");
  } catch {
    text = "";
  }
  let input: Record<string, unknown> | null = null;
  try {
    const raw: unknown = JSON.parse(text);
    input = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    input = null;
  }
  const dir = root(input);
  if (!existsSync(resolve(dir, "athlete/.urgent-stop"))) return;
  // The stop exists: a call the gate cannot read is denied (fail closed).
  const tool = input?.tool_name;
  if (typeof tool !== "string") return deny();
  if (MUTATION.test(tool)) return deny();
  if (!FILE_TOOLS.has(tool)) return;
  const ti = input?.tool_input;
  const path = ti !== null && typeof ti === "object" ? (ti as Record<string, unknown>).file_path : undefined;
  if (typeof path !== "string" || path === "") return deny();
  if (underPlans(dir, path, typeof input?.cwd === "string" ? input.cwd : undefined)) return deny();
}

main();
