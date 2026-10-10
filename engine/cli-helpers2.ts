// CLI commands for the engine helpers the skills need (contracts §22).
// engine/cli.ts dispatches here first. Output is JSON on stdout; errors are thrown as
// CoachError (cli.ts prints them), except `signals refresh`, which is async and prints its own.
//
//   readiness --date <YYYY-MM-DD> [--now <instant>]
//   weeks --from <YYYY-MM-DD> --to <YYYY-MM-DD>
//   block draft [--template <id>] --weeks <n> [--input <file.json>] [--now <instant>]
//   block write --input <block.json> --proposal <id>   (only on proposal/<id>; launch review finding 2)
//   ids next --kind block|limit|proposal [--change <kind>] [--now <instant>]
//   signals refresh
//   lint-methods [--pack <name>] [--volume]                         (exit 1: the pack has errors)
//
// (hold init lives in engine/hold.ts; adjust/loads --from-snapshot in engine/cli-helpers.ts.)
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
      change: { type: "string" },
      pack: { type: "string" },
      proposal: { type: "string" },
      volume: { type: "boolean" },
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
  const root = rootOf(a);
  const cfg = await config(root);
  const [{ readinessForDate }, { loadSnapshot }] = await Promise.all([import("./readiness-date.ts"), import("./snapshot.ts")]);
  out(readinessForDate({ root, date: a.values.date!, now: await nowOf(a), config: cfg, rules: await packRules(root, cfg), snapshot: loadSnapshot(root) }));
  return 0;
}

async function cmdWeeks(a: Args): Promise<number> {
  if (!a.values.from || !a.values.to) throw new CoachError("USAGE", "usage: weeks --from <YYYY-MM-DD> --to <YYYY-MM-DD>");
  const [{ weeksFromSnapshot }, { loadSnapshot }] = await Promise.all([import("./weeks.ts"), import("./snapshot.ts")]);
  out(weeksFromSnapshot(loadSnapshot(rootOf(a)), a.values.from, a.values.to));
  return 0;
}

/** block write: the drafted block to athlete/block.yaml, only on the branch proposal/<id>. */
async function cmdBlockWrite(a: Args): Promise<number> {
  if (!a.values.input || !a.values.proposal) throw new CoachError("USAGE", "usage: block write --input <block.json> --proposal <id>");
  const raw = readJsonFile(a.values.input);
  const block = isPlainObject(raw) && isPlainObject(raw.block) ? raw.block : raw;
  out((await import("./proposals.ts")).writeBlockOnBranch(a.values.proposal, block, { root: rootOf(a) }));
  return 0;
}

async function cmdBlockDraft(a: Args): Promise<number> {
  if (a.positionals[0] === "write") return cmdBlockWrite(a);
  if (a.positionals[0] !== "draft") throw new CoachError("USAGE", "usage: block draft [--template <id>] --weeks <n> [--input <file.json>] | block write --input <block.json> --proposal <id>");
  const root = rootOf(a);
  const cfg = await config(root);
  const [{ draftBlock, templateIdFor, todayIn }, { loadTemplates }, { loadTaxonomy }] = await Promise.all([import("./block-draft.ts"), import("./methods.ts"), import("./taxonomy.ts")]);
  const packDir = join(root, "methods", cfg.method);
  const templates = loadTemplates(packDir);
  const id = a.values.template ?? templateIdFor(cfg.template.days);
  const template = templates[id];
  if (!template) throw new CoachError("USAGE", `methods/${cfg.method} has no template ${id} (have: ${Object.keys(templates).join(", ")})`);
  const weeks = Number(a.values.weeks);
  if (!a.values.weeks || !Number.isInteger(weeks)) throw new CoachError("USAGE", "block draft needs --weeks <n>");
  const input = a.values.input ? readJsonFile(a.values.input) : {};
  if (!isPlainObject(input)) throw new CoachError("INPUT_ERROR", "block draft --input must be a JSON object");
  // Logged weeks from the snapshot: week 1 is capped against the reference week, as the guard checks it.
  const [{ loadSnapshot }, { historyWeeks }] = await Promise.all([import("./snapshot.ts"), import("./validate.ts")]);
  const snap = loadSnapshot(root);
  const draft = draftBlock(
    template,
    weeks,
    {
      tax: loadTaxonomy({ root }),
      rules: await packRules(root, cfg),
      units: cfg.athlete.units,
      method: cfg.method,
      today: todayIn(cfg.athlete.timezone, a.values.now),
      emphasis: cfg.template.emphasis,
      templateId: id,
      history: snap ? historyWeeks(snap, cfg.athlete.units) : undefined,
    },
    input as BlockDraftInput,
  );
  out({ template: id, ...draft });
  return 0;
}

async function cmdIds(a: Args): Promise<number> {
  if (a.positionals[0] !== "next") throw new CoachError("USAGE", "usage: ids next --kind block|limit|proposal [--change <kind>]");
  const root = rootOf(a);
  const kind = a.values.kind as IdKind;
  if (!["block", "limit", "proposal"].includes(kind)) throw new CoachError("USAGE", "ids next --kind must be block | limit | proposal");
  const cfg = await maybeConfig(root);
  const { nextId } = await import("./ids.ts");
  out(nextId(root, kind, { change: a.values.change, now: await nowOf(a), tz: cfg?.athlete.timezone ?? "UTC" }));
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
