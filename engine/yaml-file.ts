import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { CoachError } from "./errors.ts";

/** Reads and parses a YAML file. IO and parse errors become CoachError. */
export function readYamlFile(path: string, code = "YAML_ERROR"): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new CoachError(code, `cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return parse(text, { uniqueKeys: true });
  } catch (e) {
    throw new CoachError(code, `cannot parse ${path}: ${(e as Error).message}`);
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
