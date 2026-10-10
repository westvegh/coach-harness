// athlete/limits.yaml loader, validator and hash (contracts §2).
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { isCalendarDate } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { isPlainObject, readYamlFile } from "./yaml-file.ts";
import type { Limit, Limits, Taxonomy } from "./types.ts";

const LIMIT_KEYS = ["id", "region", "rule", "patterns", "exercises", "allow", "max_load", "max_sets_per_week", "note", "source", "since"];
const REQUIRED = ["id", "region", "rule", "source", "since"];

function stringList(v: unknown, path: string, errors: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim() === "")) {
    errors.push(`${path}: must be a list of non-empty strings`);
    return [];
  }
  return v as string[];
}

/**
 * Validates a parsed limits file. With a taxonomy, regions and patterns must be known.
 * Throws CoachError LIMITS_INVALID listing every problem.
 */
export function validateLimits(raw: unknown, tax?: Taxonomy, where = "limits.yaml"): Limits {
  const errors: string[] = [];
  if (!isPlainObject(raw)) throw new CoachError("LIMITS_INVALID", `${where} is invalid: must be a mapping`);
  for (const k of Object.keys(raw)) if (!["version", "pain_threshold", "limits"].includes(k)) errors.push(`${k}: unknown key`);
  if (raw.version !== 1) errors.push(`version: must be 1, got ${JSON.stringify(raw.version)}`);
  const pt = raw.pain_threshold;
  if (typeof pt !== "number" || !Number.isFinite(pt) || pt < 0 || pt > 10) {
    errors.push(`pain_threshold: must be a number from 0 to 10, got ${JSON.stringify(pt)}`);
  }
  const limits: Limit[] = [];
  if (!Array.isArray(raw.limits)) errors.push("limits: must be a list (use [] for none)");
  else {
    const ids = new Set<string>();
    raw.limits.forEach((l: unknown, i: number) => {
      const p = `limits[${i}]`;
      if (!isPlainObject(l)) {
        errors.push(`${p}: must be a mapping`);
        return;
      }
      for (const k of Object.keys(l)) if (!LIMIT_KEYS.includes(k)) errors.push(`${p}.${k}: unknown key`);
      for (const k of REQUIRED) if (!(k in l)) errors.push(`${p}.${k}: is required`);
      const id = l.id;
      if (typeof id !== "string" || !/^L-\d{3}$/.test(id)) errors.push(`${p}.id: must look like L-001, got ${JSON.stringify(id)}`);
      else if (ids.has(id)) errors.push(`${p}.id: duplicate id ${id}`);
      else ids.add(id);
      if (typeof l.region !== "string") errors.push(`${p}.region: must be a region id`);
      else if (tax && !tax.regions.includes(l.region)) errors.push(`${p}.region: unknown region ${l.region}`);
      if (l.rule !== "ban" && l.rule !== "cap") errors.push(`${p}.rule: must be ban | cap, got ${JSON.stringify(l.rule)}`);
      const patterns = stringList(l.patterns, `${p}.patterns`, errors);
      if (tax) for (const pat of patterns) if (!(pat in tax.patterns)) errors.push(`${p}.patterns: unknown pattern ${pat}`);
      const exercises = stringList(l.exercises, `${p}.exercises`, errors);
      const allow = stringList(l.allow, `${p}.allow`, errors);
      if (patterns.length === 0 && exercises.length === 0) errors.push(`${p}: needs patterns or exercises`);
      let max_load: Limit["max_load"];
      if (l.max_load !== undefined) {
        const m = l.max_load;
        if (!isPlainObject(m) || typeof m.value !== "number" || !Number.isFinite(m.value) || !(m.value > 0) || (m.unit !== "lbs" && m.unit !== "kg")) {
          errors.push(`${p}.max_load: must be { value: <finite positive number>, unit: lbs | kg }`);
        } else max_load = { value: m.value, unit: m.unit };
      }
      const msw = l.max_sets_per_week;
      if (msw !== undefined && (typeof msw !== "number" || !Number.isInteger(msw) || msw < 0)) {
        errors.push(`${p}.max_sets_per_week: must be a whole number of 0 or more`);
      }
      if (l.rule === "cap" && l.max_load === undefined && msw === undefined) {
        errors.push(`${p}: a cap needs max_load or max_sets_per_week`);
      }
      if (l.rule === "ban" && (l.max_load !== undefined || msw !== undefined)) {
        errors.push(`${p}: a ban cannot carry max_load or max_sets_per_week (use rule: cap)`);
      }
      if (l.note !== undefined && typeof l.note !== "string") errors.push(`${p}.note: must be a string`);
      if (l.source !== "athlete" && l.source !== "clinician-reported") {
        errors.push(`${p}.source: must be athlete | clinician-reported, got ${JSON.stringify(l.source)}`);
      }
      if (!isCalendarDate(l.since)) errors.push(`${p}.since: must be a date YYYY-MM-DD, got ${JSON.stringify(l.since)}`);
      limits.push({
        id: id as string,
        region: l.region as string,
        rule: l.rule as Limit["rule"],
        patterns,
        exercises,
        allow,
        ...(max_load ? { max_load } : {}),
        ...(typeof msw === "number" ? { max_sets_per_week: msw } : {}),
        ...(typeof l.note === "string" ? { note: l.note } : {}),
        source: l.source as Limit["source"],
        since: l.since as string,
      });
    });
  }
  if (errors.length > 0) throw new CoachError("LIMITS_INVALID", `${where} is invalid:\n  - ${errors.join("\n  - ")}`);
  return { version: 1, pain_threshold: pt as number, limits };
}

export function loadLimits(path: string, tax?: Taxonomy): Limits {
  return validateLimits(readYamlFile(path, "LIMITS_INVALID"), tax, path);
}

/** SHA-256 of the canonical JSON (sorted keys) of the parsed file. */
export function limitsHash(path: string): string {
  return sha256Hex(canonicalJson(readYamlFile(path, "LIMITS_INVALID")));
}
