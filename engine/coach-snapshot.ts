// The logger's view for the engine tools (contracts §12a). With `coach.yaml logger: files` the
// week files under plans/ are the record, so the tools that read the snapshot (readiness,
// weeks, loads, adjust, block draft, the note scan) read a snapshot built from them. With
// `tally` (or `other`), the snapshot cache that capture-reads writes.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { filesNotesHistory, filesSnapshot } from "./plans-files.ts";
import type { NotesHistoryEntry } from "./safety.ts";
import { loadSnapshot } from "./snapshot.ts";
import type { CoachConfig, Instant, Snapshot } from "./types.ts";

/** The configured logger: `tally`, `files` or `other`; `tally` before setup (no coach.yaml). */
export function loggerOf(root: string, cfg?: CoachConfig | null): CoachConfig["logger"] {
  const c = cfg !== undefined ? cfg : existsSync(join(root, "coach.yaml")) ? loadConfig(join(root, "coach.yaml")) : null;
  return c?.logger ?? "tally";
}

/** True when the plans live in plans/ (the snapshot comes from the files, never from the cache). */
export function usesFiles(root: string, cfg?: CoachConfig | null): boolean {
  return loggerOf(root, cfg) === "files";
}

/**
 * The snapshot the tools read: from the week files with `logger: files`; the Tally cache with
 * `logger: tally` (or before setup). With `logger: other` there is no snapshot (V2b fix 4): a
 * cache left from earlier Tally use is not this athlete's current record, so the tools report
 * unknown unless the coach passes the evidence as a file (`--input`).
 */
export function coachSnapshot(root: string, opts: { now?: Instant; session_id?: string; cfg?: CoachConfig | null } = {}): Snapshot | null {
  const cfg = opts.cfg !== undefined ? opts.cfg : existsSync(join(root, "coach.yaml")) ? loadConfig(join(root, "coach.yaml")) : null;
  if (cfg?.logger === "files") {
    return filesSnapshot(root, { units: cfg.athlete.units, timezone: cfg.athlete.timezone, now: opts.now ?? new Date().toISOString(), session_id: opts.session_id });
  }
  if (cfg?.logger === "other") return null;
  return loadSnapshot(root);
}

/** The session notes for the note scan: the files' notes and felt text with `logger: files`, else null (use the cache). */
export function filesNotes(root: string, cfg?: CoachConfig | null): NotesHistoryEntry[] | null {
  return usesFiles(root, cfg) ? filesNotesHistory(root) : null;
}
