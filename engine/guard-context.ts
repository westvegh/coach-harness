// Loads every guard input from the athlete's files (contracts §7, "Loads"). Shared by the
// guard-writes hook and `cli.ts validate`. Any missing or malformed required file throws,
// so the hook denies (fail closed).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { loadApprovals, type ApprovalScan } from "./approvals.ts";
import { validateBlock } from "./block.ts";
import { loadConfig } from "./config.ts";
import { isCalendarDate, localDate, weekdayOf } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { HOLD_RELATIVE, PENDING_RELATIVE, readHold } from "./hold.ts";
import { limitsHash, loadLimits } from "./limits.ts";
import { loadLogger, type LoggerAdapter } from "./logger.ts";
import { loadRules } from "./methods.ts";
import { loadSnapshot } from "./snapshot.ts";
import { loadTaxonomy } from "./taxonomy.ts";
import { isPlainObject, readYamlFile } from "./yaml-file.ts";
import type { Block, CalendarDate, CoachConfig, Hold, Instant, Limits, PainEntry, Rules, SafetyPending, Snapshot, Taxonomy } from "./types.ts";
import type { GuardInput, Mode } from "./validate.ts";

export const CONFIG_RELATIVE = "coach.yaml";
export const LIMITS_RELATIVE = "athlete/limits.yaml";
export const BLOCK_RELATIVE = "athlete/block.yaml";
export const SIGNALS_RELATIVE = "athlete/signals";

export type GuardFiles = {
  config: CoachConfig;
  tax: Taxonomy;
  limits: Limits;
  limits_hash: string;
  rules: Rules;
  hold: Hold | null;
  pending: SafetyPending | null;
  block: Block | null;
  pain: PainEntry[];
  snapshot: Snapshot | null;
  approvals: ApprovalScan;
  logger: LoggerAdapter;
  today: CalendarDate;
};

function need(root: string, rel: string): string {
  const p = join(root, rel);
  if (!existsSync(p)) throw new CoachError("MISSING_FILE", `${rel} is missing; the guard denies every logger write without it`);
  return p;
}

export function readPending(root: string): SafetyPending | null {
  const p = join(root, PENDING_RELATIVE);
  if (!existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new CoachError("PENDING_INVALID", `${PENDING_RELATIVE} is not valid JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(raw) || typeof raw.at !== "string" || !Array.isArray(raw.terms) || (raw.source !== "prompt" && raw.source !== "session-notes")) {
    throw new CoachError("PENDING_INVALID", `${PENDING_RELATIVE} must be {at, terms, source: prompt | session-notes}`);
  }
  return raw as SafetyPending;
}

/** athlete/block.yaml, or null when it is absent or still the unfilled template (start: null). */
export function readBlock(root: string): Block | null {
  const p = join(root, BLOCK_RELATIVE);
  if (!existsSync(p)) return null;
  const raw = readYamlFile(p, "BLOCK_INVALID");
  if (!isPlainObject(raw)) throw new CoachError("BLOCK_INVALID", `${BLOCK_RELATIVE} must be a mapping`);
  if (raw.start === null || raw.start === undefined) return null;
  return validateBlock(raw, BLOCK_RELATIVE);
}

/**
 * The branch HEAD names, read from the git files (no process spawn): "main", another
 * branch, "" for a detached HEAD, or null when `root` is not a git work tree.
 */
export function headBranch(root: string): string | null {
  try {
    let gitDir = join(root, ".git");
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
      if (!m) return null;
      gitDir = resolve(root, m[1].trim());
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : "";
  } catch {
    return null;
  }
}

/**
 * The approved block for the guard (launch review finding 2): athlete/block.yaml on main. On main, or
 * outside git, that is the working-tree file. On any other branch (a proposal branch holds
 * a drafted block) it is main's committed copy, so a block written on a branch never
 * authorizes a logger write; when main has none, there is no block.
 */
export function readApprovedBlock(root: string): Block | null {
  const branch = headBranch(root);
  if (branch === null || branch === "main") return readBlock(root);
  let text: string;
  try {
    text = execFileSync("git", ["-C", root, "show", `main:${BLOCK_RELATIVE}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new CoachError("BLOCK_INVALID", `main:${BLOCK_RELATIVE} is not valid YAML: ${(e as Error).message}`);
  }
  if (!isPlainObject(raw)) throw new CoachError("BLOCK_INVALID", `main:${BLOCK_RELATIVE} must be a mapping`);
  if (raw.start === null || raw.start === undefined) return null;
  return validateBlock(raw, `main:${BLOCK_RELATIVE}`);
}

/** Today's check-in pain from athlete/signals/<today>.json (contracts §11). */
export function readPain(root: string, today: CalendarDate): PainEntry[] {
  const p = join(root, SIGNALS_RELATIVE, `${today}.json`);
  if (!existsSync(p)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new CoachError("SIGNALS_INVALID", `${SIGNALS_RELATIVE}/${today}.json is not valid JSON: ${(e as Error).message}`);
  }
  const pain = isPlainObject(raw) && isPlainObject(raw.checkin) ? raw.checkin.pain : undefined;
  if (pain === undefined) return [];
  if (!Array.isArray(pain) || pain.some((x) => !isPlainObject(x) || typeof x.region !== "string" || typeof x.score !== "number")) {
    throw new CoachError("SIGNALS_INVALID", `${SIGNALS_RELATIVE}/${today}.json: checkin.pain must be [{region, score}]`);
  }
  return pain as PainEntry[];
}

export function loadGuardFiles(root: string, now: Instant): GuardFiles {
  const config = loadConfig(need(root, CONFIG_RELATIVE));
  const tax = loadTaxonomy({ root });
  const limitsPath = need(root, LIMITS_RELATIVE);
  const limits = loadLimits(limitsPath, tax);
  need(root, HOLD_RELATIVE);
  const packDir = join(root, "methods", config.method);
  need(root, join("methods", config.method, "rules.yaml"));
  let rules: Rules;
  try {
    rules = loadRules(packDir) as unknown as Rules;
  } catch (e) {
    throw new CoachError("RULES_INVALID", (e as Error).message);
  }
  const today = localDate(now, config.athlete.timezone);
  return {
    config,
    tax,
    limits,
    limits_hash: limitsHash(limitsPath),
    rules,
    hold: readHold(root),
    pending: readPending(root),
    block: readApprovedBlock(root),
    pain: readPain(root, today),
    snapshot: loadSnapshot(root),
    approvals: loadApprovals(root),
    logger: loadLogger(config.logger),
    today,
  };
}

export function guardInputFrom(files: GuardFiles, call: { tool: string; args: unknown; mode: Mode; now: Instant; session_id: string }): GuardInput {
  return {
    tool: call.tool,
    args: call.args,
    mode: call.mode,
    snapshot: files.snapshot,
    limits: files.limits,
    rules: files.rules,
    tax: files.tax,
    config: files.config,
    hold: files.hold,
    pending: files.pending,
    approvals: files.approvals.records,
    now: call.now,
    session_id: call.session_id,
    block: files.block,
    pain: files.pain,
    limits_hash: files.limits_hash,
    logger: files.logger,
  };
}
