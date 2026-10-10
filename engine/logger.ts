// Logger adapters (contracts §12): adapter.yaml plus the rebuild functions.
// Only Tally exists in v1; the adapter is chosen by coach.yaml `logger`.
import { join } from "node:path";
import * as tally from "../adapters/loggers/tally/rebuild.ts";
import { CoachError } from "./errors.ts";
import { toolSuffix as suffixOf } from "./opid.ts";
import { isPlainObject, readYamlFile } from "./yaml-file.ts";
import type { CalendarDate, DayPlan, Snapshot, SnapshotDay, Units } from "./types.ts";

export const ADAPTERS_DIR = join(import.meta.dirname, "..", "adapters", "loggers");

export type LoggerCapabilities = {
  rangeCreateIfAbsent: boolean;
  versionedSkipDelete: boolean;
  opId: boolean;
  protectsUserDays: boolean;
  /** Tally T3: true at run time only when the tool list holds `when_tool` (see serverLimits). */
  server_limits?: { when_tool: string };
};

export type AdapterConfig = {
  name: string;
  tools: { reads: Record<string, string>; mutations: Record<string, string>; limits?: { update: string } };
  matcher: string;
  capture_matcher: string;
  capabilities: LoggerCapabilities;
};

/** A mutation tool, by its suffix (for Tally: plan_workout_day, …). */
export type LoggerTool = tally.TallyMutation;
export type DayChange = tally.DayChange;

export type LoggerAdapter = {
  config: AdapterConfig;
  isMutation(suffix: string): suffix is LoggerTool;
  isRead(suffix: string): boolean;
  affectedDates(tool: LoggerTool, args: unknown): CalendarDate[];
  rebuild(tool: LoggerTool, args: unknown, snap: Snapshot): DayChange[];
  toDayPlan(date: CalendarDate, day: SnapshotDay, fallbackUnit: Units): DayPlan;
};

const CAPS = ["rangeCreateIfAbsent", "versionedSkipDelete", "opId", "protectsUserDays"] as const;

export function validateAdapterConfig(raw: unknown, where: string): AdapterConfig {
  const errors: string[] = [];
  if (!isPlainObject(raw)) throw new CoachError("ADAPTER_INVALID", `${where}: must be a mapping`);
  if (typeof raw.name !== "string" || raw.name === "") errors.push("name is required");
  const tools = raw.tools;
  if (!isPlainObject(tools) || !isPlainObject(tools.reads) || !isPlainObject(tools.mutations)) errors.push("tools.reads and tools.mutations are required");
  for (const k of ["matcher", "capture_matcher"]) {
    if (typeof raw[k] !== "string") errors.push(`${k} must be a regex string`);
    else {
      try {
        new RegExp(raw[k] as string);
      } catch (e) {
        errors.push(`${k}: ${(e as Error).message}`);
      }
    }
  }
  const caps = raw.capabilities;
  if (!isPlainObject(caps)) errors.push("capabilities is required");
  else {
    for (const c of CAPS) if (typeof caps[c] !== "boolean") errors.push(`capabilities.${c} must be true or false`);
    const sl = caps.server_limits;
    if (sl !== undefined && (!isPlainObject(sl) || typeof sl.when_tool !== "string" || sl.when_tool === "")) errors.push("capabilities.server_limits must be { when_tool: <tool suffix> }");
  }
  if (isPlainObject(tools) && tools.limits !== undefined && (!isPlainObject(tools.limits) || typeof tools.limits.update !== "string")) errors.push("tools.limits must be { update: <tool suffix> }");
  if (errors.length > 0) throw new CoachError("ADAPTER_INVALID", `${where} is invalid:\n  - ${errors.join("\n  - ")}`);
  return raw as unknown as AdapterConfig;
}

/**
 * Tally T3 (`server_limits`): true when the connected tool list holds the capability's
 * tool, in any of the server-name forms (mcp__<server>__<suffix>).
 */
export function serverLimits(config: AdapterConfig, toolNames: string[]): boolean {
  const tool = config.capabilities.server_limits?.when_tool;
  return !!tool && toolNames.some((n) => n === tool || (new RegExp(config.matcher).test(n) && suffixOf(n) === tool));
}

export function loadAdapterConfig(name: string, dir = ADAPTERS_DIR): AdapterConfig {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new CoachError("ADAPTER_INVALID", `bad logger name ${JSON.stringify(name)}`);
  const p = join(dir, name, "adapter.yaml");
  return validateAdapterConfig(readYamlFile(p, "ADAPTER_INVALID"), p);
}

/** The adapter named in coach.yaml. Throws for a logger with no rebuild functions. */
export function loadLogger(name: string, dir = ADAPTERS_DIR): LoggerAdapter {
  if (name !== "tally") throw new CoachError("ADAPTER_INVALID", `no rebuild functions for logger ${JSON.stringify(name)}`);
  const config = loadAdapterConfig(name, dir);
  return {
    config,
    isMutation: (s): s is LoggerTool => tally.isTallyMutation(s),
    isRead: (s) => (tally.READS as readonly string[]).includes(s),
    affectedDates: tally.affectedDates,
    rebuild: tally.rebuild,
    toDayPlan: tally.toDayPlan,
  };
}

/** The tool suffix of a full MCP tool name (mcp__<server>__<suffix>). One implementation: opid.ts. */
export { toolSuffix } from "./opid.ts";
