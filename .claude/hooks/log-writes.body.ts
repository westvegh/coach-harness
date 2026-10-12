// PostToolUse on logger mutations (contracts §9): reconciles the returned status and
// appends one log entry with the operation ID. A record, not a gate. Any error: stderr, exit 2.
import { join } from "node:path";
import { loadConfig } from "../../engine/config.ts";
import { CoachError } from "../../engine/errors.ts";
import { unattendedMarker } from "../../engine/mode.ts";
import { localDate } from "../../engine/dates.ts";
import { loadAdapterConfig, toolSuffix } from "../../engine/logger.ts";
import { appendLog, loggedOpId, nextStep, reconcile } from "../../engine/oplog.ts";
import { context, hookNow, projectRoot, readInput, runHook } from "./lib.ts";

runHook("log-writes", () => {
  const input = readInput();
  if (typeof input.tool_name !== "string") throw new CoachError("HOOK_INPUT", "tool_name is required");
  const root = projectRoot();
  const cfg = loadConfig(join(root, "coach.yaml"));
  // The hook matches Tally tools only, so it reads the Tally adapter whatever coach.yaml logger says (v0.2).
  const adapter = loadAdapterConfig("tally");
  if (!new RegExp(adapter.matcher).test(input.tool_name)) return;
  const tool = toolSuffix(input.tool_name);
  const args = input.tool_input ?? {};
  const now = hookNow();
  const rec = reconcile(tool, args, input.tool_response);
  // The kind is the one in the opId the call submitted (op-<date>-<kind>-<hash>), else unclassified.
  const submitted = args !== null && typeof args === "object" ? (args as Record<string, unknown>).opId : undefined;
  const kind = typeof submitted === "string" ? (/^op-\d{4}-\d{2}-\d{2}-([a-z_]+)-[0-9a-f]{12}$/.exec(submitted)?.[1] ?? "unclassified") : "unclassified";
  const date = rec.dates[0] ?? localDate(now, cfg.athlete.timezone);
  // Tally T2: the opId the call submitted, else the computed one.
  const id = loggedOpId(date, kind, { tool, args });
  const marker = unattendedMarker(process.env);
  const trigger = marker === "CLAUDE_CODE_REMOTE" ? "scheduled run (cloud)" : marker ? "scheduled run (mac)" : "user";
  const approval = marker ? "the coach, in an unattended run" : "the coach, in a live session";
  const file = appendLog(root, {
    now,
    timezone: cfg.athlete.timezone,
    op_id: id,
    trigger,
    rules: [],
    change: `${tool} on ${rec.dates.join(", ") || "the profile"}${kind !== "unclassified" ? ` (${kind})` : ""}`,
    approval,
    result: `${rec.status}: ${rec.detail}`,
  });
  const next = nextStep(rec);
  context("PostToolUse", `coach log: ${id} ${rec.status} (${rec.detail}); logged in ${file.slice(root.length + 1)}. ${next}`);
});
