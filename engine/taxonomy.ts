// Movement taxonomy: load, merge the athlete's local file, classify (contracts §3).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CoachError } from "./errors.ts";
import { isPlainObject, readYamlFile } from "./yaml-file.ts";
import type { Classification, ExerciseRef, MovementPattern, Taxonomy } from "./types.ts";

export const BASE_TAXONOMY_PATH = join(import.meta.dirname, "movements.yaml");
export const LOCAL_TAXONOMY_RELATIVE = "athlete/movements.local.yaml";

/** Lowercase, every non-alphanumeric run becomes one space. "Push-Up (DB)" → "push up db". */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type RawTaxonomy = {
  regions: string[];
  patterns: Record<string, MovementPattern>;
  keywords: Record<string, string[]>;
  exercises: Record<string, string[]>;
};

function parseShape(raw: unknown, where: string, partial: boolean): RawTaxonomy {
  const errors: string[] = [];
  const out: RawTaxonomy = { regions: [], patterns: {}, keywords: {}, exercises: {} };
  if (!isPlainObject(raw)) throw new CoachError("TAXONOMY_INVALID", `${where} is invalid: must be a mapping`);
  for (const k of Object.keys(raw)) {
    if (!["version", "regions", "patterns", "keywords", "exercises"].includes(k)) errors.push(`${k}: unknown key`);
  }
  if (raw.version !== 1) errors.push(`version: must be 1, got ${JSON.stringify(raw.version)}`);
  for (const k of ["regions", "patterns", "keywords", "exercises"]) {
    if (!partial && !(k in raw)) errors.push(`${k}: is required`);
  }

  if (raw.regions !== undefined) {
    if (!Array.isArray(raw.regions) || raw.regions.some((r) => typeof r !== "string" || !/^[a-z][a-z-]*$/.test(r))) {
      errors.push("regions: must be a list of lowercase region ids");
    } else out.regions = raw.regions as string[];
  }

  if (raw.patterns !== undefined) {
    if (!isPlainObject(raw.patterns)) errors.push("patterns: must be a mapping");
    else {
      for (const [name, p] of Object.entries(raw.patterns)) {
        const path = `patterns.${name}`;
        if (!/^[a-z0-9_]+$/.test(name)) errors.push(`${path}: pattern names are lowercase snake_case`);
        if (!isPlainObject(p)) {
          errors.push(`${path}: must be a mapping`);
          continue;
        }
        for (const k of Object.keys(p)) if (!["loads", "muscles", "recovery"].includes(k)) errors.push(`${path}.${k}: unknown key`);
        const loads = p.loads;
        const muscles = p.muscles ?? [];
        const recovery = p.recovery ?? false;
        if (!Array.isArray(loads) || loads.some((x) => typeof x !== "string")) errors.push(`${path}.loads: must be a list of regions`);
        if (!Array.isArray(muscles) || muscles.some((x) => typeof x !== "string")) errors.push(`${path}.muscles: must be a list`);
        if (typeof recovery !== "boolean") errors.push(`${path}.recovery: must be true or false`);
        out.patterns[name] = {
          loads: Array.isArray(loads) ? (loads as string[]) : [],
          muscles: Array.isArray(muscles) ? (muscles as string[]).map((m) => normalizeName(m).replace(/ /g, "-")) : [],
          recovery: recovery === true,
        };
      }
    }
  }

  for (const section of ["keywords", "exercises"] as const) {
    const v = raw[section];
    if (v === undefined) continue;
    if (!isPlainObject(v)) {
      errors.push(`${section}: must be a mapping`);
      continue;
    }
    for (const [key, pats] of Object.entries(v)) {
      const path = `${section}.${JSON.stringify(key)}`;
      const norm = normalizeName(key);
      if (norm === "") errors.push(`${path}: empty after normalization`);
      if (section === "keywords" && norm !== key) errors.push(`${path}: keywords must be lowercase words separated by one space (use ${JSON.stringify(norm)})`);
      if (!Array.isArray(pats) || pats.length === 0 || pats.some((x) => typeof x !== "string")) {
        errors.push(`${path}: must be a non-empty list of patterns`);
        continue;
      }
      if (norm in out[section]) errors.push(`${path}: duplicates another entry after normalization (${JSON.stringify(norm)})`);
      out[section][norm] = pats as string[];
    }
  }

  if (errors.length > 0) throw new CoachError("TAXONOMY_INVALID", `${where} is invalid:\n  - ${errors.join("\n  - ")}`);
  return out;
}

/** Cross-checks a merged taxonomy: every reference must resolve. */
export function checkTaxonomy(tax: Taxonomy, where = "taxonomy"): Taxonomy {
  const errors: string[] = [];
  const regions = new Set(tax.regions);
  if (regions.size !== tax.regions.length) errors.push("regions: duplicate region");
  for (const r of tax.regions) {
    const side = /^(left|right)-(.+)$/.exec(r);
    if (side && !regions.has(side[2])) errors.push(`regions: side region ${r} needs its parent ${side[2]}`);
  }
  for (const [name, p] of Object.entries(tax.patterns)) {
    for (const r of p.loads) if (!regions.has(r)) errors.push(`patterns.${name}.loads: unknown region ${r}`);
    if (p.recovery && p.loads.length > 0) errors.push(`patterns.${name}: a recovery pattern cannot load a region`);
  }
  for (const section of ["keywords", "exercises"] as const) {
    for (const [key, pats] of Object.entries(tax[section])) {
      for (const p of pats) if (!(p in tax.patterns)) errors.push(`${section}.${JSON.stringify(key)}: unknown pattern ${p}`);
    }
  }
  if (errors.length > 0) throw new CoachError("TAXONOMY_INVALID", `${where} is invalid:\n  - ${errors.join("\n  - ")}`);
  return tax;
}

/** The local file wins per entry; regions are the union. */
export function mergeTaxonomy(base: RawTaxonomy, local: RawTaxonomy): RawTaxonomy {
  return {
    regions: [...base.regions, ...local.regions.filter((r) => !base.regions.includes(r))],
    patterns: { ...base.patterns, ...local.patterns },
    keywords: { ...base.keywords, ...local.keywords },
    exercises: { ...base.exercises, ...local.exercises },
  };
}

export type LoadTaxonomyOptions = {
  /** Repo root; the local file is <root>/athlete/movements.local.yaml. Default: cwd. */
  root?: string;
  basePath?: string;
  /** Explicit local file path, or null to skip the local file. */
  localPath?: string | null;
};

export function loadTaxonomy(opts: LoadTaxonomyOptions = {}): Taxonomy {
  const basePath = opts.basePath ?? BASE_TAXONOMY_PATH;
  let merged = parseShape(readYamlFile(basePath, "TAXONOMY_INVALID"), basePath, false);
  const localPath = opts.localPath === undefined ? join(opts.root ?? process.cwd(), LOCAL_TAXONOMY_RELATIVE) : opts.localPath;
  let where = basePath;
  if (localPath !== null && existsSync(localPath)) {
    const local = parseShape(readYamlFile(localPath, "TAXONOMY_INVALID"), localPath, true);
    merged = mergeTaxonomy(merged, local);
    where = `${basePath} + ${localPath}`;
  }
  return checkTaxonomy({ version: 1, ...merged }, where);
}

/** The parent of a side region (left-knee → knee), or null. */
export function parentRegion(region: string, tax: Taxonomy): string | null {
  const m = /^(left|right)-(.+)$/.exec(region);
  return m && tax.regions.includes(m[2]) ? m[2] : null;
}

/**
 * True when a limit or pain region matches any loaded region. A side region matches its
 * parent in both directions: a pattern that loads `knee` triggers a `left-knee` limit, and
 * a pattern that loads `left-knee` triggers a `knee` limit. Opposite sides never match.
 */
export function regionMatches(region: string, loaded: string[], tax: Taxonomy): boolean {
  const parent = parentRegion(region, tax);
  return loaded.some((r) => r === region || r === parent || parentRegion(r, tax) === region);
}

/** Region ids, and for each pattern the regions it loads (recovery patterns load none): `node engine/cli.ts regions`. */
export function regionsReport(tax: Taxonomy): Record<string, unknown> {
  const patterns: Record<string, { loads: string[]; recovery?: true }> = {};
  for (const [name, p] of Object.entries(tax.patterns)) patterns[name] = { loads: [...p.loads], ...(p.recovery ? { recovery: true as const } : {}) };
  return {
    regions: [...tax.regions],
    side_rule: "a side region (left-knee) also matches its parent (knee), in both directions",
    patterns,
  };
}

type Span = { keyword: string; start: number; end: number };

/** Every place where `keyword` matches whole words of `name` (a plural "s" or "es" is allowed). */
function keywordSpans(name: string, keyword: string): Span[] {
  const spans: Span[] = [];
  for (let i = name.indexOf(keyword); i >= 0; i = name.indexOf(keyword, i + 1)) {
    const startOk = i === 0 || name[i - 1] === " ";
    const plural = /^(es|s)?( |$)/.exec(name.slice(i + keyword.length));
    if (startOk && plural) spans.push({ keyword, start: i, end: i + keyword.length + (plural[1]?.length ?? 0) });
  }
  return spans;
}

const longer = (a: Span, b: Span) => a.keyword.length > b.keyword.length || (a.keyword.length === b.keyword.length && a.keyword < b.keyword);

/**
 * The keyword matches that classify a name. A match inside a longer match is dropped
 * ("squat" inside "back squat"). Of overlapping matches, the longest wins ("reverse
 * nordic" over "nordic curl"). Separate matches all count, so a recovery phrase such as
 * "box breathing" never erases a loaded movement named next to it.
 */
function keywordMatches(name: string, tax: Taxonomy): Span[] {
  const all = Object.keys(tax.keywords).flatMap((kw) => keywordSpans(name, kw));
  const kept = all.filter((m) => !all.some((n) => n !== m && n.start <= m.start && n.end >= m.end && longer(n, m)));
  kept.sort((a, b) => a.start - b.start);
  const chosen: Span[] = [];
  let group: Span[] = [];
  const flush = () => {
    if (group.length > 0) chosen.push(group.reduce((best, m) => (longer(m, best) ? m : best)));
    group = [];
  };
  for (const m of kept) {
    if (group.length > 0 && m.start >= Math.max(...group.map((g) => g.end))) flush();
    group.push(m);
  }
  flush();
  return chosen;
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Tally `muscle` values that name no muscle (normalized): they add no volume. */
const NOT_MUSCLES = ["cardio", "conditioning", "mobility", "stretching", "breathing", "full body", "other", "flexibility", "recovery", "endurance", "none"];

function build(groups: string[][], source: Classification["source"], muscle: string | null | undefined, tax: Taxonomy): Classification {
  const patterns = groups.flat();
  const regions = unique(patterns.flatMap((p) => tax.patterns[p].loads));
  const muscles = unique(patterns.flatMap((p) => tax.patterns[p].muscles));
  // The exercise's own (Tally) muscle counts unless it names no muscle or the exercise is recovery work.
  const own = typeof muscle === "string" ? normalizeName(muscle) : "";
  if (own !== "" && !NOT_MUSCLES.includes(own) && !patterns.some((p) => tax.patterns[p].recovery)) {
    const m = own.replace(/ /g, "-");
    if (!muscles.includes(m)) muscles.push(m);
  }
  return { patterns: unique(patterns), regions, muscles, source, groups };
}

/**
 * Classifies an exercise. An exact exerciseId or name in `exercises` wins. Otherwise the
 * keyword matches of the name (or, when the name has none, the exerciseId) combine; see
 * keywordMatches.
 */
export function classify(ex: ExerciseRef, tax: Taxonomy): Classification {
  const candidates = [ex.exerciseId, ex.name].filter((s): s is string => typeof s === "string" && s.trim() !== "").map(normalizeName);
  for (const c of candidates) {
    const pats = tax.exercises[c];
    if (pats) return build([pats], "exercise", ex.muscle, tax);
  }
  // Name first: it is what the athlete sees. The exerciseId is a fallback.
  for (const c of [...candidates].reverse()) {
    const matches = keywordMatches(c, tax);
    if (matches.length > 0) return build(matches.map((m) => tax.keywords[m.keyword]), "keyword", ex.muscle, tax);
  }
  return build([], "none", ex.muscle, tax);
}

/**
 * The safety classification (P2 fix 3): the exerciseId and the name are classified on their
 * own and their patterns combine, so a new display name ("Squat" on Incline_Bench_Press)
 * cannot hide what the exerciseId loads. "none" only when neither one resolves.
 */
export function classifyForSafety(ex: ExerciseRef, tax: Taxonomy): Classification {
  const parts = [classify({ exerciseId: ex.exerciseId, name: "", muscle: ex.muscle }, tax), classify({ name: ex.name, muscle: ex.muscle }, tax)];
  const known = parts.filter((c) => c.source !== "none");
  if (known.length === 0) return classify(ex, tax);
  const source = known.some((c) => c.source === "exercise") ? "exercise" : "keyword";
  return build(known.flatMap((c) => c.groups ?? [c.patterns]), source, ex.muscle, tax);
}

/** Region ids that the merged taxonomy does not know (P2 fix 2). */
export function unknownRegions(regions: string[], tax: Taxonomy): string[] {
  return regions.filter((r) => !tax.regions.includes(r));
}
