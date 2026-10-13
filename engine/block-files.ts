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
import type { BlockDraft } from "./block-draft.ts";
import { CoachError } from "./errors.ts";
import type { Template } from "./methods.ts";
import { refuseUnderUrgentStop } from "./plans-files.ts";
import type { Block, Weekday } from "./types.ts";
import { isPlainObject } from "./yaml-file.ts";

export const BLOCKS_DIR = "athlete/blocks";

/** The template's plain lines for the week and each day (optional in a pack). */
export type DraftWhy = { week: string[]; days: { day: Weekday; why: string }[] };

export function draftWhy(template: Template, weekdays: Weekday[]): DraftWhy {
  return {
    week: [...(template.why ?? [])],
    days: template.week.flatMap((d, i) => (d.why ? [{ day: weekdays[i], why: d.why }] : [])),
  };
}

/** The build weeks, the weekly step the draft used and the deload weeks. */
function progression(draft: BlockDraft, step: number): { build_weeks: number; step: number; deload_weeks: number[] } {
  return { build_weeks: draft.weeks.filter((w) => w.kind === "build").length, step, deload_weeks: draft.weeks.filter((w) => w.kind === "deload").map((w) => w.week) };
}

/**
 * Writes <dir>/block.json and <dir>/week-<n>.json, and returns the summary to print.
 * `step` is the weekly step the draft used (input or default), for `progression`.
 */
export function writeDraftFiles(dir: string, draft: BlockDraft & { template: string }, why: DraftWhy, step: number): Record<string, unknown> {
  mkdirSync(dir, { recursive: true });
  const blockFile = join(dir, "block.json");
  writeFileSync(blockFile, JSON.stringify(draft.block, null, 2) + "\n");
  const weeks = draft.weeks.map((w) => {
    const file = join(dir, `week-${w.week}.json`);
    writeFileSync(file, JSON.stringify({ week: { week_start: w.week_start, kind: w.kind, load_factor: w.load_factor, days: w.days } }, null, 2) + "\n");
    return { week: w.week, kind: w.kind, week_start: w.week_start, load_factor: w.load_factor, file, sets_by_muscle: w.sets_by_muscle };
  });
  return {
    template: draft.template,
    block_id: draft.block.id,
    start: draft.block.start,
    block_file: blockFile,
    ready: draft.ready,
    unresolved: compactUnresolved(draft.unresolved),
    warnings: fillWarnings(draft.warnings),
    rule_ids: draft.rule_ids,
    capped: draft.capped,
    reference: draft.reference,
    progression: progression(draft, step),
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
