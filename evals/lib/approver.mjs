#!/usr/bin/env node
// The scripted user for interactive scenarios. Claude Code sends every permission
// prompt (a guard hook's "ask", or a tool outside --allowedTools) to this MCP tool
// (--permission-prompt-tool). It answers from APPROVER_RULES and logs each prompt to
// APPROVER_LOG, so a check can see what the guard asked.
//
// APPROVER_RULES: JSON list of {tool: regex on the tool name, input?: regex on the
// input JSON, behavior: "allow" | "deny"}; the first match wins. No match: deny.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const rules = JSON.parse(process.env.APPROVER_RULES || "[]");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

function decide(args) {
  const name = String(args.tool_name ?? "");
  const input = JSON.stringify(args.input ?? {});
  for (const r of rules) {
    if (new RegExp(r.tool).test(name) && (!r.input || new RegExp(r.input, "i").test(input))) return r.behavior;
  }
  return "deny";
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    return;
  }
  if (r.id === undefined) return;
  if (r.method === "initialize") {
    return send({ jsonrpc: "2.0", id: r.id, result: { protocolVersion: r.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "evalapprover", version: "1" } } });
  }
  if (r.method === "tools/list") {
    return send({
      jsonrpc: "2.0",
      id: r.id,
      result: { tools: [{ name: "approve", description: "Eval permission prompt (the scripted user). Not for direct use.", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, additionalProperties: true } }] },
    });
  }
  if (r.method === "tools/call") {
    const args = r.params?.arguments ?? {};
    const behavior = decide(args);
    if (process.env.APPROVER_LOG) appendFileSync(process.env.APPROVER_LOG, JSON.stringify({ tool_name: args.tool_name, input: args.input, behavior }) + "\n");
    const answer = behavior === "allow" ? { behavior: "allow", updatedInput: args.input ?? {} } : { behavior: "deny", message: "The user said no." };
    return send({ jsonrpc: "2.0", id: r.id, result: { content: [{ type: "text", text: JSON.stringify(answer) }] } });
  }
  send({ jsonrpc: "2.0", id: r.id, result: {} });
});
