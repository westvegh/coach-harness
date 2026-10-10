// Operation IDs, guard verdict hand-off and the operation log (contracts §9).
//
// guard-writes saves its verdict under athlete/.cache/verdicts/ keyed by the tool-use
// ID; log-writes reads it back to name the change kind, the rules and the approval.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toolCallHash } from "./approvals.ts";
import { isCalendarDate, localDate } from "./dates.ts";
import { toolSuffix } from "./logger.ts";
import { OP_KINDS } from "./opid.ts";
import { refusedDays, responsePayload, tallyRefusal } from "./snapshot.ts";
import { isPlainObject } from "./yaml-file.ts";
import type { ChangeKind, Instant } from "./types.ts";

export const VERDICTS_RELATIVE = "athlete/.cache/verdicts";
export const LOG_RELATIVE = "athlete/log";

/** contracts §9: op-<date>-<kind>-<sha256(canonical tool call)[0..12]>. */
export function opId(date: string, kind: string, call: { tool: string; args: unknown }): string {
  return `op-${date}-${kind}-${toolCallHash(call.tool, call.args).slice(0, 12)}`;
}

/**
 * The operation ID the log records: the opId the call submitted to the logger (Tally T2),
 * else the computed one. Recomputing would hash a kind the skill may not have used.
 */
export function loggedOpId(date: string, kind: string, call: { tool: string; args: unknown }): string {
  const submitted = isPlainObject(call.args) ? call.args.opId : undefined;
  return typeof submitted === "string" && submitted !== "" ? submitted : opId(date, kind, call);
}

export type SavedVerdict = {
  tool: string;
  args_hash: string;
  decision: "allow" | "ask" | "deny";
  kinds: ChangeKind[];
  rule_ids: string[];
  reasons: string[];
  warnings: string[];
  approval?: string;
  mode: "interactive" | "unattended";
  at: Instant;
};

function verdictPath(root: string, key: string): string {
  return join(root, VERDICTS_RELATIVE, `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

/** The key a verdict is saved under: the tool-use ID, else the call hash. */
export function verdictKey(toolUseId: unknown, tool: string, args: unknown): string {
  return typeof toolUseId === "string" && toolUseId !== "" ? toolUseId : toolCallHash(tool, args);
}

export function saveVerdict(root: string, key: string, v: SavedVerdict): void {
  const p = verdictPath(root, key);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n");
  renameSync(tmp, p);
}

/** The saved verdict, removed once read. Null when there is none or it is unreadable. */
export function takeVerdict(root: string, key: string): SavedVerdict | null {
  const p = verdictPath(root, key);
  if (!existsSync(p)) return null;
  try {
    const v = JSON.parse(readFileSync(p, "utf8")) as SavedVerdict;
    rmSync(p, { force: true });
    return v;
  } catch {
    return null;
  }
}

// ---------- status reconciliation ----------

export type WriteStatus = "written" | "skipped" | "conflict" | "not_found" | "uncertain" | "refused" | "replayed";
export type Reconciled = { status: WriteStatus; detail: string; dates: string[] };

const NOT_RETRIED = "Not retried: only the user can change a Tally limit, in the Tally app (Settings → Training limits)";

/** "limit L-001 "Left knee" (ban) on 2026-10-13: Back Squat; week of 2026-10-12: 7 sets, limit 6". */
function refusalWhat(x: Record<string, unknown>): string {
  const l = isPlainObject(x.limit) ? x.limit : {};
  const which = l.weeklyCap === true ? "the weekly cap" : `limit ${String(l.ruleId ?? "?")}${typeof l.label === "string" ? ` "${l.label}"` : ""}${typeof l.kind === "string" ? ` (${l.kind})` : ""}`;
  const date = isCalendarDate(x.date) ? x.date : isCalendarDate(x.violatingDate) ? x.violatingDate : null;
  const ex = Array.isArray(x.exercises) ? x.exercises.filter((e): e is string => typeof e === "string") : [];
  const w = isPlainObject(x.week) ? x.week : null;
  const week = w && isCalendarDate(w.start) ? `; week of ${w.start}: ${String(w.after)} sets, limit ${String(w.limit)}` : "";
  return `${which}${date ? ` on ${date}` : ""}${ex.length > 0 ? `: ${ex.join(", ")}` : ""}${week}`;
}

/** The outcome of a logger mutation, from its response (Tally result shapes). */
export function reconcile(tool: string, input: unknown, response: unknown): Reconciled {
  const t = toolSuffix(tool);
  const r = responsePayload(response);
  const args = isPlainObject(input) ? input : {};
  const argDates = [args.date, args.fromDate, args.toDate, ...(Array.isArray(args.days) ? args.days.map((d) => (isPlainObject(d) ? d.date : null)) : [])].filter(isCalendarDate);
  // Tally T3: a training limit refused the whole call (a single day, or an opId call
  // that rolled back every day). Logged, never retried; the days are unchanged.
  const refusal = tallyRefusal(response);
  if (refusal) {
    const notWritten = Array.isArray(refusal.notWritten) ? refusal.notWritten.filter(isCalendarDate) : [];
    return { status: "refused", detail: `refused by Tally: ${refusalWhat(refusal)}${notWritten.length > 0 ? `; not written: ${notWritten.join(", ")}` : ""}. ${NOT_RETRIED}.`, dates: notWritten.length > 0 ? notWritten : argDates };
  }
  if (!isPlainObject(r)) return { status: "uncertain", detail: "no parsable result: read the day again before any retry", dates: argDates };
  // Tally T2: a repeat of an opId writes nothing and returns the stored outcome per input,
  // with no workout content. It is history, not a fresh write: the days must be read again.
  if (r.replayed === true) {
    const items = Array.isArray(r.results) ? r.results.filter(isPlainObject) : [];
    const dates = [...new Set([...argDates, ...items.flatMap((x) => [x.date, x.toDate]).filter(isCalendarDate)])];
    const outcome = items.map((x) => `${String(x.date)}${isCalendarDate(x.toDate) ? `→${x.toDate}` : ""} ${String(x.status)}${typeof x.code === "string" ? ` (${x.code})` : ""}`).join(", ");
    return {
      status: "replayed",
      detail: `replay of ${String(r.opId ?? "the opId")} recorded ${String(r.recordedAt ?? "earlier")}: nothing new was written; the stored outcome: ${outcome || "none"}`,
      dates,
    };
  }
  const code = typeof r.code === "string" ? r.code : "";
  const one = (status: WriteStatus, detail: string): Reconciled => ({ status, detail, dates: argDates });
  switch (t) {
    case "plan_workout_day":
    case "plan_workout_range": {
      const refusedList = refusedDays(r);
      const written = (Array.isArray(r.results) ? r.results.filter(isPlainObject) : []).filter((w) => !refusedList.includes(w));
      const skipped = (Array.isArray(r.skippedDates) ? r.skippedDates.filter(isPlainObject) : []).filter((s) => !refusedList.includes(s));
      // reconcile every per-day outcome first, then choose the summary. A
      // range without opId writes each day on its own: written days need the week check,
      // refused days keep their guidance, conflicts are named.
      const conflicts = skipped.filter((x) => x.code === "version_conflict");
      const others = skipped.filter((x) => x.code !== "version_conflict");
      const parts = [
        written.length > 0 ? `written: ${written.map((w) => w.date).join(", ")}` : "",
        conflicts.length > 0 ? `version conflict on ${conflicts.map((x) => x.date).join(", ")}` : "",
        others.length > 0 ? `skipped: ${others.map((x) => `${x.date} (${x.code})`).join(", ")}` : "",
        refusedList.length > 0 ? `refused by Tally: ${refusedList.map(refusalWhat).join("; ")}` : "",
      ].filter(Boolean);
      const detail = parts.join("; ") + (refusedList.length > 0 ? `. ${NOT_RETRIED}.` : "");
      if (written.length > 0) return one("written", detail);
      if (conflicts.length > 0) return one("conflict", detail);
      if (refusedList.length > 0) return one("refused", detail);
      if (others.length > 0) return one("skipped", detail);
      return one("uncertain", "the result lists no dates");
    }
    case "update_planned_workout":
    case "move_planned_workout":
    case "delete_planned_workout":
    case "skip_planned_workout": {
      const s = r.status;
      if (s === "updated" || s === "moved" || s === "deleted") {
        const ver = typeof r.version === "string" ? r.version : isPlainObject(r.day) && typeof r.day.version === "string" ? r.day.version : null;
        return one("written", ver ? `written (version ${ver})` : "written");
      }
      if (s === "unchanged") return one("skipped", "unchanged: the status already matched");
      if (s === "not_found") return one("not_found", "nothing planned on the date");
      if (s === "conflict" || code === "version_conflict") return one("conflict", "version conflict: the day changed since the read");
      if (s === "skipped") return one("skipped", `skipped (${code || String(r.reason ?? "")})`);
      return one("uncertain", `unknown status ${JSON.stringify(s)}`);
    }
    case "update_user_profile":
      return r.status === "updated" ? one("written", `profile saved: ${Array.isArray(r.saved) ? r.saved.join(", ") : ""}`) : one("uncertain", "unknown profile result");
    case "update_training_limits": {
      // Tally T3 (spec §6.2): {status: updated, version} | {status: conflict, version} | {status: invalid, reason}.
      if (r.status === "updated") return one("written", `Tally limits saved (version ${String(r.version)})`);
      if (r.status === "conflict") return one("conflict", `Tally's limits changed (now version ${String(r.version)}): read get_training_context again, then sync again`);
      if (r.status === "invalid") return one("skipped", `Tally rejected the limit change: ${String(r.reason ?? "invalid")}`);
      return one("uncertain", `unknown status ${JSON.stringify(r.status)}: read get_training_context before any retry`);
    }
    default:
      return one("uncertain", `not a logger mutation: ${t}`);
  }
}

/** What the run does next, after a logged write (the log-writes hook says it). */
export function nextStep(rec: Reconciled): string {
  switch (rec.status) {
    case "written":
      return "Re-read the affected week with get_planned_workout and check the combined week; on a hard-rule breach, set a hold and stop writing.";
    case "uncertain":
      return "The outcome is uncertain: read the day again before any retry.";
    case "replayed":
      return "This was a replay: read the days again with get_planned_workout; a replay carries no workout content, and the days may have changed since.";
    default:
      return "Nothing was written.";
  }
}

// ---------- the log ----------

export type LogEntry = {
  now: Instant;
  timezone: string;
  op_id: string;
  trigger: string;
  rules: string[];
  change: string;
  approval: string;
  result: string;
  readiness?: string;
};

/** Appends one entry to athlete/log/YYYY-MM.md (contracts §9 format). Returns the file. */
export function appendLog(root: string, e: LogEntry): string {
  const date = localDate(e.now, e.timezone);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: e.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(e.now));
  const p = join(root, LOG_RELATIVE, `${date.slice(0, 7)}.md`);
  mkdirSync(dirname(p), { recursive: true });
  const lines = [
    `## ${date} ${time} · ${e.op_id}`,
    `- trigger: ${e.trigger}`,
    ...(e.readiness ? [`- readiness: ${e.readiness}`] : []),
    `- rules: ${e.rules.length > 0 ? e.rules.join(", ") : "none"}`,
    `- change: ${e.change}`,
    `- approval: ${e.approval}`,
    `- result: ${e.result}`,
  ];
  const head = existsSync(p) ? "\n" : `# Operation log ${date.slice(0, 7)}\n\n`;
  appendFileSync(p, head + lines.join("\n") + "\n");
  return p;
}

// ---------- is a change done? ----------

export type DayOutcome = "done" | "conflict" | "refused" | "skipped" | "not_found" | "uncertain";

export type ParsedEntry = { heading: string; op_id: string; dates: string[]; kinds: string[]; status: string; detail: string; outcomes: Record<string, DayOutcome> };

const SUCCESS = ["written", "updated", "moved", "deleted"];
const DATE_G = /\d{4}-\d{2}-\d{2}/g;
const datesIn = (s: string) => (s.match(DATE_G) ?? []).filter(isCalendarDate);

/** The per-date outcomes of one log entry, from the result line that reconcile() wrote. */
function entryOutcomes(dates: string[], status: string, detail: string): Record<string, DayOutcome> {
  const out: Record<string, DayOutcome> = {};
  const all = (o: DayOutcome) => {
    for (const d of dates) out[d] = o;
    return out;
  };
  switch (status) {
    case "written": {
      // A range lists its written dates ("written: d1, d2; ..."); a single day does not.
      const listed = /^written: ([\d, -]+?)(?:;|$)/.exec(detail);
      if (!listed) return all("done");
      const written = datesIn(listed[1]);
      const conflicts = datesIn(/version conflict on ([\d, -]+)/.exec(detail)?.[1] ?? "");
      for (const d of new Set([...dates, ...written])) out[d] = written.includes(d) ? "done" : conflicts.includes(d) ? "conflict" : /refused by Tally/.test(detail) ? "refused" : "skipped";
      return out;
    }
    case "replayed": {
      // "the stored outcome: d1 updated, d2→d3 moved, d4 skipped (code)"
      const list = /the stored outcome: (.*)$/.exec(detail)?.[1] ?? "";
      for (const item of list.split(", ")) {
        const m = /^(\d{4}-\d{2}-\d{2})(?:→(\d{4}-\d{2}-\d{2}))? ([a-z_]+)/.exec(item.trim());
        if (!m) continue;
        const o: DayOutcome = SUCCESS.includes(m[3]) ? "done" : m[3] === "not_found" ? "not_found" : "skipped";
        for (const d of [m[1], m[2]]) if (d && out[d] !== "done") out[d] = o;
      }
      for (const d of dates) out[d] ??= "uncertain";
      return out;
    }
    case "conflict":
    case "refused":
    case "skipped":
    case "not_found":
    case "uncertain":
      return all(status);
    default:
      return all("uncertain");
  }
}

/** The entries of an operation log file (contracts §9 format). */
export function parseLog(text: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  for (const block of text.split(/^(?=## )/m)) {
    const head = /^## (\d{4}-\d{2}-\d{2}) \d{2}:\d{2} · (\S+)/.exec(block);
    if (!head) continue;
    const line = (k: string) => new RegExp(`^- ${k}: (.*)$`, "m").exec(block)?.[1] ?? "";
    const result = /^([a-z_]+)(?:: (.*))?$/.exec(line("result").trim());
    if (!result) continue;
    const change = line("change");
    if (/^none\b/.test(change)) continue;
    const opm = /^op-(\d{4}-\d{2}-\d{2})-([a-z_]+)-[0-9a-f]{12}$/.exec(head[2]);
    const changeDates = /^[a-z_]+ on ([\d, -]+)/.exec(change)?.[1];
    const dates = [...new Set([...(opm ? [opm[1]] : []), ...datesIn(changeDates ?? "")])];
    const words = `${change} ${line("approval")}`;
    const kinds = [...new Set([...(opm ? [opm[2]] : []), ...OP_KINDS.filter((k) => new RegExp(`\\b${k}\\b`).test(words))])];
    const detail = result[2] ?? "";
    out.push({ heading: head[0].slice(3), op_id: head[2], dates, kinds, status: result[1], detail, outcomes: entryOutcomes(dates, result[1], detail) });
  }
  return out;
}

export type DoneResult = {
  date: string;
  kind: string;
  done: boolean;
  status: "done" | "not_done" | "uncertain";
  reason: string;
  reread: string[];
  entries: { heading: string; op_id: string; status: string; outcome: DayOutcome }[];
};

/**
 * whether a change of `kind` on `date` is done, from the operation
 * log (athlete/log/*.md). Done only for a confirmed successful outcome (written, or a
 * replay whose stored outcome succeeded). A conflict, skip, refusal or not_found is not
 * done; an uncertain result is not done and names the dates to read again.
 */
export function opDone(root: string, date: string, kind: string): DoneResult {
  const dir = join(root, LOG_RELATIVE);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.md$/.test(f)).sort() : [];
  const entries = files
    .flatMap((f) => parseLog(readFileSync(join(dir, f), "utf8")))
    .filter((e) => e.kinds.includes(kind) && date in e.outcomes)
    .map((e) => ({ heading: e.heading, op_id: e.op_id, status: e.status, outcome: e.outcomes[date] }));
  const base = { date, kind, entries };
  if (entries.some((e) => e.outcome === "done")) return { ...base, done: true, status: "done", reason: `a ${kind} change on ${date} was written`, reread: [] };
  if (entries.some((e) => e.outcome === "uncertain")) {
    return { ...base, done: false, status: "uncertain", reason: `the outcome of a ${kind} change on ${date} is uncertain: read ${date} with get_planned_workout and compare it with the change before any retry`, reread: [date] };
  }
  const why = entries.length === 0 ? `no ${kind} change on ${date} is logged` : `no ${kind} change on ${date} succeeded (${entries.map((e) => e.outcome).join(", ")})`;
  return { ...base, done: false, status: "not_done", reason: why, reread: [] };
}

/** The per-date outcomes of one logger response (the same reading as the log's). */
export function responseOutcomes(tool: string, input: unknown, response: unknown): Record<string, DayOutcome> {
  const rec = reconcile(tool, input, response);
  // skip_planned_workout "unchanged": the day already had that status, which is the goal.
  if (toolSuffix(tool) === "skip_planned_workout" && rec.status === "skipped" && rec.detail.startsWith("unchanged")) return entryOutcomes(rec.dates, "written", "");
  return entryOutcomes(rec.dates, rec.status, rec.detail);
}
