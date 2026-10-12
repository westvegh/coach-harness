// Operation IDs (contracts §9, §15): op-<date>-<kind>-<sha256(canonical tool call)[0..12]>.
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { ALL_KINDS } from "./config.ts";
import { isCalendarDate } from "./dates.ts";
import { CoachError } from "./errors.ts";
import type { CalendarDate, ChangeKind } from "./types.ts";

export type OpKind = ChangeKind | "apply" | "week";
export const OP_KINDS: readonly OpKind[] = [...ALL_KINDS, "apply", "week"];
export const OPID_RE = /^op-\d{4}-\d{2}-\d{2}-[a-z_]+-[0-9a-f]{12}$/;

/**
 * The tool name without its server prefix: "mcp__Tally_Workout__plan_workout_day" and
 * "mcp__tally__plan_workout_day" both become "plan_workout_day", so one call has one ID
 * in the cloud, on the Mac and in the local CLI (connector names differ, spike #10).
 */
export function toolSuffix(tool: string): string {
  const i = tool.lastIndexOf("__");
  return i >= 0 ? tool.slice(i + 2) : tool;
}

/**
 * The canonical form of a tool call that the operation ID hashes. A
 * top-level `opId` (Tally T2's idempotency key) is left out: it names the call, it does
 * not change it, so a call hashes the same before and after its opId is added.
 */
export function canonicalToolCall(call: { tool: string; args: unknown }): string {
  let args = call.args ?? null;
  if (typeof args === "object" && args !== null && !Array.isArray(args) && "opId" in args) {
    const { opId: _key, ...rest } = args as Record<string, unknown>;
    args = rest;
  }
  return canonicalJson({ tool: toolSuffix(call.tool), args });
}

/**
 * The canonical hash of a tool call: SHA-256 of canonicalToolCall. Operation IDs use its
 * first 12 hex characters.
 */
export function toolCallHash(tool: string, args: unknown): string {
  return sha256Hex(canonicalToolCall({ tool, args }));
}

/**
 * whether `id` is the engine's operation ID for this call: the
 * format op-<date>-<kind>-<hash>, a real date, a known kind, and the hash of the call
 * without its opId. Then one key can never name two different calls, so a Tally replay
 * of one call cannot stand in for another. Returns the problem, or null.
 */
export function opIdProblem(id: string, call: { tool: string; args: unknown }): string | null {
  const m = /^op-(\d{4}-\d{2}-\d{2})-([a-z_]+)-([0-9a-f]{12})$/.exec(id);
  if (!m) return "it is not an engine operation ID (op-<date>-<kind>-<hash>; run node engine/cli.ts opid)";
  if (!isCalendarDate(m[1])) return `${m[1]} is not a date`;
  if (!OP_KINDS.includes(m[2] as OpKind)) return `${m[2]} is not an operation kind`;
  if (sha256Hex(canonicalToolCall(call)).slice(0, 12) !== m[3]) return "its hash is not the hash of this call (an opId names exactly one call; run node engine/cli.ts opid for this call)";
  return null;
}

export function opId(date: CalendarDate, kind: OpKind, call: { tool: string; args: unknown }): string {
  if (!isCalendarDate(date)) throw new CoachError("BAD_DATE", `opId date must be YYYY-MM-DD: ${JSON.stringify(date)}`);
  if (!OP_KINDS.includes(kind)) throw new CoachError("BAD_KIND", `unknown operation kind: ${JSON.stringify(kind)}`);
  if (typeof call?.tool !== "string" || call.tool === "") throw new CoachError("BAD_CALL", "opId needs a tool name");
  return `op-${date}-${kind}-${sha256Hex(canonicalToolCall(call)).slice(0, 12)}`;
}
