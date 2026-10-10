// Loads every signal record for a date range (contracts §5, §11):
// - athlete/signals/YYYY-MM-DD.json (the Shortcut and chat check-ins), through the normalizer;
// - athlete/.cache/signals/*.json (fetched sources such as Oura), each a DayRecord[].
//
// One record per source and date: the complete one is preferred, then the latest
// observed_at. Sources are never merged (an Oura RMSSD record and an Apple SDNN record for
// the same night stay 2 records). A bad file, or a malformed cached record (for example a
// null block), is skipped with a warning, so one broken entry cannot hide the others.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalize } from "../adapters/signals/apple-health-shortcut/normalize.ts";
import { validateSchema, type Schema } from "../adapters/signals/json-schema.ts";
import { isCalendarDate, parseInstant } from "./dates.ts";
import { CoachError } from "./errors.ts";
import type { CalendarDate, DayRecord, Instant } from "./types.ts";

export const SIGNALS_DIR = "athlete/signals";
export const SIGNALS_CACHE_DIR = "athlete/.cache/signals";

export type LoadedSignals = { from: CalendarDate; to: CalendarDate; records: DayRecord[]; warnings: string[] };

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const INSTANT = { type: "string" } as const;
const SCALE = { type: "integer", minimum: 1, maximum: 5 } as const;

/** DayRecord (contracts §5) as a schema: a block, when present, must be a full object (null is malformed). */
export const DAY_RECORD_SCHEMA: Schema = {
  type: "object",
  required: ["date", "source", "observed_at", "complete"],
  properties: {
    date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    source: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" },
    observed_at: INSTANT,
    complete: { type: "boolean" },
    sleep: {
      type: "object",
      required: ["duration_min", "start_at", "end_at"],
      properties: { duration_min: { type: "number", minimum: 0, maximum: 1440 }, start_at: INSTANT, end_at: INSTANT, efficiency: { type: "number", minimum: 0, maximum: 100 } },
    },
    hrv: { type: "object", required: ["value_ms", "method"], properties: { value_ms: { type: "number", minimum: 0, maximum: 500 }, method: { enum: ["rmssd", "sdnn"] } } },
    rhr: { type: "object", required: ["bpm"], properties: { bpm: { type: "number", minimum: 20, maximum: 250 } } },
    vendor_score: { type: "number", minimum: 0, maximum: 100 },
    subjective: {
      type: "object",
      required: ["sleep_quality", "energy", "soreness", "stress"],
      properties: {
        sleep_quality: SCALE,
        energy: SCALE,
        soreness: SCALE,
        stress: SCALE,
        want_to_train: SCALE,
        pain: {
          type: "array",
          items: { type: "object", required: ["region", "score"], properties: { region: { type: "string" }, score: { type: "number", minimum: 0, maximum: 10 } } },
        },
      },
    },
  },
};

/** Why a cached record cannot be used, or null. Readiness then never sees a malformed record. */
function cachedRecordProblem(r: unknown, nowMs: number): string | null {
  const errors = validateSchema(r, DAY_RECORD_SCHEMA);
  if (errors.length > 0) return errors.join("; ");
  const x = r as DayRecord;
  if (!isCalendarDate(x.date)) return "date is not a calendar date";
  try {
    if (parseInstant(x.observed_at, "observed_at") > nowMs) return `observed_at ${x.observed_at} is in the future`;
    if (x.sleep && parseInstant(x.sleep.start_at, "sleep.start_at") >= parseInstant(x.sleep.end_at, "sleep.end_at")) return "sleep.start_at must be before sleep.end_at";
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}

/** True when `a` should replace `b` as the record for its source and date. */
function better(a: DayRecord, b: DayRecord): boolean {
  if (a.complete !== b.complete) return a.complete;
  return parseInstant(a.observed_at) > parseInstant(b.observed_at);
}

export function loadSignals(input: { root: string; from: CalendarDate; to: CalendarDate; now?: Instant | number }): LoadedSignals {
  const { root, from, to } = input;
  if (!isCalendarDate(from) || !isCalendarDate(to)) throw new CoachError("USAGE", "signals needs --from and --to as YYYY-MM-DD");
  if (from > to) throw new CoachError("USAGE", `signals: --from ${from} is after --to ${to}`);
  const nowMs = input.now === undefined ? Date.now() : typeof input.now === "number" ? input.now : parseInstant(input.now, "now");
  const warnings: string[] = [];
  const all: DayRecord[] = [];

  const dir = join(root, SIGNALS_DIR);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
      if (!m) continue;
      const date = m[1];
      if (date < from || date > to) continue;
      try {
        all.push(...normalize(readJson(join(dir, name)), { now: nowMs, expectDate: date }));
      } catch (e) {
        warnings.push(`${SIGNALS_DIR}/${name} skipped: ${(e as Error).message}`);
      }
    }
  }

  const cache = join(root, SIGNALS_CACHE_DIR);
  if (existsSync(cache)) {
    for (const name of readdirSync(cache).sort()) {
      if (!name.endsWith(".json")) continue;
      let list: unknown;
      try {
        list = readJson(join(cache, name));
      } catch (e) {
        warnings.push(`${SIGNALS_CACHE_DIR}/${name} skipped: ${(e as Error).message}`);
        continue;
      }
      if (!Array.isArray(list)) {
        warnings.push(`${SIGNALS_CACHE_DIR}/${name} skipped: must be an array of DayRecord`);
        continue;
      }
      list.forEach((r, i) => {
        // Records outside the range are not read, so they cannot warn.
        const d = (r as { date?: unknown })?.date;
        if (isCalendarDate(d) && (d < from || d > to)) return;
        const problem = cachedRecordProblem(r, nowMs);
        if (problem) {
          warnings.push(`${SIGNALS_CACHE_DIR}/${name}[${i}] skipped: ${problem}`);
          return;
        }
        const rec = r as DayRecord;
        if (rec.date >= from && rec.date <= to) all.push(rec);
      });
    }
  }

  const byKey = new Map<string, DayRecord>();
  for (const r of all) {
    const key = `${r.source}\u0000${r.date}`;
    const seen = byKey.get(key);
    if (!seen || better(r, seen)) byKey.set(key, r);
  }
  const records = [...byKey.values()].sort((a, b) => (a.date === b.date ? a.source.localeCompare(b.source) : a.date < b.date ? -1 : 1));
  return { from, to, records, warnings };
}
