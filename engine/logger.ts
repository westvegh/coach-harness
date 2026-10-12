// Logger adapters (contracts §12): adapter.yaml (tool names, the log-writes and
// capture-reads matchers, capabilities). Only Tally has an adapter; coach.yaml `logger`
// names it.
import { join } from "node:path";
import type { TallyMutation } from "../adapters/loggers/tally/day.ts";
import { CoachError } from "./errors.ts";
import { isPlainObject, readYamlFile } from "./yaml-file.ts";

export const ADAPTERS_DIR = join(import.meta.dirname, "..", "adapters", "loggers");

export type LoggerCapabilities = {
  rangeCreateIfAbsent: boolean;
  versionedSkipDelete: boolean;
  opId: boolean;
  protectsUserDays: boolean;
};

export type AdapterConfig = {
  name: string;
  tools: { reads: Record<string, string>; mutations: Record<string, string>; limits?: { update: string } };
  matcher: string;
  capture_matcher: string;
  capabilities: LoggerCapabilities;
};

/** A mutation tool, by its suffix (for Tally: plan_workout_day, …). */
export type LoggerTool = TallyMutation;

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
  }
  if (isPlainObject(tools) && tools.limits !== undefined && (!isPlainObject(tools.limits) || typeof tools.limits.update !== "string")) errors.push("tools.limits must be { update: <tool suffix> }");
  if (errors.length > 0) throw new CoachError("ADAPTER_INVALID", `${where} is invalid:\n  - ${errors.join("\n  - ")}`);
  return raw as unknown as AdapterConfig;
}

export function loadAdapterConfig(name: string, dir = ADAPTERS_DIR): AdapterConfig {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new CoachError("ADAPTER_INVALID", `bad logger name ${JSON.stringify(name)}`);
  const p = join(dir, name, "adapter.yaml");
  return validateAdapterConfig(readYamlFile(p, "ADAPTER_INVALID"), p);
}

/** The tool suffix of a full MCP tool name (mcp__<server>__<suffix>). One implementation: opid.ts. */
export { toolSuffix } from "./opid.ts";
