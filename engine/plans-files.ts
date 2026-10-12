// The files logger (coach.yaml `logger: files`; contracts §12a): one CSV per week,
// plans/<YYYY>-W<ww>.csv (the ISO week), with the columns
//
//   date, day, exercise, sets, reps, load, unit, notes, done_sets, done_reps, done_load, felt
//
// The coach fills the plan columns (`plans write`). The athlete fills the done_ columns in
// any spreadsheet app, or reports in chat and the coach runs `plans done`. The engine reads
// the files back for the volume, progression, weeks, readiness and audit tools: a week's
// planned days, and a "snapshot" whose history is the logged rows (`coachSnapshot`).
//
// The athlete edits these files by hand, so nothing in them is lost on a write: a column the
// athlete adds is kept, and a row the reader cannot parse (a spreadsheet date, broken quoting)
// is kept as it is and reported in `warnings` (V2b fix 1). Counts are bounded before use
// (fix 3), and every row keeps its own unit (fix 2).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { addDays, isCalendarDate, weekStart } from "./dates.ts";
import { CoachError } from "./errors.ts";
import type { NotesHistoryEntry } from "./safety.ts";
import { convertWeight } from "../adapters/loggers/tally/day.ts";
import type { CalendarDate, DayLog, DayPlan, ExerciseEntry, Instant, SetEntry, Snapshot, SnapshotDay, SnapshotSession, Units, WeekLog } from "./types.ts";

export const PLANS_DIR = "plans";
/** The urgent stop's file (engine/urgent.ts URGENT_RELATIVE). While it exists, no write under plans/. */
const URGENT_STOP = "athlete/.urgent-stop";

/**
 * The urgent stop (contracts §10) covers plans/: the urgent gate denies Edit and Write there,
 * and these commands run through Bash, which the gate does not see, so they refuse here.
 * The file only has to exist: an unreadable stop still stops.
 */
export function refuseUnderUrgentStop(root: string, what: string): void {
  if (existsSync(join(root, URGENT_STOP))) {
    throw new CoachError("URGENT_STOP", `${what} refused: the urgent stop is on (athlete/.urgent-stop). Give the urgent-care text and make no plan change; it clears only on the athlete's answer in a live session.`);
  }
}
export const PLAN_COLUMNS = ["date", "day", "exercise", "sets", "reps", "load", "unit", "notes", "done_sets", "done_reps", "done_load", "felt"] as const;
export type PlanColumn = (typeof PLAN_COLUMNS)[number];
const DONE_COLUMNS: readonly PlanColumn[] = ["done_sets", "done_reps", "done_load", "felt"];

/** One CSV row. Every value is text as it stands in the file; `extra` keeps the athlete's own columns. */
export type PlanRow = Record<PlanColumn, string> & { extra: Record<string, string> };

/**
 * A row the reader could not use, kept for the next write: `cells` (by column name) for a row
 * that parsed but has no YYYY-MM-DD date or no exercise; `text` (verbatim) for a line whose
 * quoting is broken.
 */
export type UnparsedRow = { cells?: Record<string, string>; text?: string };

export type WeekFile = { path: string; header: string[]; rows: PlanRow[]; unparsed: UnparsedRow[]; extras: string[]; warnings: string[] };

/** Count limits for cells the athlete types (fix 3): beyond them a count is unknown. */
export const MAX_SETS = 20;
export const MAX_REPS = 100;

// ---------- weeks and paths ----------

/** The ISO week of a date: "2026-W42" (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeekId(date: CalendarDate): string {
  if (!isCalendarDate(date)) throw new CoachError("USAGE", `not a date: ${JSON.stringify(date)}`);
  const thursday = addDays(weekStart(date), 3);
  const year = Number(thursday.slice(0, 4));
  const jan4 = `${year}-01-04`;
  const week = Math.round((Date.parse(`${weekStart(thursday)}T00:00:00Z`) - Date.parse(`${weekStart(jan4)}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The Monday of an ISO week id ("2026-W42" → "2026-10-12"). */
export function isoWeekMonday(id: string): CalendarDate {
  const m = /^(\d{4})-W(\d{2})$/.exec(id);
  if (!m) throw new CoachError("USAGE", `not an ISO week: ${JSON.stringify(id)} (YYYY-Www)`);
  const monday = addDays(weekStart(`${m[1]}-01-04`), (Number(m[2]) - 1) * 7);
  if (isoWeekId(monday) !== id) throw new CoachError("USAGE", `no such week: ${id}`);
  return monday;
}

/** plans/<YYYY>-W<ww>.csv for the week that holds `date`, under `root`. */
export function weekFilePath(root: string, date: CalendarDate): string {
  return join(root, PLANS_DIR, `${isoWeekId(date)}.csv`);
}

/** Every week file under plans/, oldest first. */
export function weekFiles(root: string): string[] {
  const dir = join(root, PLANS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-W\d{2}\.csv$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

// ---------- CSV ----------

/** One record: its cells, or null when a quoted field never closes before the end of the text. */
function parseRecord(s: string): string[] | null {
  const cells: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      cells.push(field);
      field = "";
    } else field += ch;
  }
  if (quoted) return null;
  cells.push(field);
  return cells;
}

export type CsvRecord = { cells: string[]; text: string } | { cells: null; text: string };

/**
 * RFC 4180 records with their source text: quoted fields (a newline inside quotes joins the
 * next line), doubled quotes, CRLF or LF, a leading BOM (spreadsheet apps add one). A quote
 * that never closes makes only its own line a broken record (`cells: null`, the line kept
 * verbatim); reading goes on at the next line. Blank lines are dropped.
 */
export function parseCsvRecords(text: string): CsvRecord[] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = s.split(/\r\n|\n|\r/);
  const out: CsvRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    let joined = lines[i];
    let cells = parseRecord(joined);
    let j = i;
    while (cells === null && j + 1 < lines.length) {
      j++;
      joined += `\n${lines[j]}`;
      cells = parseRecord(joined);
    }
    if (cells === null) {
      out.push({ cells: null, text: lines[i] });
      continue;
    }
    out.push({ cells, text: joined });
    i = j;
  }
  return out;
}

/** The parsed records only (broken lines left out). */
export function parseCsv(text: string): string[][] {
  return parseCsvRecords(text)
    .filter((r): r is { cells: string[]; text: string } => r.cells !== null)
    .map((r) => r.cells)
    .filter((r) => r.some((f) => f.trim() !== ""));
}

function csvField(v: string): string {
  return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function formatCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}

// ---------- week files ----------

function emptyRow(): PlanRow {
  return { ...(Object.fromEntries(PLAN_COLUMNS.map((c) => [c, ""])) as Record<PlanColumn, string>), extra: {} };
}

const isPlanColumn = (h: string): h is PlanColumn => (PLAN_COLUMNS as readonly string[]).includes(h);

/**
 * Reads a week file. A missing file is an empty week. A row without a YYYY-MM-DD date or an
 * exercise, and a line with broken quoting, go to `unparsed` with a warning: the next write
 * keeps them.
 */
export function readWeekFile(path: string): WeekFile {
  const empty: WeekFile = { path, header: [...PLAN_COLUMNS], rows: [], unparsed: [], extras: [], warnings: [] };
  if (!existsSync(path)) return empty;
  const records = parseCsvRecords(readFileSync(path, "utf8"));
  if (records.length === 0) return empty;
  const where = relative(dirname(dirname(path)), path);
  const first = records[0];
  const header = first.cells ? first.cells.map((h) => h.trim()) : [];
  const lower = header.map((h) => h.toLowerCase());
  const missing = PLAN_COLUMNS.filter((c) => !lower.includes(c));
  if (!first.cells || missing.includes("date") || missing.includes("exercise")) {
    throw new CoachError("PLANS_INVALID", `${where}: the first row must name the columns (${PLAN_COLUMNS.join(", ")}); missing ${missing.join(", ")}. The file was not changed.`);
  }
  const extras = header.filter((h) => h !== "" && !isPlanColumn(h.toLowerCase()));
  const warnings: string[] = missing.length > 0 ? [`${where}: missing columns ${missing.join(", ")} (read as empty)`] : [];
  const rows: PlanRow[] = [];
  const unparsed: UnparsedRow[] = [];
  records.slice(1).forEach((rec, i) => {
    if (rec.cells === null) {
      warnings.push(`${where}: a line has a quote that never closes; it was not read and is kept as it is: ${JSON.stringify(rec.text.slice(0, 60))}`);
      unparsed.push({ text: rec.text });
      return;
    }
    if (!rec.cells.some((c) => c.trim() !== "")) return;
    const row = emptyRow();
    const cells: Record<string, string> = {};
    header.forEach((h, j) => {
      const v = (rec.cells![j] ?? "").trim();
      if (h === "") return;
      cells[h] = v;
      if (isPlanColumn(h.toLowerCase())) row[h.toLowerCase() as PlanColumn] = v;
      else row.extra[h] = v;
    });
    if (!isCalendarDate(row.date) || row.exercise === "") {
      const why = !isCalendarDate(row.date) ? `the date ${JSON.stringify(row.date)} is not YYYY-MM-DD` : "it has no exercise";
      warnings.push(`${where} row ${i + 2}: ${why}; it was not read and is kept as it is`);
      unparsed.push({ cells });
      return;
    }
    rows.push(row);
  });
  return { path, header, rows, unparsed, extras, warnings };
}

/**
 * Writes a week file atomically (temp file and rename): the file's own column order (the
 * standard columns it lacks added at the end), rows sorted by date in their given order, then
 * the unparsed rows as they were.
 */
export function writeWeekFile(path: string, rows: PlanRow[], file: Pick<WeekFile, "header" | "unparsed">): void {
  const header = [...file.header.filter((h) => h !== ""), ...PLAN_COLUMNS.filter((c) => !file.header.some((h) => h.toLowerCase() === c))];
  const cell = (r: PlanRow, h: string) => (isPlanColumn(h.toLowerCase()) ? r[h.toLowerCase() as PlanColumn] : (r.extra[h] ?? ""));
  const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.date < b.r.date ? -1 : a.r.date > b.r.date ? 1 : a.i - b.i));
  let text = formatCsv([header, ...sorted.map(({ r }) => header.map((h) => cell(r, h)))]);
  for (const u of file.unparsed) text += u.cells ? formatCsv([header.map((h) => u.cells![h] ?? "")]) : `${u.text}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// ---------- numbers in cells ----------

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function num(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
}

/** Collects warnings for one row ("plans/2026-W42.csv 2026-10-12 Back Squat: …"). */
type Warn = (msg: string) => void;
const rowWarn = (sink: string[], r: PlanRow): Warn => (msg) => sink.push(`${r.date} ${r.exercise}: ${msg}`);

/**
 * A count cell the athlete may have typed (fix 3): undefined when empty, the whole number when
 * it is one from 0 to `max`, else null (unknown) with a warning. The raw cell stays in the file.
 */
function count(cell: string, max: number, what: string, warn: Warn): number | null | undefined {
  const t = cell.trim();
  if (t === "") return undefined;
  if (/^\d+$/.test(t) && Number(t) <= max) return Number(t);
  warn(`${what} ${JSON.stringify(t)} is not a whole number from 0 to ${max}; read as unknown`);
  return null;
}

/** "8", "8,8,7", "8/8/7", "8 8 7" or "8;8;7" → the per-set values (empty → []); "bw" is no load. */
function list(s: string): string[] {
  return s.trim() === "" ? [] : s.split(/[,;/\s]+/).filter(Boolean);
}

/** A reps cell: "8", "8-10" (a range: the bottom counts), "40min" or "600s" (a duration). Counts are bounded (fix 3). */
function parseReps(s: string, warn: Warn): { reps: number | null; repsMax: number | null; duration_s: number | null } {
  const t = s.trim().toLowerCase();
  const none = { reps: null, repsMax: null, duration_s: null };
  if (t === "") return none;
  const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(t);
  if (range) {
    const lo = count(range[1], MAX_REPS, "reps", warn);
    const hi = count(range[2], MAX_REPS, "reps", warn);
    return { reps: lo ?? null, repsMax: hi ?? null, duration_s: null };
  }
  const dur = /^(\d+(?:\.\d+)?)\s*(s|sec|min|m)$/.exec(t);
  if (dur) {
    const secs = Math.round(Number(dur[1]) * (dur[2].startsWith("m") ? 60 : 1));
    if (secs <= 6 * 3600) return { ...none, duration_s: secs };
    warn(`the duration ${JSON.stringify(t)} is longer than 6 hours; read as unknown`);
    return none;
  }
  return { ...none, reps: count(t, MAX_REPS, "reps", warn) ?? null };
}

function repsCell(sets: SetEntry[]): string {
  const reps = sets.map((s) => s.reps).filter((r): r is number => typeof r === "number");
  if (reps.length > 0) {
    const lo = Math.min(...reps);
    const hi = Math.max(...reps);
    return lo === hi ? String(lo) : `${lo}-${hi}`;
  }
  const d = sets.find((s) => typeof s.duration_s === "number")?.duration_s;
  return typeof d === "number" ? (d % 60 === 0 ? `${d / 60}min` : `${d}s`) : "";
}

/** "RPE 8", "8" or "8.5" in the felt column is an RPE (1-10); other text is a note. */
function feltRpe(s: string): number | null {
  const m = /^(?:rpe\s*)?(\d+(?:\.\d+)?)$/i.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 10 ? n : null;
}

function unitOf(s: string, fallback: Units): Units {
  const t = s.trim().toLowerCase();
  return t === "kg" ? "kg" : t === "lb" || t === "lbs" ? "lbs" : fallback;
}

/** A load cell in `from`, as a number in `to` (Tally's rounding); null for empty, "bw" or not a number. */
function loadIn(cell: string, from: Units, to: Units): number | null {
  const n = num(cell);
  return n === null || n < 0 ? null : convertWeight(n, from, to);
}

// ---------- plan rows from days ----------

/** A day to write: an engine DayPlan (exercises with `sets`), or a Tally-shaped day (exercises with `suggestedSets`). */
export type DayInput = {
  date: CalendarDate;
  dayName?: string;
  notes?: string;
  weightUnit?: Units;
  exercises: (ExerciseEntry | Record<string, unknown>)[];
};

function rowFromExercise(date: CalendarDate, day: DayInput, ex: ExerciseEntry | Record<string, unknown>, units: Units): PlanRow {
  const row = emptyRow();
  row.date = date;
  row.day = day.dayName ?? "";
  const e = ex as Record<string, unknown>;
  row.exercise = typeof e.name === "string" ? e.name : "";
  if (Array.isArray(e.sets)) {
    const work = (e.sets as SetEntry[]).filter((s) => !s.warmup);
    row.sets = work.length > 0 ? String(work.length) : "";
    row.reps = repsCell(work);
    const w = work.map((s) => s.weight).filter((x): x is number => typeof x === "number");
    row.load = w.length > 0 ? String(Math.max(...w)) : "";
    row.unit = (e.unit as Units | undefined) ?? units;
  } else {
    // Tally's shape: suggestedSets, suggestedReps (and repsMax), suggestedWeight, suggestedDuration.
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    row.sets = n(e.suggestedSets) !== null ? String(e.suggestedSets) : "";
    const lo = n(e.suggestedReps);
    const hi = n(e.repsMax);
    const dur = n(e.suggestedDuration);
    row.reps = lo !== null ? (hi !== null && hi !== lo ? `${lo}-${hi}` : String(lo)) : dur !== null ? (dur % 60 === 0 ? `${dur / 60}min` : `${dur}s`) : "";
    row.load = n(e.suggestedWeight) !== null ? String(e.suggestedWeight) : "";
    row.unit = day.weightUnit ?? units;
  }
  if (row.load === "") row.unit = "";
  return row;
}

export type WritePlanResult = { files: string[]; dates: CalendarDate[]; rows: number; kept_done: number; dropped_done: { date: CalendarDate; exercise: string }[]; warnings: string[] };

const isLoggedRow = (r: PlanRow) => DONE_COLUMNS.some((c) => r[c] !== "");

/**
 * Writes the plan columns of the given days. Each given date is replaced; other dates in the
 * file, and every unparsed row, stay as they are. A row the athlete already logged keeps its
 * done_ columns and its own columns when the new plan has the same exercise on that date, and
 * keeps its unit: the new plan load is converted to the logged unit (fix 2). A logged row the
 * new plan drops is kept as it is and listed in `dropped_done` (a log is never lost).
 */
export function writePlan(root: string, days: DayInput[], units: Units): WritePlanResult {
  refuseUnderUrgentStop(root, "plans write");
  if (!Array.isArray(days) || days.length === 0) throw new CoachError("INPUT_ERROR", "plans write needs at least one day");
  const byFile = new Map<string, DayInput[]>();
  for (const d of days) {
    if (!d || !isCalendarDate(d.date) || !Array.isArray(d.exercises)) throw new CoachError("INPUT_ERROR", `each day needs a date (YYYY-MM-DD) and exercises: ${JSON.stringify(d?.date)}`);
    const p = weekFilePath(root, d.date);
    byFile.set(p, [...(byFile.get(p) ?? []), d]);
  }
  const out: WritePlanResult = { files: [], dates: [], rows: 0, kept_done: 0, dropped_done: [], warnings: [] };
  for (const [path, list] of byFile) {
    const file = readWeekFile(path);
    out.warnings.push(...file.warnings);
    const dates = new Set(list.map((d) => d.date));
    const old = file.rows.filter((r) => dates.has(r.date));
    const kept = file.rows.filter((r) => !dates.has(r.date));
    const used = new Set<PlanRow>();
    for (const d of list) {
      d.exercises.forEach((ex, i) => {
        const row = rowFromExercise(d.date, d, ex, units);
        if (row.exercise === "") throw new CoachError("INPUT_ERROR", `${d.date}: exercise ${i + 1} has no name`);
        if (i === 0 && d.notes) row.notes = d.notes;
        const prev = old.find((r) => !used.has(r) && r.date === d.date && key(r.exercise) === key(row.exercise));
        if (prev) {
          used.add(prev);
          for (const c of DONE_COLUMNS) row[c] = prev[c];
          row.extra = { ...prev.extra };
          if (isLoggedRow(prev)) out.kept_done++;
          // The logged load stays in the unit it was logged in; the plan load follows it.
          if (prev.done_load !== "" && prev.unit !== "") {
            const logUnit = unitOf(prev.unit, units);
            const planUnit = unitOf(row.unit, units);
            if (row.load !== "" && planUnit !== logUnit) row.load = String(loadIn(row.load, planUnit, logUnit) ?? row.load);
            row.unit = prev.unit;
          }
        }
        kept.push(row);
        out.rows++;
      });
      out.dates.push(d.date);
    }
    for (const r of old) {
      if (used.has(r) || !isLoggedRow(r)) continue;
      kept.push(r);
      out.dropped_done.push({ date: r.date, exercise: r.exercise });
    }
    writeWeekFile(path, kept, file);
    out.files.push(relative(root, path));
  }
  return out;
}

// ---------- reading a week ----------

function planned(rows: PlanRow[], units: Units, warnings: string[]): DayPlan[] {
  const days = new Map<CalendarDate, DayPlan>();
  for (const r of rows) {
    const warn = rowWarn(warnings, r);
    const day = days.get(r.date) ?? { date: r.date, exercises: [] };
    if (r.day && !day.dayName) day.dayName = r.day;
    if (r.notes) day.notes = day.notes ? `${day.notes} | ${r.notes}` : r.notes;
    const n = count(r.sets, MAX_SETS, "sets", warn);
    const { reps, duration_s } = parseReps(r.reps, warn);
    const load = num(r.load);
    // An empty sets cell is one set (a cardio row); an unknown count gives no sets.
    const sets = n === undefined ? 1 : (n ?? 0);
    day.exercises.push({
      exerciseId: null,
      name: r.exercise,
      ...(load !== null ? { unit: unitOf(r.unit, units) } : {}),
      sets: Array.from({ length: sets }, () => ({ weight: load, reps, ...(duration_s !== null ? { duration_s } : {}) })),
    });
    days.set(r.date, day);
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** True when the athlete logged the row: any done_ column has a value. */
export function isLogged(r: PlanRow): boolean {
  return r.done_sets !== "" || r.done_reps !== "" || r.done_load !== "";
}

/**
 * The logged sets of a row, in the row's unit: done_sets sets (else as many as the per-set
 * lists hold), each with its reps and load. An unknown count gives no sets (fix 3).
 */
function loggedSets(r: PlanRow, warn: Warn): SetEntry[] {
  const repsCells = list(r.done_reps);
  const loadCells = list(r.done_load);
  if (repsCells.length > MAX_SETS || loadCells.length > MAX_SETS) {
    warn(`more than ${MAX_SETS} logged values; read as unknown`);
    return [];
  }
  const reps = repsCells.map((c) => count(c, MAX_REPS, "done reps", warn) ?? null);
  const loads = loadCells.map((c) => (/^bw$/i.test(c) ? null : num(c) !== null && num(c)! >= 0 ? num(c) : (warn(`done load ${JSON.stringify(c)} is not a load; read as unknown`), null)));
  const n = count(r.done_sets, MAX_SETS, "done sets", warn);
  if (n === null) return [];
  const sets = n !== undefined ? n : Math.max(reps.length, loads.length, r.done_load !== "" || r.done_reps !== "" ? 1 : 0);
  const rpe = feltRpe(r.felt);
  const at = (xs: (number | null)[], i: number) => (xs.length === 0 ? null : xs[Math.min(i, xs.length - 1)]);
  return Array.from({ length: sets }, (_, i) => ({ weight: at(loads, i), reps: at(reps, i), rpe }));
}

function logged(rows: PlanRow[], units: Units, warnings: string[]): DayLog[] {
  const days = new Map<CalendarDate, DayLog>();
  for (const r of rows.filter(isLogged)) {
    const day = days.get(r.date) ?? { date: r.date, exercises: [] };
    day.exercises.push({ exerciseId: null, name: r.exercise, unit: unitOf(r.unit, units), sets: loggedSets(r, rowWarn(warnings, r)) });
    days.set(r.date, day);
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export type WeekRead = { file: string; exists: boolean; week: string; week_start: CalendarDate; days: DayPlan[]; logged: DayLog[]; unparsed: number; warnings: string[] };

/** The week that holds `date`: its planned days (engine DayPlans), its logged days, and what could not be read. */
export function readWeek(root: string, date: CalendarDate, units: Units): WeekRead {
  const path = weekFilePath(root, date);
  const f = readWeekFile(path);
  const warnings = [...f.warnings];
  const days = planned(f.rows, units, warnings);
  const done = logged(f.rows, units, warnings);
  return { file: relative(root, path), exists: existsSync(path), week: isoWeekId(date), week_start: weekStart(date), days, logged: done, unparsed: f.unparsed.length, warnings: [...new Set(warnings)] };
}

type AllRows = { rows: PlanRow[]; warnings: string[]; unparsed: { monday: CalendarDate; row: UnparsedRow }[] };

function allRows(root: string): AllRows {
  const out: AllRows = { rows: [], warnings: [], unparsed: [] };
  for (const p of weekFiles(root)) {
    const f = readWeekFile(p);
    out.rows.push(...f.rows);
    out.warnings.push(...f.warnings);
    const monday = isoWeekMonday(/(\d{4}-W\d{2})\.csv$/.exec(p)![1]);
    out.unparsed.push(...f.unparsed.map((row) => ({ monday, row })));
  }
  return out;
}

/** Every date with a logged row, oldest first. */
export function loggedDates(root: string): CalendarDate[] {
  return [...new Set(allRows(root).rows.filter(isLogged).map((r) => r.date))].sort();
}

/** The logged weeks from the week of `from` to the week of `to`, Monday to Sunday (empty weeks included), as `weeks` prints them. */
export function filesWeeks(root: string, from: CalendarDate, to: CalendarDate, units: Units): { logs: WeekLog[]; warnings: string[] } {
  const { rows, warnings } = allRows(root);
  const days = logged(rows.filter((r) => r.date >= from && r.date <= to), units, warnings);
  const logs: WeekLog[] = [];
  for (let w = weekStart(from); w <= weekStart(to); w = addDays(w, 7)) logs.push({ week_start: w, days: days.filter((d) => weekStart(d.date) === w) });
  return { logs, warnings: [...new Set(warnings)] };
}

// ---------- a chat report fills the done_ columns ----------

export type DoneInput = {
  date: CalendarDate;
  /** One exercise (by name, case and punctuation ignored); without it, every row of the date. */
  exercise?: string;
  /** Copy the plan into the done_ columns ("did all sets"): sets, reps (a range: its top) and load. */
  asPlanned?: boolean;
  sets?: string;
  reps?: string;
  load?: string;
  felt?: string;
};

export type DoneResult = { file: string; updated: { date: CalendarDate; exercise: string; done_sets: string; done_reps: string; done_load: string; felt: string }[]; logged_sessions: number; warnings: string[] };

/**
 * Fills the done_ columns of one row (`exercise`) or of every row of a date. `asPlanned`
 * copies the plan; an explicit value wins over the plan; `felt` is written as given. With
 * `asPlanned` and no `exercise`, rows already logged are left as they are. Unparsed rows stay.
 */
export function fillDone(root: string, input: DoneInput): DoneResult {
  refuseUnderUrgentStop(root, "plans done");
  if (!isCalendarDate(input.date)) throw new CoachError("USAGE", "plans done needs --date YYYY-MM-DD");
  const values = [input.sets, input.reps, input.load, input.felt].some((v) => v !== undefined);
  if (!input.asPlanned && !values) throw new CoachError("USAGE", "plans done needs --as-planned, or one of --sets, --reps, --load, --felt");
  if (!input.exercise && !input.asPlanned) throw new CoachError("USAGE", "plans done without --exercise needs --as-planned (every exercise of the day as planned)");
  const path = weekFilePath(root, input.date);
  const f = readWeekFile(path);
  const targets = f.rows.filter((r) => r.date === input.date && (input.exercise ? key(r.exercise) === key(input.exercise) : !isLogged(r)));
  if (targets.length === 0) {
    const names = f.rows.filter((r) => r.date === input.date).map((r) => r.exercise);
    throw new CoachError(
      "NOT_PLANNED",
      input.exercise
        ? `${input.date} has no row for ${JSON.stringify(input.exercise)} in ${relative(root, path)}${names.length ? ` (planned: ${names.join(", ")})` : ""}`
        : `${input.date} has no unlogged row in ${relative(root, path)}`,
    );
  }
  const updated: DoneResult["updated"] = [];
  for (const r of targets) {
    if (input.asPlanned) {
      r.done_sets = r.sets;
      const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(r.reps);
      r.done_reps = range ? range[2] : /^\d+$/.test(r.reps) ? r.reps : "";
      r.done_load = r.load;
    }
    if (input.sets !== undefined) r.done_sets = input.sets;
    if (input.reps !== undefined) r.done_reps = input.reps;
    if (input.load !== undefined) r.done_load = input.load;
    if (input.felt !== undefined) r.felt = input.felt;
    updated.push({ date: r.date, exercise: r.exercise, done_sets: r.done_sets, done_reps: r.done_reps, done_load: r.done_load, felt: r.felt });
  }
  writeWeekFile(path, f.rows, f);
  return { file: relative(root, path), updated, logged_sessions: loggedDates(root).length, warnings: f.warnings };
}

// ---------- the engine's view of the files: a snapshot ----------

/**
 * A snapshot built from the week files, for the tools that read the logger through the
 * snapshot (readiness, weeks, loads, adjust, block draft): `days` holds every planned date in
 * the logger's shape (suggestedSets, suggestedReps, suggestedWeight), `history` the logged
 * rows. Every load is converted from its row's unit to `units`, so one day can mix units
 * (fix 2). A row the reader could not use, or a count it could not trust, makes the history
 * incomplete, with the reasons in `warnings` (fixes 1 and 3).
 */
export function filesSnapshot(root: string, opts: { units: Units; timezone: string; now: Instant; session_id?: string }): Snapshot {
  const all = allRows(root);
  const warnings = [...all.warnings];
  const days: Record<CalendarDate, SnapshotDay> = {};
  for (const d of planned(all.rows, opts.units, warnings)) {
    days[d.date] = {
      found: true,
      version: null,
      updatedAt: null,
      source: "files",
      userModified: false,
      skipped: false,
      ...(d.dayName ? { dayName: d.dayName } : {}),
      ...(d.notes ? { notes: d.notes } : {}),
      exercises: all.rows
        .filter((r) => r.date === d.date)
        .map((r) => {
          const quiet: Warn = () => {};
          const { reps, repsMax, duration_s } = parseReps(r.reps, quiet);
          const sets = count(r.sets, MAX_SETS, "sets", quiet);
          const load = loadIn(r.load, unitOf(r.unit, opts.units), opts.units);
          return {
            exerciseId: "",
            name: r.exercise,
            ...(typeof sets === "number" ? { suggestedSets: sets } : {}),
            ...(reps !== null ? { suggestedReps: reps } : {}),
            ...(repsMax !== null ? { repsMax } : {}),
            ...(duration_s !== null ? { suggestedDuration: duration_s } : {}),
            ...(load !== null ? { suggestedWeight: load } : {}),
          };
        }),
      weightUnit: opts.units,
      weightUnitSource: "settings",
      captured_at: opts.now,
    };
  }
  const history: SnapshotSession[] = logged(all.rows, opts.units, warnings).map((d) => ({
    date: d.date,
    ...(all.rows.find((r) => r.date === d.date && r.day) ? { name: all.rows.find((r) => r.date === d.date && r.day)!.day } : {}),
    weightUnit: opts.units,
    exercises: d.exercises.map((e) => ({
      exerciseId: "",
      name: e.name,
      muscle: "",
      sets: e.sets.map((s) => ({ weight: typeof s.weight === "number" ? convertWeight(s.weight, e.unit ?? opts.units, opts.units) : null, reps: s.reps ?? null, rpe: s.rpe ?? null })),
    })),
  }));
  const unique = [...new Set(warnings)];
  return {
    version: 1,
    session_id: opts.session_id ?? "files",
    captured_at: opts.now,
    timezone: opts.timezone,
    days,
    history,
    history_coverage: { captured_at: opts.now, complete: unique.length === 0 },
    weightUnit: opts.units,
    weightUnitSource: "settings",
    ...(unique.length > 0 ? { warnings: unique } : {}),
  };
}

/**
 * The athlete's notes and felt text per logged date, for the note scan (`safety scan-notes`).
 * An unparsed row is scanned too, dated its week's Monday, so a sign in it is never missed.
 */
export function filesNotesHistory(root: string): NotesHistoryEntry[] {
  const all = allRows(root);
  const byDate = new Map<CalendarDate, NotesHistoryEntry>();
  const add = (date: CalendarDate, name: string, text: string) => {
    const e = byDate.get(date) ?? { date, exercises: [] };
    e.exercises!.push({ exerciseId: null, name, notes: text });
    byDate.set(date, e);
  };
  for (const r of all.rows) {
    const text = [r.notes, feltRpe(r.felt) === null ? r.felt : ""].filter(Boolean).join(". ");
    if (text) add(r.date, r.exercise, text);
  }
  for (const { monday, row } of all.unparsed) add(monday, "unparsed row", row.text ?? Object.values(row.cells ?? {}).join(" "));
  return [...byDate.values()];
}
