// The engine CLI's own commands (contracts §13): readiness --input, volume, limits-hash,
// snapshot show and safety. engine/cli.ts dispatches here; each command imports its
// modules when it runs. The usage lines stay in this file.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CoachError } from "./errors.ts";
import type { NotesHistoryEntry } from "./safety.ts";
import type { Block, ReadinessInput, Rules, WeekLog, WeekPlan } from "./types.ts";

export const SNAPSHOT_RELATIVE = "athlete/.cache/snapshot.json";

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function opts(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: { root: { type: "string" }, input: { type: "string" }, file: { type: "string" }, now: { type: "string" } },
  });
}

function requireInput(input: string | undefined, cmd: string): string {
  if (!input) throw new CoachError("USAGE", `${cmd} needs --input <file.json>`);
  return input;
}

export async function cmdReadiness(argv: string[]): Promise<number> {
  const { values } = opts(argv);
  const { readiness } = await import("./readiness.ts");
  out(readiness(readJson(requireInput(values.input, "readiness")) as ReadinessInput));
  return 0;
}

type VolumeInput = { week?: WeekPlan | WeekLog; block?: Block; logs?: WeekLog[]; today?: string; target_week?: number; rules?: Rules };

/**
 * `week` → sets per muscle. `block` + `logs` + `today` → the reference week and the next
 * week's targets. Rules come from `rules` in the input, or else from the method pack named
 * in coach.yaml.
 */
export async function cmdVolume(argv: string[]): Promise<number> {
  const { values } = opts(argv);
  const [{ loadTaxonomy }, { weeklySetsByMuscle }, { nextWeekTargets, referenceWeek }] = await Promise.all([import("./taxonomy.ts"), import("./volume.ts"), import("./progression.ts")]);
  const root = resolve(values.root ?? ".");
  const input = readJson(requireInput(values.input, "volume")) as VolumeInput;
  if (!isPlainObject(input)) throw new CoachError("INPUT_ERROR", "volume input must be a JSON object");
  const tax = loadTaxonomy({ root });
  const result: Record<string, unknown> = {};
  if (input.week) result.sets_by_muscle = weeklySetsByMuscle(input.week, tax);
  if (input.block) {
    if (!input.today) throw new CoachError("USAGE", "volume with a block needs today");
    if (!Number.isInteger(input.target_week)) throw new CoachError("USAGE", "volume with a block needs target_week (the block week to plan)");
    const ref = referenceWeek(input.block, input.logs ?? [], input.today);
    result.reference_week = ref?.week_start ?? null;
    result.targets = nextWeekTargets(input.block, ref, input.rules ?? (await packRules(root)), { tax, week: input.target_week });
  }
  if (Object.keys(result).length === 0) throw new CoachError("USAGE", "volume input needs `week`, or `block` + `logs` + `today`");
  out(result);
  return 0;
}

async function packRules(root: string): Promise<Rules> {
  const { readYamlFile } = await import("./yaml-file.ts");
  const cfgPath = join(root, "coach.yaml");
  if (!existsSync(cfgPath)) return { pack: "none", version: 1, rules: [] };
  const cfg = readYamlFile(cfgPath, "CONFIG_INVALID") as { method?: string };
  const p = join(root, "methods", String(cfg?.method ?? ""), "rules.yaml");
  if (!existsSync(p)) return { pack: "none", version: 1, rules: [] };
  return readYamlFile(p, "RULES_INVALID") as Rules;
}

export async function cmdLimitsHash(argv: string[]): Promise<number> {
  const { values } = opts(argv);
  const { limitsHash } = await import("./limits.ts");
  const root = resolve(values.root ?? ".");
  const file = values.file ? (isAbsolute(values.file) ? values.file : resolve(values.file)) : join(root, "athlete/limits.yaml");
  out({ file, hash: limitsHash(file) });
  return 0;
}

export async function cmdSnapshot(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv);
  const { parseInstant } = await import("./dates.ts");
  if (positionals[0] !== "show") throw new CoachError("USAGE", "usage: snapshot show");
  const path = join(resolve(values.root ?? "."), SNAPSHOT_RELATIVE);
  if (!existsSync(path)) {
    out({ exists: false, path });
    return 0;
  }
  const snap = readJson(path);
  if (!isPlainObject(snap) || snap.version !== 1 || typeof snap.session_id !== "string" || !isPlainObject(snap.days)) {
    throw new CoachError("SNAPSHOT_INVALID", `${path} is not a version 1 snapshot`);
  }
  const nowMs = values.now ? parseInstant(values.now, "now") : Date.now();
  const age = (nowMs - parseInstant(snap.captured_at, "captured_at")) / 60_000;
  out({ exists: true, path, age_minutes: Math.round(age * 10) / 10, snapshot: snap });
  return 0;
}

// ---------- safety ----------

/**
 * `safety detect --text <t>`: the matcher's result; writes nothing.
 * `safety scan-notes --since <date>`: scans logged session and exercise notes from the snapshot
 * history (or --input, a JSON list of history entries) dated on or after `since`, and writes
 * the pending file with `source: "session-notes"` on a match (not with --dry-run).
 */
export async function cmdSafety(argv: string[]): Promise<number> {
  const [{ detect, recordSessionNotes, scanSessionNotes }, { isCalendarDate }] = await Promise.all([import("./safety.ts"), import("./dates.ts")]);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: "string" },
      text: { type: "string" },
      input: { type: "string" },
      since: { type: "string" },
      now: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const sub = positionals[0];
  if (sub === "detect") {
    if (values.text === undefined) throw new CoachError("USAGE", "safety detect needs --text <text>");
    out(detect(values.text));
    return 0;
  }
  if (sub === "scan-notes") {
    const root = resolve(values.root ?? ".");
    if (!values.since || !isCalendarDate(values.since)) throw new CoachError("USAGE", "safety scan-notes needs --since <YYYY-MM-DD>");
    let history: unknown;
    if (values.input) history = readJson(values.input);
    else {
      const path = join(root, SNAPSHOT_RELATIVE);
      history = existsSync(path) ? (readJson(path) as { history?: unknown }).history : [];
    }
    if (!Array.isArray(history)) throw new CoachError("INPUT_ERROR", "safety scan-notes needs a list of history entries");
    const matches = scanSessionNotes(history as NotesHistoryEntry[], { since: values.since });
    const pending = values["dry-run"] ? null : recordSessionNotes(root, matches, values.now);
    out({ matches, pending_written: pending !== null, pending });
    return 0;
  }
  throw new CoachError("USAGE", "usage: safety detect --text <text> | safety scan-notes --since <YYYY-MM-DD> [--input <file>] [--dry-run]");
}

// ---------- end safety ----------
