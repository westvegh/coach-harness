// Validates a daily signal file (athlete/signals/YYYY-MM-DD.json, contracts §11) against
// schema.json and maps it to DayRecord[] (contracts §5).
//
// - observed_at = sleep.end_at (or submitted_at when there is no sleep block);
// - complete only when sleep is present (contracts §11); a check-in-only record is not complete;
// - HRV method sdnn unless the file says rmssd;
// - the check-in block's group rules (one rating group, at least one field) are checked in
//   code (engine/checkin-shape.ts); an empty pain list is kept ("no pain now");
// - the check-in maps to `subjective`. A check-in from another source than the file
//   (for example a chat check-in merged into a Shortcut file) becomes its own record,
//   so sources stay separate.
import { readFileSync } from "node:fs";
import { CoachError } from "../../../engine/errors.ts";
import { isCalendarDate, parseInstant } from "../../../engine/dates.ts";
import { checkinBlockProblems, FOUR_SCALES } from "../../../engine/checkin-shape.ts";
import type { CalendarDate, DayRecord, Instant, PainEntry, Scale, Subjective } from "../../../engine/types.ts";
import { validateSchema, type Schema } from "../json-schema.ts";

export type SignalSource = "apple-health-shortcut" | "chat";

/**
 * The check-in block. The rating is one group: `overall`, or the four scales together, never
 * both; at least one of the rating, want_to_train or pain (engine/checkin-shape.ts). The
 * Shortcut sends the four scales; a chat check-in usually sends `overall`.
 */
export type SignalCheckin = {
  overall?: Scale;
  sleep_quality?: Scale;
  energy?: Scale;
  soreness?: Scale;
  stress?: Scale;
  /** Optional: how much the athlete wants to train today; 1 is aversion. */
  want_to_train?: Scale;
  /** An empty list records that there is no pain now. */
  pain?: PainEntry[];
  source?: SignalSource;
  submitted_at?: Instant;
};

/** The file format. Extends `ShortcutSignalFile` (engine/types.ts) with the chat source. */
export type SignalFile = {
  version: 1;
  date: CalendarDate;
  source: SignalSource;
  submitted_at: Instant;
  sleep?: { start_at: Instant; end_at: Instant; duration_min: number };
  hrv?: { value_ms: number; method?: "rmssd" | "sdnn"; samples?: number };
  rhr?: { bpm: number };
  temperature?: { deviation_c: number };
  checkin?: SignalCheckin;
};

export const SCHEMA: Schema = JSON.parse(readFileSync(new URL("./schema.json", import.meta.url), "utf8"));

function fail(message: string): never {
  throw new CoachError("SIGNAL_INVALID", message);
}

/**
 * Validates `raw` and returns it typed. Checks the schema, the calendar date, that instants
 * parse, that sleep starts before it ends, and that nothing is after `now`.
 */
export function validateSignalFile(raw: unknown, opts: { now?: Instant | number; expectDate?: CalendarDate } = {}): SignalFile {
  const errors = validateSchema(raw, SCHEMA);
  const f = raw as SignalFile;
  // The group rules the schema subset cannot state (B.3).
  if (errors.length === 0 && f.checkin !== undefined) errors.push(...checkinBlockProblems(f.checkin, "$.checkin"));
  if (errors.length > 0) fail(`signal file is invalid: ${errors.join("; ")}`);
  if (!isCalendarDate(f.date)) fail(`signal file is invalid: $.date is not a calendar date: ${f.date}`);
  if (opts.expectDate !== undefined && f.date !== opts.expectDate) {
    fail(`signal file date ${f.date} does not match its file name (${opts.expectDate})`);
  }
  const nowMs = opts.now === undefined ? Date.now() : typeof opts.now === "number" ? opts.now : parseInstant(opts.now, "now");
  const future = (field: string, s: string) => {
    if (parseInstant(s, field) > nowMs) fail(`signal file ${f.date}: ${field} ${s} is in the future`);
  };
  future("submitted_at", f.submitted_at);
  if (f.sleep) {
    future("sleep.start_at", f.sleep.start_at);
    future("sleep.end_at", f.sleep.end_at);
    if (parseInstant(f.sleep.start_at) >= parseInstant(f.sleep.end_at)) fail(`signal file ${f.date}: sleep.start_at must be before sleep.end_at`);
  }
  if (f.checkin?.submitted_at) future("checkin.submitted_at", f.checkin.submitted_at);
  return f;
}

function subjective(c: SignalCheckin): Subjective {
  const s: Subjective = {};
  if (c.overall !== undefined) s.overall = c.overall;
  for (const k of FOUR_SCALES) if (c[k] !== undefined) s[k] = c[k];
  if (c.want_to_train !== undefined) s.want_to_train = c.want_to_train;
  // An empty list stays: it records "no pain now".
  if (c.pain) s.pain = c.pain.map((p) => ({ region: p.region, score: p.score }));
  return s;
}

/** Validates the file and maps it to one DayRecord per source (usually one). */
export function normalize(raw: unknown, opts: { now?: Instant | number; expectDate?: CalendarDate } = {}): DayRecord[] {
  const f = validateSignalFile(raw, opts);
  const main: DayRecord = {
    date: f.date,
    source: f.source,
    observed_at: f.sleep ? f.sleep.end_at : f.submitted_at,
    complete: f.sleep !== undefined,
  };
  if (f.sleep) main.sleep = { duration_min: f.sleep.duration_min, start_at: f.sleep.start_at, end_at: f.sleep.end_at };
  if (f.hrv) main.hrv = { value_ms: f.hrv.value_ms, method: f.hrv.method === "rmssd" ? "rmssd" : "sdnn" };
  if (f.rhr) main.rhr = { bpm: f.rhr.bpm };
  if (f.temperature) main.temperature = { deviation_c: f.temperature.deviation_c };

  const out: DayRecord[] = [];
  let separate: DayRecord | undefined;
  if (f.checkin) {
    const src = f.checkin.source ?? f.source;
    // Both instants passed the schema pattern and the future check above (validateSignalFile).
    const at = f.checkin.submitted_at ?? f.submitted_at;
    if (src === f.source) {
      main.subjective = subjective(f.checkin);
      main.checkin_at = at;
    } else {
      separate = {
        date: f.date,
        source: src,
        observed_at: f.checkin.submitted_at ?? f.submitted_at,
        complete: false,
        subjective: subjective(f.checkin),
        checkin_at: at,
      };
    }
  }
  if (main.sleep || main.hrv || main.rhr || main.temperature || main.subjective) out.push(main);
  if (separate) out.push(separate);
  return out;
}
