// A lock file that serializes token refreshes. Refresh tokens are single-use, so 2
// refreshes at once would spend the same token twice.
//
// - The lock file is created complete: the owner record is written to a temp file and
//   hard-linked into place (link fails if the lock exists), so a crash cannot leave a
//   half-written lock.
// - The owner record is {pid, start, nonce, at}. `start` is the process start time from
//   `ps`, so a reused pid is not mistaken for the owner.
// - A lock whose owner is alive is NEVER broken, however old it is. The waiter times out
//   with OURA_LOCKED instead.
// - A dead owner's lock is broken by renaming it aside and checking that the renamed file
//   is the one judged stale. If the lock changed in between, it is put back.
// - An empty or unreadable lock is broken only after `corruptGraceMs`.
// - Release deletes the lock only when it still holds our nonce.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CoachError } from "../../../engine/errors.ts";

export const DEFAULT_LOCK_DIR = join(homedir(), ".config", "coach-harness");
export const LOCK_NAME = "oura.lock";

export type LockOptions = { dir?: string; timeoutMs?: number; pollMs?: number; corruptGraceMs?: number };

type Owner = { pid: number; start?: string; nonce?: string; at?: string };

/** The start time of a process as `ps` reports it, or null when there is no such process. */
export function processStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseOwner(text: string): Owner | null {
  try {
    const o = JSON.parse(text);
    if (typeof o?.pid === "number" && Number.isInteger(o.pid)) return o;
  } catch {
    // Not JSON.
  }
  return null;
}

/** Alive means: the pid exists and, when `ps` can tell, it started when the owner did. */
function ownerAlive(o: Owner): boolean {
  if (!Number.isInteger(o.pid) || o.pid <= 0 || !pidExists(o.pid)) return false;
  if (typeof o.start !== "string") return true; // No start time recorded: the pid alone decides.
  const start = processStartTime(o.pid);
  // If ps cannot answer for an existing pid, assume the owner is alive (never break a live lock).
  return start === null ? true : start === o.start;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Breaks the lock at `path` if it still holds exactly `seen`. Renames the lock aside first,
 * so only one breaker wins; if the renamed file is not `seen` (the lock was replaced), it
 * is linked back without overwriting anything. Returns true when the stale lock was removed.
 */
export function breakIfStale(path: string, seen: string): boolean {
  const aside = `${path}.breaking.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch {
    return false; // Gone already, or another breaker took it.
  }
  const got = readText(aside);
  if (got === seen) {
    rmSync(aside, { force: true });
    return true;
  }
  try {
    linkSync(aside, path); // Put the newer lock back; fails if a lock exists again.
  } catch {
    // A new lock exists; the one we moved is lost, and its owner's release finds a stranger.
  }
  rmSync(aside, { force: true });
  return false;
}

function tryCreate(path: string, owner: Owner): boolean {
  const tmp = `${path}.${owner.nonce}.tmp`;
  writeFileSync(tmp, JSON.stringify(owner), { mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** One attempt: create the lock, or break it when its owner is dead. Returns the live owner pid on failure. */
function attempt(path: string, me: Owner, corruptGraceMs: number): { ok: true } | { ok: false; holder?: number } {
  if (tryCreate(path, me)) return { ok: true };
  const seen = readText(path);
  if (seen === null) return { ok: false }; // Released in between: retry.
  const owner = parseOwner(seen);
  if (owner) {
    if (ownerAlive(owner)) return { ok: false, holder: owner.pid };
    breakIfStale(path, seen);
    return { ok: false };
  }
  let ageMs = 0;
  try {
    ageMs = Date.now() - statSync(path).mtimeMs;
  } catch {
    return { ok: false };
  }
  if (ageMs > corruptGraceMs) breakIfStale(path, seen);
  return { ok: false };
}

/** Runs `fn` while holding the lock. Throws OURA_LOCKED after `timeoutMs`. */
export async function withLock<T>(fn: () => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
  const dir = opts.dir ?? DEFAULT_LOCK_DIR;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 100;
  const corruptGraceMs = opts.corruptGraceMs ?? 5_000;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, LOCK_NAME);
  const me: Required<Owner> = {
    pid: process.pid,
    start: processStartTime(process.pid) ?? "unknown",
    nonce: randomBytes(12).toString("hex"),
    at: new Date().toISOString(),
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = attempt(path, me, corruptGraceMs);
    if (r.ok) break;
    if (Date.now() >= deadline) {
      const who = r.holder ? `process ${r.holder} (still running)` : "another process";
      throw new CoachError("OURA_LOCKED", `${who} holds ${path}; try again when it finishes. Do not delete the file while that process runs.`);
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  try {
    return await fn();
  } finally {
    const now = readText(path);
    if (now !== null && parseOwner(now)?.nonce === me.nonce) rmSync(path, { force: true });
  }
}
