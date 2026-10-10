#!/usr/bin/env node
// Mock Tally MCP server for the harness evals. Zero dependencies:
// stdio, newline-delimited JSON-RPC 2.0 (MCP).
//
// It serves the 11 tools of Tally's main tool list (tools-list.json, pinned from
// workout-app d0b3d30, coach-profile flag off) with Tally's semantics, ported from
// workout-api/lib/mcp (t2-build, 0c9d680): upsertPlannedDay.ts, authority.ts,
// version.ts, operations.ts, plannedExercise.ts, tools/*.ts and migration 013.
//
// Environment:
//   MOCK_TALLY_STATE  path of the JSON state file (required). Read before and
//                     written after every call, so a scenario seeds it and reads it.
//   MOCK_T2=1         Tally T2 (safe writes): ifAbsent, expectedVersion on skip and
//                     delete and on range days, opId receipts and replays, and
//                     get_planned_workout's operations. Off: those inputs are not in
//                     the tool list and are dropped like any unknown key (zod strip).
//   MOCK_T3=1         Tally T3 (server training limits, Tally server-limits spec §4-§6):
//                     update_training_limits, the refusals and trainingLimits.
//   MOCK_NOW          an ISO instant used as "now" (else state.now, else the clock).
//
// State file (all keys optional except days):
//   { timezone, now, weightUnit, weightUnitSource, days: {date: row}, sessions: [],
//     library: [], operations: [], trainingLimits: {version, doc} | null, calls: [] }
// A row uses Tally's column names: id, date, day_type, day_name, exercises, notes,
// source, user_modified, status ('planned' | 'skipped'), updated_at, client_id,
// mcp_batch_id, total_sets, estimated_duration. Missing columns get defaults.
// Every tools/call is appended to `calls` ({at, tool, args, result}).
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const T2 = process.env.MOCK_T2 === "1";
const T3 = process.env.MOCK_T3 === "1";
const STATE_PATH = process.env.MOCK_TALLY_STATE;

// ---------------------------------------------------------------------------
// Small helpers (Tally: version.ts, dates.ts, operations.ts canonicalJson)
// ---------------------------------------------------------------------------

export function encodeVersion(id, updatedAt) {
  return Buffer.from(`${id}|${updatedAt ?? ""}`, "utf8").toString("base64url");
}

export function decodeVersion(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,400}$/.test(token)) return null;
  const text = Buffer.from(token, "base64url").toString("utf8");
  if (Buffer.from(text, "utf8").toString("base64url") !== token) return null;
  const bar = text.indexOf("|");
  if (bar <= 0) return null;
  const updatedAt = text.slice(bar + 1);
  return { id: text.slice(0, bar), updatedAt: updatedAt === "" ? null : updatedAt };
}

const versionOfRow = (row) => encodeVersion(String(row.id), row.updated_at ?? null);

function rowMatchesVersion(row, token) {
  const v = decodeVersion(token);
  return !!v && v.id === String(row.id) && v.updatedAt === (row.updated_at ?? null);
}

export function canonicalJson(value) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : canon(x)));
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canon(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(canon(value));
}

function requestHash(input) {
  const { opId: _opId, ...rest } = input;
  return createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
}

export function todayInTimeZone(now, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isCalendarDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function mondayOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Reasons and texts (reasons.ts, getDbForUser.ts, trainingLimits.ts)
// ---------------------------------------------------------------------------

const VERSION_CONFLICT_REASON = "row changed since read (version conflict)";
const PAST_REASON = "date is in the past (pass allowPast: true to backfill)";
const EXISTS_REASON =
  "a plan already exists on this date. A write with expectedUpdatedAt set to the updatedAt from get_planned_workout " +
  "(null included) replaces the whole day, and so does replace: true; update_planned_workout changes part of it.";
const IF_ABSENT_REASON = "a plan already exists on this date; ifAbsent: true writes only to an empty date";
const DESTINATION_OCCUPIED_REASON = "toDate already has a planned day";
const REPLACE_IMPLIED_WARNING = "Pass replace: true to replace a whole day; update_planned_workout changes part of it.";
const SKIPPED_DAY_REASON = "the user skipped this day (leave it unless the user asks for a new plan that day)";
const IF_ABSENT_CONFLICT =
  "ifAbsent: true cannot be combined with expectedVersion, expectedUpdatedAt, replace: true or overrideUserModified: true";
const INDEX_NEEDS_VERSION = "index targets need expectedVersion from get_planned_workout";
const OP_ID_REUSED = "opId was already used for a different request";
const UNIT_UNKNOWN_WARNING = "The user's weight unit is not known to Tally; suggestedWeight was stored as given.";
const TRAINING_LIMIT_REASON =
  "A training limit the user set in Tally refused this change; nothing was written. Do not retry it with a " +
  "renamed or relabeled exercise. Tell the user which limit refused it; only the user can remove or relax a " +
  "limit, in the Tally app (Settings > Training limits).";
const OLD_WEEK_WARNING = "Tally can keep showing the old date in past weeks.";
const PAST_DESTINATION_WARNING = "The moved day shows in Tally after opening the link.";
const MAX_DAY_EXERCISES = 30;
const MINUTES_PER_SET = 3;
const KG_PER_LB = 0.45359237;

// ---------------------------------------------------------------------------
// Tool list and input validation (the MCP SDK validates against the zod shape and
// strips unknown keys; the handlers add the refinements)
// ---------------------------------------------------------------------------

const T2_PROPS = {
  get_planned_workout: ["opId"],
  plan_workout_day: ["ifAbsent", "opId"],
  plan_workout_range: ["opId"],
  update_planned_workout: ["opId"],
  move_planned_workout: ["opId"],
  skip_planned_workout: ["expectedVersion", "opId"],
  delete_planned_workout: ["expectedVersion", "opId"],
};
const T2_RANGE_DAY_PROPS = ["expectedVersion", "ifAbsent"];

const UPDATE_TRAINING_LIMITS_TOOL = {
  name: "update_training_limits",
  title: "Tighten training limits",
  description:
    "Makes the user's training limits stricter. It can only add rules (add_rule), lower a cap rule's number " +
    "(lower_cap) or set or lower the weekly set cap (set_weekly_cap). It never removes or relaxes a limit: a user " +
    "who wants a limit removed or relaxed does it in the Tally app under Settings > Training limits. " +
    "Pass expectedVersion = trainingLimits.version from get_training_context (null when trainingLimits is null).",
  inputSchema: {
    type: "object",
    properties: {
      ops: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          anyOf: [
            {
              type: "object",
              properties: {
                op: { type: "string", const: "add_rule" },
                rule: {
                  type: "object",
                  properties: {
                    id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$" },
                    label: { type: "string", minLength: 1, maxLength: 80 },
                    region: { type: "string", maxLength: 40 },
                    kind: { type: "string", enum: ["ban", "cap"] },
                    exerciseIds: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 100 } },
                    keywords: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 120 } },
                    exceptKeywords: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 120 } },
                    allow: {
                      type: "array",
                      maxItems: 100,
                      items: {
                        type: "object",
                        properties: {
                          exerciseId: { type: "string", minLength: 1, maxLength: 100 },
                          name: { type: "string", minLength: 1, maxLength: 100 },
                        },
                        required: ["exerciseId", "name"],
                        additionalProperties: false,
                      },
                    },
                    maxSetsPerWeek: { type: "integer", minimum: 0, maximum: 200 },
                  },
                  required: ["id", "label", "kind"],
                  additionalProperties: false,
                },
              },
              required: ["op", "rule"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                op: { type: "string", const: "lower_cap" },
                ruleId: { type: "string", minLength: 1, maxLength: 40 },
                maxSetsPerWeek: { type: "integer", minimum: 0, maximum: 200 },
              },
              required: ["op", "ruleId", "maxSetsPerWeek"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                op: { type: "string", const: "set_weekly_cap" },
                maxWeeklySets: { type: "integer", minimum: 1, maximum: 500 },
              },
              required: ["op", "maxWeeklySets"],
              additionalProperties: false,
            },
          ],
        },
      },
      expectedVersion: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    },
    required: ["ops", "expectedVersion"],
    additionalProperties: false,
  },
};

/** The tool list this mock serves under the current switches. */
export function toolList() {
  const tools = JSON.parse(readFileSync(join(HERE, "tools-list.json"), "utf8"));
  if (!T2) {
    for (const t of tools) {
      for (const p of T2_PROPS[t.name] ?? []) delete t.inputSchema.properties[p];
      if (t.name === "plan_workout_range") {
        const day = t.inputSchema.properties.days.items;
        for (const p of T2_RANGE_DAY_PROPS) delete day.properties[p];
      }
    }
  }
  if (T3) tools.push(UPDATE_TRAINING_LIMITS_TOOL);
  return tools;
}

class InputError extends Error {}

function typeOk(type, v) {
  switch (type) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return isObj(v);
    case "null": return v === null;
    default: return true;
  }
}

/** JSON Schema (the subset zod-to-json-schema emits for Tally) → a list of problems. */
export function schemaProblems(s, v, path = "") {
  const at = path || "input";
  if (s.anyOf) {
    const fits = s.anyOf.filter((alt) => schemaProblems(alt, v, path).length === 0);
    return fits.length ? [] : [`${at}: does not match any allowed shape`];
  }
  if (s.type && !typeOk(s.type, v)) return [`${at}: expected ${s.type}`];
  if (s.const !== undefined && v !== s.const) return [`${at}: must be ${JSON.stringify(s.const)}`];
  if (s.enum && !s.enum.includes(v)) return [`${at}: must be one of ${s.enum.join(", ")}`];
  const out = [];
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) out.push(`${at}: at least ${s.minLength} characters`);
    if (s.maxLength !== undefined && v.length > s.maxLength) out.push(`${at}: at most ${s.maxLength} characters`);
    if (s.pattern && !new RegExp(s.pattern, "u").test(v)) out.push(`${at}: does not match ${s.pattern}`);
  }
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) out.push(`${at}: at least ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) out.push(`${at}: at most ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) out.push(`${at}: at least ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) out.push(`${at}: at most ${s.maxItems} items`);
    if (s.items) v.forEach((x, i) => out.push(...schemaProblems(s.items, x, `${path}[${i}]`)));
  }
  if (isObj(v) && s.properties) {
    for (const r of s.required ?? []) if (v[r] === undefined) out.push(`${path ? path + "." : ""}${r}: required`);
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      if (s.properties[k]) out.push(...schemaProblems(s.properties[k], x, path ? `${path}.${k}` : k));
      else if (s.additionalProperties === false) out.push(`${path ? path + "." : ""}${k}: unknown key`);
    }
  }
  return out;
}

/** Drops keys the schema does not name (zod's default strip), recursively. */
export function strip(s, v) {
  if (s.anyOf) {
    const alt = s.anyOf.find((a) => schemaProblems(a, v).length === 0);
    return alt ? strip(alt, v) : v;
  }
  if (Array.isArray(v) && s.items) return v.map((x) => strip(s.items, x));
  if (isObj(v) && s.properties) {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (s.properties[k] && x !== undefined) out[k] = strip(s.properties[k], x);
    return out;
  }
  return v;
}

function inputError(msg) {
  throw new InputError(msg);
}

const DISTANCE_TYPES = new Set(["distance", "weight_distance"]);

function checkExercise(e, path) {
  if (e.trackingType && DISTANCE_TYPES.has(e.trackingType)) {
    if (e.distanceMeters == null || e.distanceMeters < 1) inputError(`${path}.distanceMeters: trackingType ${e.trackingType} needs distanceMeters (meters, at least 1)`);
  } else if (e.trackingType && e.distanceMeters != null) {
    inputError(`${path}.distanceMeters: distanceMeters applies only to trackingType distance or weight_distance`);
  }
}

function checkIfAbsent(d, path) {
  if (d.ifAbsent !== true) return;
  if (d.expectedVersion !== undefined || d.expectedUpdatedAt !== undefined || d.replace === true || d.overrideUserModified === true) {
    inputError(`${path}ifAbsent: ${IF_ABSENT_CONFLICT}`);
  }
}

/** The zod refinements every tool shares: calendar dates, timezones, version tokens, exercises. */
function refine(tool, a) {
  const date = (v, p) => {
    if (v !== undefined && !isCalendarDate(v)) inputError(`${p}: not a valid calendar date`);
  };
  const version = (v, p) => {
    if (v !== undefined && decodeVersion(v) === null) inputError(`${p}: not a version from get_planned_workout`);
  };
  if (a.timezone !== undefined && !isValidTimeZone(a.timezone)) inputError("timezone: invalid IANA timezone");
  for (const k of ["date", "fromDate", "toDate", "since", "until"]) date(a[k], k);
  if (tool !== "update_training_limits") version(a.expectedVersion, "expectedVersion");
  (a.exercises ?? []).forEach?.((e, i) => typeof e === "object" && checkExercise(e, `exercises[${i}]`));
  if (tool === "plan_workout_day") checkIfAbsent(a, "");
  if (tool === "plan_workout_range") {
    a.days.forEach((d, i) => {
      date(d.date, `days[${i}].date`);
      version(d.expectedVersion, `days[${i}].expectedVersion`);
      d.exercises.forEach((e, k) => checkExercise(e, `days[${i}].exercises[${k}]`));
      checkIfAbsent(d, `days[${i}].`);
    });
    if (new Set(a.days.map((d) => d.date)).size !== a.days.length) inputError("days: duplicate dates in range");
  }
  if (tool === "update_planned_workout") {
    a.operations.forEach((op, i) => {
      if (op.exercise) checkExercise(op.exercise, `operations[${i}].exercise`);
      if (op.op === "modify" && Object.keys(op.fields ?? {}).length === 0) inputError(`operations[${i}].fields: fields needs at least one field`);
    });
  }
  if (tool === "search_exercises" && a.query === undefined && a.queries === undefined) inputError("Provide at least one of query or queries");
}

// ---------------------------------------------------------------------------
// State and clock
// ---------------------------------------------------------------------------

function loadState() {
  if (!STATE_PATH) throw new Error("MOCK_TALLY_STATE is not set");
  let s;
  try {
    s = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    s = {};
  }
  s.timezone ??= "America/Los_Angeles";
  s.weightUnit ??= "lbs";
  s.weightUnitSource ??= "default";
  s.days ??= {};
  s.sessions ??= [];
  s.operations ??= [];
  s.calls ??= [];
  if (s.trainingLimits === undefined) s.trainingLimits = null;
  for (const [date, row] of Object.entries(s.days)) s.days[date] = normalizeRow(date, row);
  return s;
}

function saveState(s) {
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, STATE_PATH);
}

export function normalizeRow(date, row) {
  const exercises = Array.isArray(row.exercises) ? row.exercises : [];
  const totals = computeTotals(exercises);
  return {
    id: row.id ?? randomUUID(),
    date,
    client_id: row.client_id ?? `seed-${date}`,
    day_type: row.day_type ?? "workout",
    day_name: row.day_name ?? "Workout",
    exercises,
    total_sets: row.total_sets ?? totals.totalSets,
    estimated_duration: row.estimated_duration ?? totals.estimatedDuration,
    source: row.source ?? "mcp",
    status: row.status ?? "planned",
    user_modified: row.user_modified ?? false,
    notes: row.notes ?? null,
    mcp_batch_id: row.mcp_batch_id ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function nowOf(s) {
  const fixed = process.env.MOCK_NOW ?? s.now;
  return fixed ? new Date(fixed) : new Date();
}

/** A new updated_at, strictly later than every one stored (Postgres now() moves on). */
function stamp(s) {
  let t = nowOf(s).getTime();
  const last = s.clock ? Date.parse(s.clock) : 0;
  if (t <= last) t = last + 1000;
  s.clock = new Date(t).toISOString();
  return s.clock;
}

function computeTotals(exercises) {
  const setsOf = (e) => (isObj(e) && typeof e.suggestedSets === "number" && Number.isFinite(e.suggestedSets) && e.suggestedSets > 0 ? e.suggestedSets : 0);
  const totalSets = exercises.reduce((n, e) => n + setsOf(e), 0);
  return { totalSets, estimatedDuration: totalSets * MINUTES_PER_SET };
}

// plannedExercise.ts: the read view keeps entries with a name, writable fields only.
const num = (v) => (typeof v === "number" ? v : undefined);
const str = (v) => (v == null ? undefined : String(v));
const TRACKING = ["weight_reps", "bodyweight_reps", "duration", "weight_duration", "distance", "weight_distance"];

export function toPlannedExerciseDetail(raw) {
  const e = raw ?? {};
  if (!e.name) return null;
  return compact({
    exerciseId: str(e.exerciseId),
    name: String(e.name),
    muscle: str(e.muscle),
    trackingType: typeof e.trackingType === "string" && TRACKING.includes(e.trackingType) ? e.trackingType : undefined,
    equipment: str(e.equipment),
    suggestedSets: num(e.suggestedSets),
    suggestedReps: num(e.suggestedReps),
    suggestedWeight: num(e.suggestedWeight),
    suggestedDuration: num(e.suggestedDuration),
    repsMax: num(e.repsMax),
    rpe: num(e.rpe),
    perSide: typeof e.perSide === "boolean" ? e.perSide : undefined,
    distanceMeters: num(e.distanceMeters),
  });
}

function indexedPlannedExercises(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((entry, storageIndex) => {
    const detail = toPlannedExerciseDetail(entry);
    if (detail) out.push({ storageIndex, detail });
  });
  return out;
}

const toPlannedExerciseDetails = (raw) => indexedPlannedExercises(raw).map((e) => e.detail);

const unitKnown = (s) => s.weightUnitSource === "settings" || s.weightUnitSource === "history";

export function convertWeight(value, from, to) {
  if (from === to) return value;
  if (to === "kg") return Math.round(value * KG_PER_LB * 2) / 2;
  return Math.round(value / KG_PER_LB);
}

function conversionWarning(from, to) {
  return `suggestedWeight converted from ${from} to ${to} (the user's unit)`;
}

function plannedDetail(date, row, s) {
  return compact({
    date,
    found: true,
    dayType: str(row.day_type),
    dayName: str(row.day_name),
    notes: str(row.notes),
    source: str(row.source) ?? "builder",
    userModified: Boolean(row.user_modified),
    skipped: row.status === "skipped",
    updatedAt: row.updated_at ?? null,
    version: versionOfRow(row),
    exercises: toPlannedExerciseDetails(row.exercises),
    weightUnit: s.weightUnit,
    weightUnitSource: s.weightUnitSource,
  });
}

/** authority.ts decidePlannedWrite. */
function protectedReason(row, override) {
  if (!row || override) return null;
  if (String(row.source ?? "builder") !== "mcp") return "row is user-authored (source != mcp)";
  if (row.user_modified) return "row was user-modified";
  return null;
}

// ---------------------------------------------------------------------------
// T3: training limits (Tally server-limits spec §4, migration 017)
// ---------------------------------------------------------------------------

const NON_ALNUM = /[^\p{L}\p{N}]+/gu;

/** §4.1 norm(): NFKC, lowercase, every run of non letters/digits becomes one space, trimmed. */
export function norm(s) {
  if (s == null) return "";
  return String(s).normalize("NFKC").toLowerCase().replace(NON_ALNUM, " ").trim();
}

/** Start positions where `k` begins at a word start of `field`. */
function wordStarts(field, k) {
  const out = [];
  for (let p = field.indexOf(k); p !== -1; p = field.indexOf(k, p + 1)) if (p === 0 || field[p - 1] === " ") out.push(p);
  return out;
}

/** True when a keyword occurs in the field outside every except span (§4.1 masking). */
function keywordHits(field, keywords, excepts) {
  if (field === "") return false;
  const spans = [];
  for (const x of excepts) {
    for (const a of wordStarts(field, x)) {
      const next = field.indexOf(" ", a + x.length);
      spans.push([a, next === -1 ? field.length : next]);
    }
  }
  for (const k of keywords) {
    for (const p of wordStarts(field, k)) {
      if (!spans.some(([a, b]) => a < p + k.length && b > p)) return true;
    }
  }
  return false;
}

/** §4.1: does exercise `e` match rule `r`? */
export function ruleMatches(r, e) {
  if (!isObj(e)) return false;
  const nn = norm(e.name);
  const ni = norm(e.exerciseId);
  if ((r.allow ?? []).some((a) => norm(a.exerciseId) === ni && norm(a.name) === nn)) return false;
  if (ni !== "" && (r.exerciseIds ?? []).some((i) => norm(i) === ni)) return true;
  const kw = r.keywords ?? [];
  const ex = r.exceptKeywords ?? [];
  return keywordHits(nn, kw, ex) || keywordHits(ni, kw, ex);
}

const setsCounted = (e) => (isObj(e) && typeof e.suggestedSets === "number" && Number.isFinite(e.suggestedSets) && e.suggestedSets >= 0 ? e.suggestedSets : 0);
const labelOf = (e) => (isObj(e) ? (e.name || e.exerciseId || "(unnamed)") : "(unnamed)");

function sumSets(exercises, pred) {
  return (Array.isArray(exercises) ? exercises : []).reduce((n, e) => n + (pred(e) ? setsCounted(e) : 0), 0);
}

class Refusal extends Error {
  constructor(detail) {
    super(`training limit: ${detail.label}`);
    this.detail = detail;
  }
}

function limitsActive(s) {
  const doc = s.trainingLimits?.doc;
  if (!T3 || !doc) return false;
  return (doc.rules ?? []).length > 0 || typeof doc.maxWeeklySets === "number";
}

/**
 * The deferred trigger (§4.2 b, §4.3) for one row event, against the transaction's
 * final rows. Throws a Refusal with the DETAIL of the first failed check.
 */
function enforce(s, days, event, moves) {
  if (event.newStatus === "skipped") return;
  const cur = Object.values(days).find((r) => r.id === event.id);
  if (!cur || cur.status === "skipped") return;
  let prior = null;
  if (event.op === "UPDATE") prior = event.old;
  else {
    let i = moves.findIndex((m) => m.dstId === cur.id);
    const exists = (id) => Object.values(days).some((r) => r.id === id);
    if (i !== -1 && !exists(moves[i].srcId)) {
      for (;;) {
        const src = moves[i].srcId;
        let j = -1;
        for (let k = i - 1; k >= 0; k--) if (moves[k].dstId === src) { j = k; break; }
        if (j === -1 || exists(moves[j].srcId)) break;
        i = j;
      }
      const m = moves[i];
      prior = { date: m.srcDate, status: m.srcStatus, exercises: m.srcExercises };
    }
  }
  const mon = mondayOf(cur.date);
  const sun = addDays(mon, 6);
  const priorAny = prior !== null && prior.status !== "skipped";
  const priorInW = priorAny && prior.date >= mon && prior.date <= sun;
  const week = Object.values(days).filter((r) => r.date >= mon && r.date <= sun && r.status !== "skipped");
  const doc = s.trainingLimits.doc;
  const checks = [];
  (doc.rules ?? []).forEach((r, i) => checks.push({ r, i, order: r.kind === "ban" ? 0 : 1 }));
  checks.sort((a, b) => a.order - b.order || a.i - b.i);
  if (typeof doc.maxWeeklySets === "number") checks.push({ r: null });
  for (const { r } of checks) {
    const pred = r ? (e) => ruleMatches(r, e) : () => true;
    const after = week.reduce((n, row) => n + sumSets(row.exercises, pred), 0);
    const curSets = sumSets(cur.exercises, pred);
    const priorSets = priorAny ? sumSets(prior.exercises, pred) : 0;
    const before = after - curSets + (priorInW ? priorSets : 0);
    let code = null;
    let limit = 0;
    if (r && r.kind === "ban") {
      if (curSets > priorSets) code = "TL001";
    } else if (r) {
      limit = r.maxSetsPerWeek;
      if (after > limit && after > before) code = "TL002";
    } else {
      limit = doc.maxWeeklySets;
      if (after > limit && after > before) code = "TL003";
    }
    if (!code) continue;
    const names = [...new Set((Array.isArray(cur.exercises) ? cur.exercises : []).filter(pred).map(labelOf))].sort().slice(0, 30);
    throw new Refusal({
      code,
      ruleId: r ? r.id : null,
      label: r ? r.label : "Weekly set cap",
      kind: r ? r.kind : "weekly",
      date: cur.date,
      weekStart: mon,
      after,
      before,
      limit,
      exercises: names,
    });
  }
}

function refusedLimit(d) {
  return d.code === "TL003" ? { weeklyCap: true } : { ruleId: d.ruleId ?? "", label: d.label ?? "", kind: d.kind };
}

function refusedDay(d) {
  return {
    date: d.date,
    status: "refused",
    code: "training_limit",
    limit: refusedLimit(d),
    week: { start: d.weekStart, after: d.after, limit: d.limit },
    exercises: d.exercises,
    reason: TRAINING_LIMIT_REASON,
  };
}

function refusedCall(d, notWritten) {
  return {
    status: "refused",
    code: "training_limit",
    violatingDate: d.date,
    limit: refusedLimit(d),
    week: { start: d.weekStart, after: d.after, limit: d.limit },
    exercises: d.exercises,
    notWritten,
    reason: TRAINING_LIMIT_REASON,
  };
}

const dayOfCall = (c) => ({
  date: c.violatingDate,
  status: "refused",
  code: "training_limit",
  limit: c.limit,
  week: c.week,
  exercises: c.exercises,
  reason: TRAINING_LIMIT_REASON,
});

// ---------------------------------------------------------------------------
// Row operations and transactions (operations.ts executeRowOp, migrations 013, 016)
// ---------------------------------------------------------------------------

/** One transaction over the day rows: ops run on a copy; commit runs the T3 trigger first. */
class Tx {
  constructor(s) {
    this.s = s;
    this.days = clone(s.days);
    this.events = [];
    this.moves = [];
  }
  byDate(date) {
    return this.days[date] ?? null;
  }
  exec(op) {
    const row = this.days[op.date] ?? null;
    const casOk = (r) => r && r.id === op.id && (r.updated_at ?? null) === (op.expectedUpdatedAt ?? null);
    switch (op.action) {
      case "insert": {
        if (row) return { status: "conflict", id: null, updatedAt: null };
        const r = normalizeRow(op.date, { ...op.row, id: randomUUID(), updated_at: null });
        this.days[op.date] = r;
        this.events.push({ op: "INSERT", id: r.id, newStatus: r.status });
        return { status: "written", id: r.id, updatedAt: null };
      }
      case "update": {
        if (!casOk(row)) return { status: "conflict", id: null, updatedAt: null };
        const old = clone(row);
        const next = { ...row, ...op.row, date: op.date, updated_at: stamp(this.s) };
        // Trigger 011: a new client_id with an unchanged status resets status to planned.
        if (next.client_id !== old.client_id && next.status === old.status) next.status = "planned";
        this.days[op.date] = next;
        this.events.push({ op: "UPDATE", id: row.id, old, newStatus: next.status });
        return { status: "written", id: row.id, updatedAt: next.updated_at };
      }
      case "set_status": {
        if (!casOk(row)) return { status: "conflict", id: null, updatedAt: null };
        const old = clone(row);
        const next = { ...row, status: op.status, updated_at: stamp(this.s) };
        this.days[op.date] = next;
        this.events.push({ op: "UPDATE", id: row.id, old, newStatus: next.status });
        return { status: "updated", id: row.id, updatedAt: next.updated_at };
      }
      case "delete": {
        if (!casOk(row)) return { status: "conflict", id: null, updatedAt: null };
        delete this.days[op.date];
        return { status: "deleted", id: row.id, updatedAt: null };
      }
      case "move": {
        if (!row) return { status: "not_found", id: null, updatedAt: null };
        if (!casOk(row)) return { status: "version_conflict", id: null, updatedAt: null };
        if (this.days[op.toDate]) return { status: "destination_occupied", id: null, updatedAt: null };
        // 013: same client_id, source, notes, batch and user_modified; status planned; updated_at NULL.
        const moved = { ...clone(row), id: randomUUID(), date: op.toDate, status: "planned", updated_at: null };
        this.days[op.toDate] = moved;
        this.events.push({ op: "INSERT", id: moved.id, newStatus: "planned" });
        // 017 t3_note_move: the lineage, between the INSERT and the DELETE.
        this.moves.push({ srcId: row.id, srcDate: row.date, srcStatus: row.status, srcExercises: clone(row.exercises), dstId: moved.id });
        delete this.days[op.date];
        return { status: "moved", id: moved.id, updatedAt: null };
      }
    }
    throw new Error(`unknown row operation ${op.action}`);
  }
  commit() {
    if (limitsActive(this.s)) for (const ev of this.events) enforce(this.s, this.days, ev, this.moves);
    this.s.days = this.days;
  }
}

/** Every date a call names (entry dates, then move destinations), once each. */
function callDates(entries) {
  const dates = [];
  const add = (d) => { if (!dates.includes(d)) dates.push(d); };
  for (const e of entries) add(e.date);
  for (const e of entries) if (e.op && e.op.action === "move") add(e.op.toDate);
  return dates;
}

/** operations.ts replayItem. */
function replayItem(tool, r) {
  const date = String(r.input_date ?? r.date ?? "");
  if (!r.action) return compact({ date, toDate: r.to_date ?? undefined, status: r.status, code: r.code ?? undefined, reason: r.reason ?? undefined });
  const id = r.id ?? undefined;
  const updatedAt = r.updated_at ?? null;
  const written = (status) => compact({ date, status, id, updatedAt, version: id ? encodeVersion(id, updatedAt) : undefined });
  const conflict = { date, status: "skipped", code: "version_conflict", reason: VERSION_CONFLICT_REASON };
  switch (r.action) {
    case "insert":
    case "update":
      if (r.status !== "written") return conflict;
      return written(tool === "update_planned_workout" ? "updated" : "written");
    case "set_status":
      return r.status === "updated" ? written("updated") : { date, status: "conflict", reason: VERSION_CONFLICT_REASON };
    case "delete":
      return r.status === "deleted" ? compact({ date, status: "deleted", id }) : conflict;
    case "move": {
      const toDate = r.to_date ?? undefined;
      if (r.status === "moved") return { ...written("moved"), ...(toDate ? { toDate } : {}) };
      if (r.status === "not_found") return compact({ date, toDate, status: "not_found", code: "not_found" });
      if (r.status === "destination_occupied") return compact({ date, toDate, status: "skipped", code: "destination_occupied", reason: DESTINATION_OCCUPIED_REASON });
      return compact({ ...conflict, toDate });
    }
    default:
      return compact({ date, status: r.status });
  }
}

function replayResult(opId, tool, stored, recordedAt) {
  return { replayed: true, opId, recordedAt, results: (stored ?? []).map((r) => replayItem(tool, r)) };
}

/** beginOperation: the receipt lookup comes first. */
function beginOperation(s, tool, input) {
  if (!T2 || input.opId === undefined) return { kind: "none" };
  const hash = requestHash(input);
  const receipt = s.operations.find((o) => o.opId === input.opId);
  if (receipt) {
    if (receipt.tool === tool && receipt.requestHash === hash) return { kind: "replay", result: replayResult(input.opId, tool, receipt.result, receipt.recordedAt) };
    inputError(`opId: ${OP_ID_REUSED}`);
  }
  return { kind: "new", op: { opId: input.opId, tool, hash } };
}

/**
 * runEntries. No operation: each row op is its own transaction (a T3 refusal becomes
 * that entry's refused day; later entries still run). With one: one transaction for
 * every op plus the receipt; a refusal rolls back everything ({refused}).
 */
function runEntries(s, op, entries) {
  if (!op) {
    const results = [];
    for (const e of entries) {
      if (!e.op) {
        results.push(e.result);
        continue;
      }
      const tx = new Tx(s);
      const outcome = tx.exec(e.op);
      try {
        tx.commit();
      } catch (err) {
        if (!(err instanceof Refusal)) throw err;
        results.push(refusedDay(err.detail));
        continue;
      }
      results.push(e.finish(outcome));
    }
    return { results };
  }
  const tx = new Tx(s);
  const outcomes = entries.map((e) => (e.op ? tx.exec(e.op) : null));
  try {
    tx.commit();
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    return { refused: refusedCall(err.detail, callDates(entries)) };
  }
  const recordedAt = nowOf(s).toISOString();
  const stored = entries.map((e, i) => {
    if (!e.op) return compact({ input_date: e.date, ...e.decided });
    const o = outcomes[i];
    return compact({
      input_date: e.date,
      action: e.op.action,
      date: e.op.date,
      to_date: e.op.action === "move" ? e.op.toDate : undefined,
      status: o.status,
      id: o.id,
      updated_at: o.updatedAt,
    });
  });
  s.operations.push({ opId: op.opId, tool: op.tool, requestHash: op.hash, recordedAt, result: stored, dates: callDates(entries) });
  return { results: entries.map((e, i) => (e.op ? e.finish(outcomes[i]) : e.result)) };
}

// ---------------------------------------------------------------------------
// Write tools
// ---------------------------------------------------------------------------

function pastRule(s, a, date) {
  const tz = a.timezone ?? s.timezone;
  return !a.allowPast && date < todayInTimeZone(nowOf(s), tz);
}

function newBatchId(s) {
  return `mcp_${nowOf(s).getTime().toString(36)}`;
}

/** upsertPlannedDay.ts decidePlannedDay. */
function decidePlannedDay(s, batchId, day, opts) {
  const skip = (code, reason) => ({ date: day.date, decided: { status: "skipped", code, reason }, result: { date: day.date, status: "skipped", reason, code } });
  const existing = s.days[day.date] ?? null;
  if (day.ifAbsent === true && existing) return skip("exists", IF_ABSENT_REASON);
  if (opts.past) return skip("past", PAST_REASON);
  const prot = protectedReason(existing, day.overrideUserModified);
  if (prot) return skip("protected", prot);
  const wasSkipped = existing?.status === "skipped";
  if (opts.keepSkipped && wasSkipped) return skip("skipped_day", SKIPPED_DAY_REASON);
  if (day.expectedVersion !== undefined && !(existing && rowMatchesVersion(existing, day.expectedVersion))) {
    return skip("version_conflict", VERSION_CONFLICT_REASON);
  }
  const hasExercises = Array.isArray(existing?.exercises) && existing.exercises.length > 0;
  const readFirst = day.expectedUpdatedAt !== undefined || day.expectedVersion !== undefined;
  if (opts.guardExisting && hasExercises && day.replace !== true && !readFirst) return skip("exists", EXISTS_REASON);
  const replaceImplied = Boolean(opts.guardExisting && hasExercises && day.replace !== true);
  const expectedUpdatedAt =
    day.expectedVersion === undefined && day.expectedUpdatedAt !== undefined ? day.expectedUpdatedAt : (existing?.updated_at ?? null);
  const { totalSets, estimatedDuration } = computeTotals(day.exercises);
  const row = {
    client_id: `mcp-${batchId}-${day.date}`,
    day_type: day.dayType,
    day_name: day.dayName,
    exercises: day.exercises,
    total_sets: totalSets,
    estimated_duration: estimatedDuration,
    source: "mcp",
    status: "planned",
    notes: day.notes ?? null,
    mcp_batch_id: batchId,
  };
  const op = existing
    ? { action: "update", date: day.date, id: existing.id, expectedUpdatedAt, row }
    : { action: "insert", date: day.date, row };
  return {
    date: day.date,
    op,
    finish: (o) => {
      if (o.status !== "written") return { date: day.date, status: "skipped", reason: VERSION_CONFLICT_REASON, code: "version_conflict" };
      return compact({
        date: day.date,
        status: "written",
        clearedSkip: wasSkipped || undefined,
        replacedExisting: existing ? true : undefined,
        replaceImplied: replaceImplied || undefined,
      });
    },
  };
}

function partition(rows, batchId, warnings) {
  const results = [];
  const skippedDates = [];
  const out = [...warnings];
  for (const r of rows) {
    if (r.status === "refused") results.push(r);
    else if (r.status === "written") {
      results.push(compact({ date: r.date, status: "written", clearedSkip: r.clearedSkip, replacedExisting: r.replacedExisting }));
      if (r.replaceImplied && !out.includes(REPLACE_IMPLIED_WARNING)) out.push(REPLACE_IMPLIED_WARNING);
    } else skippedDates.push({ date: r.date, reason: r.reason, code: r.code });
  }
  return { results, skippedDates, warnings: out, batchId };
}

/** planWorkout.ts toUserUnit (G1). */
function toUserUnit(s, callUnit, days) {
  if (!callUnit) return { days, warnings: [] };
  if (!unitKnown(s)) {
    const weighted = days.some((d) => d.exercises.some((e) => typeof e.suggestedWeight === "number"));
    return { days, warnings: weighted ? [UNIT_UNKNOWN_WARNING] : [] };
  }
  if (s.weightUnit === callUnit) return { days, warnings: [] };
  let converted = 0;
  const out = days.map((d) => ({
    ...d,
    exercises: d.exercises.map((e) => {
      if (typeof e.suggestedWeight !== "number") return e;
      const v = convertWeight(e.suggestedWeight, callUnit, s.weightUnit);
      if (v < 0 || v > 2000) inputError(`day ${d.date}: suggestedWeight converts to ${v} ${s.weightUnit}, outside 0-2000`);
      converted += 1;
      return { ...e, suggestedWeight: v };
    }),
  }));
  return { days: out, warnings: converted ? [conversionWarning(callUnit, s.weightUnit)] : [] };
}

function planWorkoutDay(s, a) {
  const batchId = newBatchId(s);
  const started = beginOperation(s, "plan_workout_day", a);
  if (started.kind === "replay") return started.result;
  const op = started.kind === "new" ? started.op : null;
  const past = pastRule(s, a, a.date);
  let entry;
  let warnings = [];
  if (past && a.ifAbsent !== true) {
    if (!op) return partition([{ date: a.date, status: "skipped", reason: PAST_REASON, code: "past" }], batchId, []);
    entry = { date: a.date, decided: { status: "skipped", code: "past", reason: PAST_REASON }, result: { date: a.date, status: "skipped", reason: PAST_REASON, code: "past" } };
  } else {
    const conv = toUserUnit(s, a.weightUnit, [a]);
    warnings = conv.warnings;
    entry = decidePlannedDay(s, batchId, conv.days[0], { guardExisting: true, past });
  }
  const run = runEntries(s, op, [entry]);
  const rows = run.refused ? [dayOfCall(run.refused)] : run.results;
  return partition(rows, batchId, warnings);
}

function planWorkoutRange(s, a) {
  const batchId = newBatchId(s);
  const started = beginOperation(s, "plan_workout_range", a);
  if (started.kind === "replay") return started.result;
  const op = started.kind === "new" ? started.op : null;
  const { days, warnings } = toUserUnit(s, a.weightUnit, a.days);
  const decide = (day) => {
    const past = pastRule(s, a, day.date);
    if (past && day.ifAbsent !== true) {
      return { date: day.date, decided: { status: "skipped", code: "past", reason: PAST_REASON }, result: { date: day.date, status: "skipped", reason: PAST_REASON, code: "past" } };
    }
    return decidePlannedDay(s, batchId, day, { keepSkipped: true, past });
  };
  if (!op) {
    const rows = [];
    for (const day of days) rows.push(...runEntries(s, null, [decide(day)]).results);
    return partition(rows, batchId, warnings);
  }
  const entries = days.map(decide);
  const run = runEntries(s, op, entries);
  if (run.refused) return run.refused;
  return partition(run.results, batchId, warnings);
}

function updatePlannedWorkout(s, a) {
  const usesIndex = (op) => (op.op === "add" ? op.afterIndex !== undefined : "index" in op.target);
  if (a.expectedVersion === undefined) a.operations.forEach((op, i) => usesIndex(op) && inputError(`operations[${i}]: ${INDEX_NEEDS_VERSION}`));
  const started = beginOperation(s, "update_planned_workout", a);
  if (started.kind === "replay") return started.result;
  const op = started.kind === "new" ? started.op : null;
  const { date } = a;
  const decided = (result) => ({ date, decided: compact({ status: result.status, code: result.code, reason: result.reason }), result });
  const row = s.days[date] ?? null;
  let entry;
  if (!row) entry = decided({ date, status: "not_found", code: "not_found" });
  else if (a.expectedVersion !== undefined && !rowMatchesVersion(row, a.expectedVersion)) {
    entry = decided({ date, status: "skipped", reason: VERSION_CONFLICT_REASON, code: "version_conflict" });
  } else if (protectedReason(row, a.overrideUserModified)) {
    entry = decided({ date, status: "skipped", reason: protectedReason(row, a.overrideUserModified), code: "protected" });
  } else {
    const stored = Array.isArray(row.exercises) ? row.exercises : [];
    const view = indexedPlannedExercises(stored);
    const setsWeight = (o) => (o.op === "add" || o.op === "replace" ? typeof o.exercise.suggestedWeight === "number" : o.op === "modify" ? typeof o.fields.suggestedWeight === "number" : false);
    const unitUnknown = Boolean(a.weightUnit) && !unitKnown(s) && a.operations.some(setsWeight);
    let converted = 0;
    const conv = (w) => {
      if (unitUnknown || !a.weightUnit || a.weightUnit === s.weightUnit) return w;
      converted += 1;
      return convertWeight(w, a.weightUnit, s.weightUnit);
    };
    const ops = a.operations.map((o) => {
      if ((o.op === "add" || o.op === "replace") && typeof o.exercise.suggestedWeight === "number") return { ...o, exercise: { ...o.exercise, suggestedWeight: conv(o.exercise.suggestedWeight) } };
      if (o.op === "modify" && typeof o.fields.suggestedWeight === "number") return { ...o, fields: { ...o.fields, suggestedWeight: conv(o.fields.suggestedWeight) } };
      return o;
    });
    const bySlot = new Map();
    const inserts = new Map();
    ops.forEach((o, i) => {
      if (o.op === "add") {
        let after;
        if (o.afterIndex === undefined) after = stored.length - 1;
        else if (o.afterIndex === -1) after = -1;
        else {
          const ent = view[o.afterIndex];
          if (!ent) inputError(`operations[${i}]: afterIndex ${o.afterIndex} is out of range (the day has ${view.length} exercises)`);
          after = ent.storageIndex;
        }
        inserts.set(after, [...(inserts.get(after) ?? []), o.exercise]);
        return;
      }
      let index;
      if ("index" in o.target) {
        index = o.target.index;
        if (index >= view.length) inputError(`operations[${i}]: index ${index} is out of range (the day has ${view.length} exercises)`);
      } else {
        const hits = view.flatMap((e, k) => (e.detail.exerciseId === o.target.exerciseId ? [k] : []));
        if (hits.length === 0) inputError(`operations[${i}]: no exercise on ${date} has exerciseId "${o.target.exerciseId}"`);
        if (hits.length > 1) inputError(`operations[${i}]: exerciseId "${o.target.exerciseId}" matches the exercises at indexes ${hits.join(", ")}; an index target selects one`);
        index = hits[0];
      }
      const slot = view[index].storageIndex;
      if (bySlot.has(slot)) inputError(`operations[${bySlot.get(slot).i}] and operations[${i}] both target the exercise at index ${index}`);
      bySlot.set(slot, { o, i, index });
    });
    const exercises = [...(inserts.get(-1) ?? [])];
    stored.forEach((raw, slot) => {
      const hit = bySlot.get(slot);
      if (!hit) exercises.push(raw);
      else if (hit.o.op === "replace") exercises.push(hit.o.exercise);
      else if (hit.o.op === "modify") {
        const merged = Object.fromEntries(Object.entries({ ...(isObj(raw) ? raw : {}), ...hit.o.fields }).filter(([, v]) => v !== null));
        const problems = schemaProblems(exerciseSchema(), merged);
        if (problems.length) inputError(`operations[${hit.i}]: the exercise at index ${hit.index} is not valid after this change (${problems[0]}); a replace operation can supply the full exercise`);
        exercises.push(merged);
      }
      exercises.push(...(inserts.get(slot) ?? []));
    });
    const valid = exercises.filter((e) => toPlannedExerciseDetail(e) !== null).length;
    if (valid < 1 || valid > MAX_DAY_EXERCISES) inputError(`operations: the update leaves ${valid} exercises on ${date}; a planned day holds 1 to ${MAX_DAY_EXERCISES}`);
    const { totalSets, estimatedDuration } = computeTotals(exercises);
    const patch = { exercises, total_sets: totalSets, estimated_duration: estimatedDuration };
    if (a.dayName !== undefined) patch.day_name = a.dayName;
    if (a.notes !== undefined) patch.notes = a.notes;
    const warnings = unitUnknown ? [UNIT_UNKNOWN_WARNING] : converted > 0 ? [conversionWarning(a.weightUnit, s.weightUnit)] : [];
    entry = {
      date,
      op: { action: "update", date, id: row.id, expectedUpdatedAt: row.updated_at ?? null, row: patch },
      finish: (o) =>
        o.status === "written"
          ? { date, status: "updated", day: plannedDetail(date, { ...row, ...patch, updated_at: o.updatedAt ?? null }, s), warnings }
          : { date, status: "skipped", reason: VERSION_CONFLICT_REASON, code: "version_conflict" },
    };
  }
  const run = runEntries(s, op, [entry]);
  return run.refused ? dayOfCall(run.refused) : run.results[0];
}

function movePlannedWorkout(s, a) {
  if (a.fromDate === a.toDate) inputError("toDate: toDate must differ from fromDate");
  const started = beginOperation(s, "move_planned_workout", a);
  if (started.kind === "replay") return started.result;
  const op = started.kind === "new" ? started.op : null;
  const { fromDate, toDate } = a;
  const tz = a.timezone ?? s.timezone;
  const today = todayInTimeZone(nowOf(s), tz);
  const decided = (result) => ({ date: fromDate, decided: compact({ status: result.status, code: result.code, reason: result.reason, to_date: toDate }), result });
  const occupied = (r) => compact({ fromDate, toDate, status: "skipped", reason: DESTINATION_OCCUPIED_REASON, code: "destination_occupied", destination: r ? { dayName: String(r.day_name ?? ""), skipped: r.status === "skipped" } : undefined });
  const row = s.days[fromDate] ?? null;
  const dest = s.days[toDate] ?? null;
  let entry;
  const prot = row && protectedReason(row, a.overrideUserModified);
  if (!row) entry = decided({ fromDate, toDate, status: "not_found", code: "not_found" });
  else if (a.expectedVersion !== undefined && !rowMatchesVersion(row, a.expectedVersion)) entry = decided({ fromDate, toDate, status: "skipped", reason: VERSION_CONFLICT_REASON, code: "version_conflict" });
  else if (prot) entry = decided({ fromDate, toDate, status: "skipped", reason: prot, code: "protected" });
  else if (toDate < today && !a.allowPast) entry = decided({ fromDate, toDate, status: "skipped", reason: PAST_REASON, code: "past" });
  else if (dest) entry = decided(occupied(dest));
  else {
    entry = {
      date: fromDate,
      op: { action: "move", date: fromDate, toDate, id: row.id, expectedUpdatedAt: row.updated_at ?? null },
      finish: (o) => {
        if (o.status === "not_found") return { fromDate, toDate, status: "not_found", code: "not_found" };
        if (o.status === "destination_occupied") return occupied(s.days[toDate] ?? null);
        if (o.status !== "moved" || !o.id) return { fromDate, toDate, status: "skipped", reason: VERSION_CONFLICT_REASON, code: "version_conflict" };
        const warnings = [];
        if (fromDate < mondayOf(today)) warnings.push(OLD_WEEK_WARNING);
        if (toDate < today) warnings.push(PAST_DESTINATION_WARNING);
        return { fromDate, toDate, status: "moved", version: encodeVersion(o.id, o.updatedAt), warnings };
      },
    };
  }
  const run = runEntries(s, op, [entry]);
  const first = run.refused ? dayOfCall(run.refused) : run.results[0];
  return first.status === "refused" ? { fromDate, toDate, ...first } : first;
}

function skipPlannedWorkout(s, a) {
  const started = beginOperation(s, "skip_planned_workout", a);
  if (started.kind === "replay") return started.result;
  const op = started.kind === "new" ? started.op : null;
  const { date } = a;
  const decided = (result) => ({ date, decided: compact({ status: result.status, reason: result.reason }), result });
  const row = s.days[date] ?? null;
  let entry;
  if (a.expectedVersion !== undefined && !(row && rowMatchesVersion(row, a.expectedVersion))) entry = decided({ date, status: "conflict", reason: VERSION_CONFLICT_REASON });
  else if (!row) entry = decided({ date, status: "not_found" });
  else {
    const wanted = a.skip === false ? "planned" : "skipped";
    const current = row.status === "skipped" ? "skipped" : "planned";
    const skipped = wanted === "skipped";
    const dayName = String(row.day_name ?? "");
    if (current === wanted) entry = decided({ date, status: "unchanged", skipped, dayName, updatedAt: row.updated_at ?? null });
    else {
      entry = {
        date,
        op: { action: "set_status", date, id: row.id, expectedUpdatedAt: row.updated_at ?? null, status: wanted },
        finish: (o) => (o.status === "updated" ? { date, status: "updated", skipped, dayName, updatedAt: o.updatedAt } : { date, status: "conflict", reason: VERSION_CONFLICT_REASON }),
      };
    }
  }
  const run = runEntries(s, op, [entry]);
  return run.refused ? dayOfCall(run.refused) : run.results[0];
}

function fallbackExerciseId(name) {
  const key = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (key) return key;
  return `custom_${createHash("sha256").update(String(name).trim().toLowerCase()).digest("hex").slice(0, 8)}`;
}

function deletePlannedWorkout(s, a) {
  const started = beginOperation(s, "delete_planned_workout", a);
  if (started.kind === "replay") return started.result;
  const op = started.kind === "new" ? started.op : null;
  const { date } = a;
  const skip = (code, reason) => ({ date, decided: { status: "skipped", code, reason }, result: { date, status: "skipped", reason, code } });
  const row = s.days[date] ?? null;
  let entry;
  if (a.expectedVersion !== undefined && !(row && rowMatchesVersion(row, a.expectedVersion))) entry = skip("version_conflict", VERSION_CONFLICT_REASON);
  else if (!row) entry = { date, decided: { status: "not_found" }, result: { date, status: "not_found" } };
  else if (protectedReason(row, a.overrideUserModified)) entry = skip("protected", protectedReason(row, a.overrideUserModified));
  else {
    const deleted = compact({
      date,
      dayType: String(row.day_type ?? "") || "workout",
      dayName: String(row.day_name ?? "") || "Workout",
      exercises: toPlannedExerciseDetails(row.exercises).map((e) => (e.exerciseId ? e : { ...e, exerciseId: fallbackExerciseId(e.name) })),
      skipped: row.status === "skipped",
      notes: row.notes != null ? String(row.notes) : undefined,
    });
    entry = {
      date,
      op: { action: "delete", date, id: row.id, expectedUpdatedAt: row.updated_at ?? null },
      finish: (o) => (o.status === "deleted" ? { date, status: "deleted", deleted } : { date, status: "skipped", reason: VERSION_CONFLICT_REASON, code: "version_conflict" }),
    };
  }
  const run = runEntries(s, op, [entry]);
  return run.refused ? dayOfCall(run.refused) : run.results[0];
}

// ---------------------------------------------------------------------------
// update_training_limits (T3 §5.2, tools/updateTrainingLimits.ts, 017 tighten)
// ---------------------------------------------------------------------------

/** 017 t3_limits_problem: the document checks (§3.2). Null when valid. */
export function limitsProblem(doc) {
  const rules = doc.rules ?? [];
  if (rules.length > 50) return "at most 50 rules";
  const ids = new Set();
  for (const [i, r] of rules.entries()) {
    if (typeof r.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(r.id)) return `rule ${i}: id must match ^[A-Za-z0-9_-]{1,40}$`;
    if (ids.has(r.id)) return `rule ${i}: duplicate id ${r.id}`;
    ids.add(r.id);
    if (typeof r.label !== "string" || r.label.length < 1 || r.label.length > 80) return `rule ${r.id}: label must be 1-80 characters`;
    if (r.kind !== "ban" && r.kind !== "cap") return `rule ${r.id}: kind must be ban or cap`;
    if (r.kind === "cap" && !(Number.isInteger(r.maxSetsPerWeek) && r.maxSetsPerWeek >= 0 && r.maxSetsPerWeek <= 200)) return `rule ${r.id}: a cap needs maxSetsPerWeek 0-200`;
    if (r.kind === "ban" && r.maxSetsPerWeek !== undefined) return `rule ${r.id}: a ban has no maxSetsPerWeek`;
    if (!(r.exerciseIds?.length) && !(r.keywords?.length)) return `rule ${r.id}: needs at least one exerciseId or keyword`;
    for (const k of [...(r.keywords ?? []), ...(r.exceptKeywords ?? [])]) {
      if (k !== norm(k) || k.length < 2 || k.length > 60) return `rule ${r.id}: keyword "${k}" must be 2-60 characters in norm() form`;
    }
  }
  if (doc.maxWeeklySets !== undefined && !(Number.isInteger(doc.maxWeeklySets) && doc.maxWeeklySets >= 1 && doc.maxWeeklySets <= 500)) return "maxWeeklySets must be 1-500";
  return null;
}

function updateTrainingLimits(s, a) {
  for (const [i, o] of a.ops.entries()) {
    if (o.op !== "add_rule") continue;
    const r = o.rule;
    if (r.kind === "cap" && r.maxSetsPerWeek === undefined) inputError(`ops[${i}].rule.maxSetsPerWeek: a cap rule needs maxSetsPerWeek`);
    if (r.kind === "ban" && r.maxSetsPerWeek !== undefined) inputError(`ops[${i}].rule.maxSetsPerWeek: a ban rule has no maxSetsPerWeek`);
    if (!(r.exerciseIds?.length) && !(r.keywords?.length)) inputError(`ops[${i}].rule.keywords: a rule needs at least one exerciseId or keyword`);
  }
  const cur = s.trainingLimits;
  if (a.expectedVersion === null) {
    if (cur) return { status: "conflict", version: cur.version };
  } else if (!cur || cur.version !== a.expectedVersion) return { status: "conflict", version: cur ? cur.version : null };
  const doc = clone(cur?.doc ?? { rules: [] });
  doc.rules ??= [];
  for (const [i, o] of a.ops.entries()) {
    if (o.op === "add_rule") {
      const rule = { ...o.rule };
      if (rule.keywords) rule.keywords = rule.keywords.map(norm);
      if (rule.exceptKeywords) rule.exceptKeywords = rule.exceptKeywords.map(norm);
      if (doc.rules.some((r) => r.id === rule.id)) return { status: "invalid", reason: `op ${i}: rule id ${rule.id} already exists` };
      doc.rules.push(rule);
    } else if (o.op === "lower_cap") {
      const r = doc.rules.find((x) => x.id === o.ruleId);
      if (!r) return { status: "invalid", reason: `op ${i}: no rule with id ${o.ruleId}` };
      if (r.kind !== "cap") return { status: "invalid", reason: `op ${i}: rule ${o.ruleId} is not a cap rule` };
      if (o.maxSetsPerWeek >= r.maxSetsPerWeek) {
        return { status: "invalid", reason: `op ${i}: lower_cap must lower the cap (now ${r.maxSetsPerWeek}); only the user can raise it in the Tally app` };
      }
      r.maxSetsPerWeek = o.maxSetsPerWeek;
    } else if (o.op === "set_weekly_cap") {
      if (doc.maxWeeklySets !== undefined && o.maxWeeklySets >= doc.maxWeeklySets) {
        return { status: "invalid", reason: `op ${i}: set_weekly_cap must lower the weekly cap (now ${doc.maxWeeklySets}); only the user can raise it in the Tally app` };
      }
      doc.maxWeeklySets = o.maxWeeklySets;
    }
  }
  const problem = limitsProblem(doc);
  if (problem) return { status: "invalid", reason: problem };
  s.trainingLimits = { version: cur ? cur.version + 1 : 1, doc, updated_via: "mcp" };
  return { status: "updated", version: s.trainingLimits.version, limits: { rules: doc.rules, maxWeeklySets: typeof doc.maxWeeklySets === "number" ? doc.maxWeeklySets : null } };
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

function operationsFor(s, date, opId) {
  const view = (r) => ({ opId: r.opId, tool: r.tool, recordedAt: r.recordedAt, result: r.result.map((x) => replayItem(r.tool, x)) });
  const list = s.operations
    .filter((r) => (r.dates ?? r.result.map((x) => x.input_date)).includes(date) || r.result.some((x) => x.date === date || x.to_date === date))
    .slice()
    .reverse()
    .slice(0, 10)
    .map(view);
  const out = { operations: list };
  if (opId !== undefined) {
    const one = s.operations.find((r) => r.opId === opId);
    out.operation = one ? view(one) : null;
  }
  return out;
}

function getPlannedWorkout(s, a) {
  const row = s.days[a.date] ?? null;
  const ops = T2 ? operationsFor(s, a.date, a.opId) : {};
  if (!row) return { date: a.date, found: false, exercises: [], weightUnit: s.weightUnit, weightUnitSource: s.weightUnitSource, ...ops };
  return { ...plannedDetail(a.date, row, s), ...ops };
}

function getTrainingContext(s, a) {
  const tz = a.timezone ?? s.timezone;
  const now = nowOf(s);
  const today = todayInTimeZone(now, tz);
  const rows = Object.values(s.days).sort((x, y) => (x.date < y.date ? -1 : 1));
  const futurePlanned = rows
    .filter((r) => r.date >= today)
    .map((r) => ({
      date: r.date,
      dayName: String(r.day_name ?? ""),
      source: String(r.source ?? "builder"),
      userModified: Boolean(r.user_modified),
      exerciseCount: Array.isArray(r.exercises) ? r.exercises.length : 0,
      skipped: r.status === "skipped",
    }));
  const out = { timezone: tz, today, futurePlanned };
  if (a.historyWeeks != null) {
    const since = todayInTimeZone(new Date(now.getTime() - a.historyWeeks * 7 * 86_400_000), tz);
    const until = addDays(today, -1);
    const sessions = sortedSessions(s).filter((x) => x.date >= since);
    out.recentHistory = sessions.slice(0, 50).map((x) => compact({
      date: x.date,
      name: String(x.name ?? ""),
      dayType: String(x.dayType ?? ""),
      rating: x.rating == null ? undefined : String(x.rating),
      exerciseCount: typeof x.totalExercises === "number" ? x.totalExercises : (x.exercises ?? []).length,
      totalSetsCompleted: typeof x.totalSetsCompleted === "number" ? x.totalSetsCompleted : (x.exercises ?? []).reduce((n, e) => n + (e.sets ?? []).length, 0),
    }));
    const done = new Set(sortedSessions(s).filter((x) => x.date >= since && x.date <= until).map((x) => x.date));
    out.pastPlanned = rows
      .filter((r) => r.date >= since && r.date <= until && !done.has(r.date))
      .map((r) => ({ date: r.date, dayName: String(r.day_name ?? ""), source: String(r.source ?? "builder"), skipped: r.status === "skipped" }));
  }
  out.weightUnit = s.weightUnit;
  out.weightUnitSource = s.weightUnitSource;
  if (T3) {
    const tl = s.trainingLimits;
    out.trainingLimits = tl ? { version: tl.version, rules: tl.doc.rules ?? [], maxWeeklySets: typeof tl.doc.maxWeeklySets === "number" ? tl.doc.maxWeeklySets : null } : null;
  }
  out.notes = [];
  return out;
}

function sortedSessions(s) {
  return s.sessions.slice().sort((x, y) => (x.date === y.date ? 0 : x.date < y.date ? 1 : -1));
}

function getWorkoutHistory(s, a) {
  const limit = a.limit ?? 20;
  let offset = 0;
  if (a.cursor) {
    const n = Number(Buffer.from(a.cursor, "base64").toString("utf8"));
    if (!Number.isInteger(n) || n < 0) throw new Error("invalid cursor: pass back the nextCursor from a previous call, unmodified");
    offset = n;
  }
  const rows = sortedSessions(s).filter((x) => (!a.since || x.date >= a.since) && (!a.until || x.date <= a.until));
  const page = rows.slice(offset, offset + limit);
  const sessions = page.map((x) => ({ weightUnit: "lbs", exercises: [], ...x }));
  return compact({
    timezone: a.timezone,
    since: a.since,
    until: a.until,
    count: sessions.length,
    sessions,
    nextCursor: rows.length > offset + limit ? Buffer.from(String(offset + limit), "utf8").toString("base64") : undefined,
  });
}

function getExerciseProgress(s, a) {
  const tz = a.timezone ?? s.timezone;
  const until = todayInTimeZone(nowOf(s), tz);
  const since = addDays(until, -182);
  const n = a.sessions ?? 6;
  const sessions = sortedSessions(s).filter((x) => x.date >= since && x.date <= until);
  const exercises = a.exercises.map((query) => {
    const q = norm(query);
    const hits = sessions.flatMap((x) => (x.exercises ?? []).filter((e) => norm(e.name) === q || norm(e.exerciseId) === q).map((e) => ({ x, e })));
    if (!hits.length) {
      const names = [...new Set(sessions.flatMap((x) => (x.exercises ?? []).map((e) => e.name)))];
      return { query, found: false, candidates: names.filter((nm) => norm(nm).includes(q.split(" ")[0] ?? "")).slice(0, 5) };
    }
    const top = (sets) => sets.reduce((b, st) => (typeof st.weight === "number" && (!b || st.weight > b.weight) ? st : b), undefined);
    const list = hits.slice(0, n).map(({ x, e }) => compact({ date: x.date, weightUnit: x.weightUnit ?? "lbs", sets: e.sets ?? [], topSet: top(e.sets ?? []) }));
    const best = list.reduce((b, ss) => (ss.topSet && (!b || ss.topSet.weight > b.weight) ? { ...ss.topSet, date: ss.date } : b), undefined);
    return { query, found: true, name: hits[0].e.name, matchedBy: norm(hits[0].e.name) === q ? "name" : "exerciseId", trackingType: hits[0].e.trackingType ?? "weight_reps", sessionsFound: new Set(hits.map((h) => h.x.date)).size, sessions: list, best: compact({ topSet: best }) };
  });
  return { timezone: tz, since, until, weightUnit: unitKnown(s) ? s.weightUnit : null, weightUnitSource: s.weightUnitSource, truncated: false, exercises };
}

const DEFAULT_LIBRARY = [
  { exerciseId: "Barbell_Squat", name: "Barbell Back Squat", muscle: "quads", equipment: "Barbell" },
  { exerciseId: "Goblet_Squat", name: "Goblet Squat", muscle: "quads", equipment: "Dumbbell" },
  { exerciseId: "Box_Squat", name: "Box Squat", muscle: "quads", equipment: "Barbell" },
  { exerciseId: "Leg_Press", name: "Leg Press", muscle: "quads", equipment: "Machine" },
  { exerciseId: "Romanian_Deadlift", name: "Romanian Deadlift", muscle: "hamstrings", equipment: "Barbell" },
  { exerciseId: "Hip_Thrust", name: "Hip Thrust", muscle: "glutes", equipment: "Barbell" },
  { exerciseId: "Bench_Press", name: "Bench Press", muscle: "chest", equipment: "Barbell" },
  { exerciseId: "Dumbbell_Bench_Press", name: "Dumbbell Bench Press", muscle: "chest", equipment: "Dumbbell" },
  { exerciseId: "Overhead_Press", name: "Overhead Press", muscle: "shoulders", equipment: "Barbell" },
  { exerciseId: "Pull_Up", name: "Pull-Up", muscle: "lats", equipment: "Bodyweight", trackingType: "bodyweight_reps" },
  { exerciseId: "Seated_Cable_Row", name: "Seated Cable Row", muscle: "upper back", equipment: "Cable" },
  { exerciseId: "Lat_Pulldown", name: "Lat Pulldown", muscle: "lats", equipment: "Cable" },
  { exerciseId: "Zone_2_Bike", name: "Zone 2 Bike", muscle: "cardio", equipment: "Bike", trackingType: "duration" },
  { exerciseId: "Hip_Mobility_Flow", name: "Hip Mobility Flow", muscle: "mobility", equipment: "Bodyweight", trackingType: "duration" },
  { exerciseId: "Box_Breathing", name: "Box Breathing", muscle: "breathing", equipment: "Bodyweight", trackingType: "duration" },
];

function searchExercises(s, a) {
  const library = s.library ?? DEFAULT_LIBRARY;
  const recent = new Map();
  for (const r of Object.values(s.days)) for (const e of r.exercises ?? []) if (isObj(e) && e.exerciseId && e.name) recent.set(e.exerciseId, e);
  const find = (query) => {
    const q = norm(query);
    const words = q.split(" ").filter(Boolean);
    const hit = (e) => words.every((w) => norm(e.name).includes(w) || norm(e.exerciseId).includes(w));
    const out = [];
    for (const e of recent.values()) if (hit(e)) out.push(compact({ exerciseId: e.exerciseId, name: e.name, muscle: e.muscle, source: "recent", trackingType: e.trackingType, equipment: e.equipment }));
    for (const e of library) if (hit(e) && !out.some((o) => o.exerciseId === e.exerciseId)) out.push(compact({ ...e, source: "library" }));
    return out.slice(0, 10);
  };
  const hint = "No match: plan it as a custom exercise (exerciseId = the name in lowercase snake_case, plus muscle, trackingType and equipment).";
  if (a.queries === undefined) {
    const results = find(a.query);
    return compact({ results, hint: results.length ? undefined : hint });
  }
  const qs = [...new Set([...(a.query ? [a.query] : []), ...a.queries])];
  return { queries: qs.map((query) => { const results = find(query); return compact({ query, results, hint: results.length ? undefined : hint }); }) };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const HANDLERS = {
  get_training_context: getTrainingContext,
  get_planned_workout: getPlannedWorkout,
  get_workout_history: getWorkoutHistory,
  get_exercise_progress: getExerciseProgress,
  search_exercises: searchExercises,
  plan_workout_day: planWorkoutDay,
  plan_workout_range: planWorkoutRange,
  update_planned_workout: updatePlannedWorkout,
  move_planned_workout: movePlannedWorkout,
  skip_planned_workout: skipPlannedWorkout,
  delete_planned_workout: deletePlannedWorkout,
  update_training_limits: updateTrainingLimits,
};

let TOOLS = null;
const tools = () => (TOOLS ??= toolList());

function exerciseSchema() {
  return tools().find((t) => t.name === "plan_workout_day").inputSchema.properties.exercises.items;
}

/** One tools/call: validate, run against the state file, record the call. Returns the MCP result. */
export function callTool(name, rawArgs) {
  const tool = tools().find((t) => t.name === name);
  const s = loadState();
  const at = nowOf(s).toISOString();
  let result;
  let payload;
  try {
    if (!tool) throw new InputError(`Tool ${name} not found`);
    const args = rawArgs ?? {};
    const problems = schemaProblems(tool.inputSchema, args);
    if (problems.length) throw new InputError(`Input validation error: Invalid arguments for tool ${name}: ${problems.join("; ")}`);
    const a = strip(tool.inputSchema, args);
    refine(name, a);
    payload = HANDLERS[name](s, a);
    result = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  } catch (err) {
    const msg = err instanceof InputError ? err.message : `Error: ${err.message}`;
    result = { content: [{ type: "text", text: msg }], isError: true };
  }
  s.calls.push({ at, tool: name, args: rawArgs ?? {}, ...(result.isError ? { error: result.content[0].text } : { result: payload }) });
  saveState(s);
  return result;
}

function serve() {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  createInterface({ input: process.stdin }).on("line", (line) => {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    if (req.id === undefined) return; // a notification
    const { method, params = {} } = req;
    try {
      if (method === "initialize") {
        return send({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            protocolVersion: params.protocolVersion || "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "tally-mock", version: "1.0.0" },
            instructions: "Mock Tally for coach-harness evals. Read get_training_context first.",
          },
        });
      }
      if (method === "ping") return send({ jsonrpc: "2.0", id: req.id, result: {} });
      if (method === "tools/list") return send({ jsonrpc: "2.0", id: req.id, result: { tools: tools() } });
      if (method === "tools/call") return send({ jsonrpc: "2.0", id: req.id, result: callTool(params.name, params.arguments) });
      if (method === "prompts/list") return send({ jsonrpc: "2.0", id: req.id, result: { prompts: [] } });
      if (method === "resources/list") return send({ jsonrpc: "2.0", id: req.id, result: { resources: [] } });
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `method not found: ${method}` } });
    } catch (err) {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: String(err?.message ?? err) } });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) serve();
