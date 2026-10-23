// V7: `today-write-prep --input <{after, tool, kind}.json>` (contracts §22b): one preparation call
// for a today write. It reads the day from the snapshot once (the same read for `before` and
// `snapshotDay`, as classify needs them) and returns:
// - the classify result;
// - the limits check on the final day, and when a weekly set cap applies, on the whole week with
//   today replaced (a day it cannot see makes the week `unknown`, never a pass);
// - the write arguments for the chosen tool with `version` as expectedVersion: `plain`, and on a
//   protected day also `approved` (overrideUserModified: true), each with its own opId when the
//   adapter has opId. A revised list or a new version means running it again.
// The model still decides the change and its loads; this computes and reports.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./canonical.ts";
import { loadConfig } from "./config.ts";
import { addDays, isCalendarDate, localDate, parseInstant, weekStart } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { OP_KINDS, opId, type OpKind } from "./opid.ts";
import { SNAPSHOT_MAX_AGE_MIN, snapshotProblems } from "./snapshot.ts";
import type { CoachConfig, DayPlan, Instant, LoggerExercise, Snapshot, SnapshotDay, Units } from "./types.ts";

export const WRITE_TOOLS = ["update_planned_workout", "plan_workout_day"] as const;
export type WriteTool = (typeof WRITE_TOOLS)[number];

export const EXAMPLE_INPUT = {
  after: {
    date: "2026-10-14",
    dayType: "lower",
    dayName: "Lower A",
    notes: "[coach] Adjusted for recovery (NA-REC-009)",
    exercises: [
      { exerciseId: "Barbell_Squat", name: "Back Squat", suggestedSets: 3, suggestedReps: 5, suggestedWeight: 185 },
      { exerciseId: "Dumbbell_Split_Squat", name: "Split Squat", suggestedSets: 2, suggestedReps: 8, repsMax: 10, perSide: true, notes: "slow down" },
    ],
    weightUnit: "lbs",
  },
  tool: "update_planned_workout",
  kind: "trim_session",
};
export const EXAMPLE_EDIT = { edit: { notes: "[coach] Load progression (NA-PROG-001)", exercises: [{ index: 0, set: { suggestedWeight: 195 } }] }, tool: "update_planned_workout", kind: "load_progression" };
const SHAPE = `expected {after: <the Tally-shaped day, as adjust's tally_day>} or {edit: {notes?, exercises?: [{index, set: {<field>: <value or null>}} | {index, remove: true}]}} (applied to today's day as read), with tool: update_planned_workout | plan_workout_day and kind: <an operation kind>; for example ${JSON.stringify(EXAMPLE_INPUT)} or ${JSON.stringify(EXAMPLE_EDIT)}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (m: string): never => {
  throw new CoachError("INPUT_ERROR", `today-write-prep: ${m}; ${SHAPE}`);
};

/** An explicit change to today's stored day (V7b): the notes, and fields set, cleared (null) or exercises removed by index. */
export type DayEdit = { notes?: string; exercises?: ({ index: number; set: Record<string, unknown> } | { index: number; remove: true })[] };
export type WritePrepInput = { after?: Record<string, unknown>; edit?: DayEdit; tool: WriteTool; kind: OpKind; before?: Record<string, unknown> };

export function parseWritePrepInput(raw: unknown): WritePrepInput {
  if (!isObj(raw)) bad("the input must be a JSON object");
  const r = raw as Record<string, unknown>;
  if ((r.after === undefined) === (r.edit === undefined)) bad("give exactly one of after and edit");
  if (r.edit !== undefined) {
    if (!isObj(r.edit)) bad("edit must be an object");
    const e = r.edit as Record<string, unknown>;
    if (Object.keys(e).some((k) => k !== "notes" && k !== "exercises")) bad("edit takes notes and exercises only");
    if (e.notes !== undefined && typeof e.notes !== "string") bad("edit.notes must be text");
    if (e.exercises !== undefined && (!Array.isArray(e.exercises) || !e.exercises.every((x) => isObj(x) && Number.isInteger(x.index) && (x.index as number) >= 0 && ((x.remove === true && !("set" in x)) || (isObj(x.set) && !("remove" in x))))))
      bad("edit.exercises items are {index, set: {...}} or {index, remove: true}");
  } else {
    if (!isObj(r.after)) bad("after must be an object");
    const a = r.after as Record<string, unknown>;
    if (!isCalendarDate(a.date)) bad("after.date must be YYYY-MM-DD");
    if (!Array.isArray(a.exercises) || a.exercises.length === 0) bad("after.exercises must be a non-empty list (a day with no exercises is not a write)");
    (a.exercises as unknown[]).forEach((e, i) => {
      // The id may be empty (a files-logger exercise is named only); writePrep requires it for Tally.
      if (!isObj(e) || typeof e.name !== "string" || e.name === "" || typeof e.exerciseId !== "string") bad(`after.exercises[${i}] needs exerciseId and name`);
      if (Array.isArray((e as Record<string, unknown>).sets)) bad(`after.exercises[${i}] has sets: pass the Tally shape (suggestedSets, suggestedReps, suggestedWeight), as adjust's tally_day`);
    });
  }
  if (!WRITE_TOOLS.includes(r.tool as WriteTool)) bad(`tool must be ${WRITE_TOOLS.join(" or ")}`);
  if (!OP_KINDS.includes(r.kind as OpKind)) bad(`kind must be one of ${OP_KINDS.join(", ")}`);
  if (r.before !== undefined && !isObj(r.before)) bad("before must be an object (logger other only)");
  return { ...(isObj(r.after) ? { after: r.after } : {}), ...(isObj(r.edit) ? { edit: r.edit as DayEdit } : {}), tool: r.tool as WriteTool, kind: r.kind as OpKind, ...(isObj(r.before) ? { before: r.before } : {}) };
}

/**
 * The day for a write, from the snapshot (one read): this session's, read in the last 15
 * minutes, and found. Otherwise an error that names the read to make.
 */
export function snapshotBefore(snap: Snapshot | null, date: string, session_id: string | null, now: Instant, logger: string): SnapshotDay {
  const read = `read it with get_planned_workout {"date": "${date}"}, then run this again`;
  if (!snap) throw new CoachError("NO_SNAPSHOT", `no snapshot: ${read}`);
  const sd = snap.days[date];
  if (!sd) throw new CoachError("NOT_IN_SNAPSHOT", `${date} is not in the snapshot: ${read}`);
  if (logger === "tally") {
    if (!session_id) throw new CoachError("SESSION_UNKNOWN", "needs this session's id (CLAUDE_CODE_SESSION_ID or --session <id>) to check the snapshot is this session's");
    const problems = snapshotProblems(snap, session_id, now, [date]);
    if (problems.length > 0) throw new CoachError("SNAPSHOT_STALE", `${problems.join("; ")}; ${read}`);
  }
  if (!sd.found) throw new CoachError("NOT_PLANNED", `${date} has no planned day: nothing to change`);
  return sd;
}

// ---------- update_planned_workout operations ----------

type Op =
  | { op: "modify"; target: { index: number }; fields: Record<string, unknown> }
  | { op: "remove"; target: { index: number } }
  | { op: "replace"; target: { index: number }; exercise: LoggerExercise }
  | { op: "add"; exercise: LoggerExercise; afterIndex: number };

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/**
 * The operations that turn `before` into `after` (index targets: the call carries
 * expectedVersion). Exercises pair by exerciseId in order. A pair whose fields differ is a modify
 * (a field gone is null, which clears it); an unpaired exercise before is removed, or replaced by
 * the unpaired exercise that takes its place; an unpaired exercise after is added after the
 * previous kept one. Null when the operations cannot give exactly `after` (a reorder): use
 * plan_workout_day then.
 */
export function updateOperations(before: LoggerExercise[], after: LoggerExercise[]): Op[] | null {
  const pairOf = new Map<number, number>(); // after index → before index
  const used = new Set<number>();
  after.forEach((e, j) => {
    const i = before.findIndex((b, k) => !used.has(k) && b.exerciseId === e.exerciseId);
    if (i >= 0) {
      used.add(i);
      pairOf.set(j, i);
    }
  });
  // Pairs must keep their order, or no index operations can give `after`.
  const order = [...pairOf.entries()].sort((x, y) => x[0] - y[0]).map(([, i]) => i);
  if (order.some((i, k) => k > 0 && i < order[k - 1])) return null;
  const ops: Op[] = [];
  const unpairedBefore = before.map((_, i) => i).filter((i) => !used.has(i));
  const unpairedAfter = after.map((_, j) => j).filter((j) => !pairOf.has(j));
  // An unpaired after exercise takes the place of an unpaired before exercise between the same kept neighbours.
  const prevKept = (j: number) => {
    for (let k = j - 1; k >= 0; k--) if (pairOf.has(k)) return pairOf.get(k)!;
    return -1;
  };
  const replaced = new Map<number, number>(); // before index → after index
  for (const j of unpairedAfter) {
    const lo = prevKept(j);
    const nextKept = (() => {
      for (let k = j + 1; k < after.length; k++) if (pairOf.has(k)) return pairOf.get(k)!;
      return before.length;
    })();
    const slot = unpairedBefore.find((i) => i > lo && i < nextKept && !replaced.has(i));
    if (slot !== undefined) replaced.set(slot, j);
  }
  for (const [j, i] of [...pairOf.entries()].sort((x, y) => x[1] - y[1])) {
    const b = before[i];
    const a = after[j];
    const fields: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) if (!same(b[k], a[k])) fields[k] = a[k] === undefined ? null : a[k];
    if (Object.keys(fields).length > 0) ops.push({ op: "modify", target: { index: i }, fields });
  }
  for (const i of unpairedBefore) {
    const j = replaced.get(i);
    ops.push(j !== undefined ? { op: "replace", target: { index: i }, exercise: after[j] } : { op: "remove", target: { index: i } });
  }
  for (const j of unpairedAfter) if (![...replaced.values()].includes(j)) ops.push({ op: "add", exercise: after[j], afterIndex: prevKept(j) });
  return same(applyOperations(before, ops), after) ? ops : null;
}

/** Tally's update semantics (the mock server's updatePlannedWorkout): index targets on the stored day, inserts after a stored position. */
export function applyOperations(before: LoggerExercise[], ops: Op[]): LoggerExercise[] {
  const bySlot = new Map<number, Op>();
  const inserts = new Map<number, LoggerExercise[]>();
  for (const o of ops) {
    if (o.op === "add") inserts.set(o.afterIndex, [...(inserts.get(o.afterIndex) ?? []), o.exercise]);
    else bySlot.set(o.target.index, o);
  }
  const out: LoggerExercise[] = [...(inserts.get(-1) ?? [])];
  before.forEach((raw, i) => {
    const o = bySlot.get(i);
    if (!o) out.push(raw);
    else if (o.op === "replace") out.push(o.exercise);
    else if (o.op === "modify") out.push(Object.fromEntries(Object.entries({ ...raw, ...o.fields }).filter(([, v]) => v !== null)));
    out.push(...(inserts.get(i) ?? []));
  });
  return out;
}

// ---------- the write step ----------

/**
 * The final day: `edit` applied to the stored day (lossless: every field the read holds is kept),
 * or `after` as given. For `annotate`, only the notes may differ from the stored day: anything else
 * that differs (exercises, day name, day type, unit) is refused (V7b finding 7).
 */
export function finalDay(inp: WritePrepInput, sd: SnapshotDay, date: string, storedUnit: Units): Record<string, unknown> {
  const stored = { date, ...(sd.dayType ? { dayType: sd.dayType } : {}), ...(sd.dayName ? { dayName: sd.dayName } : {}), ...(sd.notes !== undefined ? { notes: sd.notes } : {}), exercises: sd.exercises, weightUnit: storedUnit };
  if (inp.edit) {
    const e = inp.edit;
    if (inp.kind === "annotate" && e.exercises?.length) throw new CoachError("INPUT_ERROR", "today-write-prep: an annotate write changes notes only; edit.exercises is not allowed");
    let exercises = structuredClone(sd.exercises);
    const removed = new Set<number>();
    for (const x of e.exercises ?? []) {
      if (x.index >= exercises.length) throw new CoachError("INPUT_ERROR", `today-write-prep: edit.exercises index ${x.index} is out of range (the day has ${exercises.length} exercises)`);
      if ("remove" in x) removed.add(x.index);
      else exercises[x.index] = Object.fromEntries(Object.entries({ ...exercises[x.index], ...x.set }).filter(([, v]) => v !== null));
    }
    exercises = exercises.filter((_, i) => !removed.has(i));
    if (exercises.length === 0) throw new CoachError("INPUT_ERROR", "today-write-prep: the edit leaves no exercise (a day with no exercises is not a write)");
    return { ...stored, ...(e.notes !== undefined ? { notes: e.notes } : {}), exercises };
  }
  const a = inp.after!;
  if (inp.kind === "annotate") {
    const diffs = ["exercises", "dayName", "dayType", "weightUnit"].filter((k) => a[k] !== undefined && !same(a[k], (stored as Record<string, unknown>)[k]));
    if (diffs.length > 0) throw new CoachError("INPUT_ERROR", `today-write-prep: an annotate write changes notes only; after changes ${diffs.join(", ")}`);
    return { ...stored, ...(typeof a.notes === "string" ? { notes: a.notes } : {}) };
  }
  return a;
}

/** The prescription fields a no-op operation may restate (each changes nothing when it repeats the stored value). */
const PLACEHOLDER_FIELDS = ["suggestedSets", "suggestedReps", "repsMax", "suggestedWeight", "suggestedDuration", "distanceMeters", "rpe", "perSide"];

/**
 * The one operation Tally needs for a notes-only `update_planned_workout`: a field an exercise
 * already has, restated with its stored value (V7c: never an invented value). Null when no
 * exercise has one.
 */
export function placeholderOperation(exercises: LoggerExercise[]): Op | null {
  for (const [i, e] of exercises.entries()) {
    const f = PLACEHOLDER_FIELDS.find((k) => e[k] !== undefined && e[k] !== null);
    if (f) return { op: "modify", target: { index: i }, fields: { [f]: e[f] } };
  }
  return null;
}

export type WritePrepOptions = { root: string; input: unknown; now?: Instant; session_id?: string | null };

export async function writePrep(o: WritePrepOptions): Promise<Record<string, unknown>> {
  const root = o.root;
  const now = o.now ?? new Date().toISOString();
  const session_id = o.session_id !== undefined ? o.session_id : process.env.CLAUDE_CODE_SESSION_ID || null;
  const cfgPath = join(root, "coach.yaml");
  if (!existsSync(cfgPath)) throw new CoachError("MISSING_FILE", "coach.yaml is missing: run the setup skill first");
  const cfg: CoachConfig = loadConfig(cfgPath);
  const inp = parseWritePrepInput(o.input);
  const today = localDate(now, cfg.athlete.timezone);
  const date = inp.after ? (inp.after.date as string) : today;
  if (date !== today) throw new CoachError("INPUT_ERROR", `today-write-prep writes today only (${today}); after.date is ${date}`);
  const logger = cfg.logger;
  if (logger !== "files" && inp.after && (inp.after.exercises as LoggerExercise[]).some((e) => e.exerciseId === "")) {
    throw new CoachError("INPUT_ERROR", "today-write-prep: a Tally exercise needs its exerciseId (resolve a new one with search_exercises)");
  }
  const [{ tallyDayToPlan, snapshotDayToPlan, tallyDayUnit }, { classifyResult }, { checkLimits }, { loadLimits }, { loadTaxonomy }, { loadClusters }] = await Promise.all([
    import("./tally-shape.ts"),
    import("./cli-core.ts"),
    import("./limits-check.ts"),
    import("./limits.ts"),
    import("./taxonomy.ts"),
    import("./clusters.ts"),
  ]);
  const units: Units = cfg.athlete.units;

  // ---- the day before the change: one read ----
  let snap: Snapshot | null = null;
  let sd: SnapshotDay;
  if (logger === "other") {
    if (!inp.before) throw new CoachError("INPUT_ERROR", "today-write-prep: logger other: pass that tool's day as before (the same Tally shape as after)");
    const b = inp.before;
    // That tool's own protection, when the coach passes it (source, userModified); else a coach-written day.
    sd = { found: true, version: null, updatedAt: null, source: typeof b.source === "string" ? b.source : "mcp", userModified: b.userModified === true, skipped: false, exercises: (b.exercises as LoggerExercise[]) ?? [], ...(typeof b.dayName === "string" ? { dayName: b.dayName } : {}), ...(typeof b.notes === "string" ? { notes: b.notes } : {}), captured_at: now };
  } else {
    if (logger === "files") snap = (await import("./coach-snapshot.ts")).coachSnapshot(root, { now, cfg });
    else snap = (await import("./snapshot.ts")).loadSnapshot(root);
    sd = snapshotBefore(snap, date, session_id, now, logger);
  }
  // W1: every value is checked in the conversion (logger other: the coach's `before`).
  const before = logger === "other" ? tallyDayToPlan({ ...sd, date } as unknown as Record<string, unknown>, { date, units, where: { cmd: "today-write-prep", file: "before" } }) : snapshotDayToPlan(date, sd, units);
  // The unit of the stored day, and the unit the write sends (V7b finding 1): the limits check
  // reads the final day in that same unit.
  const storedUnit: Units = tallyDayUnit(sd, units);
  const after = finalDay(inp, sd, date, storedUnit);
  // W1b: a supplied unit is checked before any fallback ("kilograms" is refused, never replaced);
  // the stored unit is used only when the field is absent.
  const { checkUnit } = await import("./input-values.ts");
  checkUnit(after, "weightUnit", { cmd: "today-write-prep", file: inp.edit ? "today's day after the edit" : "after" }, "");
  const writeUnit: Units = after.weightUnit === "kg" || after.weightUnit === "lbs" ? after.weightUnit : storedUnit;
  // As write input (no read keys), so the conversion takes exactly the unit the write sends.
  const { found: _found, version: _version, weightUnitSource: _source, ...asWrite } = after;
  // W1: values are checked on the final day, after an edit's nulls removed their fields (a null
  // clears a field; it is never checked as a value).
  // W1b: with logger files, a 0 sets count is the plans/ zero-work row (plans write keeps it).
  const afterPlan = tallyDayToPlan({ ...asWrite, weightUnit: writeUnit }, { units, where: { cmd: "today-write-prep", file: inp.edit ? "today's day after the edit" : "after" }, zeroSets: logger === "files" });
  const afterExercises = after.exercises as LoggerExercise[];

  // ---- classify ----
  const classify = await classifyResult(root, { before, after: afterPlan, tool: inp.tool, today, snapshotDay: sd });

  // ---- limits: the final day, and the whole week when a weekly set cap applies ----
  const tax = loadTaxonomy({ root });
  const lp = join(root, "athlete/limits.yaml");
  const limits = existsSync(lp) ? loadLimits(lp, tax) : { version: 1 as const, pain_threshold: 4, limits: [] };
  const clusters = loadClusters(root);
  const finalFindings = checkLimits([afterPlan], limits, tax, clusters);
  const capped = limits.limits.some((l) => typeof l.max_sets_per_week === "number");
  let week: Record<string, unknown> = { status: "not_needed", reason: "no limit has a weekly set cap" };
  if (capped) {
    const start = weekStart(date);
    const days: DayPlan[] = [afterPlan];
    const missing: string[] = [];
    // W1b: a day of the week it cannot read (a plans/ cell, a stored value) makes the week unknown, never ok.
    const unreadable: string[] = [];
    const nowMs = parseInstant(now, "now");
    for (let k = 0; k < 7; k++) {
      const d = addDays(start, k);
      if (d === date) continue;
      const day = snap?.days[d];
      const fresh = day && (logger !== "tally" || (nowMs - parseInstant(day.captured_at, "captured_at")) / 60_000 <= SNAPSHOT_MAX_AGE_MIN);
      if (day && fresh) {
        if (day.found) {
          try {
            days.push(snapshotDayToPlan(d, day, units));
          } catch (e) {
            if (!(e instanceof CoachError) || e.code !== "INPUT_ERROR") throw e;
            unreadable.push(e.message);
          }
        }
        continue;
      }
      if (logger === "files") continue; // the files are the record: no day is no plan
      // The training context lists every planned day from its `from` date: a date it covers and does not list has no plan.
      const listing = snap?.planned;
      const listingFresh = listing && (nowMs - parseInstant(listing.captured_at, "captured_at")) / 60_000 <= SNAPSHOT_MAX_AGE_MIN;
      if (logger === "tally" && listingFresh && d >= listing!.from && !(d in listing!.dates)) continue;
      missing.push(d);
    }
    const findings = checkLimits(days, limits, tax, clusters);
    const over = findings.some((f) => f.kind !== "unclassified");
    week = missing.length > 0
      ? { status: "unknown", reason: `the week's other days are not all known: ${missing.join(", ")}`, missing, need_reads: missing.map((d) => ({ tool: "get_planned_workout", args: { date: d } })), findings }
      : over
        ? { status: "over", findings, ...(unreadable.length > 0 ? { reason: `also, a day of the week cannot be read: ${unreadable.join("; ")}` } : {}) }
        : unreadable.length > 0
          ? { status: "unknown", reason: `a day of the week cannot be read: ${unreadable.join("; ")}`, findings }
          : { status: "ok", findings };
  }
  const limitsResult = { ok: finalFindings.every((f) => f.kind === "unclassified") && (week.status === "ok" || week.status === "not_needed"), final_day: { ok: finalFindings.every((f) => f.kind === "unclassified"), findings: finalFindings }, week };

  const isProtected = logger !== "files" && (sd.source !== "mcp" || sd.userModified);
  const base = { date, kind: inp.kind, logger, protected: isProtected, version: sd.version, classify, limits: limitsResult };
  if (logger === "other") return { ...base, write: null, note: "logger other: write through that tool by its own instructions" };
  if (logger === "files") return { ...base, write: { plain: { command: "plans write", input: { tally_day: { ...after, weightUnit: writeUnit } } } } };

  // ---- the Tally write arguments ----
  const { loadAdapterConfig } = await import("./logger.ts");
  const withOpId = loadAdapterConfig("tally").capabilities.opId;
  const unit = writeUnit;
  let args: Record<string, unknown>;
  if (inp.kind === "annotate") {
    // An annotation is the stored day with new notes, nothing else (V7b finding 7). Tally needs at
    // least one operation: it restates the first exercise's set count, strictly unchanged.
    if (inp.tool === "update_planned_workout") {
      const op = placeholderOperation(sd.exercises);
      if (!op) throw new CoachError("INPUT_ERROR", "today-write-prep: no exercise of today has a prescription field to restate unchanged, so update_planned_workout cannot carry a notes-only write: use plan_workout_day (it writes the stored day unchanged with the new notes)");
      args = { date, timezone: cfg.athlete.timezone, ...(sd.version ? { expectedVersion: sd.version } : {}), notes: after.notes ?? "", operations: [op] };
    } else args = { date, dayType: sd.dayType ?? "training", dayName: sd.dayName ?? "Training", exercises: sd.exercises, notes: after.notes ?? "", timezone: cfg.athlete.timezone, weightUnit: storedUnit, ...(sd.version ? { expectedVersion: sd.version } : {}), replace: true };
  } else if (inp.tool === "update_planned_workout") {
    let ops = updateOperations(sd.exercises, afterExercises);
    if (ops === null) throw new CoachError("INPUT_ERROR", "today-write-prep: update_planned_workout cannot give this day (the exercises change order): use plan_workout_day");
    // Tally needs at least one operation: a notes-only write restates the first exercise's set count.
    if (ops.length === 0) ops = [{ op: "modify", target: { index: 0 }, fields: { suggestedSets: sd.exercises[0]?.suggestedSets ?? 1 } }];
    args = {
      date,
      timezone: cfg.athlete.timezone,
      ...(sd.version ? { expectedVersion: sd.version } : {}),
      weightUnit: unit,
      ...(typeof after.notes === "string" && after.notes !== (sd.notes ?? "") ? { notes: after.notes } : {}),
      ...(typeof after.dayName === "string" && after.dayName !== (sd.dayName ?? "") ? { dayName: after.dayName } : {}),
      operations: ops,
    };
  } else {
    args = {
      date,
      dayType: after.dayType ?? sd.dayType ?? "training",
      dayName: after.dayName ?? sd.dayName ?? "Training",
      exercises: afterExercises,
      ...(typeof after.notes === "string" ? { notes: after.notes } : {}),
      timezone: cfg.athlete.timezone,
      weightUnit: unit,
      ...(sd.version ? { expectedVersion: sd.version } : {}),
      replace: true,
    };
  }
  const variant = (a: Record<string, unknown>) => {
    const call = { tool: inp.tool, args: a };
    return { tool: inp.tool, args: withOpId ? { ...a, opId: opId(date, inp.kind, call) } : a };
  };
  const write: Record<string, unknown> = { plain: variant(args) };
  if (isProtected) write.approved = variant({ ...args, overrideUserModified: true });
  return { ...base, write };
}
