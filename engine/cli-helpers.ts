// CLI commands for the coaching helpers and automation (contracts §15). engine/cli.ts
// dispatches here. Output is JSON on stdout; errors are thrown as CoachError.
//
//   mode
//   opid --date <YYYY-MM-DD> --kind <kind> --input <call.json>          (call: {tool, args})
//   adjust --input <file.json>       ({day, decision: trim|recovery, planned_minutes?})
//   adjust --from-snapshot <date> --decision trim|recovery [--planned-minutes n] [--session <id>] [--now <instant>]
//   adjust --decision trim|recovery < tally-day.json       (a raw Tally day on stdin)
//   loads --input <file.json>        ({exercises, history?}; history defaults to the snapshot's)
//   loads --from-snapshot <date>  |  loads < tally-day.json
//   loads --input <week file> --fill [--history <file>]   (fills the week file in place)
//   tally-days --input <week file>   (one plan_workout_day input per date)
//   targets --input <file.json>      ({block, logs, today, target_week})
//   routine-body --kind daily|weekly --repo-url <https://github.com/o/r>
//                (--discover | --connections <file.json> | --connector-uuid <uuid> [--connector-name Tally_Workout])
//                [--environment-id env_…] [--model <id>] [--disabled] [--now <instant>]
//   launchd-plist --kind daily|weekly [--repo-path <abs path>] [--claude <abs path>]
//   install-launchd --kind daily|weekly|both [--yes] [--load] [--claude <abs path>]
//   window-check --kind daily|weekly [--now <instant>]     (exit 4: unattended run outside the window)
//
// Every command takes --root <dir> (default: the current directory).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CoachError } from "./errors.ts";
// Every other engine module is imported inside the command that uses it:
// a command loads only its own modules, so the CLI starts fast.
import type { TallyDayPlan, TallyExerciseEntry } from "./tally-shape.ts";
import type { Connector, RoutineKind } from "./automation.ts";
import type { LoadSuggestion, SessionHistory } from "./loads.ts";
import type { Template } from "./methods.ts";
import type { OpKind } from "./opid.ts";
import type { Block, CoachConfig, DayPlan, Limits, Rules, Snapshot, Units, WeekLog } from "./types.ts";

/** A plain object (not null, not an array). The same test as yaml-file.ts, without loading yaml. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The Tally connector URL (automation.ts TALLY_CONNECTOR_URL; a test checks they agree). */
export const TALLY_URL = "https://mcp.tallyworkout.app/api/mcp";

import { HELPER_COMMANDS } from "./cli-help.ts";
export { HELPER_COMMANDS };

/** Exit code of window-check when an unattended run is outside its window. */
export const EXIT_OUTSIDE_WINDOW = 4;

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

function args(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: "string" },
      input: { type: "string" },
      id: { type: "string" },
      date: { type: "string" },
      kind: { type: "string" },
      "repo-url": { type: "string" },
      connections: { type: "string" },
      "connector-uuid": { type: "string" },
      "connector-name": { type: "string" },
      "environment-id": { type: "string" },
      model: { type: "string" },
      disabled: { type: "boolean" },
      discover: { type: "boolean" },
      now: { type: "string" },
      "repo-path": { type: "string" },
      yes: { type: "boolean" },
      claude: { type: "string" },
      load: { type: "boolean" },
      "tool-prefix": { type: "string" },
      // adjust and loads read a Tally day from the snapshot or stdin.
      "from-snapshot": { type: "string" },
      decision: { type: "string" },
      "planned-minutes": { type: "string" },
      session: { type: "string" },
      // loads --fill fills a week file in place; --history is a normalized history file.
      fill: { type: "boolean" },
      history: { type: "string" },
    },
  });
}

type Args = ReturnType<typeof args>;

function need(v: string | undefined, what: string): string {
  if (!v) throw new CoachError("USAGE", `needs ${what}`);
  return v;
}

function input(a: Args, cmd: string): Record<string, unknown> {
  const v = readJson(need(a.values.input, `--input <file.json> (${cmd})`));
  if (!isPlainObject(v)) throw new CoachError("INPUT_ERROR", `${cmd} input must be a JSON object`);
  return v;
}

const rootOf = (a: Args) => resolve(a.values.root ?? ".");
async function config(root: string): Promise<CoachConfig> {
  const { loadConfig } = await import("./config.ts");
  return loadConfig(join(root, "coach.yaml"));
}

async function limitsAt(root: string): Promise<Limits> {
  const p = join(root, "athlete/limits.yaml");
  if (!existsSync(p)) return { version: 1, pain_threshold: 4, limits: [] };
  const { loadLimits } = await import("./limits.ts");
  return loadLimits(p);
}

async function rulesAt(root: string, cfg: CoachConfig | null): Promise<Rules> {
  const p = cfg ? join(root, "methods", cfg.method, "rules.yaml") : "";
  if (!cfg || !existsSync(p)) return { pack: "none", version: 1, rules: [] };
  const { readYamlFile } = await import("./yaml-file.ts");
  return readYamlFile(p, "RULES_INVALID") as Rules;
}

async function templateAt(root: string, cfg: CoachConfig | null): Promise<Template | undefined> {
  if (!cfg) return undefined;
  const dir = join(root, "methods", cfg.method);
  if (!existsSync(join(dir, "templates"))) return undefined;
  const { loadTemplates } = await import("./methods.ts");
  return loadTemplates(dir)[`${cfg.template.days}-day`];
}

const maybeConfig = async (root: string) => (existsSync(join(root, "coach.yaml")) ? await config(root) : null);

async function cmdOpid(a: Args): Promise<number> {
  const { opId } = await import("./opid.ts");
  const call = readJson(need(a.values.input, "--input <call.json>"));
  if (!isPlainObject(call)) throw new CoachError("INPUT_ERROR", "the call must be {tool, args}");
  out({ opid: opId(need(a.values.date, "--date"), need(a.values.kind, "--kind") as OpKind, call as { tool: string; args: unknown }) });
  return 0;
}

function readStdin(): unknown {
  let text: string;
  try {
    text = readFileSync(0, "utf8");
  } catch (e) {
    throw new CoachError("INPUT_ERROR", `cannot read stdin: ${(e as Error).message}`);
  }
  if (text.trim() === "") throw new CoachError("USAGE", "needs --input <file.json>, --from-snapshot <date>, or a Tally day on stdin");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CoachError("INPUT_ERROR", `cannot parse stdin: ${(e as Error).message}`);
  }
}

/** The session this command runs in: --session, else CLAUDE_CODE_SESSION_ID. */
function sessionOf(a: Args): string | null {
  return a.values.session ?? (process.env.CLAUDE_CODE_SESSION_ID || null);
}

type DayInput = { inp: Record<string, unknown>; day: DayPlan | TallyDayPlan | null; tally: boolean; unit: Units; snap: Snapshot | null };

/**
 * The day for adjust or loads: `--from-snapshot <date>` reads the snapshot day;
 * otherwise --input or stdin. A Tally-shaped day (alone, or as `day`) is converted; `tally`
 * is then true and the output carries the day back in Tally's shape. A snapshot day must be
 * from this session and read in the last 15 minutes, or it is refused.
 */
async function dayInput(a: Args, root: string, units: Units, cmd: string): Promise<DayInput> {
  const { asTallyDay, snapshotDayToPlan, tallyDayToPlan, tallyDayUnit } = await import("./tally-shape.ts");
  const { loadSnapshot, snapshotProblems } = await import("./snapshot.ts");
  const date = a.values["from-snapshot"];
  if (date) {
    // logger: files: the week files are the record and are always current (contracts §12a).
    const { coachSnapshot, loggerOf, usesFiles } = await import("./coach-snapshot.ts");
    if (loggerOf(root) === "other") throw new CoachError("NO_SNAPSHOT", "logger: other: the engine cannot read that tool; pass the day as --input <file.json> (or on stdin)");
    if (usesFiles(root)) {
      const snap = coachSnapshot(root, { now: a.values.now });
      const sd = snap?.days[date];
      if (!snap || !sd || !sd.found) throw new CoachError("NOT_PLANNED", `${date} has no planned day in plans/: write it with plans write first`);
      return { inp: {}, day: snapshotDayToPlan(date, sd, units), tally: true, unit: tallyDayUnit(sd, units), snap };
    }
    const snap = loadSnapshot(root);
    if (!snap) throw new CoachError("NO_SNAPSHOT", "no snapshot: read the day with get_planned_workout first");
    const sd = snap.days[date];
    if (!sd) throw new CoachError("NOT_IN_SNAPSHOT", `${date} is not in the snapshot: read it with get_planned_workout first`);
    const session = sessionOf(a);
    if (!session) throw new CoachError("SESSION_UNKNOWN", "--from-snapshot needs this session's id (CLAUDE_CODE_SESSION_ID or --session <id>) to check the snapshot is this session's");
    const problems = snapshotProblems(snap, session, a.values.now ?? new Date().toISOString(), [date]);
    if (problems.length > 0) throw new CoachError("SNAPSHOT_STALE", problems.join("; "));
    return { inp: {}, day: snapshotDayToPlan(date, sd, units), tally: true, unit: tallyDayUnit(sd, units), snap };
  }
  const raw = a.values.input ? readJson(a.values.input) : readStdin();
  // W1: the day is checked in plan mode (engine/input-shapes.ts): the engine's shape or Tally's,
  // never mixed; a value it cannot read is INPUT_ERROR with its path.
  const { planDay } = await import("./input-shapes.ts");
  const where = { cmd, file: a.values.input ?? "stdin" };
  const td = asTallyDay(raw);
  const wrapped = isPlainObject(raw) && isPlainObject(raw.day) && !Array.isArray(raw.exercises);
  if (td) {
    const { day, tally } = planDay(td, where, wrapped ? "day" : "", units, { empty: "tally" });
    return { inp: wrapped ? (raw as Record<string, unknown>) : {}, day, tally, unit: tally ? tallyDayUnit(td, units) : units, snap: null };
  }
  if (!isPlainObject(raw)) throw new CoachError("INPUT_ERROR", "the input must be a JSON object or a Tally day");
  const inner = isPlainObject(raw.day) ? asTallyDay(raw.day) : null;
  if (inner) return { inp: raw, day: tallyDayToPlan(inner, { units, where, path: "day" }), tally: true, unit: tallyDayUnit(inner, units), snap: null };
  return { inp: raw, day: raw.day === undefined ? null : planDay(raw.day, where, "day", units).day, tally: false, unit: units, snap: null };
}

async function cmdAdjust(a: Args): Promise<number> {
  out(await computeAdjust(a));
  return 0;
}

/** V7: the adjust result for these arguments, as `adjust` prints it (today-brief calls the same code). */
export async function adjustFor(argv: string[]): Promise<Record<string, unknown>> {
  return computeAdjust(args(argv));
}

async function computeAdjust(a: Args): Promise<Record<string, unknown>> {
  const root = rootOf(a);
  const cfg = await maybeConfig(root);
  const { inp, day, tally } = await dayInput(a, root, cfg?.athlete.units ?? "lbs", "adjust");
  if (!day) throw new CoachError("INPUT_ERROR", `${a.values.input ?? "stdin"}: adjust needs a day ({day, decision}, a Tally day, or --from-snapshot <date>); see node engine/cli.ts help adjust`);
  const [{ adjustDay }, { loadTaxonomy }, { planToTallyDay }] = await Promise.all([import("./adjust.ts"), import("./taxonomy.ts"), import("./tally-shape.ts")]);
  const decision = a.values.decision ?? inp.decision;
  const pm = a.values["planned-minutes"] !== undefined ? Number(a.values["planned-minutes"]) : inp.planned_minutes;
  const tax = loadTaxonomy({ root });
  const { loadClusters } = await import("./clusters.ts");
  const res = adjustDay(day as DayPlan, decision as "trim" | "recovery", {
    tax,
    clusters: loadClusters(root, inp),
    thresholds: { ...(cfg?.thresholds ?? {}) },
    template: await templateAt(root, cfg),
    limits: await limitsAt(root),
    ...(typeof pm === "number" ? { planned_minutes: pm } : {}),
  });
  if (!tally) return res as unknown as Record<string, unknown>;
  const back = planToTallyDay(res.day);
  return { ...res, tally_day: back.day, warnings: back.warnings };
}

/**
 * Load suggestions. A history from the snapshot, or for a Tally day, is converted to the
 * plan's unit, and a session without a unit gives no suggestion. A history
 * given in --input is taken as `units` unless a session names its own unit.
 */
async function cmdLoads(a: Args): Promise<number> {
  if (a.values.fill) return cmdLoadsFill(a);
  out(await computeLoads(a));
  return 0;
}

/** V7: the loads result for these arguments (not --fill), as `loads` prints it (today-brief calls the same code). */
export async function loadsFor(argv: string[]): Promise<Record<string, unknown>> {
  return computeLoads(args(argv));
}

async function computeLoads(a: Args): Promise<Record<string, unknown>> {
  if (a.values.history) throw new CoachError("USAGE", "--history goes with loads --input <week file> --fill");
  const root = rootOf(a);
  const cfg = await maybeConfig(root);
  const [{ asTallyDay }, { suggestLoads }, { loadTaxonomy }] = await Promise.all([import("./tally-shape.ts"), import("./loads.ts"), import("./taxonomy.ts")]);
  let unit: Units = cfg?.athlete.units ?? "lbs";
  const raw = a.values["from-snapshot"] === undefined && a.values.input ? readJson(a.values.input) : undefined;
  let d: DayInput;
  if (raw !== undefined && asTallyDay(raw) === null) {
    if (!isPlainObject(raw)) throw new CoachError("INPUT_ERROR", "loads input must be a JSON object");
    d = { inp: raw, day: null, tally: false, unit, snap: null };
  } else d = await dayInput(a, root, unit, "loads");
  const tallyDay = d.tally && d.day ? (d.day as TallyDayPlan) : null;
  if (tallyDay) unit = d.unit;
  const inp = d.inp;
  // W1: a given history is logged sets only (a prescription is never a logged set).
  const { historySessions, planExercises } = await import("./input-shapes.ts");
  const where = { cmd: "loads", file: a.values.input ?? "stdin" };
  let history = inp.history === undefined ? undefined : (historySessions(inp.history, where, "history") as SessionHistory);
  const strictUnits = tallyDay !== null || history === undefined;
  // V7: the snapshot whose history the loads use also backs the coverage (one read; V7 review finding 4).
  let used: Snapshot | null = null;
  if (!history) {
    // The snapshot already read for --from-snapshot is reused.
    used = d.snap ?? (await import("./coach-snapshot.ts")).coachSnapshot(root, { now: a.values.now, cfg });
    history = used?.history ?? [];
  }
  if (!tallyDay && !Array.isArray(inp.exercises)) throw new CoachError("INPUT_ERROR", "loads input needs exercises or a Tally day");
  if (!tallyDay && inp.units !== undefined && inp.units !== "lbs" && inp.units !== "kg") throw new CoachError("INPUT_ERROR", `${where.file}: units must be lbs or kg; see node engine/cli.ts help loads`);
  const units = tallyDay ? unit : ((inp.units as "lbs" | "kg" | undefined) ?? cfg?.athlete.units ?? "lbs");
  // {exercises}: checked in plan mode (one shape per list).
  const exercises = tallyDay ? tallyDay.exercises : planExercises(inp.exercises, where, "exercises", units);
  // Clusters (0.2.4): the input's list, else coach.yaml's. The planned date decides `since`: the
  // day's date, else the input's `date`, else today in the athlete's timezone.
  const { athleteToday, loadClusters } = await import("./clusters.ts");
  const { isCalendarDate } = await import("./dates.ts");
  const date = tallyDay ? tallyDay.date : isCalendarDate(inp.date) ? inp.date : athleteToday(root, a.values.now);
  let suggestions: LoadSuggestion[] = suggestLoads(exercises as never, history, await rulesAt(root, cfg), units, { tax: loadTaxonomy({ root }), strictUnits, clusters: loadClusters(root, inp), date });
  // V7: the history came from the cache, so say whether it covers the 8 weeks to the day
  // (contracts §9a). From the snapshot (today's progression), an incomplete history holds every
  // load: the latest session may be missing, so no load changes on it.
  let coverage: Record<string, unknown> | undefined;
  if (inp.history === undefined) {
    const [{ loggerHistoryCoverage, standardRange, withHistoryValues }, { athleteToday: todayOf }] = await Promise.all([import("./coverage.ts"), import("./clusters.ts")]);
    const now = a.values.now ?? new Date().toISOString();
    const today = todayOf(root, now);
    const r = standardRange(date < today ? date : today);
    // W1b confirmation finding 1: suggestLoads reads every cached session (the last time each
    // exercise was done can be older than the 8 weeks), so the value check covers all of them.
    const cov = withHistoryValues(loggerHistoryCoverage(root, cfg, r.since, r.until, now, sessionOf(a), used), used, undefined, r.until);
    coverage = { status: cov.status, since: r.since, until: r.until, ...(cov.reason ? { reason: cov.reason } : {}) };
    if (cov.values) {
      // W1b: a logged value the engine cannot read: no number at all, not even a held one.
      suggestions = suggestions.map((s) => ({ exerciseId: s.exerciseId, reason: `unknown: ${cov.values}; no suggestion`, rule_ids: [] }));
    } else if (cov.status !== "complete" && a.values["from-snapshot"]) {
      suggestions = suggestions.map((s) => ({
        exerciseId: s.exerciseId,
        reason: `held: the history is incomplete (${cov.reason ?? cov.status}); the planned load stays`,
        rule_ids: [],
        ...(s.suggestedWeight !== undefined ? { held_suggestion: s.suggestedWeight } : {}),
      }));
    }
  }
  if (!tallyDay) return { units, suggestions, ...(coverage ? { coverage } : {}) };
  return { units, suggestions, update: loadOperations(tallyDay, suggestions, units), ...(coverage ? { coverage } : {}) };
}

/**
 * loads --input <week file> --fill [--history <file>]: fills the week's loads in place and prints
 * them. The history: --history when given, else the logged weeks (the snapshot or plans/).
 */
async function cmdLoadsFill(a: Args): Promise<number> {
  const root = rootOf(a);
  const path = need(a.values.input, "--input <week file> (loads --fill)");
  const cfg = await maybeConfig(root);
  const [{ readWeekFile, saveWeekFile, fillWeekLoads, parseHistoryFile }, { loadTaxonomy }] = await Promise.all([import("./week-file.ts"), import("./taxonomy.ts")]);
  const wf = readWeekFile(path, "loads");
  const first = wf.week.days.flatMap((d) => d.exercises).find((e) => e.unit === "lbs" || e.unit === "kg");
  const units: Units = cfg?.athlete.units ?? first?.unit ?? "lbs";
  let history: SessionHistory;
  let source: "file" | "logged weeks" | "none";
  if (a.values.history) {
    history = parseHistoryFile(readJson(a.values.history), a.values.history);
    source = "file";
  } else {
    const snap = (await import("./coach-snapshot.ts")).coachSnapshot(root, { now: a.values.now, cfg });
    history = snap?.history ?? [];
    source = history.length > 0 ? "logged weeks" : "none";
    // W1b: a logged value the engine cannot read fills no load (the file is not written).
    const { historyValueProblems, inputError, valueProblemsText } = await import("./input-values.ts");
    const bad = historyValueProblems(history);
    if (bad.length > 0) throw inputError({ cmd: "loads" }, "", `the logged weeks: ${valueProblemsText(bad)}; no load was filled`);
  }
  const { loadClusters } = await import("./clusters.ts");
  const res = fillWeekLoads(wf, history, await rulesAt(root, cfg), units, { tax: loadTaxonomy({ root }), source, clusters: loadClusters(root, wf) });
  saveWeekFile(path, wf);
  out({ file: path, ...res });
  return 0;
}

/** tally-days --input <week file>: one plan_workout_day input per date. */
async function cmdTallyDays(a: Args): Promise<number> {
  const root = rootOf(a);
  const cfg = await maybeConfig(root);
  const [{ readWeekFile, tallyDays }, { loadClusters }] = await Promise.all([import("./week-file.ts"), import("./clusters.ts")]);
  const wf = readWeekFile(need(a.values.input, "--input <week file>"));
  const first = wf.week.days.flatMap((d) => d.exercises).find((e) => e.unit === "lbs" || e.unit === "kg");
  out(tallyDays(wf, cfg?.athlete.units ?? first?.unit ?? "lbs", cfg?.athlete.timezone, loadClusters(root, wf)));
  return 0;
}

/**
 * update_planned_workout fields for the suggestions that change a weight. Each
 * operation targets a unique exerciseId; an exercise without one, or with a duplicate, is
 * listed in `not_targeted` (an index target needs expectedVersion: read the day first).
 */
function loadOperations(day: TallyDayPlan, suggestions: { exerciseId: string; suggestedWeight?: number }[], units: Units) {
  const operations: { op: "modify"; target: { exerciseId: string }; fields: { suggestedWeight: number } }[] = [];
  const not_targeted: string[] = [];
  day.exercises.forEach((ex: TallyExerciseEntry, i) => {
    const s = suggestions[i];
    if (s?.suggestedWeight === undefined) return;
    const current = typeof ex.tally?.suggestedWeight === "number" ? ex.tally.suggestedWeight : null;
    if (current === s.suggestedWeight) return;
    const id = ex.exerciseId;
    if (!id || day.exercises.filter((e) => e.exerciseId === id).length !== 1) {
      not_targeted.push(ex.name);
      return;
    }
    operations.push({ op: "modify", target: { exerciseId: id }, fields: { suggestedWeight: s.suggestedWeight } });
  });
  return { date: day.date, weightUnit: units, operations, not_targeted };
}

async function cmdTargets(a: Args): Promise<number> {
  const root = rootOf(a);
  const [{ nextWeekTargets, referenceWeek }, { loadTaxonomy }] = await Promise.all([import("./progression.ts"), import("./taxonomy.ts")]);
  const inp = input(a, "targets");
  if (!isPlainObject(inp.block)) throw new CoachError("USAGE", "targets input needs block");
  if (typeof inp.today !== "string") throw new CoachError("USAGE", "targets input needs today");
  if (!Number.isInteger(inp.target_week)) throw new CoachError("USAGE", "targets input needs target_week (the block week to plan)");
  const block = inp.block as unknown as Block;
  // W1: logs are logged sets only (a prescription is never a logged set).
  const { weekLogs } = await import("./input-shapes.ts");
  const logs: WeekLog[] = inp.logs === undefined ? [] : weekLogs(inp.logs, { cmd: "targets", file: a.values.input }, "logs");
  const ref = referenceWeek(block, logs, inp.today);
  const { loadClusters } = await import("./clusters.ts");
  const targets = nextWeekTargets(block, ref, await rulesAt(root, await maybeConfig(root)), { tax: loadTaxonomy({ root }), week: inp.target_week as number, clusters: loadClusters(root, inp) });
  out({ reference_week: ref?.week_start ?? null, targets });
  return 0;
}

function kindOf(a: Args, allowBoth = false): RoutineKind[] {
  const k = a.values.kind;
  if (k === "daily" || k === "weekly") return [k];
  if (allowBoth && k === "both") return ["daily", "weekly"];
  throw new CoachError("USAGE", `--kind must be daily | weekly${allowBoth ? " | both" : ""}`);
}

/** The Tally connector from a RemoteTrigger response (or its mcp_connections list), matched by URL. */
export function pickTallyConnector(raw: unknown): Connector {
  const TALLY_CONNECTOR_URL = TALLY_URL;
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(raw)
    ? raw
    : isPlainObject(r) && Array.isArray(r.mcp_connections)
      ? r.mcp_connections
      : isPlainObject(r) && isPlainObject(r.trigger) && Array.isArray(r.trigger.mcp_connections)
        ? r.trigger.mcp_connections
        : null;
  if (!list) throw new CoachError("INPUT_ERROR", "--connections must hold mcp_connections (a list, or a routine response)");
  const hits = list.filter((c: unknown) => isPlainObject(c) && c.url === TALLY_CONNECTOR_URL);
  if (hits.length === 0) throw new CoachError("NO_TALLY_CONNECTOR", `no connector with url ${TALLY_CONNECTOR_URL}: connect Tally in claude.ai first`);
  const c = hits[0] as Record<string, unknown>;
  return { uuid: String(c.connector_uuid ?? ""), name: String(c.name ?? ""), url: TALLY_CONNECTOR_URL };
}

async function cmdRoutineBody(a: Args): Promise<number> {
  const root = rootOf(a);
  const [kind] = kindOf(a);
  const cfg = await config(root);
  const [{ TALLY_CONNECTOR_URL, dailyCron, routineBody, weeklyCron }, { parseInstant }] = await Promise.all([import("./automation.ts"), import("./dates.ts")]);
  const connector = a.values.discover
    ? null
    : a.values.connections
    ? pickTallyConnector(readJson(a.values.connections))
    : { uuid: need(a.values["connector-uuid"], "--discover, --connections <file> or --connector-uuid"), name: a.values["connector-name"] ?? "Tally_Workout", url: TALLY_CONNECTOR_URL };
  const now = a.values.now ? parseInstant(a.values.now, "--now") : Date.now();
  const body = routineBody(kind, cfg, need(a.values["repo-url"], "--repo-url https://github.com/<owner>/<repo>"), connector, {
    now,
    ...(a.values["environment-id"] ? { environment_id: a.values["environment-id"] } : {}),
    ...(a.values.model ? { model: a.values.model } : {}),
    ...(a.values.disabled ? { enabled: false } : {}),
  });
  const cron = kind === "daily" ? dailyCron(cfg, now) : weeklyCron(cfg, now);
  out({ body, cron });
  return 0;
}

/** --claude <path>, else `command -v claude` on this shell's PATH; validated either way. */
async function claudeOf(a: Args): Promise<string> {
  const { checkClaudePath, resolveClaude } = await import("./automation.ts");
  return a.values.claude ? checkClaudePath(a.values.claude) : resolveClaude(process.env);
}

async function cmdLaunchdPlist(a: Args): Promise<number> {
  const root = rootOf(a);
  const [kind] = kindOf(a);
  const repoPath = resolve(a.values["repo-path"] ?? root);
  const claude = await claudeOf(a);
  const cfg = await config(root);
  const { launchdLabel, launchdPlist, resolveToolPrefixes } = await import("./automation.ts");
  const tools = resolveToolPrefixes({ flag: a.values["tool-prefix"], config: cfg.automation.tool_prefix, claude, cwd: root });
  out({ label: launchdLabel(kind), claude, tool_prefixes: tools.prefixes, tool_prefix_source: tools.source, plist: launchdPlist(kind, cfg, repoPath, { claude, toolPrefixes: tools.prefixes }) });
  return 0;
}

/**
 * Exit 0 when a scheduled run may go on, EXIT_OUTSIDE_WINDOW when an unattended run is
 * outside its local window. The today and week skills, and the routine
 * and launchd prompts, run it first. Interactive runs are never refused.
 */
async function cmdWindowCheck(a: Args): Promise<number> {
  const r = await computeWindowCheck(a);
  out(r.result);
  return r.exit;
}

/** V7: the window-check result and exit code for these arguments (today-brief --stage pre calls the same code). */
export async function windowCheckFor(argv: string[]): Promise<{ result: Record<string, unknown>; exit: number }> {
  return computeWindowCheck(args(argv));
}

async function computeWindowCheck(a: Args): Promise<{ result: Record<string, unknown>; exit: number }> {
  const root = rootOf(a);
  const [kind] = kindOf(a);
  const [{ windowCheck }, { parseInstant }, { mode }] = await Promise.all([import("./automation.ts"), import("./dates.ts"), import("./mode.ts")]);
  const now = a.values.now ? parseInstant(a.values.now, "--now") : Date.now();
  const res = windowCheck(kind, await config(root), now);
  const enforced = mode() === "unattended";
  const result = { ...res, enforced, inside: enforced ? res.inside : true, ...(enforced ? {} : { reason: `interactive run: no window (${res.reason})` }) };
  return { result, exit: enforced && !res.inside ? EXIT_OUTSIDE_WINDOW : 0 };
}

/** Writes to ~/Library/LaunchAgents only with --yes; --load also runs launchctl bootstrap. */
async function cmdInstallLaunchd(a: Args): Promise<number> {
  // Installing scheduled agents is the athlete's choice in a live session (contracts §23).
  const marker = (await import("./mode.ts")).unattendedMarker(process.env);
  if (marker) throw new CoachError("UNATTENDED", `install-launchd never runs unattended (${marker} is set)`);
  const root = rootOf(a);
  const cfg = await config(root);
  const { launchdLabel, launchdPlist, probeLoggerTools, resolveToolPrefixes } = await import("./automation.ts");
  const dir = join(homedir(), "Library/LaunchAgents");
  const warnings = cfg.automation.mode === "mac" ? [] : [`coach.yaml automation.mode is ${cfg.automation.mode}, not mac`];
  const claude = await claudeOf(a);
  // The connected logger's exact tool names go into the allowlist (launch review finding 7).
  const tools = resolveToolPrefixes({ flag: a.values["tool-prefix"], config: cfg.automation.tool_prefix, claude, cwd: root });
  const agents = kindOf(a, true).map((kind) => ({ kind, label: launchdLabel(kind), path: join(dir, `${launchdLabel(kind)}.plist`), plist: launchdPlist(kind, cfg, root, { claude, toolPrefixes: tools.prefixes }) }));
  if (!a.values.yes) {
    out({ dry_run: true, message: "nothing written; re-run with --yes to install (a probe run checks the tool names first)", warnings, tool_prefixes: tools.prefixes, tool_prefix_source: tools.source, agents });
    return 0;
  }
  // A test run proves the tool names in the scheduled environment before anything is installed.
  const probe = probeLoggerTools(claude, tools.prefixes, root);
  if (!probe.ok) throw new CoachError("LOGGER_PROBE_FAILED", `the probe run could not call the logger with ${tools.prefixes.join(", ")}: ${probe.reason}; nothing installed`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, "athlete/.cache"), { recursive: true });
  const loaded: string[] = [];
  for (const ag of agents) {
    writeFileSync(ag.path, ag.plist, { mode: 0o644 });
    if (a.values.load) {
      const domain = `gui/${process.getuid?.() ?? ""}`;
      try {
        execFileSync("launchctl", ["bootout", domain, ag.path], { stdio: "ignore" });
      } catch {
        /* not loaded yet */
      }
      execFileSync("launchctl", ["bootstrap", domain, ag.path], { stdio: ["ignore", "pipe", "pipe"] });
      loaded.push(ag.label);
    }
  }
  out({
    dry_run: false,
    tool_prefixes: tools.prefixes,
    probe,
    written: agents.map((ag) => ag.path),
    loaded,
    next: a.values.load ? [] : agents.map((ag) => `launchctl bootstrap gui/$(id -u) ${ag.path}`),
    warnings,
  });
  return 0;
}

/** Runs a helper command. Returns null when `cmd` is not one of them. */
export async function helpersCommand(cmd: string, argv: string[]): Promise<number | null> {
  if (!(HELPER_COMMANDS as readonly string[]).includes(cmd)) return null;
  const a = args(argv);
  switch (cmd as (typeof HELPER_COMMANDS)[number]) {
    case "mode":
      out({ mode: (await import("./mode.ts")).mode() });
      return 0;
    case "opid":
      return cmdOpid(a);
    case "adjust":
      return cmdAdjust(a);
    case "loads":
      return cmdLoads(a);
    case "targets":
      return cmdTargets(a);
    case "routine-body":
      return cmdRoutineBody(a);
    case "launchd-plist":
      return cmdLaunchdPlist(a);
    case "install-launchd":
      return cmdInstallLaunchd(a);
    case "window-check":
      return cmdWindowCheck(a);
    case "tally-days":
      return cmdTallyDays(a);
  }
}
