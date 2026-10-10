// CLI subcommands for Tally T3 server limits. Wired into engine/cli.ts in one block.
//
//   node engine/cli.ts limits server-rules [--resolved <file.json|->] [--file <limits.yaml>]
//   node engine/cli.ts limits sync-ops --server <file.json|-> [--resolved <file.json|->] [--file <limits.yaml>]
//
// --resolved: {"<limits.yaml exercise or allow name>": {"exerciseId": "…", "name": "…"}},
// filled by the skill with one search_exercises call.
// --server: a get_training_context result (the tool response or its JSON); - reads stdin.
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CoachError } from "./errors.ts";
import { compileServerRules } from "./limits-compile.ts";
import type { Resolved } from "./limits-compile.ts";
import { serverLimitsFromContext, syncOps } from "./limits-sync.ts";
import { loadLimits } from "./limits.ts";
import { loadTaxonomy } from "./taxonomy.ts";
import { isPlainObject } from "./yaml-file.ts";

const USAGE = "usage: limits server-rules [--resolved <file|->] | limits sync-ops --server <file|-> [--resolved <file|->]";

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function readJson(path: string, what: string): unknown {
  let text: string;
  try {
    text = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  } catch (e) {
    throw new CoachError("INPUT_ERROR", `cannot read ${what} ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CoachError("INPUT_ERROR", `cannot parse ${what} ${path}: ${(e as Error).message}`);
  }
}

function readResolved(path: string | undefined): Resolved {
  if (!path) return {};
  const raw = readJson(path, "--resolved");
  if (!isPlainObject(raw)) throw new CoachError("INPUT_ERROR", "--resolved must be a JSON object of name → {exerciseId, name}");
  const outMap: Resolved = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isPlainObject(v) || typeof v.exerciseId !== "string" || v.exerciseId === "" || typeof v.name !== "string" || v.name === "") {
      throw new CoachError("INPUT_ERROR", `--resolved ${JSON.stringify(k)}: needs {exerciseId, name}`);
    }
    outMap[k] = { exerciseId: v.exerciseId, name: v.name };
  }
  return outMap;
}

/** Returns the exit code, or null when `cmd` is not this brief's command. */
export function limitsCommand(cmd: string, argv: string[]): number | null {
  if (cmd !== "limits") return null;
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: { root: { type: "string" }, file: { type: "string" }, resolved: { type: "string" }, server: { type: "string" } },
  });
  const sub = positionals[0];
  if (sub !== "server-rules" && sub !== "sync-ops") throw new CoachError("USAGE", USAGE);
  if (sub === "sync-ops" && !values.server) throw new CoachError("USAGE", "limits sync-ops needs --server <file|-> (a get_training_context result)");
  if (values.server === "-" && values.resolved === "-") throw new CoachError("USAGE", "only one of --server and --resolved can read stdin");
  const root = resolve(values.root ?? ".");
  const tax = loadTaxonomy({ root });
  const file = values.file ? (isAbsolute(values.file) ? values.file : resolve(values.file)) : join(root, "athlete/limits.yaml");
  const compiled = compileServerRules(loadLimits(file, tax), tax, readResolved(values.resolved));
  const report = { skipped: compiled.skipped, localOnly: compiled.localOnly, unresolved: compiled.unresolved };
  if (sub === "server-rules") {
    out({ rules: compiled.rules, ...report });
    return 0;
  }
  const sync = syncOps({ rules: compiled.rules }, serverLimitsFromContext(readJson(values.server as string, "--server")));
  out({ expectedVersion: sync.expectedVersion, ops: sync.ops, appOnly: sync.appOnly, ...report });
  return 0;
}
