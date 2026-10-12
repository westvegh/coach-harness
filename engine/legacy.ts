// v0.1 safety files in a v0.2 copy (docs/build/v0.2-trust-the-coach.md, "Migration").
// athlete/hold.yaml and athlete/.safety-pending no longer gate anything. session-context
// classifies them before the first training write: an urgent hold (the flag, or an urgent
// term or the word "urgent" in its reason) or urgent terms in the pending file become
// athlete/.urgent-stop first. Then the coach asks whether to remove the old files.
// Removing them never clears a converted urgent stop.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { localDate } from "./dates.ts";
import { detect, loadSafetyTerms } from "./safety.ts";
import { clearedThrough, OTHER_TERM, readClearances } from "./urgent.ts";
import { isPlainObject } from "./yaml-file.ts";

export const LEGACY_HOLD = "athlete/hold.yaml";
export const LEGACY_PENDING = "athlete/.safety-pending";

export type LegacyReport = {
  /** The legacy files that exist (relative paths). */
  files: string[];
  /** Urgent terms they hold that no later clearance covers. */
  urgent: string[];
  /** A short description for the coach: active hold, regions, pending terms. Never the reason text. */
  summary: string[];
};

/** The file's text; null when it does not exist; `unreadable` when it exists but cannot be read (a folder, no permission, an I/O error). */
function readText(root: string, rel: string): string | null | { unreadable: string } {
  const p = join(root, rel);
  let present: boolean;
  try {
    present = existsSync(p);
  } catch (e) {
    return { unreadable: (e as Error).message };
  }
  if (!present) return null;
  try {
    return readFileSync(p, "utf8");
  } catch (e) {
    return { unreadable: (e as NodeJS.ErrnoException).code ?? (e as Error).message };
  }
}

/** Classifies the legacy files. Never throws: an unreadable file is listed and counts as urgent (it may hold one). */
export function classifyLegacy(root: string, tz = "UTC"): LegacyReport {
  const files: string[] = [];
  const found: { terms: string[]; at: string | null }[] = [];
  const summary: string[] = [];
  const urgentNames = new Set(loadSafetyTerms().urgent.map((e) => e.term));
  const holdText = readText(root, LEGACY_HOLD);
  if (typeof holdText === "object" && holdText !== null) {
    // The file exists but cannot be read: it may hold an urgent hold, so it stops.
    files.push(LEGACY_HOLD);
    summary.push(`a hold file that cannot be read (${holdText.unreadable})`);
    found.push({ terms: [OTHER_TERM], at: null });
  } else if (holdText !== null) {
    files.push(LEGACY_HOLD);
    try {
      const h: unknown = parse(holdText);
      if (isPlainObject(h) && h.active === true) {
        const reason = typeof h.reason === "string" ? h.reason : "";
        const terms = detect(reason).urgent;
        const urgent = h.urgent === true || /\burgent\b/i.test(reason) || terms.length > 0;
        const regions = Array.isArray(h.regions) ? h.regions.filter((r): r is string => typeof r === "string") : [];
        summary.push(`an active ${urgent ? "urgent " : ""}hold${regions.length ? ` (regions: ${regions.join(", ")})` : " (no regions)"}`);
        if (urgent) found.push({ terms: terms.length > 0 ? terms : [OTHER_TERM], at: typeof h.set_at === "string" ? h.set_at : null });
      } else summary.push("an inactive hold file");
    } catch {
      summary.push("a hold file that does not parse");
      found.push({ terms: [OTHER_TERM], at: null });
    }
  }
  const pendingText = readText(root, LEGACY_PENDING);
  if (typeof pendingText === "object" && pendingText !== null) {
    files.push(LEGACY_PENDING);
    summary.push(`a pending safety file that cannot be read (${pendingText.unreadable})`);
    found.push({ terms: [OTHER_TERM], at: null });
  } else if (pendingText !== null) {
    files.push(LEGACY_PENDING);
    try {
      const p: unknown = JSON.parse(pendingText);
      const terms = isPlainObject(p) && Array.isArray(p.terms) ? p.terms.filter((t): t is string => typeof t === "string") : [];
      const urgent = terms.filter((t) => urgentNames.has(t));
      summary.push(`a pending safety check (${terms.filter((t) => !t.startsWith("region:")).length} term(s))`);
      if (urgent.length > 0) found.push({ terms: urgent, at: isPlainObject(p) && typeof p.at === "string" ? p.at : null });
    } catch {
      summary.push("a pending safety file that does not parse");
      found.push({ terms: [OTHER_TERM], at: null });
    }
  }
  // A clearance on or after the legacy event's date already covers the term.
  const cleared = clearedThrough(readClearances(root));
  const urgent = new Set<string>();
  for (const f of found) {
    let day: string | null = null;
    try {
      day = f.at ? localDate(f.at, tz) : null;
    } catch {
      day = null;
    }
    for (const t of f.terms) {
      const c = cleared.get(t);
      if (c && (!day || c >= day)) continue;
      urgent.add(t);
    }
  }
  return { files, urgent: [...urgent], summary };
}
