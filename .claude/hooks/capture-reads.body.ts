// PostToolUse on logger reads and writes (contracts §9): merges each response into
// athlete/.cache/snapshot.json. Only this hook writes the snapshot. A malformed snapshot
// is replaced (the guard denies until the days are read again). Any error: stderr, exit 2.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../engine/config.ts";
import { CoachError } from "../../engine/errors.ts";
import { loadAdapterConfig, toolSuffix } from "../../engine/logger.ts";
import { loadSnapshot, mergeResponse, saveSnapshot } from "../../engine/snapshot.ts";
import type { Snapshot } from "../../engine/types.ts";
import { hookNow, projectRoot, readInput, runHook } from "./lib.ts";

runHook("capture-reads", () => {
  const input = readInput();
  if (typeof input.tool_name !== "string" || typeof input.session_id !== "string") throw new CoachError("HOOK_INPUT", "tool_name and session_id are required");
  const root = projectRoot();
  const cfgPath = join(root, "coach.yaml");
  const cfg = existsSync(cfgPath) ? loadConfig(cfgPath) : null;
  // The hook matches Tally tools only, so it reads the Tally adapter whatever coach.yaml logger says (v0.2).
  const adapter = loadAdapterConfig("tally");
  if (!new RegExp(adapter.capture_matcher).test(input.tool_name)) return;
  // V4b: no prefix filter (a cloud routine names the same connector differently). The snapshot
  // belongs to one server: a read from another server starts a new snapshot (engine/snapshot.ts).
  // The server: the part of the tool name between mcp__ and the last __ (the tool).
  const cut = input.tool_name.lastIndexOf("__");
  const server = input.tool_name.startsWith("mcp__") && cut > 5 ? input.tool_name.slice(5, cut) : undefined;
  let prev: Snapshot | null = null;
  try {
    prev = loadSnapshot(root);
  } catch (e) {
    process.stderr.write(`capture-reads: replacing a malformed snapshot (${(e as Error).message.split("\n")[0]})\n`);
  }
  const snap = mergeResponse(prev, {
    tool: toolSuffix(input.tool_name),
    input: input.tool_input,
    response: input.tool_response,
    session_id: input.session_id,
    now: hookNow(),
    timezone: cfg?.athlete.timezone ?? "UTC",
    ...(server ? { server } : {}),
  });
  saveSnapshot(root, snap);
});
