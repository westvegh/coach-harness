// The next free ID from the athlete's files (contracts §0 IDs).
//   block:    B-NNN from athlete/block.yaml and athlete/blocks/*.yaml
//   limit:    L-NNN from athlete/limits.yaml
//   proposal: P-YYYYMMDD-<kind>-<n> from athlete/proposals/ (today in the athlete's timezone)
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ALL_KINDS } from "./config.ts";
import { localDate } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { PROPOSALS_RELATIVE } from "./proposals.ts";
import { isPlainObject, readYamlFile } from "./yaml-file.ts";
import type { ChangeKind, Instant } from "./types.ts";

export type IdKind = "block" | "limit" | "proposal";
export type NextId = { kind: IdKind; id: string; taken: string[] };

const pad3 = (n: number) => String(n).padStart(3, "0");

function idsIn(path: string, pick: (raw: unknown) => unknown[]): string[] {
  if (!existsSync(path)) return [];
  return pick(readYamlFile(path, "INPUT_ERROR")).filter((x): x is string => typeof x === "string");
}

function nextNumbered(prefix: string, taken: string[]): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  const max = taken.reduce((m, id) => Math.max(m, Number(re.exec(id)?.[1] ?? 0)), 0);
  return `${prefix}-${pad3(max + 1)}`;
}

export function nextId(root: string, kind: IdKind, opts: { change?: string; now?: Instant; tz?: string } = {}): NextId {
  if (kind === "block") {
    const taken = idsIn(join(root, "athlete/block.yaml"), (r) => [isPlainObject(r) ? r.id : null]);
    const dir = join(root, "athlete/blocks");
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith(".yaml")) continue;
        taken.push(...idsIn(join(dir, f), (r) => [isPlainObject(r) ? r.id : null]), f.slice(0, -5));
      }
    }
    const ids = [...new Set(taken.filter((t) => /^B-\d+$/.test(t)))].sort();
    return { kind, id: nextNumbered("B", ids), taken: ids };
  }
  if (kind === "limit") {
    const ids = idsIn(join(root, "athlete/limits.yaml"), (r) => (isPlainObject(r) && Array.isArray(r.limits) ? r.limits.map((l) => (isPlainObject(l) ? l.id : null)) : []))
      .filter((t) => /^L-\d+$/.test(t))
      .sort();
    return { kind, id: nextNumbered("L", ids), taken: ids };
  }
  if (kind === "proposal") {
    const change = opts.change;
    if (!change || !ALL_KINDS.includes(change as ChangeKind)) throw new CoachError("USAGE", `ids next --kind proposal needs --change <kind> (${ALL_KINDS.join(" | ")})`);
    const day = localDate(opts.now ?? new Date().toISOString(), opts.tz ?? "UTC").replace(/-/g, "");
    const prefix = `P-${day}-${change}-`;
    const dir = join(root, PROPOSALS_RELATIVE);
    const taken = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".yaml")).map((f) => f.slice(0, -5)).sort() : [];
    // The same rule as createProposal: one more than the highest number taken.
    const n = taken.reduce((m, id) => Math.max(m, Number(id.slice(prefix.length)) || 0), 0) + 1;
    return { kind, id: `${prefix}${n}`, taken };
  }
  throw new CoachError("USAGE", "ids next --kind must be block | limit | proposal");
}
