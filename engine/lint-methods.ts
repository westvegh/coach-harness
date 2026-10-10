// Method pack lint (contracts §4).
//
//   node engine/lint-methods.ts <packDir> [--taxonomy <movements.yaml>] [--json] [--volume]
//
// Errors exit 1. Warnings print but do not fail. Checks:
// - every rule ID cited in the pack's prose exists in rules.yaml, and every
//   rule is cited in principles/*.md;
// - every sourced rule has a source with a key from sources.md and a timestamp;
// - every check type is one the engine implements;
// - for each template and each emphasis, weekly hard sets per muscle fall
//   inside every weekly_sets_per_muscle_range. Out of range is an error for
//   the emphases in VOLUME_ERROR_EMPHASES and a warning for the others.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  CHECK_TYPES,
  EMPHASES,
  MethodError,
  loadRules,
  loadTemplates,
  rulesByCheck,
  scaledSets,
} from "./methods.ts";
import type { Adaptation, Emphasis, RangeCheck, Rules, Template } from "./methods.ts";

export type LintResult = { errors: string[]; warnings: string[]; volume: VolumeRow[] };
export type VolumeRow = { template: string; emphasis: Emphasis; sets: Record<string, number> };
export type PatternMuscles = Record<string, { muscles: string[]; recovery?: boolean }>;

// Slots of these adaptations count as hard sets toward weekly volume per
// muscle. Power, speed and skill sets stop far from failure, and conditioning
// slots count rounds, not sets, so they are left out.
const VOLUME_ADAPTATIONS: readonly Adaptation[] = ["strength", "hypertrophy", "muscular_endurance"];

// The 10-20 sets range is a hypertrophy rule (NA-HYP-001), so only the
// hypertrophy emphasis must meet it. Other emphases get warnings.
export const VOLUME_ERROR_EMPHASES: readonly Emphasis[] = ["hypertrophy"];

// Used for any pattern that the taxonomy does not define (or when no taxonomy
// file exists yet). engine/movements.yaml wins when it defines the pattern.
export const FALLBACK_PATTERNS: PatternMuscles = {
  squat: { muscles: ["quads", "glutes"] },
  hinge: { muscles: ["hamstrings", "glutes"] },
  lunge: { muscles: ["quads", "glutes"] },
  horizontal_push: { muscles: ["chest", "triceps"] },
  vertical_push: { muscles: ["shoulders", "triceps"] },
  horizontal_pull: { muscles: ["back", "biceps"] },
  vertical_pull: { muscles: ["back", "biceps"] },
  carry: { muscles: ["core"] },
  rotation: { muscles: ["core"] },
  knee_flexion: { muscles: ["hamstrings"] },
  knee_extension: { muscles: ["quads"] },
  elbow_flexion: { muscles: ["biceps"] },
  elbow_extension: { muscles: ["triceps"] },
  lateral_raise: { muscles: ["shoulders"] },
  overhead_press: { muscles: ["shoulders", "triceps"] },
  rear_delt: { muscles: ["shoulders", "upper-back"] },
  shrug: { muscles: ["traps"] },
  plyometric: { muscles: [] },
  sprint: { muscles: [] },
  zone2_cardio: { muscles: [], recovery: true },
  intervals: { muscles: [] },
  mobility: { muscles: [], recovery: true },
  breathing: { muscles: [], recovery: true },
};

const RULE_REF = /\[(NA-[A-Z]+-\d{3})\]/g;

function mdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...mdFiles(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

// Source keys from the first column of the markdown table in sources.md.
export function sourceKeys(sourcesMd: string): Set<string> {
  const keys = new Set<string>();
  for (const line of sourcesMd.split("\n")) {
    const m = /^\|\s*([A-Za-z][A-Za-z0-9_-]*)\s*\|/.exec(line);
    if (m && m[1].toLowerCase() !== "key") keys.add(m[1]);
  }
  return keys;
}

export function loadPatternMuscles(taxonomyPath?: string): { patterns: PatternMuscles; from: string } {
  const path = taxonomyPath ?? fileURLToPath(new URL("./movements.yaml", import.meta.url));
  const merged: PatternMuscles = { ...FALLBACK_PATTERNS };
  if (!existsSync(path)) return { patterns: merged, from: "fallback" };
  const raw = parse(readFileSync(path, "utf8")) as { patterns?: Record<string, { muscles?: string[]; recovery?: boolean }> };
  for (const [id, p] of Object.entries(raw?.patterns ?? {})) {
    merged[id] = { muscles: p?.muscles ?? [], ...(p?.recovery ? { recovery: true } : {}) };
  }
  return { patterns: merged, from: path };
}

export function weeklySetsPerMuscle(
  template: Template,
  emphasis: Emphasis,
  patterns: PatternMuscles,
): { sets: Record<string, number>; unknown: string[] } {
  const sets: Record<string, number> = {};
  const unknown: string[] = [];
  for (const day of template.week) {
    for (const slot of day.slots) {
      const p = patterns[slot.pattern];
      if (!p) {
        unknown.push(slot.pattern);
        continue;
      }
      if (p.recovery || !VOLUME_ADAPTATIONS.includes(slot.adaptation)) continue;
      const n = scaledSets(slot, template, emphasis);
      for (const m of p.muscles) sets[m] = (sets[m] ?? 0) + n;
    }
  }
  return { sets, unknown };
}

function countBounds(c: number | [number, number]): [number, number] {
  return typeof c === "number" ? [c, c] : c;
}

export function lintPack(packDir: string, opts: { taxonomyPath?: string } = {}): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const volume: VolumeRow[] = [];

  let rules: Rules;
  try {
    rules = loadRules(packDir);
  } catch (e) {
    return { errors: [(e as Error).message], warnings, volume };
  }
  const ids = new Set(rules.rules.map((r) => r.id));

  // 1. Prose IDs ↔ rules.yaml.
  const principlesDir = join(packDir, "principles");
  const principleFiles = mdFiles(principlesDir);
  if (principleFiles.length === 0) errors.push("principles/: no prose files found");
  const citedInPrinciples = new Set<string>();
  for (const file of mdFiles(packDir)) {
    const text = readFileSync(file, "utf8");
    const rel = relative(packDir, file);
    for (const m of text.matchAll(RULE_REF)) {
      if (!ids.has(m[1])) errors.push(`${rel}: cites ${m[1]}, which is not in rules.yaml`);
      if (file.startsWith(principlesDir)) citedInPrinciples.add(m[1]);
    }
  }
  for (const id of ids) {
    if (!citedInPrinciples.has(id)) errors.push(`rules.yaml: ${id} is not cited in principles/*.md`);
  }

  // 2. Sources.
  const sourcesPath = join(packDir, "sources.md");
  const keys = existsSync(sourcesPath) ? sourceKeys(readFileSync(sourcesPath, "utf8")) : new Set<string>();
  if (!existsSync(sourcesPath)) errors.push("sources.md is missing");
  for (const r of rules.rules) {
    if (r.kind === "sourced" && !r.source) {
      errors.push(`${r.id}: kind is sourced but it has no source`);
      continue;
    }
    if (r.source && !keys.has(r.source.ref)) errors.push(`${r.id}: source ${r.source.ref} is not a key in sources.md`);
  }

  // 3. Check types.
  for (const r of rules.rules) {
    if (r.check && !(CHECK_TYPES as readonly string[]).includes(r.check.type)) {
      errors.push(`${r.id}: unknown check type ${r.check.type}`);
    }
  }

  // 4. Templates.
  let templates: Record<string, Template> = {};
  try {
    templates = loadTemplates(packDir);
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (Object.keys(templates).length === 0) errors.push("templates/: no templates found");
  const { patterns } = loadPatternMuscles(opts.taxonomyPath);
  const ranges = rulesByCheck(rules, "weekly_sets_per_muscle_range");
  const repRanges = rulesByCheck(rules, "rep_range");
  const restRanges = rulesByCheck(rules, "rest_range_s");

  for (const [name, t] of Object.entries(templates)) {
    const unknownPatterns = new Set<string>();
    for (const emphasis of EMPHASES) {
      const { sets, unknown } = weeklySetsPerMuscle(t, emphasis, patterns);
      unknown.forEach((p) => unknownPatterns.add(p));
      volume.push({ template: name, emphasis, sets });
      for (const r of ranges) {
        const [min, max] = r.check!.value as [number, number];
        for (const [muscle, n] of Object.entries(sets).sort()) {
          if (n >= min && n <= max) continue;
          const msg = `templates/${name}.yaml [${emphasis}]: ${muscle} gets ${n} sets a week, outside ${r.id} [${min}, ${max}]`;
          (VOLUME_ERROR_EMPHASES.includes(emphasis) ? errors : warnings).push(msg);
        }
      }
    }
    for (const p of unknownPatterns) errors.push(`templates/${name}.yaml: unknown pattern ${p}`);

    // Soft: slot reps and rest against the pack's ranges (warnings only).
    for (const day of t.week) {
      for (const slot of day.slots) {
        const where = `templates/${name}.yaml day ${day.day} ${slot.pattern}`;
        for (const r of repRanges) {
          const v = r.check!.value as RangeCheck;
          if (v.adaptation !== slot.adaptation || slot.reps === undefined) continue;
          const [lo, hi] = countBounds(slot.reps);
          if (lo < v.min || hi > v.max) warnings.push(`${where}: reps ${lo}-${hi} outside ${r.id} [${v.min}, ${v.max}]`);
        }
        for (const r of restRanges) {
          const v = r.check!.value as RangeCheck;
          if (v.adaptation !== slot.adaptation) continue;
          if (slot.rest_s < v.min || slot.rest_s > v.max) {
            warnings.push(`${where}: rest ${slot.rest_s}s outside ${r.id} [${v.min}, ${v.max}]`);
          }
        }
      }
    }
  }

  return { errors, warnings, volume };
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const showVolume = args.includes("--volume");
  const ti = args.indexOf("--taxonomy");
  const taxonomyPath = ti >= 0 ? args[ti + 1] : undefined;
  const packDir = args.find((a, i) => !a.startsWith("--") && (ti < 0 || i !== ti + 1));
  if (!packDir) {
    console.error("usage: node engine/lint-methods.ts <packDir> [--taxonomy <movements.yaml>] [--json] [--volume]");
    return 2;
  }
  let res: LintResult;
  try {
    res = lintPack(packDir, { taxonomyPath });
  } catch (e) {
    const code = e instanceof MethodError ? e.code : "LINT_ERROR";
    console.error(`${code}: ${(e as Error).message}`);
    return 2;
  }
  if (json) {
    console.log(JSON.stringify({ ok: res.errors.length === 0, ...res, volume: showVolume ? res.volume : undefined }, null, 2));
  } else {
    for (const e of res.errors) console.log(`error: ${e}`);
    for (const w of res.warnings) console.log(`warning: ${w}`);
    if (showVolume) {
      for (const row of res.volume) {
        const cells = Object.entries(row.sets).sort().map(([m, n]) => `${m} ${n}`).join(", ");
        console.log(`volume: ${row.template} [${row.emphasis}]: ${cells}`);
      }
    }
    console.log(`${res.errors.length} errors, ${res.warnings.length} warnings`);
  }
  return res.errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv);
}
