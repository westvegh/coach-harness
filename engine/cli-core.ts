// The engine CLI's own commands (contracts §13): readiness --input, volume, limits-hash,
// snapshot show, safety and classify. engine/cli.ts dispatches here; each command imports its
// modules when it runs. The usage lines stay in this file.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CoachError } from "./errors.ts";
import type { LoggerTool } from "./logger.ts";
import type { NotesHistoryEntry } from "./safety.ts";
import type { Block, DayPlan, ReadinessInput, Rules, WeekLog, WeekPlan } from "./types.ts";

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

type VolumeInput = { week?: WeekPlan | WeekLog; block?: Block; logs?: WeekLog[]; today?: string; target_week?: number; rules?: Rules; clusters?: unknown };

/**
 * `week` → counted sets per muscle (a cluster counts total reps ÷ its rep max), each cluster with
 * its count, and the straight exercises above the pack's per-exercise session maximum (advisory).
 * `block` + `logs` + `today` → the reference week and the next week's targets. Rules come from
 * `rules` in the input, or else from the method pack named in coach.yaml; `clusters` from the
 * input, or else from coach.yaml.
 */
export async function cmdVolume(argv: string[]): Promise<number> {
  const { values } = opts(argv);
  const [{ loadTaxonomy }, { weeklySetsByMuscle }, { nextWeekTargets, referenceWeek }, { clusterLine, loadClusters }, { sessionMaxCheck, sessionMaxFindings }] = await Promise.all([
    import("./taxonomy.ts"),
    import("./volume.ts"),
    import("./progression.ts"),
    import("./clusters.ts"),
    import("./session-max.ts"),
  ]);
  const root = resolve(values.root ?? ".");
  const input = readJson(requireInput(values.input, "volume")) as VolumeInput;
  if (!isPlainObject(input)) throw new CoachError("INPUT_ERROR", "volume input must be a JSON object");
  const tax = loadTaxonomy({ root });
  const clusters = loadClusters(root, input);
  const result: Record<string, unknown> = {};
  let rules: Rules | null = null;
  const rulesOf = async () => (rules ??= input.rules ?? (await packRules(root)));
  if (input.week) {
    result.sets_by_muscle = weeklySetsByMuscle(input.week, tax, clusters);
    const lines = input.week.days.flatMap((d) =>
      d.exercises.flatMap((e) => {
        const c = clusterLine(e, d.date, clusters);
        return c ? [{ date: d.date, exercise: e.name, ...c }] : [];
      }),
    );
    if (lines.length > 0) result.clusters = lines;
    const check = sessionMaxCheck(await rulesOf());
    const over = check ? sessionMaxFindings(input.week.days as DayPlan[], check, tax, clusters) : [];
    if (over.length > 0) result.session_max = over;
  }
  if (input.block) {
    if (!input.today) throw new CoachError("USAGE", "volume with a block needs today");
    if (!Number.isInteger(input.target_week)) throw new CoachError("USAGE", "volume with a block needs target_week (the block week to plan)");
    const ref = referenceWeek(input.block, input.logs ?? [], input.today);
    result.reference_week = ref?.week_start ?? null;
    result.targets = nextWeekTargets(input.block, ref, await rulesOf(), { tax, week: input.target_week, clusters });
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
  if (positionals[0] === "reset") {
    // V4: the snapshot is a cache; setup empties it after the Tally account question.
    const { resetSnapshot } = await import("./snapshot.ts");
    const root = resolve(values.root ?? ".");
    out({ reset: true, removed: resetSnapshot(root), path: join(root, SNAPSHOT_RELATIVE) });
    return 0;
  }
  if (positionals[0] !== "show") throw new CoachError("USAGE", "usage: snapshot show | snapshot reset");
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
 * history (or --input, a JSON list of history entries) dated on or after `since`. Pain matches
 * are reported only. An urgent term newer than its latest clearance writes, commits and
 * pushes the urgent stop (`source: "note"`; not with --dry-run).
 */
export async function cmdSafety(argv: string[]): Promise<number> {
  const [{ detect, scanSessionNotes, urgentTermsOf }, { isCalendarDate }, urgent] = await Promise.all([import("./safety.ts"), import("./dates.ts"), import("./urgent.ts")]);
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
    let server: string | string[] | null = null;
    if (values.input) history = readJson(values.input);
    else {
      // logger: files: the notes and felt columns of the week files (contracts §12a). logger: other:
      // no cache (V2b fix 4); the coach passes that tool's notes with --input.
      const cs = await import("./coach-snapshot.ts");
      const fromFiles = cs.filesNotes(root);
      const path = join(root, SNAPSHOT_RELATIVE);
      history = fromFiles ?? (cs.loggerOf(root) === "other" ? [] : existsSync(path) ? (readJson(path) as { history?: unknown }).history : []);
      // V4: which Tally connection the scanned sessions came from, so the coach can check it read the chosen account.
      if (!fromFiles && Array.isArray(history)) {
        const servers = [...new Set(history.map((h) => (isPlainObject(h) && typeof h.server === "string" ? h.server : null)).filter((x): x is string => x !== null))].sort();
        server = servers.length === 0 ? null : servers.length === 1 ? servers[0] : servers;
      }
    }
    if (!Array.isArray(history)) throw new CoachError("INPUT_ERROR", "safety scan-notes needs a list of history entries");
    // Urgent terms in notes on or before the latest clearance of the same term were cleared.
    const matches = scanSessionNotes(history as NotesHistoryEntry[], { since: values.since, cleared: urgent.clearedThrough(urgent.readClearances(root)) });
    const terms = urgentTermsOf(matches);
    const stop = terms.length > 0 && !values["dry-run"] ? await urgent.recordStop(root, { terms, source: "note", now: values.now }, { push: true }) : null;
    const scanned = (history as NotesHistoryEntry[]).filter((h) => isPlainObject(h) && (!values.since || String(h.date) >= values.since)).length;
    out({ server, sessions: scanned, matches, urgent_terms: terms, urgent_stop: stop });
    return 0;
  }
  throw new CoachError("USAGE", "usage: safety detect --text <text> | safety scan-notes --since <YYYY-MM-DD> [--input <file>] [--dry-run]  (an urgent term in a note writes, commits and pushes the urgent stop)");
}

// ---------- end safety ----------

// ---------- classify (contracts §6) ----------

/** classify --exercise "<name>" [--id <exerciseId>] [--muscle <m>] | classify --input <file.json> ({before, after, tool, today?, volume?}). */
export async function cmdClassify(argv: string[]): Promise<number> {
  const [{ classifyChange }, { loadConfig }, { localDate }, { readBlock }, { loadRules }, { loadSnapshot }, { classify, loadTaxonomy }] = await Promise.all([
    import("./classify.ts"),
    import("./config.ts"),
    import("./dates.ts"),
    import("./block.ts"),
    import("./methods.ts"),
    import("./snapshot.ts"),
    import("./taxonomy.ts"),
  ]);
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: { root: { type: "string" }, input: { type: "string" }, exercise: { type: "string" }, id: { type: "string" }, muscle: { type: "string" } },
  });
  const root = resolve(values.root ?? ".");
  const tax = loadTaxonomy({ root });
  if (values.exercise) {
    out(classify({ name: values.exercise, exerciseId: values.id ?? null, muscle: values.muscle ?? null }, tax));
    return 0;
  }
  if (!values.input) throw new CoachError("USAGE", "classify needs --exercise <name> or --input <file.json>");
  const input = readJson(values.input) as Record<string, any>;
  const config = loadConfig(join(root, "coach.yaml"));
  const rules = loadRules(join(root, "methods", config.method)) as unknown as Rules;
  // With logger: files the history is the week files (contracts §12a).
  const snap = config.logger === "tally" ? loadSnapshot(root) : (await import("./coach-snapshot.ts")).coachSnapshot(root, { cfg: config });
  const today = typeof input.today === "string" ? input.today : localDate(new Date().toISOString(), config.athlete.timezone);
  const { loadClusters } = await import("./clusters.ts");
  out(
    classifyChange(input.before ?? null, input.after ?? null, {
      block: readBlock(root),
      history: snap?.history ?? [],
      tool: String(input.tool ?? "plan_workout_day") as LoggerTool,
      snapshotDay: input.snapshotDay ?? null,
      tax,
      rules,
      config,
      today,
      clusters: loadClusters(root, input),
      ...(input.volume ? { volume: input.volume } : {}),
    }),
  );
  return 0;
}
