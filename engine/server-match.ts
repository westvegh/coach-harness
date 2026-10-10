// Tally T3 server matching (Tally server-limits spec v3.2, §3.2, §4.1), ported to
// TypeScript. The harness compiles its limits into these rules (engine/limits-compile.ts)
// and uses this matcher in tests to prove the server refuses no exercise that the local
// guard allows.

/** A rule in Tally's training-limits document (spec §3.2). */
export type ServerRule = {
  id: string;
  label: string;
  region?: string;
  kind: "ban" | "cap";
  exerciseIds: string[];
  keywords: string[];
  exceptKeywords: string[];
  allow: { exerciseId: string; name: string }[];
  maxSetsPerWeek?: number;
};

/** The document (spec §3.2); `get_training_context` adds `version`. */
export type ServerLimits = { rules: ServerRule[]; maxWeeklySets?: number };

export type ServerExercise = { exerciseId?: unknown; name?: unknown };

/** Spec §3.2 bounds. */
export const RULE_ID = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_RULES = 50;
export const MAX_EXERCISE_IDS = 200;
export const MAX_KEYWORDS = 100;
export const MAX_ALLOW = 100;
export const MAX_SETS_PER_WEEK = 200;

/** Spec v3.2 §4.1: zero-width and format characters that norm() deletes before NFKC. */
const FORMAT_CHARS = /[\u00AD\u034F\u061C\u115F-\u1160\u17B4-\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

/** Spec v3.2 §4.1: each field is read only to its first 200 characters. */
export const FIELD_MAX = 200;

/**
 * Spec §4.1 norm(): delete zero-width and format characters, NFKC, lowercase, every run
 * of characters that are not letters or digits becomes one space, trimmed. A null or
 * missing value is the empty string.
 */
export function norm(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .replace(FORMAT_CHARS, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Spec v3.2 §4.1: every place where a keyword matches whole words of a normalized field,
 * with an optional plural "s" or "es" (the rule of engine/taxonomy.ts keywordSpans). A
 * span covers the keyword and its plural suffix.
 */
export function occurrences(field: string, keyword: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  if (keyword === "") return out;
  for (let i = field.indexOf(keyword); i >= 0; i = field.indexOf(keyword, i + 1)) {
    if (i > 0 && field[i - 1] !== " ") continue;
    const plural = /^(es|s)?( |$)/.exec(field.slice(i + keyword.length));
    if (plural) out.push({ start: i, end: i + keyword.length + (plural[1]?.length ?? 0) });
  }
  return out;
}

/** Whether a keyword occurs in a normalized field (whole words, optional plural). */
export function occurs(field: string, keyword: string): boolean {
  return occurrences(field, keyword).length > 0;
}

/**
 * Masks the union of every except-keyword occurrence in the original field (each span
 * with its plural suffix), so the result does not depend on the order of the except list.
 */
export function maskField(field: string, except: string[]): string {
  const masked = new Array<boolean>(field.length).fill(false);
  for (const k of except) {
    for (const o of occurrences(field, k)) for (let j = o.start; j < o.end; j++) masked[j] = true;
  }
  let out = "";
  for (let j = 0; j < field.length; j++) out += masked[j] ? " " : field[j];
  return out;
}

/** Spec §4.1: whether exercise `e` matches rule `r`. */
export function ruleMatches(r: ServerRule, e: ServerExercise): boolean {
  const id = norm(e.exerciseId);
  const name = norm(e.name);
  if (r.allow.some((a) => norm(a.exerciseId) === id && norm(a.name) === name)) return false;
  if (r.exerciseIds.some((x) => norm(x) === id)) return true;
  for (const field of [name.slice(0, FIELD_MAX), id.slice(0, FIELD_MAX)]) {
    const m = maskField(field, r.exceptKeywords);
    if (r.keywords.some((k) => occurs(m, k))) return true;
  }
  return false;
}

/** The rules of a document that an exercise matches. */
export function matchingRules(doc: ServerLimits, e: ServerExercise): ServerRule[] {
  return doc.rules.filter((r) => ruleMatches(r, e));
}
