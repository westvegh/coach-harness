// PostToolUse on logger mutations (contracts §9): reconciles the returned status and
// appends one log entry with the operation ID. Then it asks for the after-write week
// check. Any error: stderr, exit 2.
import { join } from "node:path";
import { loadConfig } from "../../engine/config.ts";
import { CoachError } from "../../engine/errors.ts";
import { unattendedMarker } from "../../engine/hold.ts";
import { localDate } from "../../engine/dates.ts";
import { loadAdapterConfig, toolSuffix } from "../../engine/logger.ts";
import { appendLog, loggedOpId, nextStep, reconcile, takeVerdict, verdictKey } from "../../engine/oplog.ts";
import { context, hookNow, projectRoot, readInput, runHook } from "./lib.ts";

runHook("log-writes", () => {
  const input = readInput();
  if (typeof input.tool_name !== "string") throw new CoachError("HOOK_INPUT", "tool_name is required");
  const root = projectRoot();
  const cfg = loadConfig(join(root, "coach.yaml"));
  const adapter = loadAdapterConfig(cfg.logger);
  if (!new RegExp(adapter.matcher).test(input.tool_name)) return;
  const tool = toolSuffix(input.tool_name);
  const args = input.tool_input ?? {};
  const now = hookNow();
  const verdict = takeVerdict(root, verdictKey(input.tool_use_id, tool, args));
  const rec = reconcile(tool, args, input.tool_response);
  const kind = verdict?.kinds[0] ?? "unclassified";
  const date = rec.dates[0] ?? localDate(now, cfg.athlete.timezone);
  // Tally T2: the opId the call submitted, else the computed one.
  const id = loggedOpId(date, kind, { tool, args });
  const marker = unattendedMarker(process.env);
  const trigger = marker === "CLAUDE_CODE_REMOTE" ? "scheduled run (cloud)" : marker ? "scheduled run (mac)" : "user";
  const approval = !verdict
    ? "unknown (no guard verdict was saved)"
    : verdict.approval
      ? `approval record ${verdict.approval}`
      : verdict.decision === "ask"
        ? `user (interactive yes; ${verdict.kinds.join(", ") || "unclassified"})`
        : `auto (${verdict.kinds.join(", ") || "unclassified"})`;
  const file = appendLog(root, {
    now,
    timezone: cfg.athlete.timezone,
    op_id: id,
    trigger,
    rules: verdict?.rule_ids ?? [],
    change: `${tool} on ${rec.dates.join(", ") || "the profile"}${verdict?.kinds.length ? ` (${verdict.kinds.join(", ")})` : ""}`,
    approval,
    result: `${rec.status}: ${rec.detail}`,
  });
  const next = nextStep(rec);
  context("PostToolUse", `coach log: ${id} ${rec.status} (${rec.detail}); logged in ${file.slice(root.length + 1)}. ${next}`);
});
