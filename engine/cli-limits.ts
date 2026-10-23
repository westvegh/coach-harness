// CLI subcommands for limits (contracts §2). Wired into engine/cli.ts in one block. Facts
// and reports only: the coach changes athlete/limits.yaml itself, when the athlete asks.
//
//   node engine/cli.ts limits schema                (the limits.yaml entry shape and examples)
//   node engine/cli.ts limits regions               (region ids, and the regions each pattern loads)
//   node engine/cli.ts limits check --input <file.json> [--file <limits.yaml>]
//                                                   ({week: {days}}, {days} or a list; each day in the
//                                                   engine's shape or Tally's; report only)
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CoachError } from "./errors.ts";
import { loadClusters } from "./clusters.ts";
import { checkLimits } from "./limits-check.ts";
import { limitsSchema, regionsReport } from "./limits-schema.ts";
import { loadLimits } from "./limits.ts";
import { loadTaxonomy } from "./taxonomy.ts";
import { inputError, planDaysFrom } from "./input-shapes.ts";
import { readYamlFile } from "./yaml-file.ts";
import type { Units } from "./types.ts";

const USAGE = "usage: limits schema | limits regions | limits check --input <file.json> [--file <limits.yaml>]";

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new CoachError("INPUT_ERROR", `cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CoachError("INPUT_ERROR", `cannot parse ${path}: ${(e as Error).message}`);
  }
}

/** The athlete's units (coach.yaml), the fallback unit of a Tally day; lbs before setup. */
function unitsAt(root: string): Units {
  const p = join(root, "coach.yaml");
  if (!existsSync(p)) return "lbs";
  const u = (readYamlFile(p, "CONFIG_INVALID") as { athlete?: { units?: unknown } } | null)?.athlete?.units;
  return u === "kg" ? "kg" : "lbs";
}

/** Returns the exit code, or null when `cmd` is not `limits`. */
export function limitsCommand(cmd: string, argv: string[]): number | null {
  if (cmd !== "limits") return null;
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: { root: { type: "string" }, file: { type: "string" }, input: { type: "string" } },
  });
  const sub = positionals[0];
  const root = resolve(values.root ?? ".");
  if (sub === "schema") {
    out(limitsSchema());
    return 0;
  }
  if (sub === "regions") {
    out(regionsReport(loadTaxonomy({ root })));
    return 0;
  }
  if (sub === "check") {
    if (!values.input) throw new CoachError("USAGE", "limits check needs --input <file.json> ({week} or {days})");
    const raw = readJson(isAbsolute(values.input) ? values.input : resolve(values.input));
    // W1: each day in the engine's shape or Tally's (converted), checked; input it cannot read is an error, never "ok".
    const where = { cmd: "limits check", file: values.input };
    const days = planDaysFrom(raw, where, unitsAt(root));
    if (!days) throw inputError(where, "", "must be {week: {days}}, {days} or a list of days");
    const tax = loadTaxonomy({ root });
    const file = values.file ? (isAbsolute(values.file) ? values.file : resolve(values.file)) : join(root, "athlete/limits.yaml");
    // Clusters count their counted sets (0.2.4): the input's list, else coach.yaml's.
    const findings = checkLimits(days, loadLimits(file, tax), tax, loadClusters(root, raw));
    out({ ok: findings.every((f) => f.kind === "unclassified"), findings });
    return 0;
  }
  throw new CoachError("USAGE", USAGE);
}
