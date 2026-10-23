// The 0.3.0 migration (contracts §2a): an old athlete/limits.yaml becomes athlete/limits.md in
// plain words, field by field, and its pain_threshold moves to coach.yaml thresholds.pain_threshold.
// This module is the only code that reads the old file's structure (with the legacy carry in
// engine/limits-text.ts, which renders through it). It runs in the new version, after the restart:
// the update skill's step 6 runs `node engine/cli.ts migrate-limits`.
//
// - Lossless: each limit becomes one bullet that keeps the region, the rule, the movements, the
//   named exercises, the exceptions and their precedence, the numbers exactly, building back, the
//   source, the date and the note (as an addition). Deterministic: the same yaml gives the same text.
// - States: yaml only → convert; limits.md with this file's marker and the yaml still there (an
//   interrupted run) → finish; limits.md without a marker → its lines stay and the converted ones
//   are added under "From your old limits file"; limits.md only → nothing to do.
// - Safety: a malformed yaml stops with an error and is kept. Any uncommitted change in athlete/ or
//   coach.yaml other than its own refuses. The yaml's bytes go to .tmp/coach/migrate-limits/
//   first (kept). One commit: limits.md, coach.yaml and `git rm athlete/limits.yaml`; when a step
//   fails, everything goes back to HEAD (the yaml from HEAD).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, parseDocument } from "yaml";
import { CoachError } from "./errors.ts";
import { isCalendarDate } from "./dates.ts";
import { LEGACY_LIMITS_FILE, LIMITS_FILE, LIMITS_INTRO, limitsBody, MARKER_RE, sha256 } from "./limits-text.ts";
import { unattendedMarker } from "./mode.ts";
import { isPlainObject } from "./yaml-file.ts";
import { loadTaxonomy } from "./taxonomy.ts";
import type { Taxonomy } from "./types.ts";

export const BACKUP_FILE = ".tmp/coach/migrate-limits/limits.yaml";
export const COMMIT_MESSAGE = "limits: in plain words (0.3.0 migration)";
export const OLD_SECTION = "## From your old limits file";

// ---------- the old file (0.2.x contracts §2) ----------

export type OldLimit = {
  id: string;
  region: string;
  rule: "ban" | "cap";
  patterns: string[];
  exercises: string[];
  allow: string[];
  max_load?: { value: number; unit: "lbs" | "kg" };
  max_sets_per_week?: number;
  build_back?: boolean;
  note?: string;
  source: "athlete" | "clinician-reported";
  since: string;
};
export type OldLimits = { version: 1; pain_threshold: number; limits: OldLimit[] };

const LIMIT_KEYS = ["id", "region", "rule", "patterns", "exercises", "allow", "max_load", "max_sets_per_week", "build_back", "note", "source", "since"];
const REQUIRED = ["id", "region", "rule", "source", "since"];

function stringList(v: unknown, path: string, errors: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim() === "")) {
    errors.push(`${path}: must be a list of non-empty strings`);
    return [];
  }
  return v as string[];
}

/** Parses and checks an old limits.yaml (0.2.x rules). Throws LIMITS_INVALID naming every problem. */
export function parseOldLimits(text: string): OldLimits {
  let raw: unknown;
  try {
    raw = parse(text, { uniqueKeys: true });
  } catch (e) {
    throw new CoachError("LIMITS_INVALID", `athlete/limits.yaml cannot be read: ${(e as Error).message.split("\n")[0]}`);
  }
  const errors: string[] = [];
  if (!isPlainObject(raw)) throw new CoachError("LIMITS_INVALID", "athlete/limits.yaml cannot be read: it must be a mapping");
  for (const k of Object.keys(raw)) if (!["version", "pain_threshold", "limits"].includes(k)) errors.push(`${k}: unknown key`);
  if (raw.version !== 1) errors.push(`version: must be 1, got ${JSON.stringify(raw.version)}`);
  const pt = raw.pain_threshold;
  if (typeof pt !== "number" || !Number.isFinite(pt) || pt < 0 || pt > 10) errors.push(`pain_threshold: must be a number from 0 to 10, got ${JSON.stringify(pt)}`);
  const limits: OldLimit[] = [];
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
      if (typeof l.region !== "string" || l.region.trim() === "") errors.push(`${p}.region: must be a region id`);
      if (l.rule !== "ban" && l.rule !== "cap") errors.push(`${p}.rule: must be ban | cap, got ${JSON.stringify(l.rule)}`);
      const patterns = stringList(l.patterns, `${p}.patterns`, errors);
      const exercises = stringList(l.exercises, `${p}.exercises`, errors);
      const allow = stringList(l.allow, `${p}.allow`, errors);
      if (patterns.length === 0 && exercises.length === 0) errors.push(`${p}: needs patterns or exercises`);
      let max_load: OldLimit["max_load"];
      if (l.max_load !== undefined) {
        const m = l.max_load;
        if (!isPlainObject(m) || typeof m.value !== "number" || !Number.isFinite(m.value) || !(m.value > 0) || (m.unit !== "lbs" && m.unit !== "kg")) {
          errors.push(`${p}.max_load: must be { value: <finite positive number>, unit: lbs | kg }`);
        } else max_load = { value: m.value, unit: m.unit };
      }
      const msw = l.max_sets_per_week;
      if (msw !== undefined && (typeof msw !== "number" || !Number.isInteger(msw) || msw < 0)) errors.push(`${p}.max_sets_per_week: must be a whole number of 0 or more`);
      if (l.rule === "cap" && l.max_load === undefined && msw === undefined) errors.push(`${p}: a cap needs max_load or max_sets_per_week`);
      if (l.rule === "ban" && (l.max_load !== undefined || msw !== undefined)) errors.push(`${p}: a ban cannot carry max_load or max_sets_per_week`);
      if (l.build_back !== undefined && typeof l.build_back !== "boolean") errors.push(`${p}.build_back: must be true or false`);
      if (l.build_back === true && l.rule !== "cap") errors.push(`${p}.build_back: only a cap can build back`);
      if (l.note !== undefined && typeof l.note !== "string") errors.push(`${p}.note: must be a string`);
      if (l.source !== "athlete" && l.source !== "clinician-reported") errors.push(`${p}.source: must be athlete | clinician-reported, got ${JSON.stringify(l.source)}`);
      if (!isCalendarDate(l.since)) errors.push(`${p}.since: must be a date YYYY-MM-DD, got ${JSON.stringify(l.since)}`);
      limits.push({
        id: id as string,
        region: l.region as string,
        rule: l.rule as OldLimit["rule"],
        patterns,
        exercises,
        allow,
        ...(max_load ? { max_load } : {}),
        ...(typeof msw === "number" ? { max_sets_per_week: msw } : {}),
        ...(l.build_back === true ? { build_back: true } : {}),
        ...(typeof l.note === "string" && l.note.trim() !== "" ? { note: l.note.trim() } : {}),
        source: l.source as OldLimit["source"],
        since: l.since as string,
      });
    });
  }
  if (errors.length > 0) throw new CoachError("LIMITS_INVALID", `athlete/limits.yaml cannot be converted:\n  - ${errors.join("\n  - ")}`);
  return { version: 1, pain_threshold: pt as number, limits };
}

// ---------- the converter ----------

/**
 * Each movement pattern of engine/movements.yaml as a short plain name. The converted line adds,
 * after the name, every taxonomy member of the pattern (its keywords and named exercises), so the
 * words keep the pattern's whole scope (W3b: a ban on jumps also covers medicine ball slams).
 */
export const PLAIN_MOVEMENTS: Record<string, string> = {
  squat: "squats",
  loaded_deep_knee_flexion: "deep knee bends under load",
  lunge: "lunges",
  step_up: "step-ups",
  leg_press: "leg presses",
  knee_extension: "knee extensions",
  knee_flexion: "knee curls",
  hinge: "hinges",
  hinge_isometric: "bent-over holds",
  hip_thrust: "hip thrusts",
  back_extension: "back extensions",
  hip_abduction: "hip abduction work",
  hip_adduction: "hip adduction work",
  calf_raise: "calf raises",
  ankle_dorsiflexion: "ankle raises",
  sled: "sled work",
  horizontal_push: "flat pressing",
  incline_push: "incline pressing",
  vertical_push: "dips",
  overhead_press: "overhead pressing",
  chest_fly: "chest flyes",
  horizontal_pull: "rows",
  vertical_pull: "vertical pulls",
  lateral_raise: "lateral raises",
  rear_delt: "rear delt work",
  shoulder_rotation: "shoulder rotation work",
  shrug: "shrugs",
  neck_work: "neck work",
  elbow_flexion: "curls",
  elbow_extension: "triceps extensions",
  wrist_forearm: "wrist and forearm work",
  loaded_spinal_flexion: "loaded trunk flexion",
  core_anti_extension: "anti-extension core work",
  core_anti_rotation: "anti-rotation core work",
  core_lateral: "side core work",
  rotation: "rotational core work",
  carry: "loaded carries",
  olympic_lift: "Olympic lifts",
  plyometric: "jumps and throws",
  sprint: "sprints",
  impact_running: "running",
  rowing_erg: "the rowing machine",
  balance: "balance work",
  loaded_walk: "loaded walks",
  intervals: "intervals",
  zone2_cardio: "easy cardio",
  mobility: "mobility work",
  breathing: "breathing work",
};

/** Every taxonomy member of a pattern: the keywords and the named exercises that map to it, sorted. */
export function patternMembers(p: string, tax: Taxonomy): string[] {
  const kw = Object.entries(tax.keywords).filter(([, ps]) => ps.includes(p)).map(([k]) => k);
  const ex = Object.entries(tax.exercises).filter(([, ps]) => ps.includes(p)).map(([k]) => k);
  return [...new Set([...kw, ...ex])].sort();
}

const headWords = (p: string) => PLAIN_MOVEMENTS[p] ?? p.replace(/_/g, " ");
/** A pattern in words with its whole scope: "jumps and throws (any exercise like these: box jump, …, medicine ball slam, …)". */
export function movementWords(p: string, tax: Taxonomy): string {
  const m = patternMembers(p, tax);
  return m.length ? `${headWords(p)} (any exercise like these: ${m.join(", ")})` : headWords(p);
}
/** "left-shoulder" → "Left shoulder". */
export const regionWords = (r: string) => {
  const w = r.replace(/-/g, " ").trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
};
/** "a", "a and b", "a, b and c". */
function list(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
/** Movements with their member lists (which hold commas): "a; b; and c". */
function movementList(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join("; ")}; and ${xs[xs.length - 1]}`;
}
/** An exerciseId as written in the old file (no spaces, an underscore) is marked as one. */
const exerciseWords = (x: string) => (/^[^\s]+_[^\s]*$/.test(x) ? `${x} (exercise id)` : x);
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
const fmt = (n: number) => String(n);

/** One limit as one plain-words bullet. Every field of the old entry is in it. */
export function renderLimit(l: OldLimit, tax: Taxonomy): string {
  const region = regionWords(l.region);
  const moves = l.patterns.map((p) => movementWords(p, tax));
  const heads = l.patterns.map(headWords);
  const named = l.exercises.map(exerciseWords);
  const parts: string[] = [];
  if (l.rule === "ban") {
    if (moves.length > 0) {
      parts.push(`${region}: avoid for now: ${movementList(moves)}.`);
      if (named.length > 0) parts.push(`Also avoid these exercises: ${list(named)}.`);
    } else parts.push(`${region}: avoid these exercises for now: ${list(named)}.`);
  } else {
    const covered = moves.length > 0 ? `${movementList(moves)}${named.length > 0 ? `; and these exercises: ${list(named)}` : ""}` : `these exercises: ${list(named)}`;
    if (typeof l.max_sets_per_week === "number") {
      parts.push(`${region}: at most ${fmt(l.max_sets_per_week)} sets a week of ${covered}, counted together (warm-up sets do not count).`);
      if (l.max_load) parts.push(`Every set of these at most ${fmt(l.max_load.value)} ${l.max_load.unit}, warm-ups included.`);
    } else if (l.max_load) parts.push(`${region}: at most ${fmt(l.max_load.value)} ${l.max_load.unit} on every set of ${covered}, warm-ups included.`);
  }
  if (l.build_back) parts.push("Building back slowly.");
  if (l.allow.length > 0) {
    parts.push(`These exact exercises do not count: ${list(l.allow.map(exerciseWords))}.`);
    // W3b: the explicit exercises always win, also when this list names one by another name or its id.
    if (l.exercises.length > 0) parts.push(`An exercise this limit names (${list(named)}) still counts, even when this list also names it, by the same name, another name or its exercise id.`);
    if (moves.length > 0) parts.push(`Only these exact exercises: another exercise with the same name that loads ${list(heads)} still counts.`);
  }
  if (l.note) parts.push(`Note: ${sentence(l.note)}`);
  parts.push(`(since ${l.since}; ${l.source === "clinician-reported" ? "from your clinician" : "you set it"})`);
  return `- ${parts.join(" ")}`;
}

/** The bullets of every limit, or "None yet." for an empty list. */
export function renderBullets(old: OldLimits, tax: Taxonomy): string {
  return old.limits.length === 0 ? "None yet." : old.limits.map((l) => renderLimit(l, tax)).join("\n");
}

export function marker(hash: string, old: OldLimits): string {
  const ids = old.limits.map((l) => l.id);
  return `<!-- coach: converted from athlete/limits.yaml sha256:${hash}${ids.length ? ` (old ids ${ids.join(", ")})` : ""} -->`;
}

/**
 * The limits.md the migration writes: a new file, or the athlete's own file (HEAD) with the
 * converted lines added under OLD_SECTION. An empty old list adds nothing to an existing file.
 */
export function expectedLimitsMd(base: string | null, old: OldLimits, hash: string, tax: Taxonomy): string {
  if (base === null) return `# Injuries and limits\n\n${LIMITS_INTRO}\n\n${marker(hash, old)}\n${renderBullets(old, tax)}\n`;
  if (old.limits.length === 0) return base;
  return `${base.replace(/\s+$/, "")}\n\n${OLD_SECTION}\n\n${marker(hash, old)}\n${renderBullets(old, tax)}\n`;
}

/**
 * True only when `md` holds this yaml's conversion: the marker for its hash directly followed by
 * exactly the converted bullets (W3b: a marker alone never hides or deletes the old limits). An
 * empty old list has nothing to hold.
 */
export function holdsConversion(md: string | null, old: OldLimits, hash: string, tax: Taxonomy): boolean {
  if (old.limits.length === 0) return true;
  if (md === null) return false;
  const bullets = renderBullets(old, tax);
  // W3b confirmation 1: the bullets must be where the coach reads them: after the first heading,
  // and in the text the carriers give (limitsBody), never only above the heading.
  const h = md.search(/^#\s/m);
  const afterHeading = h >= 0 ? md.slice(h) : md;
  return afterHeading.includes(`${marker(hash, old)}\n${bullets}\n`) && limitsBody(md).includes(bullets.trim());
}

// ---------- coach.yaml ----------

/**
 * coach.yaml with thresholds.pain_threshold set to the old value, unless it already has one (kept).
 * A small text edit keeps the athlete's layout and comments; the result must parse to the same
 * config plus that one key, else the yaml library writes it.
 */
export function expectedConfig(text: string, old: number): { text: string; kept: number | null } {
  const doc = parseDocument(text);
  const cur = doc.getIn(["thresholds", "pain_threshold"]);
  if (typeof cur === "number") return { text, kept: cur };
  const before = parse(text) as Record<string, unknown>;
  const want = { ...before, thresholds: { ...((before.thresholds as object | null) ?? {}), pain_threshold: old } };
  const same = (t: string) => {
    try {
      return sameKeys(parse(t), want);
    } catch {
      return false;
    }
  };
  const line = `pain_threshold: ${old}`;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^thresholds:/.test(l));
  let edited: string | null = null;
  if (at < 0) edited = `${text.replace(/\n*$/, "\n")}thresholds:\n  ${line}\n`;
  else if (/^thresholds:\s*\{\s*\}\s*(#.*)?$/.test(lines[at])) {
    const comment = /(\s+#.*)$/.exec(lines[at])?.[1] ?? "";
    edited = [...lines.slice(0, at), `thresholds:${comment}`, `  ${line}`, ...lines.slice(at + 1)].join("\n");
  } else if (/^thresholds:\s*(#.*)?$/.test(lines[at])) {
    const child = lines.slice(at + 1).find((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    const indent = child && /^\s+/.test(child) ? /^\s+/.exec(child)![0] : "  ";
    edited = [...lines.slice(0, at + 1), `${indent}${line}`, ...lines.slice(at + 1)].join("\n");
  }
  if (edited !== null && same(edited)) return { text: edited, kept: null };
  doc.setIn(["thresholds", "pain_threshold"], old);
  return { text: String(doc), kept: null };
}

/** The same config: equal keys and values (order aside). */
function sameKeys(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameKeys((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// ---------- git and files ----------

function gitIn(root: string) {
  return (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function headFile(root: string, rel: string): string | null {
  try {
    return execFileSync("git", ["show", `HEAD:${rel}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Temp file and rename. A failed write or rename removes the temp file (W3b), so a retry finds no stray file. */
function writeAtomic(path: string, text: string | Buffer, failRename = false): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text);
    if (failRename) throw new CoachError("MIGRATE_TEST_FAILURE", `test failure at the rename of ${path}`);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Uncommitted entries under athlete/ and coach.yaml: [status, path]. */
function dirty(root: string): [string, string][] {
  const out = gitIn(root)(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "athlete", "coach.yaml"]);
  const parts = out.split("\0").filter(Boolean);
  const res: [string, string][] = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i].slice(0, 2);
    res.push([st, parts[i].slice(3)]);
    if (st[0] === "R" || st[0] === "C") i++; // the rename's source path follows
  }
  return res;
}

export type MigrateStep = "backup" | "write-limits" | "rename-limits" | "write-config" | "rename-config" | "stage" | "commit";
export type MigrateOptions = { root: string; env?: NodeJS.ProcessEnv; /** Tests only: fail at this step. */ failAt?: MigrateStep };
export type MigrateResult = {
  status: "migrated" | "nothing_to_do";
  reason?: string;
  file?: string;
  limits?: number;
  pain_threshold?: { value: number; kept_coach_yaml?: number; old: number };
  backup?: string;
  commit?: string;
  /** The new file's text after its heading, for the update skill to show. */
  text?: string;
};

/** Runs the migration. Throws CoachError (the tree is as before) when it cannot finish. */
export function migrateLimits(o: MigrateOptions): MigrateResult {
  const root = o.root;
  const env = o.env ?? process.env;
  const m = unattendedMarker(env);
  if (m) throw new CoachError("UNATTENDED", `migrate-limits runs in a live session only (${m} is set): follow the old limits as the session context gives them, and log one line`);
  const git = gitIn(root);
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new CoachError("NOT_A_REPO", `${root} is not a git repository`);
  }
  const yamlPath = join(root, LEGACY_LIMITS_FILE);
  const mdPath = join(root, LIMITS_FILE);
  const cfgPath = join(root, "coach.yaml");
  const mdNow = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : null;
  const headYaml = headFile(root, LEGACY_LIMITS_FILE);
  // The source: the yaml on disk; else HEAD's, when an interrupted run already staged its removal.
  const tax = loadTaxonomy({ root });
  let bytes: Buffer | null = existsSync(yamlPath) ? readFileSync(yamlPath) : null;
  if (!bytes && headYaml !== null && mdNow !== null && MARKER_RE.exec(mdNow)?.[1] === sha256(headYaml)) {
    // W3b: never the marker alone: limits.md must hold that file's converted bullets.
    let held = false;
    try {
      held = holdsConversion(mdNow, parseOldLimits(headYaml), sha256(headYaml), tax);
    } catch {
      held = false;
    }
    if (held) bytes = Buffer.from(headYaml, "utf8");
  }
  // W3b confirmation 3: the old file is gone from the disk but still in HEAD, and limits.md does not
  // hold its conversion: never "nothing to do" (its limits would be lost); put it back first.
  if (!bytes && headYaml !== null) {
    throw new CoachError("MIGRATE_REFUSED", "athlete/limits.yaml is deleted on disk but its limits are not in athlete/limits.md: put it back with git checkout HEAD -- athlete/limits.yaml, then run migrate-limits again. Nothing was changed.");
  }
  if (!bytes) {
    return { status: "nothing_to_do", reason: mdNow !== null ? "athlete/limits.md is in place and there is no old limits file" : "there is no limits file to convert", ...(mdNow !== null ? { file: LIMITS_FILE, text: limitsBody(mdNow) } : {}) };
  }
  const hash = sha256(bytes);
  // A file it cannot convert stops here, with the file kept and nothing written.
  const old = parseOldLimits(bytes.toString("utf8"));

  const headMd = headFile(root, LIMITS_FILE);
  // W3b: HEAD's limits.md counts as this file's conversion only when it holds the converted bullets.
  const headMdOurs = headMd !== null && holdsConversion(headMd, old, hash, tax);
  const wantMd = headMdOurs ? headMd! : expectedLimitsMd(headMd, old, hash, tax);
  const headCfg = headFile(root, "coach.yaml");
  if (headCfg === null) throw new CoachError("MIGRATE_REFUSED", "coach.yaml is not committed: commit it first (node engine/cli.ts commit --message \"coach: before the limits migration\")");
  const cfg = expectedConfig(headCfg, old.pain_threshold);
  // An earlier run committed the conversion and stopped before the file left the disk: finish it.
  // W3b confirmation 2: only when HEAD already holds everything the old file had: its limits
  // (headMdOurs) and its pain threshold (coach.yaml needs no change). Else the normal path, which
  // refuses an untracked old file as an uncommitted change and keeps it.
  if (headMdOurs && headYaml === null && cfg.text === headCfg) {
    writeAtomic(join(root, BACKUP_FILE), bytes);
    rmSync(yamlPath, { force: true });
    return { status: "migrated", reason: "an earlier run committed the conversion; the old file is removed now", file: LIMITS_FILE, limits: old.limits.length, backup: BACKUP_FILE, commit: git(["rev-parse", "HEAD"]).trim(), text: limitsBody(headMd!) };
  }

  // ---- the tree: only its own uncommitted states ----
  const others: string[] = [];
  for (const [st, p] of dirty(root)) {
    if (p === LIMITS_FILE && mdNow === wantMd) continue;
    if (p === "coach.yaml" && existsSync(cfgPath) && readFileSync(cfgPath, "utf8") === cfg.text) continue;
    if (p === LEGACY_LIMITS_FILE && st.includes("D") && mdNow === wantMd) continue;
    others.push(p);
  }
  if (others.length > 0) {
    throw new CoachError("MIGRATE_REFUSED", `uncommitted changes in ${others.join(", ")}: commit them first (node engine/cli.ts commit --message "<what changed>") or finish that work, then run migrate-limits again. Nothing was changed.`);
  }

  // ---- backup, then the writes, the staging and the one commit ----
  const createdMd = headMd === null;
  const fail = (s: MigrateStep) => {
    if (o.failAt === s) throw new CoachError("MIGRATE_TEST_FAILURE", `test failure at ${s}`);
  };
  fail("backup");
  writeAtomic(join(root, BACKUP_FILE), bytes);
  try {
    fail("write-limits");
    if (mdNow !== wantMd) writeAtomic(mdPath, wantMd, o.failAt === "rename-limits");
    fail("write-config");
    if (readFileSync(cfgPath, "utf8") !== cfg.text) writeAtomic(cfgPath, cfg.text, o.failAt === "rename-config");
    fail("stage");
    git(["add", "--", LIMITS_FILE]);
    if (cfg.text !== headCfg) git(["add", "--", "coach.yaml"]);
    // `commit --only` takes each path as the disk has it, so the file leaves the disk here; its
    // bytes stay in HEAD and in the backup, and a failure below puts it back.
    if (headYaml !== null) git(["rm", "-q", "--ignore-unmatch", "--", LEGACY_LIMITS_FILE]);
    fail("commit");
    const msg = cfg.kept !== null && cfg.kept !== old.pain_threshold ? `${COMMIT_MESSAGE}\n\ncoach.yaml thresholds.pain_threshold ${cfg.kept} kept; the old limits file had ${old.pain_threshold}.` : COMMIT_MESSAGE;
    const paths = [LIMITS_FILE, ...(headYaml !== null ? [LEGACY_LIMITS_FILE] : []), ...(cfg.text !== headCfg ? ["coach.yaml"] : [])];
    git(["commit", "-q", "--only", "-m", msg, "--", ...paths]);
  } catch (e) {
    rollback(root, { createdMd, wantMd, cfgText: cfg.text, headCfg, headYaml, bytes });
    const why = e instanceof CoachError ? e.message : ((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n").slice(-2).join(" | ");
    throw new CoachError("MIGRATE_FAILED", `the limits migration did not finish (${why}); your old limits file is back as it was, and nothing was committed. The backup is in ${BACKUP_FILE}.`);
  }
  return {
    status: "migrated",
    file: LIMITS_FILE,
    limits: old.limits.length,
    pain_threshold: { value: cfg.kept ?? old.pain_threshold, old: old.pain_threshold, ...(cfg.kept !== null ? { kept_coach_yaml: cfg.kept } : {}) },
    backup: BACKUP_FILE,
    commit: git(["rev-parse", "HEAD"]).trim(),
    text: limitsBody(wantMd),
  };
}

/** Puts athlete/limits.yaml, athlete/limits.md and coach.yaml back as HEAD has them (its own changes only). */
function rollback(root: string, s: { createdMd: boolean; wantMd: string; cfgText: string; headCfg: string; headYaml: string | null; bytes: Buffer }): void {
  const quiet = (args: string[]) => {
    try {
      gitIn(root)(args);
    } catch {
      /* best effort; each file is checked below */
    }
  };
  quiet(["reset", "-q", "--", LEGACY_LIMITS_FILE, LIMITS_FILE, "coach.yaml"]);
  const yamlPath = join(root, LEGACY_LIMITS_FILE);
  if (s.headYaml !== null) quiet(["checkout", "HEAD", "--", LEGACY_LIMITS_FILE]);
  if (!existsSync(yamlPath)) writeAtomic(yamlPath, s.bytes);
  const mdPath = join(root, LIMITS_FILE);
  if (existsSync(mdPath) && readFileSync(mdPath, "utf8") === s.wantMd) {
    if (s.createdMd) rmSync(mdPath);
    else quiet(["checkout", "HEAD", "--", LIMITS_FILE]);
  }
  const cfgPath = join(root, "coach.yaml");
  if (existsSync(cfgPath) && readFileSync(cfgPath, "utf8") === s.cfgText && s.cfgText !== s.headCfg) quiet(["checkout", "HEAD", "--", "coach.yaml"]);
}
