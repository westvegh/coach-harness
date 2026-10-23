// The athlete's limits in plain words (contracts §2): athlete/limits.md, written by the coach in
// the athlete's words. Code never reads a limit's meaning. This module only carries the text to
// the coach: the session-context hook and `today-brief --stage pre` include the text after the
// heading, cut at LIMITS_TEXT_MAX characters (then the coach Reads the file in full).
//
// Until the 0.3.0 migration runs (`node engine/cli.ts migrate-limits`), an old athlete/limits.yaml
// is carried too, rendered by the migration's converter, and its pain_threshold is read as a
// legacy fallback (painThreshold). Both are the migration exception: nothing else reads the yaml.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { CoachConfig } from "./types.ts";

export const LIMITS_FILE = "athlete/limits.md";
export const LEGACY_LIMITS_FILE = "athlete/limits.yaml";
export const LIMITS_TEXT_MAX = 2000;
export const DEFAULT_PAIN_THRESHOLD = 4;
/** The template's line under the heading: the same for every athlete, so it is not carried. */
export const LIMITS_INTRO = 'The coach plans around each line below in every plan. Say "change my limits" to change one.';
/** The migration marker (an HTML comment): the source file's SHA-256 and the old limit ids. */
export const MARKER_RE = /<!-- coach: converted from athlete\/limits\.yaml sha256:([0-9a-f]{64})\b[^>]*-->/;

export type LegacyCarry = {
  file: string;
  /** What the coach runs in a live session. */
  migrate: string;
  /** False: the old file cannot be converted; its raw text is carried with `error`. */
  ok: boolean;
  error?: string;
};

export type LimitsCarry = {
  file: string;
  exists: boolean;
  /** The text to follow: athlete/limits.md after its heading, then the old file's limits when not converted yet. */
  text: string;
  truncated: boolean;
  /** The length of the whole text before the cut. */
  chars: number;
  /** Every file the text comes from (W3b): when it is cut, Read each of them in full. */
  sources: string[];
  /** SHA-256 of the sources' bytes (W3b): post and save compare it with what pre carried. */
  fingerprint: string;
  legacy?: LegacyCarry;
};

export const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** The file's text after its first heading, without HTML comments (the migration marker) and the template's intro line. */
export function limitsBody(md: string): string {
  const noComments = md.replace(/<!--[\s\S]*?-->/g, "");
  const lines = noComments.split("\n");
  const h = lines.findIndex((l) => /^#\s/.test(l));
  const rest = (h >= 0 ? lines.slice(h + 1) : lines).filter((l) => l.trim() !== LIMITS_INTRO);
  return rest
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The first `max` characters (code points), and whether it cut. */
export function cut(text: string, max = LIMITS_TEXT_MAX): { text: string; truncated: boolean; chars: number } {
  const cps = Array.from(text);
  return cps.length <= max ? { text, truncated: false, chars: cps.length } : { text: cps.slice(0, max).join(""), truncated: true, chars: cps.length };
}

/**
 * The limits text for the coach. With an old athlete/limits.yaml still in place, its limits are
 * added as the migration would write them (unless limits.md already holds that conversion), or
 * its raw text with an error when it cannot be converted. Never "None yet" for a file it cannot read.
 */
export async function limitsCarry(root: string): Promise<LimitsCarry> {
  const mdPath = join(root, LIMITS_FILE);
  const exists = existsSync(mdPath);
  const md = exists ? readFileSync(mdPath, "utf8") : "";
  const parts: string[] = exists ? [limitsBody(md)] : [];
  const sources: string[] = exists ? [LIMITS_FILE] : [];
  let legacy: LegacyCarry | undefined;
  const yamlPath = join(root, LEGACY_LIMITS_FILE);
  const yamlBytes = existsSync(yamlPath) ? readFileSync(yamlPath) : null;
  if (yamlBytes) {
    legacy = { file: LEGACY_LIMITS_FILE, migrate: "node engine/cli.ts migrate-limits", ok: true };
    const [{ parseOldLimits, renderBullets, holdsConversion }, { loadTaxonomy }] = await Promise.all([import("./migrate-limits.ts"), import("./taxonomy.ts")]);
    try {
      const old = parseOldLimits(yamlBytes.toString("utf8"));
      const tax = loadTaxonomy({ root });
      // W3b: the old limits are left out only when limits.md holds exactly their converted bullets, never on the marker alone.
      if (!(exists && holdsConversion(md, old, sha256(yamlBytes), tax))) {
        parts.push(`From your old limits file (not converted yet):\n${renderBullets(old, tax)}`);
        sources.push(LEGACY_LIMITS_FILE);
      }
    } catch (e) {
      legacy = { ...legacy, ok: false, error: (e as Error).message.replace(/\s*\n\s*/g, " ").trim() };
      parts.push(`Your old limits file (athlete/limits.yaml) as written:\n${yamlBytes.toString("utf8").trim()}`);
      sources.push(LEGACY_LIMITS_FILE);
    }
  }
  const c = cut(parts.filter((p) => p !== "").join("\n\n"));
  const fingerprint = sha256(Buffer.concat([Buffer.from(exists ? md : "\0missing\0"), Buffer.from("\0"), yamlBytes ?? Buffer.from("\0none\0")]));
  return { file: LIMITS_FILE, exists, ...c, sources, fingerprint, ...(legacy ? { legacy } : {}) };
}

/** The fingerprint of the limits sources now (the same as limitsCarry's, without rendering). */
export function limitsFingerprint(root: string): string {
  const mdPath = join(root, LIMITS_FILE);
  const yamlPath = join(root, LEGACY_LIMITS_FILE);
  const md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "\0missing\0";
  const yamlBytes = existsSync(yamlPath) ? readFileSync(yamlPath) : Buffer.from("\0none\0");
  return sha256(Buffer.concat([Buffer.from(md), Buffer.from("\0"), yamlBytes]));
}

export type PainThreshold = { value: number; source: "coach.yaml" | "athlete/limits.yaml" | "default" };

/**
 * The check-in pain threshold: coach.yaml thresholds.pain_threshold, else (until the migration
 * runs) the old athlete/limits.yaml pain_threshold when it is a number from 0 to 10, else 4.
 */
export function painThreshold(root: string, cfg: Pick<CoachConfig, "thresholds"> | null): PainThreshold {
  const own = cfg?.thresholds?.pain_threshold;
  if (typeof own === "number") return { value: own, source: "coach.yaml" };
  const yamlPath = join(root, LEGACY_LIMITS_FILE);
  if (existsSync(yamlPath)) {
    // W3b: real YAML (flow style, 3e0, comments); the same 0 to 10 range the old validator checked.
    let v: unknown;
    try {
      const raw = parse(readFileSync(yamlPath, "utf8"));
      v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).pain_threshold : undefined;
    } catch {
      v = undefined;
    }
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10) return { value: v, source: LEGACY_LIMITS_FILE };
  }
  return { value: DEFAULT_PAIN_THRESHOLD, source: "default" };
}
