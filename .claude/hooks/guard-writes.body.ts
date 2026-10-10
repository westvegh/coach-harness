// PreToolUse guard for logger mutations (contracts §7). Deny or ask with JSON; allow
// with no output (or with warnings as additionalContext). Any error: stderr, exit 2.
import { toolCallHash } from "../../engine/approvals.ts";
import { CoachError } from "../../engine/errors.ts";
import { guardInputFrom, loadGuardFiles } from "../../engine/guard-context.ts";
import { toolSuffix } from "../../engine/logger.ts";
import { saveVerdict, verdictKey } from "../../engine/oplog.ts";
import { guard } from "../../engine/validate.ts";
import { context, hookMode, hookNow, preToolUse, projectRoot, readInput, runHook } from "./lib.ts";

runHook("guard-writes", () => {
  const input = readInput();
  if (typeof input.tool_name !== "string" || input.tool_name === "") throw new CoachError("HOOK_INPUT", "tool_name is missing");
  if (typeof input.session_id !== "string" || input.session_id === "") throw new CoachError("HOOK_INPUT", "session_id is missing");
  const root = projectRoot();
  const now = hookNow();
  const mode = hookMode();
  const files = loadGuardFiles(root, now);
  const tool = toolSuffix(input.tool_name);
  if (!new RegExp(files.logger.config.matcher).test(input.tool_name) || !files.logger.isMutation(tool)) {
    // Registered for this tool by mistake: not a logger mutation, nothing to guard.
    return;
  }
  const args = input.tool_input ?? {};
  const v = guard(guardInputFrom(files, { tool, args, mode, now, session_id: input.session_id }));
  // log-writes reads the verdict after the call runs; a denied call never runs.
  if (v.decision !== "deny") saveVerdict(root, verdictKey(input.tool_use_id, tool, args), {
    tool,
    args_hash: toolCallHash(tool, args),
    decision: v.decision,
    kinds: v.kinds ?? [],
    rule_ids: v.rule_ids,
    reasons: v.reasons,
    warnings: v.warnings,
    ...(v.approval ? { approval: v.approval } : {}),
    mode,
    at: now,
  });
  const rules = v.rule_ids.length > 0 ? ` [${v.rule_ids.join(", ")}]` : "";
  const warn = [...v.warnings, ...files.approvals.warnings];
  if (v.decision === "deny") preToolUse("deny", `coach guard: ${v.reasons.join("; ")}${rules}`);
  else if (v.decision === "ask") preToolUse("ask", `coach guard: ${v.reasons.join("; ")}${rules}${warn.length ? ` (warnings: ${warn.join("; ")})` : ""}`);
  else if (warn.length > 0) context("PreToolUse", `coach guard warnings: ${warn.join("; ")}`);
});
