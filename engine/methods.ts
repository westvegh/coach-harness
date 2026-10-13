// Method pack types and loader (contracts §4).
//
// A pack lives in methods/<pack>/ and holds rules.yaml, principles/*.md,
// templates/{3,4,5}-day.yaml, assessments.md and sources.md. This module only
// parses and shape-checks; engine/lint-methods.ts does the cross-file checks.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const CHECK_TYPES = [
  "weekly_volume_increase_max",
  "deload_depth",
  "deload_every_weeks",
  "weekly_sets_per_muscle_range",
  "top_set_jump_max",
  "session_minutes_max",
  "rep_range",
  "rest_range_s",
  "program_change_min_categories",
  "single_day_action",
  "off_mornings_short_pattern",
  "off_mornings_long_pattern",
  "aversion_scale_max",
] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

// The nine adaptations, in order from most neural to most metabolic, plus
// "recovery" for mobility and breathing slots that train no adaptation.
export const ADAPTATIONS = [
  "skill",
  "speed",
  "power",
  "strength",
  "hypertrophy",
  "muscular_endurance",
  "anaerobic_capacity",
  "max_aerobic",
  "long_duration",
  "recovery",
] as const;
export type Adaptation = (typeof ADAPTATIONS)[number];

export const EMPHASES = ["all-around", "strength", "hypertrophy", "endurance", "general-health"] as const;
export type Emphasis = (typeof EMPHASES)[number];

export type RangeCheck = { adaptation: Adaptation; min: number; max: number };

export type Check =
  | { type: "weekly_volume_increase_max"; value: number }
  | { type: "deload_depth"; value: { volume: number; load: number } }
  | { type: "deload_every_weeks"; value: number }
  | { type: "weekly_sets_per_muscle_range"; value: [number, number] }
  | { type: "top_set_jump_max"; value: number }
  | { type: "session_minutes_max"; value: number }
  | { type: "rep_range"; value: RangeCheck }
  | { type: "rest_range_s"; value: RangeCheck }
  | { type: "program_change_min_categories"; value: number }
  | { type: "single_day_action"; value: "note" }
  | { type: "off_mornings_short_pattern"; value: number }
  | { type: "off_mornings_long_pattern"; value: number }
  | { type: "aversion_scale_max"; value: number };

export type RuleSource = {
  ref: string; // key in sources.md
  at?: string; // HH:MM:SS into the episode; absent only when precision is approximate
  // exact = checked in the episode; chapter = chapter start only; approximate = the episode
  // is the source, but no timestamp was checked (so there is no `at`)
  precision?: "exact" | "chapter" | "approximate";
};

export type Rule = {
  id: string;
  text: string;
  kind: "sourced" | "policy";
  severity: "hard" | "soft";
  source?: RuleSource; // required when kind is sourced; optional basis for policy
  check?: Check;
  note?: string;
};

export type Rules = { pack: string; version: number; rules: Rule[] };

// A count is a fixed number or an inclusive [min, max] range.
export type Count = number | [number, number];

export type Slot = {
  pattern: string; // pattern ID from engine/movements.yaml
  adaptation: Adaptation;
  sets: number; // hard sets (or rounds / bouts for conditioning)
  reps?: Count; // per set
  duration?: Count; // seconds per set or bout
  rest_s: number;
  note?: string;
};

/** `why`: one plain line on why the day looks as it does (optional; shown to the athlete). */
export type TemplateDay = { day: number; focus: string; slots: Slot[]; why?: string };

export type Template = {
  pack: string;
  version: number;
  days: number;
  name: string;
  week: TemplateDay[];
  // Set multiplier per adaptation, per emphasis. Missing adaptations mean 1.
  emphasis: Record<Emphasis, Partial<Record<Adaptation, number>>>;
  // Optional plain lines for the athlete on why the week looks as it does (the setup and
  // block skills show them before the week table). The lint checks their length.
  why?: string[];
};

export type MethodPack = {
  dir: string;
  rules: Rules;
  templates: Record<string, Template>; // keyed by file name, e.g. "3-day"
};

export class MethodError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "CoachError";
  }
}

const RULE_ID = /^NA-[A-Z]+-\d{3}$/;
const TIMESTAMP = /^\d{2}:\d{2}:\d{2}$/;

function fail(file: string, msg: string): never {
  throw new MethodError("METHOD_INVALID", `${file}: ${msg}`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isCount(v: unknown): v is Count {
  return isNum(v) || (Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) && v[0] <= v[1]);
}

function readYaml(path: string): unknown {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new MethodError("METHOD_IO", `${path}: ${(e as Error).message}`);
  }
}

// Checks the value shape for a known check type. Unknown types are left to the
// lint, which reports them as errors, so the loader stays usable for linting.
export function checkValueError(check: { type: string; value: unknown }): string | null {
  const v = check.value;
  switch (check.type) {
    case "weekly_volume_increase_max":
    case "top_set_jump_max":
      return isNum(v) && v > 0 && v < 1 ? null : "value must be a fraction between 0 and 1";
    case "deload_depth":
      return isObj(v) && isNum(v.volume) && isNum(v.load) && v.volume > 0 && v.volume < 1 && v.load > 0 && v.load < 1
        ? null
        : "value must be {volume, load}, each a fraction between 0 and 1";
    case "deload_every_weeks":
    case "session_minutes_max":
    case "program_change_min_categories":
    case "off_mornings_short_pattern":
    case "off_mornings_long_pattern":
      return Number.isInteger(v) && (v as number) > 0 ? null : "value must be a positive integer";
    case "aversion_scale_max":
      return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5 ? null : "value must be a whole number from 1 to 5";
    case "single_day_action":
      return v === "note" ? null : 'value must be "note"';
    case "weekly_sets_per_muscle_range":
      return Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) && v[0] <= v[1]
        ? null
        : "value must be [min, max]";
    case "rep_range":
    case "rest_range_s":
      return isObj(v) &&
        (ADAPTATIONS as readonly string[]).includes(v.adaptation as string) &&
        isNum(v.min) &&
        isNum(v.max) &&
        v.min <= v.max
        ? null
        : "value must be {adaptation, min, max} with a known adaptation";
    default:
      return null;
  }
}

export function parseRules(raw: unknown, file = "rules.yaml"): Rules {
  if (!isObj(raw)) fail(file, "expected a mapping");
  if (typeof raw.pack !== "string") fail(file, "pack must be a string");
  if (raw.version !== 1) fail(file, "version must be 1");
  if (!Array.isArray(raw.rules)) fail(file, "rules must be a list");
  const seen = new Set<string>();
  const rules = raw.rules.map((r, i): Rule => {
    const where = `rule ${i + 1}`;
    if (!isObj(r)) fail(file, `${where}: expected a mapping`);
    const id = r.id;
    if (typeof id !== "string" || !RULE_ID.test(id)) fail(file, `${where}: id must look like NA-AREA-001`);
    if (seen.has(id)) fail(file, `${id}: duplicate id`);
    seen.add(id);
    if (typeof r.text !== "string" || r.text.trim() === "") fail(file, `${id}: text is required`);
    if (r.kind !== "sourced" && r.kind !== "policy") fail(file, `${id}: kind must be sourced or policy`);
    if (r.severity !== "hard" && r.severity !== "soft") fail(file, `${id}: severity must be hard or soft`);
    let source: RuleSource | undefined;
    if (r.source !== undefined) {
      const s = r.source;
      if (!isObj(s) || typeof s.ref !== "string") fail(file, `${id}: source must be {ref, at: "HH:MM:SS"}`);
      if (s.precision !== undefined && s.precision !== "exact" && s.precision !== "chapter" && s.precision !== "approximate") {
        fail(file, `${id}: source.precision must be exact, chapter or approximate`);
      }
      // An approximate source names the episode only: a timestamp would claim a check that was not made.
      if (s.precision === "approximate") {
        if (s.at !== undefined) fail(file, `${id}: an approximate source has no timestamp (remove at, or check it and use exact or chapter)`);
      } else if (typeof s.at !== "string" || !TIMESTAMP.test(s.at)) {
        fail(file, `${id}: source must be {ref, at: "HH:MM:SS"}`);
      }
      source = { ref: s.ref, ...(s.at !== undefined ? { at: s.at as string } : {}), ...(s.precision ? { precision: s.precision } : {}) } as RuleSource;
    }
    let check: Check | undefined;
    if (r.check !== undefined) {
      if (!isObj(r.check) || typeof r.check.type !== "string") fail(file, `${id}: check must be {type, value}`);
      const err = checkValueError(r.check as { type: string; value: unknown });
      if (err) fail(file, `${id}: ${r.check.type}: ${err}`);
      check = r.check as unknown as Check;
    }
    return {
      id,
      text: r.text,
      kind: r.kind,
      severity: r.severity,
      ...(source ? { source } : {}),
      ...(check ? { check } : {}),
      ...(typeof r.note === "string" ? { note: r.note } : {}),
    };
  });
  return { pack: raw.pack, version: 1, rules };
}

export function parseTemplate(raw: unknown, file = "template"): Template {
  if (!isObj(raw)) fail(file, "expected a mapping");
  if (typeof raw.pack !== "string") fail(file, "pack must be a string");
  if (raw.version !== 1) fail(file, "version must be 1");
  if (typeof raw.name !== "string") fail(file, "name must be a string");
  if (!Number.isInteger(raw.days)) fail(file, "days must be an integer");
  if (!Array.isArray(raw.week)) fail(file, "week must be a list of days");
  if (raw.week.length !== raw.days) fail(file, `week has ${raw.week.length} days, expected ${raw.days}`);
  const week = raw.week.map((d, i): TemplateDay => {
    const where = `day ${i + 1}`;
    if (!isObj(d) || d.day !== i + 1) fail(file, `${where}: day must be ${i + 1}`);
    if (typeof d.focus !== "string") fail(file, `${where}: focus is required`);
    if (!Array.isArray(d.slots) || d.slots.length === 0) fail(file, `${where}: slots must be a non-empty list`);
    const slots = d.slots.map((s, j): Slot => {
      const at = `${where} slot ${j + 1}`;
      if (!isObj(s)) fail(file, `${at}: expected a mapping`);
      if (typeof s.pattern !== "string" || !/^[a-z0-9_]+$/.test(s.pattern)) fail(file, `${at}: pattern must be a pattern id`);
      if (!(ADAPTATIONS as readonly string[]).includes(s.adaptation as string)) fail(file, `${at}: unknown adaptation ${String(s.adaptation)}`);
      if (!Number.isInteger(s.sets) || (s.sets as number) < 1) fail(file, `${at}: sets must be a positive integer`);
      if (s.reps === undefined && s.duration === undefined) fail(file, `${at}: needs reps or duration`);
      if (s.reps !== undefined && !isCount(s.reps)) fail(file, `${at}: reps must be a number or [min, max]`);
      if (s.duration !== undefined && !isCount(s.duration)) fail(file, `${at}: duration must be seconds or [min, max]`);
      if (!isNum(s.rest_s) || s.rest_s < 0) fail(file, `${at}: rest_s must be a number of seconds`);
      return s as unknown as Slot;
    });
    if (d.why !== undefined && (typeof d.why !== "string" || d.why.trim() === "")) fail(file, `${where}: why must be one line of text`);
    return { day: d.day as number, focus: d.focus, slots, ...(typeof d.why === "string" ? { why: d.why.trim() } : {}) };
  });
  if (raw.why !== undefined && (!Array.isArray(raw.why) || raw.why.some((l) => typeof l !== "string" || l.trim() === ""))) fail(file, "why must be a list of lines");
  if (!isObj(raw.emphasis)) fail(file, "emphasis must be a mapping");
  for (const e of EMPHASES) {
    const row = raw.emphasis[e];
    if (!isObj(row)) fail(file, `emphasis.${e} is missing`);
    for (const [a, m] of Object.entries(row)) {
      if (!(ADAPTATIONS as readonly string[]).includes(a)) fail(file, `emphasis.${e}: unknown adaptation ${a}`);
      if (!isNum(m) || m < 0) fail(file, `emphasis.${e}.${a}: multiplier must be a number >= 0`);
    }
  }
  for (const e of Object.keys(raw.emphasis)) {
    if (!(EMPHASES as readonly string[]).includes(e)) fail(file, `unknown emphasis ${e}`);
  }
  return {
    pack: raw.pack,
    version: 1,
    days: raw.days as number,
    name: raw.name,
    week,
    emphasis: raw.emphasis as Template["emphasis"],
    ...(Array.isArray(raw.why) ? { why: (raw.why as string[]).map((l) => l.trim()) } : {}),
  };
}

// Sets for one slot under an emphasis. Rounds to the nearest whole set; a
// multiplier above 0 never drops a slot below 1 set.
export function scaledSets(slot: Slot, template: Template, emphasis: Emphasis): number {
  const m = template.emphasis[emphasis][slot.adaptation] ?? 1;
  if (m === 0) return 0;
  return Math.max(1, Math.round(slot.sets * m));
}

export function loadRules(packDir: string): Rules {
  const file = join(packDir, "rules.yaml");
  return parseRules(readYaml(file), file);
}

export function loadTemplates(packDir: string): Record<string, Template> {
  const dir = join(packDir, "templates");
  const out: Record<string, Template> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".yaml")) continue;
    const file = join(dir, f);
    out[f.replace(/\.yaml$/, "")] = parseTemplate(readYaml(file), file);
  }
  return out;
}

export function loadPack(packDir: string): MethodPack {
  return { dir: packDir, rules: loadRules(packDir), templates: loadTemplates(packDir) };
}

// Returns the check of the given type, or undefined. Use rulesByCheck when a
// type can appear more than once (rep_range, rest_range_s).
export function ruleCheck<T extends CheckType>(rules: Rules, type: T): Extract<Check, { type: T }> | undefined {
  return rulesByCheck(rules, type)[0]?.check as Extract<Check, { type: T }> | undefined;
}

export function rulesByCheck(rules: Rules, type: CheckType): Rule[] {
  return rules.rules.filter((r) => r.check?.type === type);
}
