// Drives the mock Tally over stdio (one server process per call: the state lives in
// the JSON file, so every call sees the last one's writes). Used by the mock's unit
// tests, the golden parity test and the scenario runner.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));

export type MockOpts = { state: string; t2?: boolean; t3?: boolean; now?: string };
export type CallResult = { isError: boolean; text: string; json: any };

/** A Tally row as stored (column names), for seeding. */
export type Row = {
  id?: string;
  day_type?: string;
  day_name?: string;
  exercises?: unknown[];
  notes?: string | null;
  source?: string;
  user_modified?: boolean;
  status?: "planned" | "skipped";
  updated_at?: string | null;
  client_id?: string;
  mcp_batch_id?: string | null;
};

export type MockState = {
  timezone?: string;
  now?: string;
  weightUnit?: "lbs" | "kg";
  weightUnitSource?: "settings" | "history" | "default" | "unknown";
  days: Record<string, Row & Record<string, unknown>>;
  sessions?: unknown[];
  library?: unknown[];
  operations?: any[];
  trainingLimits?: { version: number; doc: { rules: any[]; maxWeeklySets?: number } } | null;
  calls?: { at: string; tool: string; args: any; result?: any; error?: string }[];
};

export function env(opts: MockOpts): Record<string, string> {
  return {
    MOCK_TALLY_STATE: opts.state,
    ...(opts.t2 ? { MOCK_T2: "1" } : {}),
    ...(opts.t3 ? { MOCK_T3: "1" } : {}),
    ...(opts.now ? { MOCK_NOW: opts.now } : {}),
  };
}

function rpc(opts: MockOpts, requests: object[]): any[] {
  const init = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "eval", version: "1" } } };
  const lines = [init, { jsonrpc: "2.0", method: "notifications/initialized" }, ...requests].map((r) => JSON.stringify(r)).join("\n") + "\n";
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("MOCK_"))) as Record<string, string>;
  const r = spawnSync(process.execPath, [SERVER], { input: lines, encoding: "utf8", env: { ...clean, ...env(opts) } });
  if (r.status !== 0) throw new Error(`mock exited ${r.status}: ${r.stderr}`);
  const out = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  return out.filter((m) => m.id !== 0);
}

export function listTools(opts: MockOpts): any[] {
  return rpc(opts, [{ jsonrpc: "2.0", id: 1, method: "tools/list" }])[0].result.tools;
}

export function call(opts: MockOpts, name: string, args: unknown): CallResult {
  const [msg] = rpc(opts, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }]);
  if (msg.error) throw new Error(`JSON-RPC error: ${msg.error.message}`);
  const text: string = msg.result.content[0].text;
  const isError = msg.result.isError === true;
  let json: any = null;
  if (!isError) json = JSON.parse(text);
  return { isError, text, json };
}

export function writeState(path: string, state: MockState): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

export function readState(path: string): MockState & { days: Record<string, any>; calls: any[]; operations: any[] } {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Tally's version token for a row (version.ts encodeVersion). */
export function versionOf(row: { id: string; updated_at?: string | null }): string {
  return Buffer.from(`${row.id}|${row.updated_at ?? ""}`, "utf8").toString("base64url");
}
