// Tally rebuild functions (contracts §12): the day or days a mutation would leave behind,
// built from the snapshot plus the tool input, with Tally's stored semantics
// (workout-api/lib/mcp: upsertPlannedDay.ts, tools/updatePlannedWorkout.ts,
// movePlannedWorkout.ts, skipPlannedWorkout.ts, deletePlannedWorkout.ts, schemas.ts).
//
// - The rebuild assumes the write happens. Protection (user days) and consent are the
//   guard's job; a case where Tally would refuse the call (not found, an occupied
//   destination, an index target without a version, an unknown key) throws, so the
//   guard denies it instead of guessing.
// - Exercises stay in Tally's shape (suggestedSets, suggestedWeight, …). toDayPlan
//   converts a day to the engine's DayPlan.
import { CoachError } from "../../../engine/errors.ts";
import { isCalendarDate } from "../../../engine/dates.ts";
import type { CalendarDate, DayPlan, ExerciseEntry, LoggerExercise, SetEntry, Snapshot, SnapshotDay, Units } from "../../../engine/types.ts";

export const MUTATIONS = [
  "plan_workout_day",
  "plan_workout_range",
  "update_planned_workout",
  "move_planned_workout",
  "skip_planned_workout",
  "delete_planned_workout",
  "update_user_profile",
  "update_training_limits",
] as const;
export type TallyMutation = (typeof MUTATIONS)[number];

export const READS = ["get_planned_workout", "get_training_context", "get_workout_history"] as const;
export type TallyRead = (typeof READS)[number];

/** One date a mutation touches. `before`/`after` null: no day on the date. */
export type DayChange = { date: CalendarDate; before: SnapshotDay | null; after: SnapshotDay | null };

// Top-level keys each tool accepts (schemas.ts). An unknown key fails closed.
const KEYS: Record<TallyMutation, string[]> = {
  plan_workout_day: ["date", "dayType", "dayName", "exercises", "notes", "timezone", "overrideUserModified", "expectedUpdatedAt", "expectedVersion", "allowPast", "weightUnit", "replace", "ifAbsent", "opId"],
  plan_workout_range: ["timezone", "days", "allowPast", "weightUnit", "opId"],
  update_planned_workout: ["timezone", "date", "expectedVersion", "overrideUserModified", "weightUnit", "dayName", "notes", "operations", "opId"],
  move_planned_workout: ["timezone", "fromDate", "toDate", "expectedVersion", "overrideUserModified", "allowPast", "opId"],
  skip_planned_workout: ["date", "skip", "expectedVersion", "opId"],
  delete_planned_workout: ["date", "overrideUserModified", "expectedVersion", "opId"],
  update_user_profile: ["goals", "experience", "schedule", "sessionLength", "equipment", "limits", "injuries"],
  update_training_limits: ["ops", "expectedVersion"],
};
// Tally T3 tightening ops (Tally server-limits spec §5.2, §6.2).
const LIMIT_OP_KEYS: Record<string, string[]> = {
  add_rule: ["op", "rule"],
  lower_cap: ["op", "ruleId", "maxSetsPerWeek"],
  set_weekly_cap: ["op", "maxWeeklySets"],
};
const DAY_KEYS = ["date", "dayType", "dayName", "exercises", "notes", "expectedVersion", "ifAbsent"];
// Tally T2 (schemas.ts): an idempotency key, 8-120 characters.
const OPID_RE = /^[A-Za-z0-9._:-]{8,120}$/;
const OP_KEYS: Record<string, string[]> = {
  add: ["op", "exercise", "afterIndex"],
  remove: ["op", "target"],
  replace: ["op", "target", "exercise"],
  modify: ["op", "target", "fields"],
};
const MODIFY_FIELDS = ["suggestedSets", "suggestedReps", "repsMax", "suggestedWeight", "suggestedDuration", "distanceMeters", "rpe", "perSide"];

const KNOWN_UNIT_SOURCES = ["settings", "history"];
const KG_PER_LB = 0.45359237;

function fail(code: string, msg: string): never {
  throw new CoachError(code, msg);
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail("REBUILD_INVALID", `${what} must be an object`);
  return v as Record<string, unknown>;
}

function onlyKeys(o: Record<string, unknown>, allowed: string[], what: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail("REBUILD_INVALID", `${what}: unknown key ${JSON.stringify(k)}`);
}

function date(v: unknown, what: string): CalendarDate {
  if (!isCalendarDate(v)) fail("REBUILD_INVALID", `${what} must be a date YYYY-MM-DD, got ${JSON.stringify(v)}`);
  return v;
}

function exercise(v: unknown, what: string): LoggerExercise {
  const e = obj(v, what);
  if (typeof e.name !== "string" || e.name === "") fail("REBUILD_INVALID", `${what}.name is required`);
  if (typeof e.exerciseId !== "string" || e.exerciseId === "") fail("REBUILD_INVALID", `${what}.exerciseId is required`);
  return { ...e };
}

/** Tally T2: opId, when present, is 8-120 characters of letters, digits, ".", "_", ":" or "-". */
function checkOpId(args: Record<string, unknown>, what: string): void {
  if (args.opId !== undefined && (typeof args.opId !== "string" || !OPID_RE.test(args.opId))) {
    fail("REBUILD_INVALID", `${what}.opId must be 8-120 characters of letters, digits, ".", "_", ":" or "-"`);
  }
}

/** Tally T2: expectedVersion, when present, is a version string from get_planned_workout. */
function checkVersion(args: Record<string, unknown>, what: string): void {
  if (args.expectedVersion !== undefined && (typeof args.expectedVersion !== "string" || args.expectedVersion === "" || args.expectedVersion.length > 400)) {
    fail("REBUILD_INVALID", `${what}.expectedVersion must be the version string from get_planned_workout`);
  }
}

/**
 * Tally T2 ifAbsent: true writes only to an empty date; a date with any planned day is
 * skipped with code exists (the day stays). It cannot be combined with expectedVersion,
 * expectedUpdatedAt, replace: true or overrideUserModified: true (a validation error).
 */
function ifAbsent(spec: Record<string, unknown>, what: string): boolean {
  if (spec.ifAbsent === undefined) return false;
  if (typeof spec.ifAbsent !== "boolean") fail("REBUILD_INVALID", `${what}.ifAbsent must be true or false`);
  if (spec.ifAbsent && (spec.expectedVersion !== undefined || spec.expectedUpdatedAt !== undefined || spec.replace === true || spec.overrideUserModified === true)) {
    fail("REBUILD_INVALID", `${what}: ifAbsent cannot be combined with expectedVersion, expectedUpdatedAt, replace or overrideUserModified`);
  }
  return spec.ifAbsent;
}

export function isTallyMutation(s: string): s is TallyMutation {
  return (MUTATIONS as readonly string[]).includes(s);
}

/** Tally's conversion (weightUnit.ts): lbs→kg to the nearest 0.5 kg; kg→lbs to the nearest 1 lb. */
export function convertWeight(value: number, from: Units, to: Units): number {
  if (from === to) return value;
  if (to === "kg") return Math.round(value * KG_PER_LB * 2) / 2;
  return Math.round(value / KG_PER_LB);
}

function knownUnit(day: SnapshotDay | null, snap: Snapshot): Units | null {
  if (day?.weightUnit && KNOWN_UNIT_SOURCES.includes(day.weightUnitSource ?? "")) return day.weightUnit;
  if (snap.weightUnit && KNOWN_UNIT_SOURCES.includes(snap.weightUnitSource ?? "")) return snap.weightUnit;
  return null;
}

function callUnit(args: Record<string, unknown>): Units | undefined {
  const u = args.weightUnit;
  if (u === undefined) return undefined;
  if (u !== "lbs" && u !== "kg") fail("REBUILD_INVALID", `weightUnit must be lbs | kg, got ${JSON.stringify(u)}`);
  return u;
}

/**
 * G1: a call's weights are converted to the user's unit only when the call names a unit
 * and Tally knows the user's unit. Otherwise they are stored as given. Returns the
 * converter and the unit the stored values are in (undefined when nobody knows).
 */
function unitPlan(args: Record<string, unknown>, day: SnapshotDay | null, snap: Snapshot) {
  const from = callUnit(args);
  const user = knownUnit(day, snap);
  const convert = (w: number) => (from && user ? convertWeight(w, from, user) : w);
  return { convert, unit: user ?? from, unitSource: user ? "settings" : from ? "call" : undefined };
}

function withWeight(e: LoggerExercise, convert: (w: number) => number): LoggerExercise {
  return typeof e.suggestedWeight === "number" ? { ...e, suggestedWeight: convert(e.suggestedWeight) } : e;
}

function found(snap: Snapshot, d: CalendarDate): SnapshotDay | null {
  const day = snap.days[d];
  return day && day.found ? day : null;
}

function newDay(
  spec: Record<string, unknown>,
  before: SnapshotDay | null,
  unit: ReturnType<typeof unitPlan>,
  what: string,
): SnapshotDay {
  if (typeof spec.dayType !== "string" || spec.dayType === "") fail("REBUILD_INVALID", `${what}.dayType is required`);
  if (typeof spec.dayName !== "string" || spec.dayName === "") fail("REBUILD_INVALID", `${what}.dayName is required`);
  if (!Array.isArray(spec.exercises) || spec.exercises.length === 0) fail("REBUILD_INVALID", `${what}.exercises must be a non-empty list`);
  if (spec.notes !== undefined && typeof spec.notes !== "string") fail("REBUILD_INVALID", `${what}.notes must be a string`);
  // upsertPlannedDay writes source 'mcp', status 'planned' and notes (absent → null).
  return {
    found: true,
    version: null,
    updatedAt: null,
    source: "mcp",
    userModified: before?.userModified ?? false,
    skipped: false,
    dayName: spec.dayName,
    dayType: spec.dayType,
    ...(typeof spec.notes === "string" ? { notes: spec.notes } : {}),
    exercises: spec.exercises.map((e, i) => withWeight(exercise(e, `${what}.exercises[${i}]`), unit.convert)),
    ...(unit.unit ? { weightUnit: unit.unit, weightUnitSource: unit.unitSource } : {}),
    captured_at: before?.captured_at ?? "",
  };
}

/** plan_workout_day: the full day replaces whatever is on the date. */
export function planWorkoutDay(rawArgs: unknown, snap: Snapshot): DayChange[] {
  const args = obj(rawArgs, "plan_workout_day input");
  onlyKeys(args, KEYS.plan_workout_day, "plan_workout_day");
  checkOpId(args, "plan_workout_day");
  checkVersion(args, "plan_workout_day");
  const d = date(args.date, "date");
  const before = found(snap, d);
  const after = newDay(args, before, unitPlan(args, before, snap), "plan_workout_day");
  // ifAbsent over a day: Tally skips the date (code exists) and the day stays.
  if (ifAbsent(args, "plan_workout_day") && before) return [{ date: d, before, after: before }];
  return [{ date: d, before, after }];
}

/**
 * plan_workout_range: each day as plan_workout_day, except that a skipped day is left
 * alone (keepSkipped) and a day with ifAbsent over an existing day stays (code exists).
 */
export function planWorkoutRange(rawArgs: unknown, snap: Snapshot): DayChange[] {
  const args = obj(rawArgs, "plan_workout_range input");
  onlyKeys(args, KEYS.plan_workout_range, "plan_workout_range");
  checkOpId(args, "plan_workout_range");
  if (!Array.isArray(args.days) || args.days.length === 0) fail("REBUILD_INVALID", "plan_workout_range.days must be a non-empty list");
  const seen = new Set<string>();
  return args.days.map((raw, i) => {
    const spec = obj(raw, `days[${i}]`);
    onlyKeys(spec, DAY_KEYS, `days[${i}]`);
    checkVersion(spec, `days[${i}]`);
    const absent = ifAbsent(spec, `days[${i}]`);
    const d = date(spec.date, `days[${i}].date`);
    if (seen.has(d)) fail("REBUILD_INVALID", `plan_workout_range: duplicate date ${d}`);
    seen.add(d);
    const before = found(snap, d);
    const after = newDay(spec, before, unitPlan(args, before, snap), `days[${i}]`);
    if (before?.skipped || (absent && before)) return { date: d, before, after: before };
    return { date: d, before, after };
  });
}

type Target = { index: number } | { exerciseId: string };

function target(v: unknown, what: string): Target {
  const t = obj(v, what);
  const keys = Object.keys(t);
  if (keys.length === 1 && keys[0] === "index" && Number.isInteger(t.index) && (t.index as number) >= 0) return { index: t.index as number };
  if (keys.length === 1 && keys[0] === "exerciseId" && typeof t.exerciseId === "string" && t.exerciseId !== "") return { exerciseId: t.exerciseId };
  fail("REBUILD_INVALID", `${what} must be { index } or { exerciseId }`);
}

/**
 * update_planned_workout: operations applied together, every target resolved against the
 * day as read. Exercises no operation names keep their stored values exactly; only the
 * operations' new weights are converted. dayName sets the name; notes null clears them.
 * The skip status, source and userModified are not written.
 */
export function updatePlannedWorkout(rawArgs: unknown, snap: Snapshot): DayChange[] {
  const args = obj(rawArgs, "update_planned_workout input");
  onlyKeys(args, KEYS.update_planned_workout, "update_planned_workout");
  checkOpId(args, "update_planned_workout");
  const d = date(args.date, "date");
  const before = found(snap, d);
  if (!before) fail("REBUILD_NOT_FOUND", `update_planned_workout: nothing is planned on ${d} (Tally returns not_found)`);
  if (!Array.isArray(args.operations) || args.operations.length === 0) fail("REBUILD_INVALID", "operations must be a non-empty list");
  if (args.dayName !== undefined && (typeof args.dayName !== "string" || args.dayName === "")) fail("REBUILD_INVALID", "dayName must be a non-empty string");
  if (args.notes !== undefined && args.notes !== null && typeof args.notes !== "string") fail("REBUILD_INVALID", "notes must be a string or null");
  const unit = unitPlan(args, before, snap);
  const view = before.exercises;

  const bySlot = new Map<number, { op: string; value: Record<string, unknown>; i: number }>();
  const inserts = new Map<number, LoggerExercise[]>();
  args.operations.forEach((raw, i) => {
    const op = obj(raw, `operations[${i}]`);
    const kind = String(op.op);
    if (!(kind in OP_KEYS)) fail("REBUILD_INVALID", `operations[${i}].op must be add | remove | replace | modify`);
    onlyKeys(op, OP_KEYS[kind], `operations[${i}]`);
    if (kind === "add") {
      const ex = withWeight(exercise(op.exercise, `operations[${i}].exercise`), unit.convert);
      let after = view.length - 1;
      if (op.afterIndex !== undefined) {
        if (args.expectedVersion === undefined) fail("REBUILD_INVALID", `operations[${i}]: index targets need expectedVersion`);
        if (!Number.isInteger(op.afterIndex) || (op.afterIndex as number) < -1) fail("REBUILD_INVALID", `operations[${i}].afterIndex must be -1 or more`);
        after = op.afterIndex as number;
        if (after >= view.length) fail("REBUILD_INVALID", `operations[${i}]: afterIndex ${after} is out of range (the day has ${view.length} exercises)`);
      }
      inserts.set(after, [...(inserts.get(after) ?? []), ex]);
      return;
    }
    const t = target(op.target, `operations[${i}].target`);
    let index: number;
    if ("index" in t) {
      if (args.expectedVersion === undefined) fail("REBUILD_INVALID", `operations[${i}]: index targets need expectedVersion`);
      if (t.index >= view.length) fail("REBUILD_INVALID", `operations[${i}]: index ${t.index} is out of range (the day has ${view.length} exercises)`);
      index = t.index;
    } else {
      const hits = view.flatMap((e, k) => (e.exerciseId === t.exerciseId ? [k] : []));
      if (hits.length !== 1) {
        fail("REBUILD_INVALID", `operations[${i}]: exerciseId ${JSON.stringify(t.exerciseId)} matches ${hits.length} exercises on ${d}; it must match exactly one`);
      }
      index = hits[0];
    }
    if (bySlot.has(index)) fail("REBUILD_INVALID", `operations[${bySlot.get(index)!.i}] and operations[${i}] both target the exercise at index ${index}`);
    let value: Record<string, unknown> = {};
    if (kind === "replace") value = withWeight(exercise(op.exercise, `operations[${i}].exercise`), unit.convert);
    if (kind === "modify") {
      const fields = obj(op.fields, `operations[${i}].fields`);
      onlyKeys(fields, MODIFY_FIELDS, `operations[${i}].fields`);
      if (Object.keys(fields).length === 0) fail("REBUILD_INVALID", `operations[${i}].fields needs at least one field`);
      value = withWeight(fields, unit.convert);
    }
    bySlot.set(index, { op: kind, value, i });
  });

  const exercises: LoggerExercise[] = [...(inserts.get(-1) ?? [])];
  view.forEach((stored, slot) => {
    const hit = bySlot.get(slot);
    if (!hit) exercises.push(stored);
    else if (hit.op === "replace") exercises.push(hit.value);
    else if (hit.op === "modify") {
      // mergeModify: keys whose merged value is null are dropped.
      exercises.push(Object.fromEntries(Object.entries({ ...stored, ...hit.value }).filter(([, v]) => v !== null)));
    }
    exercises.push(...(inserts.get(slot) ?? []));
  });
  if (exercises.length < 1 || exercises.length > 30) fail("REBUILD_INVALID", `the update leaves ${exercises.length} exercises on ${d}; a planned day holds 1 to 30`);

  const after: SnapshotDay = { ...before, exercises, version: null, updatedAt: null };
  if (typeof args.dayName === "string") after.dayName = args.dayName;
  if (args.notes === null) delete after.notes;
  else if (typeof args.notes === "string") after.notes = args.notes;
  // An update converts its own weights to the user's unit; untouched ones are already in it.
  if (unit.unit && !after.weightUnit) Object.assign(after, { weightUnit: unit.unit, weightUnitSource: unit.unitSource });
  return [{ date: d, before, after }];
}

/** move_planned_workout: the day moves; content, source, notes and userModified are kept; status resets to planned. */
export function movePlannedWorkout(rawArgs: unknown, snap: Snapshot): DayChange[] {
  const args = obj(rawArgs, "move_planned_workout input");
  onlyKeys(args, KEYS.move_planned_workout, "move_planned_workout");
  checkOpId(args, "move_planned_workout");
  const from = date(args.fromDate, "fromDate");
  const to = date(args.toDate, "toDate");
  if (from === to) fail("REBUILD_INVALID", "toDate must differ from fromDate");
  const before = found(snap, from);
  if (!before) fail("REBUILD_NOT_FOUND", `move_planned_workout: nothing is planned on ${from} (Tally returns not_found)`);
  const dest = found(snap, to);
  if (dest) fail("REBUILD_DESTINATION_OCCUPIED", `move_planned_workout: ${to} already has a planned day (Tally skips: destination_occupied)`);
  return [
    { date: from, before, after: null },
    { date: to, before: null, after: { ...before, skipped: false, version: null, updatedAt: null } },
  ];
}

/** skip_planned_workout: only the status changes (skip: false restores). */
export function skipPlannedWorkout(rawArgs: unknown, snap: Snapshot): DayChange[] {
  const args = obj(rawArgs, "skip_planned_workout input");
  onlyKeys(args, KEYS.skip_planned_workout, "skip_planned_workout");
  checkOpId(args, "skip_planned_workout");
  checkVersion(args, "skip_planned_workout");
  const d = date(args.date, "date");
  if (args.skip !== undefined && typeof args.skip !== "boolean") fail("REBUILD_INVALID", "skip must be true or false");
  const before = found(snap, d);
  if (!before) fail("REBUILD_NOT_FOUND", `skip_planned_workout: nothing is planned on ${d} (Tally returns not_found)`);
  const skipped = args.skip !== false;
  if (before.skipped === skipped) return [{ date: d, before, after: before }];
  return [{ date: d, before, after: { ...before, skipped, version: null, updatedAt: null } }];
}

/** delete_planned_workout: the day is gone. */
export function deletePlannedWorkout(rawArgs: unknown, snap: Snapshot): DayChange[] {
  const args = obj(rawArgs, "delete_planned_workout input");
  onlyKeys(args, KEYS.delete_planned_workout, "delete_planned_workout");
  checkOpId(args, "delete_planned_workout");
  checkVersion(args, "delete_planned_workout");
  const d = date(args.date, "date");
  const before = found(snap, d);
  if (!before) fail("REBUILD_NOT_FOUND", `delete_planned_workout: nothing is planned on ${d} (Tally returns not_found)`);
  return [{ date: d, before, after: null }];
}

/** update_user_profile changes no day. Only the shape is checked here. */
export function updateUserProfile(rawArgs: unknown): DayChange[] {
  const args = obj(rawArgs, "update_user_profile input");
  onlyKeys(args, KEYS.update_user_profile, "update_user_profile");
  return [];
}

/**
 * update_training_limits (Tally T3) changes no day. Only the shape is checked here: 1-20
 * ops, each add_rule, lower_cap or set_weekly_cap; the server validates the rest.
 */
export function updateTrainingLimits(rawArgs: unknown): DayChange[] {
  const args = obj(rawArgs, "update_training_limits input");
  onlyKeys(args, KEYS.update_training_limits, "update_training_limits");
  const ev = args.expectedVersion;
  if (!(ev === null || (typeof ev === "number" && Number.isInteger(ev)))) fail("REBUILD_INVALID", "update_training_limits.expectedVersion must be a whole number or null");
  if (!Array.isArray(args.ops) || args.ops.length < 1 || args.ops.length > 20) fail("REBUILD_INVALID", "update_training_limits.ops must be a list of 1 to 20 ops");
  args.ops.forEach((raw, i) => {
    const op = obj(raw, `ops[${i}]`);
    const keys = typeof op.op === "string" ? LIMIT_OP_KEYS[op.op] : undefined;
    if (!keys) fail("REBUILD_INVALID", `ops[${i}].op must be add_rule, lower_cap or set_weekly_cap (MCP can only tighten limits)`);
    onlyKeys(op, keys, `ops[${i}]`);
  });
  return [];
}

export function rebuild(tool: TallyMutation, args: unknown, snap: Snapshot): DayChange[] {
  switch (tool) {
    case "plan_workout_day":
      return planWorkoutDay(args, snap);
    case "plan_workout_range":
      return planWorkoutRange(args, snap);
    case "update_planned_workout":
      return updatePlannedWorkout(args, snap);
    case "move_planned_workout":
      return movePlannedWorkout(args, snap);
    case "skip_planned_workout":
      return skipPlannedWorkout(args, snap);
    case "delete_planned_workout":
      return deletePlannedWorkout(args, snap);
    case "update_user_profile":
      return updateUserProfile(args);
    case "update_training_limits":
      return updateTrainingLimits(args);
  }
}

/** The dates a mutation reads or writes: each must be in the snapshot before the guard allows it. */
export function affectedDates(tool: TallyMutation, rawArgs: unknown): CalendarDate[] {
  const args = obj(rawArgs, `${tool} input`);
  switch (tool) {
    case "plan_workout_range":
      if (!Array.isArray(args.days)) fail("REBUILD_INVALID", "plan_workout_range.days must be a list");
      return args.days.map((d, i) => date(obj(d, `days[${i}]`).date, `days[${i}].date`));
    case "move_planned_workout":
      return [date(args.fromDate, "fromDate"), date(args.toDate, "toDate")];
    case "update_user_profile":
    case "update_training_limits":
      return [];
    default:
      return [date(args.date, "date")];
  }
}

function setsOf(e: LoggerExercise): SetEntry[] {
  // Fail closed: a stored exercise without a valid set count still counts as 1 set.
  const n = Number.isInteger(e.suggestedSets) && (e.suggestedSets as number) > 0 ? (e.suggestedSets as number) : 1;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // The top of a rep range is the heavier prescription.
  const reps = num(e.repsMax) ?? num(e.suggestedReps);
  const set: SetEntry = { weight: num(e.suggestedWeight), reps, duration_s: num(e.suggestedDuration), rpe: num(e.rpe) };
  // Distance is part of the prescription: a longer ride is more training, not a note.
  const distance = num(e.distanceMeters);
  if (distance !== null) set.distance_m = distance;
  return Array.from({ length: n }, () => ({ ...set }));
}

/**
 * A snapshot day as an engine DayPlan. Weights are in the day's unit when Tally knows
 * it, else in `fallbackUnit` (the call's unit or the athlete's unit).
 */
export function toDayPlan(date: CalendarDate, day: SnapshotDay, fallbackUnit: Units): DayPlan {
  const unit = day.weightUnit ?? fallbackUnit;
  const exercises: ExerciseEntry[] = day.exercises.map((e) => ({
    exerciseId: typeof e.exerciseId === "string" ? e.exerciseId : null,
    name: typeof e.name === "string" ? e.name : "",
    muscle: typeof e.muscle === "string" ? e.muscle : null,
    unit,
    ...(e.perSide === true ? { perSide: true } : {}),
    sets: setsOf(e),
  }));
  return {
    date,
    ...(day.dayName !== undefined ? { dayName: day.dayName } : {}),
    ...(day.dayType !== undefined ? { dayType: day.dayType } : {}),
    ...(day.notes !== undefined ? { notes: day.notes } : {}),
    status: day.skipped ? "skipped" : "planned",
    source: day.source,
    userModified: day.userModified,
    exercises,
  };
}

/** The after-days of a mutation as DayPlans (a deleted or moved-away day is gone). */
export function rebuildDays(tool: TallyMutation, args: unknown, snap: Snapshot, fallbackUnit: Units): DayPlan[] {
  return rebuild(tool, args, snap).flatMap((c) => (c.after ? [toDayPlan(c.date, c.after, fallbackUnit)] : []));
}
