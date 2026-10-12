// Workspace trust for the permission proxy (runner --proxy). In print mode Claude Code ignores
// the project's `permissions.allow` rules in a folder whose trust dialog was never accepted
// ("Ignoring N permissions.allow entries from .claude/settings.json: this workspace has not
// been trusted", Claude Code 2.1.296). An athlete runs the coach in a folder they trusted, so
// the proxy marks the temp instance as trusted in ~/.claude.json for the run, then puts the
// previous record back exactly (V3c):
// - before the edit, a recovery file (pid, config path, each path's previous record or
//   "absent") is written to the recovery folder;
// - each edit re-reads ~/.claude.json right before an atomic write (a temp file and a
//   rename), so other changes made meanwhile are kept;
// - the restore puts back each previous record (or deletes the entry when there was none)
//   and removes the recovery file;
// - a crashed run leaves its recovery file: `recoverTrust` (run at the start of every eval
//   run) restores each one whose process is gone.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO } from "./instance.ts";

/** The user config file Claude Code reads trust from. */
export function claudeConfigPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json");
}

/** Where the recovery files live (gitignored, next to the results). */
export const RECOVERY_DIR = join(REPO, "evals/results/.trust-recovery");

type Recovery = { pid: number; file: string; previous: Record<string, unknown | "absent"> };

/** Re-reads the config, applies `fn` to its projects, and writes it atomically. */
function update(file: string, fn: (projects: Record<string, unknown>) => void): void {
  if (!existsSync(file)) return;
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  cfg.projects ??= {};
  fn(cfg.projects);
  const tmp = `${file}.coach-eval-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, file);
}

function restore(r: Recovery): void {
  update(r.file, (p) => {
    for (const [k, v] of Object.entries(r.previous)) {
      if (v === "absent") delete p[k];
      else p[k] = v;
    }
  });
}

/**
 * Marks `dir` (and its real path) as trusted; returns the function that restores the
 * previous records exactly and removes the recovery file.
 */
export function trustWorkspace(dir: string, file = claudeConfigPath(), recoveryDir = RECOVERY_DIR): () => void {
  if (!existsSync(file)) return () => {};
  const paths = [...new Set([dir, realpathSync(dir)])];
  const current = (JSON.parse(readFileSync(file, "utf8")).projects ?? {}) as Record<string, unknown>;
  const previous: Recovery["previous"] = Object.fromEntries(paths.map((k) => [k, k in current ? current[k] : "absent"]));
  mkdirSync(recoveryDir, { recursive: true });
  const rec = join(recoveryDir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(rec, JSON.stringify({ pid: process.pid, file, previous } satisfies Recovery, null, 2));
  update(file, (p) => {
    for (const k of paths) p[k] = { ...((p[k] as object) ?? {}), hasTrustDialogAccepted: true };
  });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    restore({ pid: process.pid, file, previous });
    rmSync(rec, { force: true });
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Restores the records of crashed runs (their process is gone). Returns the files it restored. */
export function recoverTrust(recoveryDir = RECOVERY_DIR): string[] {
  if (!existsSync(recoveryDir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(recoveryDir).filter((n) => n.endsWith(".json"))) {
    const path = join(recoveryDir, f);
    let r: Recovery;
    try {
      r = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (r.pid !== process.pid && alive(r.pid)) continue; // another eval run still owns it
    restore(r);
    rmSync(path, { force: true });
    out.push(f);
  }
  return out;
}

/** The warning Claude Code prints when it ignores the project's allow rules. */
export const UNTRUSTED = /has not been trusted/;
