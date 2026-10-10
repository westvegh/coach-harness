// Compiles athlete/limits.yaml plus the taxonomy into Tally T3 server rules
// (Tally server-limits spec §8).
//
// The server has no taxonomy. A rule matches by exerciseId, by keyword (whole words with
// a plural s or es, as in the taxonomy; spec v3.2 §4.1), and with except-keywords masked.
// The local taxonomy also lets the longest keyword win, so the compiler adds an
// except-keyword for every taxonomy phrase that holds a banned keyword but that the local
// taxonomy maps to none of the limit's patterns. With that, the server refuses no taxonomy exercise that the local
// guard allows (the property test in engine/server-match.test.ts).
import { normalizeName, classify } from "./taxonomy.ts";
import { MAX_ALLOW, MAX_EXERCISE_IDS, MAX_KEYWORDS, MAX_RULES, MAX_SETS_PER_WEEK, norm, occurs } from "./server-match.ts";
import type { ServerRule } from "./server-match.ts";
import type { Limit, Limits, Taxonomy } from "./types.ts";

/** Exercise names from limits.yaml → the Tally exercise (one `search_exercises` call). */
export type Resolved = Record<string, { exerciseId: string; name: string }>;

export type CompileResult = {
  rules: ServerRule[];
  /** Limits not pushed to the server, with the reason. The local guard still enforces them. */
  skipped: { id: string; reason: string }[];
  /** Parts of a pushed limit that only the local guard enforces (for example max_load). */
  localOnly: { id: string; reason: string }[];
  /** limits.yaml exercise and allow names with no entry in `resolved`. */
  unresolved: string[];
};

const KEYWORD_MIN = 2;
const KEYWORD_MAX = 60;
const ID_MAX = 100;
const LABEL_MAX = 80;
const REGION_MAX = 40;

const keywordOk = (k: string) => k.length >= KEYWORD_MIN && k.length <= KEYWORD_MAX;

function meets(patterns: string[], limit: Limit): boolean {
  return patterns.some((p) => limit.patterns.includes(p));
}

/** The entry of `resolved` for a name: the exact key, else the key with the same normalized form. */
export function lookupResolved(resolved: Resolved, name: string): { exerciseId: string; name: string } | null {
  if (resolved[name]) return resolved[name];
  const n = normalizeName(name);
  for (const [k, v] of Object.entries(resolved)) if (normalizeName(k) === n) return v;
  return null;
}

/**
 * Phrases where two taxonomy keywords overlap by whole words: "incline bench" + "bench
 * press" → "incline bench press", where the local taxonomy lets the longest keyword win.
 * These phrases are candidates for except-keywords.
 */
function overlapPhrases(keywords: string[]): string[] {
  const words = keywords.map((k) => k.split(" "));
  const out = new Set<string>();
  for (const a of words) {
    for (const b of words) {
      if (a === b) continue;
      for (let k = 1; k < a.length && k < b.length; k++) {
        if (a.slice(a.length - k).join(" ") === b.slice(0, k).join(" ")) out.add([...a, ...b.slice(k)].join(" "));
      }
    }
  }
  return [...out];
}

function uniqueByNorm(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const n = norm(x);
    if (n === "" || seen.has(n)) continue;
    seen.add(n);
    out.push(x);
  }
  return out;
}

function label(l: Limit): string {
  const region = l.region.replace(/-/g, " ");
  const text = l.note ? `${region[0].toUpperCase()}${region.slice(1)}: ${l.note}` : `${region[0].toUpperCase()}${region.slice(1)} limit`;
  return text.length <= LABEL_MAX ? text : text.slice(0, LABEL_MAX).trimEnd();
}

/**
 * Tally rules for the limits (spec §8):
 * - `ban` → kind ban; a cap with `max_sets_per_week` → kind cap. A cap with only
 *   `max_load` is skipped and reported (no server load check in v1).
 * - exerciseIds: the limit's exercises (as written and resolved) and every taxonomy
 *   `exercises` entry whose patterns meet the limit's patterns.
 * - keywords: every taxonomy keyword whose patterns meet the limit's patterns (norm form).
 * - exceptKeywords: every taxonomy phrase (keyword, exercise entry, or two overlapping
 *   keywords) that holds a banned keyword but that the local taxonomy maps to none of
 *   the limit's patterns.
 * - allow: the limit's allow entries resolved to {exerciseId, name}. A limit with an
 *   unresolved allow entry is skipped, because without it the server would refuse an
 *   exercise the local guard allows.
 */
export function compileServerRules(limits: Limits, tax: Taxonomy, resolved: Resolved = {}): CompileResult {
  const rules: ServerRule[] = [];
  const skipped: CompileResult["skipped"] = [];
  const localOnly: CompileResult["localOnly"] = [];
  const unresolved = new Set<string>();
  const taxKeywords = Object.keys(tax.keywords);
  const candidates = uniqueByNorm([...taxKeywords, ...Object.keys(tax.exercises), ...overlapPhrases(taxKeywords.map(norm))]).map(norm);

  for (const l of limits.limits) {
    if (l.rule === "cap" && l.max_sets_per_week === undefined) {
      skipped.push({ id: l.id, reason: `${l.id} caps only the load (max_load); Tally has no load check in v1, so only the local guard enforces it` });
      continue;
    }
    if (l.rule === "cap" && (l.max_sets_per_week as number) > MAX_SETS_PER_WEEK) {
      skipped.push({ id: l.id, reason: `${l.id} allows ${l.max_sets_per_week} sets a week; Tally caps hold at most ${MAX_SETS_PER_WEEK}` });
      continue;
    }
    if (l.rule === "cap" && l.max_load) localOnly.push({ id: l.id, reason: `${l.id}: the load cap (max_load) stays local; Tally checks only the sets` });

    const limitNames = new Set(l.exercises.map(normalizeName));
    const exerciseIds: string[] = [];
    for (const name of l.exercises) {
      const r = lookupResolved(resolved, name);
      if (r) exerciseIds.push(r.exerciseId);
      else unresolved.add(name);
      exerciseIds.push(name);
    }
    for (const [key, pats] of Object.entries(tax.exercises)) if (meets(pats, l)) exerciseIds.push(key);
    const ids = uniqueByNorm(exerciseIds).filter((x) => x.length <= ID_MAX);

    const keywords = [...new Set(taxKeywords.filter((k) => meets(tax.keywords[k], l)).map(norm))].filter(keywordOk).sort();

    const except = candidates
      .filter((p) => keywordOk(p) && !limitNames.has(p) && keywords.some((k) => occurs(p, k)))
      .filter((p) => !meets(classify({ exerciseId: null, name: p }, tax).patterns, l))
      .sort();

    const allow: ServerRule["allow"] = [];
    const missing: string[] = [];
    for (const name of l.allow) {
      // Locally the limit's own exercises beat its allow list.
      if (limitNames.has(normalizeName(name))) continue;
      const r = lookupResolved(resolved, name);
      if (r) allow.push({ exerciseId: r.exerciseId, name: r.name });
      else missing.push(name);
    }
    for (const m of missing) unresolved.add(m);
    if (missing.length > 0) {
      skipped.push({ id: l.id, reason: `${l.id}: resolve the allowed exercise${missing.length > 1 ? "s" : ""} ${missing.map((m) => JSON.stringify(m)).join(", ")} first; without ${missing.length > 1 ? "them" : "it"} Tally would refuse what the local guard allows` });
      continue;
    }

    if (ids.length === 0 && keywords.length === 0) {
      skipped.push({ id: l.id, reason: `${l.id} names no exercise or keyword that Tally can match` });
      continue;
    }
    const sizes: [string, number, number][] = [
      ["exerciseIds", ids.length, MAX_EXERCISE_IDS],
      ["keywords", keywords.length, MAX_KEYWORDS],
      ["exceptKeywords", except.length, MAX_KEYWORDS],
      ["allow", allow.length, MAX_ALLOW],
    ];
    const tooBig = sizes.filter(([, n, max]) => n > max);
    if (tooBig.length > 0) {
      skipped.push({ id: l.id, reason: `${l.id} is too large for Tally: ${tooBig.map(([k, n, max]) => `${n} ${k} (at most ${max})`).join(", ")}` });
      continue;
    }
    if (rules.length >= MAX_RULES) {
      skipped.push({ id: l.id, reason: `Tally holds at most ${MAX_RULES} rules` });
      continue;
    }
    rules.push({
      id: l.id,
      label: label(l),
      region: l.region.slice(0, REGION_MAX),
      kind: l.rule,
      exerciseIds: ids,
      keywords,
      exceptKeywords: except,
      allow,
      ...(l.rule === "cap" ? { maxSetsPerWeek: l.max_sets_per_week } : {}),
    });
  }
  return { rules, skipped, localOnly, unresolved: [...unresolved] };
}
