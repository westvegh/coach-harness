// V7: a lock on athlete/.cache/snapshot.json (contracts §9a). Parallel Tally reads run one
// capture-reads hook each; every hook loads, merges and saves the same file, so the
// load-merge-save is serialized here. Older consumers read snapshot.json directly and see
// every read, with no change on their side.
//
// - The lock file holds the owner's pid, a random token and the time. It is published whole: the
//   record goes to a private file that is hard-linked into place (link fails when the lock exists).
// - A waiter retries every 5 to 15 ms, up to `waitMs` (default 5 s; the hook timeout is 10 s).
//   On timeout: SNAPSHOT_LOCKED, and the hook records the failed read (capture-failures.jsonl).
// - A stale lock (the owner process is gone, or the lock is older than `staleMs`) is broken
//   under a second lock (`.break`), and only when the file still holds the stale token: two
//   waiters never both break it, and a fresh lock is never removed.
// - The owner removes the lock only when it still holds its own token.
import { appendFileSync, closeSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { CoachError } from "./errors.ts";

export const LOCK_RELATIVE = "athlete/.cache/snapshot.lock";
export const CAPTURE_FAILURES_RELATIVE = "athlete/.cache/capture-failures.jsonl";
export const LOCK_WAIT_MS = 5_000;
export const LOCK_STALE_MS = 30_000;

const SLEEP = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number) => Atomics.wait(SLEEP, 0, 0, ms);

function readText(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** True when the process is gone. A process we may not signal (EPERM) is alive. */
function deadPid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Creates the lock with its whole ownership record at once (V7 review finding 1): the record is
 * written to a private file first and linked into place, so no reader ever sees an empty lock.
 */
function tryCreate(p: string, text: string): boolean {
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

const RECORD = /^(\d+) (\S+) (\d+)$/;

/**
 * A lock is stale when its owner process is gone, or it is older than `staleMs`. A record that
 * does not parse (empty, or cut short) is judged by the file's age only: it may be a lock that is
 * being created, never a dead owner.
 */
function isStale(text: string, p: string, staleMs: number, nowMs: number): boolean {
  const m = RECORD.exec(text.trim());
  if (m) return deadPid(Number(m[1])) || nowMs - Number(m[3]) > staleMs;
  try {
    return nowMs - statSync(p).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/** Breaks the lock only when it still holds `observed`, under the break lock. */
function breakStale(p: string, observed: string, staleMs: number): void {
  const brk = `${p}.break`;
  if (!tryCreate(brk, `${process.pid} ${Date.now()}`)) {
    // A breaker that died leaves its break lock: remove it when it is old.
    try {
      if (Date.now() - statSync(brk).mtimeMs > Math.min(staleMs, 2_000)) rmSync(brk, { force: true });
    } catch {
      /* gone already */
    }
    return;
  }
  try {
    if (readText(p) === observed) rmSync(p, { force: true });
  } finally {
    rmSync(brk, { force: true });
  }
}

export type LockOptions = { waitMs?: number; staleMs?: number };

/** Runs `fn` while holding the snapshot lock. Throws SNAPSHOT_LOCKED when the wait runs out. */
export function withSnapshotLock<T>(root: string, fn: () => T, opts: LockOptions = {}): T {
  const p = join(root, LOCK_RELATIVE);
  mkdirSync(dirname(p), { recursive: true });
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const mine = `${process.pid} ${randomBytes(8).toString("hex")} ${Date.now()}`;
  const start = Date.now();
  for (;;) {
    if (tryCreate(p, mine)) break;
    const held = readText(p);
    if (held !== null && isStale(held, p, staleMs, Date.now())) {
      breakStale(p, held, staleMs);
      continue;
    }
    if (Date.now() - start > waitMs) throw new CoachError("SNAPSHOT_LOCKED", `the snapshot lock was busy for ${waitMs} ms; the read was not saved: read it again`);
    sleep(5 + Math.floor(Math.random() * 10));
  }
  try {
    return fn();
  } finally {
    if (readText(p) === mine) rmSync(p, { force: true });
  }
}

/** One line in capture-failures.jsonl: a read the hook could not save (the lock timed out). */
export type CaptureFailure = { at: string; session_id: string; tool: string; date?: string; since?: string; until?: string; cursor?: string; reason: string };

export function recordCaptureFailure(root: string, f: CaptureFailure): void {
  const p = join(root, CAPTURE_FAILURES_RELATIVE);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(f) + "\n");
}

/** The failures recorded for a session (newest last). A malformed line is skipped. */
export function readCaptureFailures(root: string, session_id: string): CaptureFailure[] {
  const text = readText(join(root, CAPTURE_FAILURES_RELATIVE));
  if (!text) return [];
  const out: CaptureFailure[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const f = JSON.parse(line) as CaptureFailure;
      if (f && f.session_id === session_id && typeof f.at === "string") out.push(f);
    } catch {
      /* skip */
    }
  }
  return out;
}
