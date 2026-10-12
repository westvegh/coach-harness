// athlete/block.yaml validation (contracts §16 item 5). Every number must be
// a finite, non-negative integer: a NaN target would make every volume comparison pass.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isCalendarDate, weekdayOf, WEEKDAYS } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { isPlainObject, readYamlFile } from "./yaml-file.ts";
import type { Block } from "./types.ts";

const KINDS = ["build", "deload", "test"];
const EMPHASES = ["all-around", "strength", "hypertrophy", "endurance", "general-health"];

function count(v: unknown, min = 0): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= min;
}

/** Validates the whole block. Throws CoachError BLOCK_INVALID listing every problem. */
export function validateBlock(raw: unknown, where = "athlete/block.yaml"): Block {
  const errors: string[] = [];
  if (!isPlainObject(raw)) throw new CoachError("BLOCK_INVALID", `${where} must be a mapping`);
  for (const k of Object.keys(raw)) if (!["version", "id", "method", "template", "start", "weeks", "days"].includes(k)) errors.push(`${k}: unknown key`);
  if (raw.version !== 1) errors.push("version must be 1");
  if (typeof raw.id !== "string" || raw.id === "") errors.push("id is required");
  if (typeof raw.method !== "string" || raw.method === "") errors.push("method is required");
  const t = raw.template;
  if (!isPlainObject(t) || ![3, 4, 5].includes(t.days as number) || !EMPHASES.includes(t.emphasis as string)) errors.push("template must be {days: 3|4|5, emphasis}");
  if (!isCalendarDate(raw.start) || weekdayOf(raw.start) !== "mon") errors.push("start must be a Monday (YYYY-MM-DD)");
  if (!Array.isArray(raw.weeks) || raw.weeks.length === 0) errors.push("weeks must be a non-empty list");
  else {
    const seen = new Set<number>();
    raw.weeks.forEach((w, i) => {
      const at = `weeks[${i}]`;
      if (!isPlainObject(w)) return errors.push(`${at} must be a mapping`);
      for (const k of Object.keys(w)) if (!["week", "kind", "sessions", "targets"].includes(k)) errors.push(`${at}.${k}: unknown key`);
      if (!count(w.week, 1)) errors.push(`${at}.week must be a whole number of 1 or more`);
      else if (seen.has(w.week as number)) errors.push(`${at}.week: duplicate week ${w.week}`);
      else seen.add(w.week as number);
      if (!KINDS.includes(w.kind as string)) errors.push(`${at}.kind must be build | deload | test`);
      if (!count(w.sessions)) errors.push(`${at}.sessions must be a whole number of 0 or more`);
      if (w.targets !== undefined) {
        if (!isPlainObject(w.targets)) errors.push(`${at}.targets must map muscles to set counts`);
        else for (const [m, n] of Object.entries(w.targets)) if (!count(n)) errors.push(`${at}.targets.${m} must be a finite whole number of 0 or more, got ${String(n)}`);
      }
    });
  }
  if (!Array.isArray(raw.days)) errors.push("days must be a list");
  else raw.days.forEach((d, i) => {
    const at = `days[${i}]`;
    if (!isPlainObject(d)) return errors.push(`${at} must be a mapping`);
    if (!WEEKDAYS.includes(d.day as never)) errors.push(`${at}.day must be mon … sun`);
    if (typeof d.focus !== "string") errors.push(`${at}.focus is required`);
    if (!Array.isArray(d.slots)) return errors.push(`${at}.slots must be a list`);
    d.slots.forEach((s, j) => {
      const sat = `${at}.slots[${j}]`;
      if (!isPlainObject(s)) return errors.push(`${sat} must be a mapping`);
      if (typeof s.pattern !== "string" || s.pattern === "") errors.push(`${sat}.pattern is required`);
      if (typeof s.adaptation !== "string") errors.push(`${sat}.adaptation is required`);
      if (!count(s.sets, 1)) errors.push(`${sat}.sets must be a whole number of 1 or more`);
      if (s.rest_s !== undefined && !(typeof s.rest_s === "number" && Number.isFinite(s.rest_s) && s.rest_s >= 0)) errors.push(`${sat}.rest_s must be seconds`);
      if (s.exercise !== undefined && (typeof s.exercise !== "string" || s.exercise === "")) errors.push(`${sat}.exercise must be a name or exerciseId`);
    });
  });
  if (errors.length > 0) throw new CoachError("BLOCK_INVALID", `${where} is invalid:\n  - ${errors.join("\n  - ")}`);
  return raw as unknown as Block;
}

export const BLOCK_RELATIVE = "athlete/block.yaml";

/** athlete/block.yaml, or null when it is absent or still the unfilled template (start: null). */
export function readBlock(root: string): Block | null {
  const p = join(root, BLOCK_RELATIVE);
  if (!existsSync(p)) return null;
  const raw = readYamlFile(p, "BLOCK_INVALID");
  if (!isPlainObject(raw)) throw new CoachError("BLOCK_INVALID", `${BLOCK_RELATIVE} must be a mapping`);
  if (raw.start === null || raw.start === undefined) return null;
  return validateBlock(raw, BLOCK_RELATIVE);
}
