// CLI commands for the engine helpers the skills need (contracts §22).
// engine/cli.ts dispatches here first. Output is JSON on stdout; errors are thrown as
// CoachError (cli.ts prints them), except `signals refresh`, which is async and prints its own.
//
//   readiness --date <YYYY-MM-DD> [--now <instant>]
//   weeks --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--input <{clusters}.json>]
//   block draft [--template <id>] --weeks <n> [--input <file.json>] [--out <dir>] [--now <instant>]
//   block write --input <dir>/block.json
//   ids next --kind block|limit [--now <instant>]
//   signals refresh
//   lint-methods [--pack <name>] [--volume]                         (exit 1: the pack has errors)
//
// (adjust/loads --from-snapshot live in engine/cli-helpers.ts.)
// Every command takes --root <dir> (default: the current directory).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isHelpers2Command } from "./cli-help.ts";
import { CoachError } from "./errors.ts";
// Every other engine module is imported inside the command that uses it.
import type { BlockDraftInput } from "./block-draft.ts";
import type { IdKind } from "./ids.ts";
import type { CoachConfig, Rules } from "./types.ts";

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function args(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: "string" },
      date: { type: "string" },
      now: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      template: { type: "string" },
      weeks: { type: "string" },
      input: { type: "string" },
      kind: { type: "string" },
      pack: { type: "string" },
      volume: { type: "boolean" },
      out: { type: "string" },
    },
  });
}
type Args = ReturnType<typeof args>;

const rootOf = (a: Args) => resolve(a.values.root ?? ".");
async function nowOf(a: Args): Promise<string> {
  const n = a.values.now ?? new Date().toISOString();
  (await import("./dates.ts")).parseInstant(n, "--now");
  return n;
}

async function config(root: string): Promise<CoachConfig> {
  const p = join(root, "coach.yaml");
  if (!existsSync(p)) throw new CoachError("MISSING_FILE", "coach.yaml is missing: run the setup skill first");
  return (await import("./config.ts")).loadConfig(p);
}

const maybeConfig = async (root: string) => (existsSync(join(root, "coach.yaml")) ? await config(root) : null);

async function packRules(root: string, cfg: CoachConfig): Promise<Rules> {
  const dir = join(root, "methods", cfg.method);
  if (!existsSync(join(dir, "rules.yaml"))) throw new CoachError("MISSING_FILE", `methods/${cfg.method}/rules.yaml is missing`);
  return (await import("./methods.ts")).loadRules(dir) as unknown as Rules;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CoachError("INPUT_ERROR", `cannot read ${path}: ${(e as Error).message}`);
  }
}

async function cmdReadinessDate(a: Args): Promise<number> {
  out(await readinessDateResult(rootOf(a), a.values.date!, await nowOf(a)));
  return 0;
}

/** V7: the `readiness --date` result (today-brief --stage post calls the same code). */
export async function readinessDateResult(root: string, date: string, now: string) {
  const cfg = await config(root);
  const [{ readinessForDate }, { coachSnapshot }] = await Promise.all([import("./readiness-date.ts"), import("./coach-snapshot.ts")]);
  return readinessForDate({ root, date, now, config: cfg, rules: await packRules(root, cfg), snapshot: coachSnapshot(root, { now, cfg }) });
}

async function cmdWeeks(a: Args): Promise<number> {
  if (!a.values.from || !a.values.to) throw new CoachError("USAGE", "usage: weeks --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--input <{clusters}.json>]");
  const root = rootOf(a);
  const [{ weeksFromSnapshot }, { coachSnapshot }, { loadClusters }, { weeklySetsByMuscle }, { loadTaxonomy }] = await Promise.all([
    import("./weeks.ts"),
    import("./coach-snapshot.ts"),
    import("./clusters.ts"),
    import("./volume.ts"),
    import("./taxonomy.ts"),
  ]);
  // With logger: files the week files are the record (contracts §12a).
  const res = weeksFromSnapshot(coachSnapshot(root, { now: await nowOf(a), cfg: await maybeConfig(root) }), a.values.from, a.values.to);
  // 0.2.4: each week's counted sets per muscle (a cluster counts total reps ÷ its rep max).
  const tax = loadTaxonomy({ root });
  // The list: --input's `clusters` (for example before coach.yaml exists), else coach.yaml's.
  const clusters = loadClusters(root, a.values.input ? readJsonFile(a.values.input) : undefined);
  out({ ...res, logs: res.logs.map((w) => ({ ...w, sets_by_muscle: weeklySetsByMuscle(w, tax, clusters) })) });
  return 0;
}

const BLOCK_USAGE = "usage: block draft [--template <id>] --weeks <n> [--input <file.json>] [--out <dir>] | block write --input <dir>/block.json";

/**
 * The draft's settings. With coach.yaml: method, units, timezone and logger from it; days from
 * --template, else coach.yaml; emphasis from the input, else coach.yaml. Before coach.yaml
 * exists (setup), the input gives all six. An error only names a value with no source.
 */
export function draftSettings(cfg: CoachConfig | null, input: BlockDraftInput, template: string | undefined) {
  const missing: string[] = [];
  const method = cfg?.method ?? input.method;
  const units = cfg?.athlete.units ?? input.units;
  const timezone = cfg?.athlete.timezone ?? input.timezone;
  const logger = cfg ? cfg.logger : input.logger;
  const fromTemplate = template !== undefined && /^\d+-day$/.test(template) ? Number(template.split("-")[0]) : undefined;
  const days = fromTemplate ?? cfg?.template.days ?? input.days;
  const emphasis = input.emphasis ?? cfg?.template.emphasis;
  if (typeof method !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(method)) missing.push("method (a folder under methods/)");
  if (units !== "lbs" && units !== "kg") missing.push("units (lbs or kg)");
  if (typeof timezone !== "string" || timezone === "") missing.push("timezone (for example America/Los_Angeles)");
  else {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      missing.push(`timezone (${timezone} is not a timezone)`);
    }
  }
  if (!["tally", "files", "none", "other"].includes(String(logger))) missing.push("logger (tally, files or none)");
  if (template === undefined && ![3, 4, 5].includes(Number(days))) missing.push("days (3, 4 or 5) or --template");
  if (typeof emphasis !== "string") missing.push("emphasis (all-around, strength, hypertrophy, endurance or general-health)");
  if (missing.length > 0) {
    throw new CoachError(cfg ? "INPUT_ERROR" : "MISSING_FILE", `block draft needs ${missing.join(", ")}${cfg ? "" : ": coach.yaml does not exist yet, so the --input file must give them (node engine/cli.ts help block draft)"}`);
  }
  return { method: method as string, units: units as "lbs" | "kg", timezone: timezone as string, logger: logger as "tally" | "files" | "none" | "other", days: Number(days), emphasis: emphasis as CoachConfig["template"]["emphasis"] };
}

async function cmdBlockDraft(a: Args): Promise<number> {
  if (a.positionals[0] === "write") return cmdBlockWrite(a);
  if (a.positionals[0] !== "draft") throw new CoachError("USAGE", BLOCK_USAGE);
  const root = rootOf(a);
  const cfg = await maybeConfig(root);
  const input = a.values.input ? readJsonFile(a.values.input) : {};
  if (!isPlainObject(input)) throw new CoachError("INPUT_ERROR", "block draft --input must be a JSON object");
  const set = draftSettings(cfg, input as BlockDraftInput, a.values.template);
  const [{ draftBlock, effectiveStep, templateIdFor, todayIn }, { loadTemplates }, { loadTaxonomy }] = await Promise.all([import("./block-draft.ts"), import("./methods.ts"), import("./taxonomy.ts")]);
  const packDir = join(root, "methods", set.method);
  if (!existsSync(join(packDir, "rules.yaml"))) throw new CoachError("MISSING_FILE", `methods/${set.method}/rules.yaml is missing`);
  const templates = loadTemplates(packDir);
  const id = a.values.template ?? templateIdFor(set.days);
  const template = templates[id];
  if (!template) throw new CoachError("USAGE", `methods/${set.method} has no template ${id} (have: ${Object.keys(templates).join(", ")})`);
  const weeks = Number(a.values.weeks);
  if (!a.values.weeks || !Number.isInteger(weeks)) throw new CoachError("USAGE", "block draft needs --weeks <n>");
  const now = await nowOf(a);
  // Logged weeks: week 1 is capped against the reference week. Before coach.yaml exists, the
  // input's logger says where they are: tally (the cache), files (plans/), none (no history; a
  // leftover Tally cache is ignored).
  const [{ coachSnapshot }, { snapshotWeeks }, { loadSnapshot }, { filesSnapshot }] = await Promise.all([import("./coach-snapshot.ts"), import("./weeks.ts"), import("./snapshot.ts"), import("./plans-files.ts")]);
  const snap = cfg
    ? coachSnapshot(root, { now, cfg })
    : set.logger === "tally"
      ? loadSnapshot(root)
      : set.logger === "files"
        ? filesSnapshot(root, { units: set.units, timezone: set.timezone, now })
        : null;
  const rules = (await import("./methods.ts")).loadRules(packDir) as unknown as Rules;
  // Clusters (0.2.4): the input's list (setup, before coach.yaml), else coach.yaml's.
  const clusters = (await import("./clusters.ts")).loadClusters(root, input);
  const draft = draftBlock(
    template,
    weeks,
    {
      tax: loadTaxonomy({ root }),
      rules,
      units: set.units,
      method: set.method,
      today: todayIn(set.timezone, a.values.now),
      emphasis: set.emphasis,
      templateId: id,
      history: snap ? snapshotWeeks(snap, set.units) : undefined,
      clusters,
    },
    input as BlockDraftInput,
  );
  if (!a.values.out) {
    out({ template: id, ...draft });
    return 0;
  }
  const { draftWhy, writeDraftFiles } = await import("./block-files.ts");
  const weekdays = draft.block.days.map((d) => d.day);
  // Only a list the input carries travels with the week files (setup, before coach.yaml exists): a
  // copy of coach.yaml's list would win over a later edit of coach.yaml.
  const carried = "clusters" in input && input.clusters !== undefined ? clusters : null;
  out(writeDraftFiles(a.values.out, { template: id, ...draft }, draftWhy(template, weekdays, draft), effectiveStep(rules, input as BlockDraftInput), carried));
  return 0;
}

async function cmdBlockWrite(a: Args): Promise<number> {
  if (!a.values.input) throw new CoachError("USAGE", "block write needs --input <dir>/block.json (the block from block draft --out)");
  const { writeBlock } = await import("./block-files.ts");
  out(writeBlock(rootOf(a), readJsonFile(a.values.input)));
  return 0;
}

async function cmdIds(a: Args): Promise<number> {
  if (a.positionals[0] !== "next") throw new CoachError("USAGE", "usage: ids next --kind block|limit");
  const root = rootOf(a);
  const kind = a.values.kind as IdKind;
  if (!["block", "limit"].includes(kind)) throw new CoachError("USAGE", "ids next --kind must be block | limit");
  const { nextId } = await import("./ids.ts");
  out(nextId(root, kind));
  return 0;
}

async function cmdSignalsRefresh(a: Args): Promise<number> {
  try {
    const root = rootOf(a);
    const { refreshSignals } = await import("./signals-refresh.ts");
    out(await refreshSignals(root, await maybeConfig(root)));
    return 0;
  } catch (e) {
    const err = e instanceof CoachError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: "signals refresh failed" };
    out({ error: err });
    process.stderr.write(`${err.code}: ${err.message}\n`);
    return 1;
  }
}

async function cmdLintMethods(a: Args): Promise<number> {
  const root = rootOf(a);
  const pack = a.values.pack ?? (await maybeConfig(root))?.method ?? "nine-adaptations";
  const { lintPack } = await import("./lint-methods.ts");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(pack)) throw new CoachError("USAGE", `--pack must be a folder name under methods/, got ${pack}`);
  const dir = join(root, "methods", pack);
  if (!existsSync(dir)) throw new CoachError("USAGE", `no method pack at methods/${pack}`);
  const local = join(root, "engine/movements.yaml");
  let res;
  try {
    res = lintPack(dir, existsSync(local) ? { taxonomyPath: local } : {});
  } catch (e) {
    throw new CoachError((e as { code?: string }).code ?? "LINT_ERROR", (e as Error).message);
  }
  out({ pack, ok: res.errors.length === 0, errors: res.errors, warnings: res.warnings, ...(a.values.volume ? { volume: res.volume } : {}) });
  return res.errors.length === 0 ? 0 : 1;
}

export { HELP, helpCommand } from "./cli-help.ts";

/**
 * Runs an engine helper command. Returns null when `cmd` (with these arguments) is not one of
 * them: `readiness` without --date and `signals` without `refresh` stay with cli.ts.
 */
export function helpers2Command(cmd: string, argv: string[]): Promise<number> | null {
  if (!isHelpers2Command(cmd, argv)) return null;
  const a = args(cmd === "signals" ? argv.slice(1) : argv);
  switch (cmd) {
    case "readiness":
      return cmdReadinessDate(a);
    case "weeks":
      return cmdWeeks(a);
    case "block":
      return cmdBlockDraft(a);
    case "ids":
      return cmdIds(a);
    case "signals":
      return cmdSignalsRefresh(a);
    case "lint-methods":
      return cmdLintMethods(a);
  }
  return null;
}
