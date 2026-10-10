// Calendar dates (YYYY-MM-DD, athlete timezone) and instants (ISO 8601 with offset).
// Calendar arithmetic is done on UTC midnights, so DST never shifts a date.
import { CoachError } from "./errors.ts";
import type { CalendarDate, Weekday } from "./types.ts";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86_400_000;
export const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export function isCalendarDate(s: unknown): s is CalendarDate {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function dateToUtcMs(date: CalendarDate): number {
  if (!isCalendarDate(date)) throw new CoachError("BAD_DATE", `not a calendar date (YYYY-MM-DD): ${JSON.stringify(date)}`);
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcMsToDate(ms: number): CalendarDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  return utcMsToDate(dateToUtcMs(date) + days * DAY_MS);
}

/** Whole days from `a` to `b` (b − a). */
export function diffDays(a: CalendarDate, b: CalendarDate): number {
  return Math.round((dateToUtcMs(b) - dateToUtcMs(a)) / DAY_MS);
}

export function weekdayOf(date: CalendarDate): Weekday {
  const js = new Date(dateToUtcMs(date)).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(js + 6) % 7];
}

/** The Monday of the week that holds `date` (weeks run Monday to Sunday). */
export function weekStart(date: CalendarDate): CalendarDate {
  return addDays(date, -WEEKDAYS.indexOf(weekdayOf(date)));
}

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Parses an ISO 8601 instant that carries an offset. Returns epoch milliseconds. */
export function parseInstant(s: unknown, what = "instant"): number {
  if (typeof s !== "string" || !INSTANT_RE.test(s)) {
    throw new CoachError("BAD_INSTANT", `${what} must be ISO 8601 with an offset: ${JSON.stringify(s)}`);
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new CoachError("BAD_INSTANT", `${what} is not a valid instant: ${s}`);
  return ms;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    if (!isValidTimezone(tz)) throw new CoachError("BAD_TIMEZONE", `unknown IANA timezone: ${tz}`);
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

function wallParts(epochMs: number, tz: string): { date: CalendarDate; wallUtcMs: number } {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(epochMs))) parts[p.type] = p.value;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const wallUtcMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return { date, wallUtcMs };
}

/** The local calendar date of an instant in `tz`. */
export function localDate(instant: string | number, tz: string): CalendarDate {
  const ms = typeof instant === "number" ? instant : parseInstant(instant);
  return wallParts(ms, tz).date;
}

/** The epoch milliseconds of a local wall time (HH:MM) on `date` in `tz`. */
export function zonedTimeToEpoch(date: CalendarDate, time: string, tz: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) throw new CoachError("BAD_TIME", `time must be HH:MM: ${time}`);
  const wall = dateToUtcMs(date) + (+m[1] * 60 + +m[2]) * 60_000;
  let guess = wall;
  // Two passes settle the offset, including across a DST change.
  for (let i = 0; i < 2; i++) {
    const offset = wallParts(guess, tz).wallUtcMs - guess;
    guess = wall - offset;
  }
  return guess;
}
