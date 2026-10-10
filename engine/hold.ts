// Training hold and the pending safety file (contracts §10). `set` is always allowed.
// `clear` and `clear-pending` need an interactive yes: without --approved, or in an
// unattended run even with it, they exit with EXIT_NEEDS_APPROVAL, which the guard maps to `ask`.
//
//   node engine/hold.ts init                       (writes the inactive hold only when none exists; exit 3 on an active hold)
//   node engine/hold.ts set --reason "<short reason>" [--regions a,b] [--by safety-agent] [--urgent]
//   node engine/hold.ts clear [--approved] [--by user]
//   node engine/hold.ts clear-pending [--approved]
//   node engine/hold.ts status
import { isUrgentHold } from "./safety.ts";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { parseInstant } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { isPlainObject, readYamlFile } from "./yaml-file.ts";
import type { Hold, SafetyPending } from "./types.ts";

export const HOLD_RELATIVE = "athlete/hold.yaml";
export const PENDING_RELATIVE = "athlete/.safety-pending";
export const EXIT_NEEDS_APPROVAL = 3;

const HEADER = "# PROTECTED. Training hold (contracts §10). Set it with `node engine/hold.ts set`.\n# Clearing it needs an interactive yes.\n";
const KEYS = ["active", "set_at", "reason", "regions", "set_by", "urgent", "cleared_at", "cleared_by"];

export function validateHold(raw: unknown, where = "hold.yaml"): Hold {
  const errors: string[] = [];
  if (!isPlainObject(raw)) throw new CoachError("HOLD_INVALID", `${where} is invalid: must be a mapping`);
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) errors.push(`${k}: unknown key`);
  if (typeof raw.active !== "boolean") errors.push("active: must be true or false");
  const optStr = (k: string) => {
    const v = raw[k];
    if (v !== null && v !== undefined && typeof v !== "string") errors.push(`${k}: must be a string or null`);
  };
  ["set_at", "reason", "set_by", "cleared_at", "cleared_by"].forEach(optStr);
  for (const k of ["set_at", "cleared_at"]) {
    if (typeof raw[k] === "string") {
      try {
        parseInstant(raw[k], k);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  }
  const regions = raw.regions ?? [];
  if (!Array.isArray(regions) || regions.some((r) => typeof r !== "string")) errors.push("regions: must be a list of region ids");
  if (raw.urgent !== undefined && typeof raw.urgent !== "boolean") errors.push("urgent: must be true or false");
  if (raw.active === true && (typeof raw.set_at !== "string" || typeof raw.reason !== "string")) {
    errors.push("an active hold needs set_at and reason");
  }
  if (errors.length > 0) throw new CoachError("HOLD_INVALID", `${where} is invalid:\n  - ${errors.join("\n  - ")}`);
  return {
    active: raw.active as boolean,
    set_at: (raw.set_at as string | null) ?? null,
    reason: (raw.reason as string | null) ?? null,
    regions: regions as string[],
    set_by: (raw.set_by as string | null) ?? null,
    ...(raw.urgent === true ? { urgent: true } : {}),
    ...(typeof raw.cleared_at === "string" ? { cleared_at: raw.cleared_at } : {}),
    ...(typeof raw.cleared_by === "string" ? { cleared_by: raw.cleared_by } : {}),
  };
}

/** The hold, or null when the file does not exist. A malformed file throws. */
export function readHold(root: string): Hold | null {
  const p = join(root, HOLD_RELATIVE);
  if (!existsSync(p)) return null;
  return validateHold(readYamlFile(p, "HOLD_INVALID"), p);
}

function writeHold(root: string, hold: Hold): void {
  const p = join(root, HOLD_RELATIVE);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, HEADER + stringify(hold));
  renameSync(tmp, p);
}

/** The inactive hold that `init` writes (the shape of templates/athlete/hold.yaml). */
export const INACTIVE_HOLD: Hold = { active: false, set_at: null, reason: null, regions: [], set_by: null };

export type InitHoldResult = { created: boolean; hold: Hold; path: string };

/** An existing hold file, judged for init: active → HOLD_ACTIVE; inactive → no change. */
function existingForInit(root: string, path: string): InitHoldResult {
  const prev = readHold(root);
  if (!prev) throw new CoachError("HOLD_INVALID", `${HOLD_RELATIVE} vanished while init ran; run it again`);
  if (prev.active) throw new CoachError("HOLD_ACTIVE", `${HOLD_RELATIVE} holds an active hold (${prev.reason ?? "no reason"}); init never changes it`);
  return { created: false, hold: prev, path };
}

/**
 * Writes the inactive hold when there is no hold file (the guard needs the
 * file, and setup cannot write a protected path). An existing inactive hold is left as it
 * is. An active hold throws HOLD_ACTIVE and is never changed; a malformed file throws
 * HOLD_INVALID and is never overwritten.
 *
 * Create-if-absent is atomic: the full file is written to a temporary name
 * and hard-linked to hold.yaml, which fails when the file exists. A hold that `hold set`
 * writes meanwhile therefore wins, and init then reports it (HOLD_ACTIVE) instead of
 * replacing it. `beforeCreate` is a test seam that runs between the first read and the link.
 */
export function initHold(root: string, opts: { beforeCreate?: () => void } = {}): InitHoldResult {
  const path = join(root, HOLD_RELATIVE);
  if (existsSync(path)) return existingForInit(root, path);
  opts.beforeCreate?.();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.init-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, HEADER + stringify(INACTIVE_HOLD), { flag: "wx" });
  try {
    linkSync(tmp, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return existingForInit(root, path);
    throw new CoachError("HOLD_IO", `cannot create ${HOLD_RELATIVE}: ${(e as Error).message}`);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { created: true, hold: { ...INACTIVE_HOLD, regions: [] }, path };
}

export type SetHoldInput = { reason: string; regions?: string[]; by?: string; now?: string; urgent?: boolean };

/**
 * Sets (or extends) the hold. Always allowed: a hold makes training safer. The hold is
 * urgent (launch review finding 3) with --urgent, when the reason says "urgent", or when it extends an
 * urgent hold: extending never makes a hold less strict.
 */
export function setHold(root: string, input: SetHoldInput): Hold {
  const reason = input.reason?.trim();
  if (!reason) throw new CoachError("HOLD_USAGE", "hold set needs --reason");
  const now = input.now ?? new Date().toISOString();
  parseInstant(now, "now");
  const prev = readHold(root);
  const regions = [...new Set([...(prev?.active ? prev.regions : []), ...(input.regions ?? [])])];
  const hold: Hold = {
    active: true,
    set_at: prev?.active && prev.set_at ? prev.set_at : now,
    reason,
    regions,
    set_by: input.by ?? "safety-agent",
  };
  // The same test as the guard: the flag, the word "urgent" or an urgent term, in the new
  // hold or in the active hold it extends.
  if (input.urgent === true || isUrgentHold({ reason }) || (prev?.active === true && isUrgentHold(prev))) hold.urgent = true;
  writeHold(root, hold);
  return hold;
}

// ---------- the pending safety file ----------

const PENDING_KEYS = ["at", "terms", "source"];
const PENDING_SOURCES = ["prompt", "session-notes"];

export function validatePending(raw: unknown, where = ".safety-pending"): SafetyPending {
  const errors: string[] = [];
  if (!isPlainObject(raw)) throw new CoachError("PENDING_INVALID", `${where} is invalid: must be a JSON object`);
  for (const k of Object.keys(raw)) if (!PENDING_KEYS.includes(k)) errors.push(`${k}: unknown key`);
  if (typeof raw.at !== "string") errors.push("at: must be an instant");
  else {
    try {
      parseInstant(raw.at, "at");
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (!Array.isArray(raw.terms) || raw.terms.some((t) => typeof t !== "string")) errors.push("terms: must be a list of strings");
  if (!PENDING_SOURCES.includes(raw.source as string)) errors.push(`source: must be one of ${PENDING_SOURCES.join(", ")}`);
  if (errors.length > 0) throw new CoachError("PENDING_INVALID", `${where} is invalid:\n  - ${errors.join("\n  - ")}`);
  return { at: raw.at as string, terms: raw.terms as string[], source: raw.source as SafetyPending["source"] };
}

/** The pending safety file, or null when it does not exist. A malformed file throws. */
export function readPending(root: string): SafetyPending | null {
  const p = join(root, PENDING_RELATIVE);
  if (!existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new CoachError("PENDING_INVALID", `${p} is invalid: ${(e as Error).message}`);
  }
  return validatePending(raw, p);
}

export type ClearHoldInput = { approved: boolean; by?: string; now?: string; env?: NodeJS.ProcessEnv };

/** The markers of an unattended run (contracts §7). Any non-empty value counts. */
export const UNATTENDED_MARKERS = ["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED"];

export function unattendedMarker(env: NodeJS.ProcessEnv = process.env): string | null {
  return UNATTENDED_MARKERS.find((k) => (env[k] ?? "") !== "") ?? null;
}
export type ClearHoldResult = { hold: Hold | null; pending_removed: boolean };

/**
 * Clears the hold and the pending safety file. Throws UNATTENDED in an unattended run,
 * even with approval, and NEEDS_APPROVAL unless the user approved it interactively.
 */
export function clearHold(root: string, input: ClearHoldInput): ClearHoldResult {
  requireInteractiveYes(input, "a hold", "hold clear");
  const now = input.now ?? new Date().toISOString();
  parseInstant(now, "now");
  const prev = readHold(root);
  let hold: Hold | null = null;
  if (prev) {
    hold = { ...prev, active: false, cleared_at: now, cleared_by: input.by ?? "user" };
    writeHold(root, hold);
  }
  const pending = join(root, PENDING_RELATIVE);
  const pending_removed = existsSync(pending);
  if (pending_removed) rmSync(pending);
  return { hold, pending_removed };
}

function requireInteractiveYes(input: { approved: boolean; env?: NodeJS.ProcessEnv }, what: string, cmd: string): void {
  const marker = unattendedMarker(input.env ?? process.env);
  if (marker) {
    throw new CoachError("UNATTENDED", `${what} cannot be cleared in an unattended run (${marker} is set); clearing needs an interactive yes`);
  }
  if (!input.approved) {
    throw new CoachError("NEEDS_APPROVAL", `clearing ${what} needs an interactive yes: ask the user, then run \`${cmd} --approved\``);
  }
}

/**
 * Removes the pending safety file and leaves the hold as it is. The same rule as
 * `clearHold`: UNATTENDED in an unattended run, NEEDS_APPROVAL without approval.
 */
export function clearPending(root: string, input: { approved: boolean; env?: NodeJS.ProcessEnv }): { pending_removed: boolean } {
  requireInteractiveYes(input, "the pending safety file", "hold clear-pending");
  const p = join(root, PENDING_RELATIVE);
  const pending_removed = existsSync(p);
  if (pending_removed) rmSync(p);
  return { pending_removed };
}

/** Runs `hold init|set|clear|clear-pending|status` and returns the exit code. Output is JSON on stdout. */
export function holdCommand(argv: string[], defaultRoot: string): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      reason: { type: "string" },
      regions: { type: "string" },
      by: { type: "string" },
      urgent: { type: "boolean", default: false },
      approved: { type: "boolean", default: false },
      now: { type: "string" },
      root: { type: "string" },
    },
  });
  const root = resolve(values.root ?? defaultRoot);
  const sub = positionals[0];
  if (sub === "init") {
    try {
      process.stdout.write(JSON.stringify({ ok: true, ...initHold(root) }) + "\n");
      return 0;
    } catch (e) {
      if (e instanceof CoachError && e.code === "HOLD_ACTIVE") {
        process.stdout.write(JSON.stringify({ ok: false, active: true, message: e.message }) + "\n");
        return EXIT_NEEDS_APPROVAL;
      }
      throw e;
    }
  }
  if (sub === "set") {
    const regions = values.regions ? values.regions.split(",").map((r) => r.trim()).filter(Boolean) : [];
    const hold = setHold(root, { reason: values.reason ?? "", regions, by: values.by, now: values.now, urgent: values.urgent });
    process.stdout.write(JSON.stringify({ ok: true, hold }) + "\n");
    return 0;
  }
  if (sub === "clear" || sub === "clear-pending") {
    try {
      const res =
        sub === "clear"
          ? clearHold(root, { approved: values.approved, by: values.by, now: values.now })
          : clearPending(root, { approved: values.approved });
      process.stdout.write(JSON.stringify({ ok: true, ...res }) + "\n");
      return 0;
    } catch (e) {
      if (e instanceof CoachError && (e.code === "NEEDS_APPROVAL" || e.code === "UNATTENDED")) {
        const unattended = e.code === "UNATTENDED";
        process.stdout.write(JSON.stringify({ ok: false, needs_approval: true, unattended, message: e.message }) + "\n");
        return EXIT_NEEDS_APPROVAL;
      }
      throw e;
    }
  }
  if (sub === "status") {
    process.stdout.write(JSON.stringify({ ok: true, hold: readHold(root), pending: readPending(root) }) + "\n");
    return 0;
  }
  throw new CoachError(
    "USAGE",
    "usage: hold init | hold set --reason <text> [--regions a,b] [--by who] [--urgent] | hold clear [--approved] [--by who] | hold clear-pending [--approved] | hold status",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = holdCommand(process.argv.slice(2), process.cwd());
  } catch (e) {
    const err = e instanceof CoachError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: String(e) };
    process.stdout.write(JSON.stringify({ error: err }) + "\n");
    process.stderr.write(`${err.code}: ${err.message}\n`);
    process.exitCode = 1;
  }
}
