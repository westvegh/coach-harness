// block draft --out and block write (contracts §22.6, §22.6a).
//
// `block draft --out <dir>` writes the draft as files and prints a short summary, so the coach
// never reads a 160 KB draft: <dir>/block.json (the block) and one <dir>/week-<n>.json per block
// week, {week: {week_start, kind, load_factor, days}}. That one week shape goes to every command:
// loads --fill, limits check, volume, plans write and tally-days.
//
// `block write --input <dir>/block.json` owns the whole step: it refuses under the urgent stop,
// validates the block, archives a block with another id to athlete/blocks/<safe id>.yaml, and
// writes athlete/block.yaml atomically (a temporary file, then a rename).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { BLOCK_RELATIVE, validateBlock } from "./block.ts";
import type { BlockDraft, ShortMuscle } from "./block-draft.ts";
import type { ClusterEntry } from "./clusters.ts";
import { CoachError } from "./errors.ts";
import type { Template } from "./methods.ts";
import { refuseUnderUrgentStop } from "./plans-files.ts";
import type { Block, Weekday } from "./types.ts";
import { isPlainObject } from "./yaml-file.ts";

export const BLOCKS_DIR = "athlete/blocks";

/**
 * The template's plain lines for the week and each day (optional in a pack), and one plain line per
 * muscle the draft plans below its target (0.2.4: the per-exercise maximum), for the athlete.
 */
export type DraftWhy = { week: string[]; days: { day: Weekday; why: string }[]; short?: string[] };

export function draftWhy(template: Template, weekdays: Weekday[], draft?: Pick<BlockDraft, "weeks">): DraftWhy {
  const short = draft ? shortLines(draft) : [];
  return {
    week: [...(template.why ?? [])],
    days: template.week.flatMap((d, i) => (d.why ? [{ day: weekdays[i], why: d.why }] : [])),
    ...(short.length > 0 ? { short } : {}),
  };
}

/**
 * Plain lines for the athlete on the muscles the draft plans below their target: one line per
 * reason, each muscle with its planned and wanted sets in the first build week it falls short.
 */
function shortLines(draft: Pick<BlockDraft, "weeks">): string[] {
  const first = new Map<string, ShortMuscle>();
  for (const w of draft.weeks) for (const x of w.short ?? []) if (!first.has(x.muscle)) first.set(x.muscle, x);
  const list = (reason: ShortMuscle["reason"]) =>
    [...first.values()]
      .filter((x) => x.reason === reason)
      .map((x) => `${x.muscle.replace(/-/g, " ")} (${x.planned} of ${x.requested})`)
      .join(", ");
  const out: string[] = [];
  const atMax = list("at_max");
  if (atMax) out.push(`Some muscles get fewer sets a week than wanted, because each of their exercises already has the most sets one exercise gets in a session: ${atMax}. An extra exercise or day would close the gap.`);
  const other = list("other_target");
  if (other) out.push(`Some muscles get fewer sets than wanted, because more sets on their exercises would give another muscle too many: ${other}.`);
  const none = list("no_slot");
  if (none) out.push(`No exercise in the week can take more sets for: ${none}. An extra exercise or day would close the gap.`);
  return out;
}

/**
 * The short muscles across the block, compact (the summary stays under 8 KB): per muscle its reason
 * and "<week>: <wanted>→<planned>" for each build week it falls short in.
 */
function compactShort(draft: Pick<BlockDraft, "weeks">): { muscle: string; reason: ShortMuscle["reason"]; weeks: string }[] {
  const by = new Map<string, { reason: ShortMuscle["reason"]; parts: string[] }>();
  for (const w of draft.weeks) {
    for (const x of w.short ?? []) {
      const e = by.get(x.muscle) ?? { reason: x.reason, parts: [] };
      e.parts.push(`${w.week}: ${x.requested}→${x.planned}${x.reason !== e.reason ? ` ${x.reason}` : ""}`);
      by.set(x.muscle, e);
    }
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([muscle, e]) => ({ muscle, reason: e.reason, weeks: e.parts.join(", ") }));
}

/** The short-muscle warnings fold into one line in the --out summary: `short` lists them (the full draft keeps one per week). */
function foldShortWarnings(warnings: string[]): string[] {
  const isShort = (w: string) => /^week \d+: [a-z-]+: \d+ sets wanted, \d+ planned: /.test(w);
  const muscles = new Set(warnings.filter(isShort).map((w) => /^week \d+: ([a-z-]+): /.exec(w)![1]));
  if (muscles.size === 0) return warnings;
  return [...warnings.filter((w) => !isShort(w)), `${muscles.size} muscles are planned below their target in some build weeks (the per-exercise session maximum, or another muscle's target): see short`];
}

/** The build weeks, the weekly step the draft used and the deload weeks. */
function progression(draft: BlockDraft, step: number): { build_weeks: number; step: number; deload_weeks: number[] } {
  return { build_weeks: draft.weeks.filter((w) => w.kind === "build").length, step, deload_weeks: draft.weeks.filter((w) => w.kind === "deload").map((w) => w.week) };
}

/**
 * Writes <dir>/block.json and <dir>/week-<n>.json, and returns the summary to print.
 * `step` is the weekly step the draft used (input or default), for `progression`.
 */
export function writeDraftFiles(dir: string, draft: BlockDraft & { template: string }, why: DraftWhy, step: number, clusters: readonly ClusterEntry[] | null = null): Record<string, unknown> {
  mkdirSync(dir, { recursive: true });
  const blockFile = join(dir, "block.json");
  writeFileSync(blockFile, JSON.stringify(draft.block, null, 2) + "\n");
  const weeks = draft.weeks.map((w) => {
    const file = join(dir, `week-${w.week}.json`);
    // 0.2.4: the input's cluster list travels with the week file, so every command that reads it
    // (volume, limits check, loads --fill, plans write, tally-days) uses it, before coach.yaml exists
    // too. An empty list is kept: it overrides coach.yaml, as it did in the draft. null: no key.
    const body = { week: { week_start: w.week_start, kind: w.kind, load_factor: w.load_factor, days: w.days }, ...(clusters !== null ? { clusters } : {}) };
    writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
    return {
      week: w.week,
      kind: w.kind,
      week_start: w.week_start,
      load_factor: w.load_factor,
      file,
      sets_by_muscle: w.sets_by_muscle,
      ...(w.cluster_above_target.length > 0 ? { cluster_above_target: w.cluster_above_target } : {}),
    };
  });
  return {
    template: draft.template,
    block_id: draft.block.id,
    start: draft.block.start,
    block_file: blockFile,
    ready: draft.ready,
    unresolved: compactUnresolved(draft.unresolved),
    warnings: foldShortWarnings(fillWarnings(draft.warnings)),
    rule_ids: draft.rule_ids,
    capped: draft.capped,
    reference: draft.reference,
    progression: progression(draft, step),
    short: compactShort(draft),
    why,
    weeks,
  };
}

/**
 * The unresolved slots, compact (V4b: the summary stays under 8 KB): a count, and per weekday
 * "<day.slot> <pattern>", with the reason only when it is not "no exercise given".
 */
export function compactUnresolved(list: BlockDraft["unresolved"]): { count: number; by_day: Record<string, string[]> } {
  const by_day: Record<string, string[]> = {};
  for (const u of list) {
    const extra = u.reason.startsWith("no exercise given") ? "" : ` (${u.reason})`;
    (by_day[u.day] ??= []).push(`${u.slot} ${u.pattern}${extra}`);
  }
  return { count: list.length, by_day };
}

/** The deload-load warnings say one thing in the --out flow: loads --fill sets each week's loads. */
function fillWarnings(warnings: string[]): string[] {
  const noLoad = warnings.filter((w) => w.includes("no working load given, so the deload load is not set"));
  if (noLoad.length === 0) return warnings;
  return [...warnings.filter((w) => !noLoad.includes(w)), `${noLoad.length} exercises have no load yet: loads --input <week file> --fill sets each week's loads (a lighter week at its load_factor)`];
}

/** "B-001" → "B-001"; anything outside [A-Za-z0-9._-] becomes "_" (never a path). */
export function safeId(id: string): string {
  const s = id.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.{2,}/g, "_").replace(/^\.+/, "_").slice(0, 80);
  return s === "" ? "block" : s;
}

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * Archives the old block to athlete/blocks/<safe id>.yaml, or -2, -3 … when that name holds
 * different content. A file with the same content is reused (a retry archives nothing new).
 * V4b: each name is created exclusively (it fails when the file exists, and the next name is
 * tried), so a file another call writes between the check and the write is never overwritten.
 * `beforeCreate` is for tests: it runs right before each exclusive create.
 */
function archiveOld(root: string, id: string, text: string, beforeCreate?: (rel: string) => void): { path: string; created: boolean } {
  const base = safeId(id);
  mkdirSync(join(root, BLOCKS_DIR), { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const rel = join(BLOCKS_DIR, `${base}${n === 1 ? "" : `-${n}`}.yaml`);
    const abs = join(root, rel);
    if (readText(abs) === text) return { path: rel, created: false };
    if (existsSync(abs)) continue;
    beforeCreate?.(rel);
    try {
      writeFileSync(abs, text, { flag: "wx" });
      return { path: rel, created: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (readText(abs) === text) return { path: rel, created: false };
    }
  }
  throw new CoachError("BLOCK_WRITE", `too many archived blocks named ${base}`);
}

export type BlockWriteResult = { written: string; id: string; archived: string | null; replaced: "new" | "same-id" | "other-id" };

/**
 * Writes the block to athlete/block.yaml. `failBeforeRename`, `beforeArchiveCreate` and `afterArchiveCreate` are for
 * tests: a failed final rename, a file that appears between the archive check and its write, and
 * an archive another call replaces after this call created it.
 */
export function writeBlock(root: string, raw: unknown, opts: { failBeforeRename?: boolean; beforeArchiveCreate?: (rel: string) => void; afterArchiveCreate?: (rel: string) => void } = {}): BlockWriteResult {
  refuseUnderUrgentStop(root, "block write");
  // The draft's block.json, or the whole draft output ({block, …}).
  const candidate = isPlainObject(raw) && isPlainObject(raw.block) && !("version" in raw) ? raw.block : raw;
  const block: Block = validateBlock(candidate, "block write --input");
  const target = join(root, BLOCK_RELATIVE);
  const oldText = readText(target);
  let oldId: string | null = null;
  if (oldText !== null) {
    try {
      const old = parse(oldText);
      if (isPlainObject(old) && typeof old.id === "string" && old.id !== "") oldId = old.id;
    } catch {
      // An unreadable old file is archived as it is, under a plain name.
      oldId = "unreadable";
    }
  }
  let archived: string | null = null;
  let created: string | null = null;
  if (oldText !== null && oldId !== null && oldId !== block.id) {
    const a = archiveOld(root, oldId, oldText, opts.beforeArchiveCreate);
    archived = a.path;
    if (a.created) created = a.path;
    if (a.created) opts.afterArchiveCreate?.(a.path);
  }
  const text = `# The current training block (written by node engine/cli.ts block write).\n${stringify(block)}`;
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, text);
    if (opts.failBeforeRename) throw new Error("simulated failure before the rename");
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    // A failed write leaves every archive as it was: remove the one this call created, only while
    // it still holds what this call wrote (another call may have replaced it since).
    if (created && readText(join(root, created)) === oldText) rmSync(join(root, created), { force: true });
    throw new CoachError("BLOCK_WRITE", `athlete/block.yaml was not changed: ${(e as Error).message}`);
  }
  return { written: BLOCK_RELATIVE, id: block.id, archived, replaced: oldId === null ? "new" : oldId === block.id ? "same-id" : "other-id" };
}
