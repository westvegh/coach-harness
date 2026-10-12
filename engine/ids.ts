// The next free ID from the athlete's files (contracts §0 IDs).
//   block:    B-NNN from athlete/block.yaml and athlete/blocks/*.yaml
//   limit:    L-NNN from athlete/limits.yaml
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CoachError } from "./errors.ts";
import { isPlainObject, readYamlFile } from "./yaml-file.ts";

export type IdKind = "block" | "limit";
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

export function nextId(root: string, kind: IdKind): NextId {
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
  throw new CoachError("USAGE", "ids next --kind must be block | limit");
}
