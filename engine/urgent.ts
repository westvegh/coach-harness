// The urgent stop (contracts §10). Code enforces it: while athlete/.urgent-stop exists, the
// urgent-gate hook denies every plan mutation (any MCP server) and every Edit, Write or
// MultiEdit under plans/. The file holds term names, sources and the time only, never
// the athlete's words. It is committed and pushed, so a cloud run sees it.
//
//   node engine/cli.ts urgent set --term <name> --source chat|checkin|note|answer   (commits and pushes)
//   node engine/cli.ts urgent clear --reason clinician|false-alarm                  (live session only)
//   node engine/cli.ts urgent status
//
// `clear` appends {date, at, terms, sources, reason} to athlete/log/urgent-clearances.jsonl
// and deletes the stop. The note scan skips notes dated on or before the latest clearance
// of the same term; a new event after it stops again.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isCalendarDate, localDate, parseInstant } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { unattendedMarker } from "./mode.ts";
import { loadSafetyTerms } from "./safety.ts";
import { isPlainObject } from "./yaml-file.ts";
import type { CalendarDate, Instant, UrgentClearance, UrgentSource, UrgentStop } from "./types.ts";

export const URGENT_RELATIVE = "athlete/.urgent-stop";
export const CLEARANCES_RELATIVE = "athlete/log/urgent-clearances.jsonl";
export const URGENT_SOURCES: readonly UrgentSource[] = ["chat", "checkin", "note", "answer", "legacy"];
/** The sources `urgent set` takes (legacy is the session-context conversion only). */
export const SET_SOURCES: readonly UrgentSource[] = ["chat", "checkin", "note", "answer"];
export const CLEAR_REASONS = ["clinician", "false-alarm"] as const;
/** The term `urgent set` takes for a sign the term list does not name. */
export const OTHER_TERM = "other urgent sign";
/** The term a stop file that cannot be read stands for: it still stops. */
export const UNREADABLE_TERM = "unreadable stop file";

/** The urgent term names in engine/safety-terms.yaml, plus OTHER_TERM. */
export function urgentTermNames(): string[] {
  return [...new Set([...loadSafetyTerms().urgent.map((e) => e.term), OTHER_TERM])];
}

/** The stop, or null when there is none. A file that cannot be read still stops (UNREADABLE_TERM). */
export function readStop(root: string): UrgentStop | null {
  const p = join(root, URGENT_RELATIVE);
  if (!existsSync(p)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (isPlainObject(raw) && typeof raw.at === "string" && Array.isArray(raw.terms) && Array.isArray(raw.sources)) {
      return {
        version: 1,
        at: raw.at,
        terms: raw.terms.filter((t): t is string => typeof t === "string"),
        sources: raw.sources.filter((s): s is UrgentSource => URGENT_SOURCES.includes(s as UrgentSource)),
      };
    }
  } catch {
    /* falls through: an unreadable file still stops */
  }
  return { version: 1, at: new Date(0).toISOString(), terms: [UNREADABLE_TERM], sources: [] };
}

/** Writes (or extends) the stop. Terms and sources already in the file are kept. */
export function writeStop(root: string, input: { terms: string[]; source: UrgentSource; now?: Instant }): { stop: UrgentStop; changed: boolean } {
  if (!URGENT_SOURCES.includes(input.source)) throw new CoachError("USAGE", `--source must be one of ${URGENT_SOURCES.join(", ")}`);
  if (input.terms.length === 0) throw new CoachError("USAGE", "the urgent stop needs at least one term");
  const now = input.now ?? new Date().toISOString();
  parseInstant(now, "now");
  const prev = readStop(root);
  const terms = [...new Set([...(prev?.terms ?? []), ...input.terms])];
  const sources = [...new Set([...(prev?.sources ?? []), input.source])];
  const changed = !prev || terms.length !== prev.terms.length || sources.length !== prev.sources.length;
  const stop: UrgentStop = { version: 1, at: prev?.at && prev.terms[0] !== UNREADABLE_TERM ? prev.at : now, terms, sources };
  const p = join(root, URGENT_RELATIVE);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(stop, null, 2) + "\n");
  renameSync(tmp, p);
  return { stop, changed };
}

/** Every clearance record, oldest first. Lines that do not parse are skipped. */
export function readClearances(root: string): UrgentClearance[] {
  const p = join(root, CLEARANCES_RELATIVE);
  if (!existsSync(p)) return [];
  const out: UrgentClearance[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r: unknown = JSON.parse(line);
      if (isPlainObject(r) && isCalendarDate(r.date) && Array.isArray(r.terms)) out.push(r as unknown as UrgentClearance);
    } catch {
      /* a broken line clears nothing */
    }
  }
  return out;
}

/** The latest clearance date for each term. */
export function clearedThrough(clearances: UrgentClearance[]): Map<string, CalendarDate> {
  const m = new Map<string, CalendarDate>();
  for (const c of clearances) for (const t of c.terms) if (!m.has(t) || (m.get(t) as string) < c.date) m.set(t, c.date);
  return m;
}

/** The athlete's timezone from coach.yaml, else UTC (a hook or a fresh copy without one). */
function athleteTimezone(root: string): string {
  try {
    const m = /^\s*timezone:\s*["']?([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)["']?\s*$/m.exec(readFileSync(join(root, "coach.yaml"), "utf8"));
    return m ? m[1] : "UTC";
  } catch {
    return "UTC";
  }
}

export type ClearResult = { cleared: boolean; record: UrgentClearance | null };

/**
 * Clears the stop after the athlete's answer in a live session: a clinician has seen it,
 * or it was a false alarm. Refuses in an unattended run and without one of the two reasons.
 */
export function clearStop(root: string, input: { reason?: string; now?: Instant; env?: NodeJS.ProcessEnv }): ClearResult {
  const marker = unattendedMarker(input.env ?? process.env);
  if (marker) throw new CoachError("UNATTENDED", `the urgent stop is never cleared in an unattended run (${marker} is set); it needs the athlete's answer in a live session`);
  if (!CLEAR_REASONS.includes(input.reason as (typeof CLEAR_REASONS)[number])) {
    throw new CoachError("USAGE", "urgent clear needs --reason clinician (a clinician has seen it) or --reason false-alarm");
  }
  const now = input.now ?? new Date().toISOString();
  parseInstant(now, "now");
  const stop = readStop(root);
  if (!stop) return { cleared: false, record: null };
  const record: UrgentClearance = { date: localDate(now, athleteTimezone(root)), at: now, terms: stop.terms, sources: stop.sources, reason: input.reason as UrgentClearance["reason"] };
  const p = join(root, CLEARANCES_RELATIVE);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(record) + "\n");
  rmSync(join(root, URGENT_RELATIVE), { force: true });
  return { cleared: true, record };
}

export type CommitResult = { committed: boolean; reason?: string };

/**
 * Commits exactly `paths` (git add, then git commit --only), never other staged work.
 * Never throws: not a git repository, nothing to commit or a failed commit is reported.
 */
export function commitPaths(root: string, paths: string[], message: string): CommitResult {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { committed: false, reason: "not a git repository" };
  }
  const tracked = (p: string) => {
    try {
      git(["ls-files", "--error-unmatch", "--", p]);
      return true;
    } catch {
      return false;
    }
  };
  // A path removed with `git rm` is gone from the disk and the index, but HEAD still has it.
  const inHead = (p: string) => {
    try {
      git(["cat-file", "-e", `HEAD:${p}`]);
      return true;
    } catch {
      return false;
    }
  };
  // `git add` fails on a path that is neither on disk nor tracked; a path only HEAD has is already staged.
  const addable = paths.filter((p) => existsSync(join(root, p)) || tracked(p));
  const live = paths.filter((p) => addable.includes(p) || inHead(p));
  if (live.length === 0) return { committed: false, reason: "nothing to commit" };
  try {
    if (addable.length > 0) git(["add", "-A", "--", ...addable]);
    const staged = git(["diff", "--cached", "--name-only", "-z", "--", ...live]).split("\0").filter(Boolean);
    if (staged.length === 0) return { committed: false, reason: "nothing to commit" };
    // Only the paths with staged changes: a folder that exists but holds nothing git knows (an
    // ignored cache only) would fail `commit --only` as an unknown pathspec.
    const changed = live.filter((p) => staged.some((f) => f === p || f.startsWith(`${p}/`)));
    git(["commit", "-q", "--only", "-m", message, "--", ...changed]);
    return { committed: true };
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { committed: false, reason: (err.stderr || err.message).trim().split("\n").slice(-2).join(" | ") };
  }
}

export type PushResult = { pushed: boolean; reason?: string };
export type RecordResult = { stop: UrgentStop; changed: boolean; commit: CommitResult; push: PushResult | null };

/**
 * True when a commit that touches `paths` is not on the upstream yet: the branch has no
 * upstream and some commit touches them, or the upstream lacks one. False outside git.
 */
export function unpushed(root: string, paths: string[]): boolean {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git(["rev-parse", "--verify", "-q", "HEAD"]);
  } catch {
    return false;
  }
  try {
    git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    try {
      return git(["log", "-1", "--format=%H", "--", ...paths]) !== "";
    } catch {
      return false;
    }
  }
  try {
    return git(["rev-list", "--count", "@{u}..HEAD", "--", ...paths]) !== "0";
  } catch {
    return true;
  }
}

/**
 * Reconciles the stop's persistence on every call, not only when the content changed: an
 * uncommitted change to `paths` is committed, and a commit not yet on the upstream is
 * pushed (with `push`). A failed commit or push never undoes the stop: the result says so,
 * and the next call tries again.
 */
export async function persist(root: string, paths: string[], message: string, opts: { push: boolean }): Promise<{ commit: CommitResult; push: PushResult | null }> {
  const commit = commitPaths(root, paths, message);
  const push = opts.push && (commit.committed || unpushed(root, paths)) ? await pushNow(root) : null;
  return { commit, push };
}

/** Writes the stop, then commits and (with `push`) pushes it through the trusted push, so a cloud run sees it. */
export async function recordStop(root: string, input: { terms: string[]; source: UrgentSource; now?: Instant }, opts: { push: boolean }): Promise<RecordResult> {
  const { stop, changed } = writeStop(root, input);
  return { stop, changed, ...(await persist(root, [URGENT_RELATIVE], `urgent stop (${input.source})`, opts)) };
}

/** The trusted push (privacy check first). Never throws. */
export async function pushNow(root: string): Promise<PushResult> {
  try {
    const r = (await import("./cli-git.ts")).pushBranch(root);
    return { pushed: r.pushed, ...(r.reason ? { reason: String(r.reason) } : {}) };
  } catch (e) {
    return { pushed: false, reason: (e as Error).message.split("\n")[0] };
  }
}

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

const USAGE = "usage: urgent set --term <name> --source chat|checkin|note|answer | urgent clear --reason clinician|false-alarm | urgent status";

/** Runs `urgent set|clear|status`. Output is JSON on stdout. */
export async function urgentCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: { root: { type: "string" }, term: { type: "string", multiple: true }, source: { type: "string" }, reason: { type: "string" }, now: { type: "string" } },
  });
  const root = resolve(values.root ?? ".");
  const sub = positionals[0];
  if (sub === "status") {
    const stop = readStop(root);
    out({ ok: true, stopped: stop !== null, stop, clearances: readClearances(root).slice(-3) });
    return 0;
  }
  if (sub === "set") {
    const known = urgentTermNames();
    const terms = (values.term ?? []).flatMap((t) => t.split(",")).map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (terms.length === 0) throw new CoachError("USAGE", `urgent set needs --term <name> (one of: ${known.join(", ")})`);
    const bad = terms.filter((t) => !known.includes(t));
    if (bad.length > 0) throw new CoachError("USAGE", `unknown urgent term ${bad.join(", ")}; use one of: ${known.join(", ")}`);
    if (!SET_SOURCES.includes(values.source as UrgentSource)) throw new CoachError("USAGE", `urgent set needs --source ${SET_SOURCES.join(" | ")}`);
    const r = await recordStop(root, { terms, source: values.source as UrgentSource, now: values.now }, { push: true });
    out({ ok: true, ...r });
    return 0;
  }
  if (sub === "clear") {
    const r = clearStop(root, { reason: values.reason, now: values.now });
    // Every call reconciles: a clearance committed earlier but not pushed is pushed now.
    out({ ok: true, ...r, ...(await persist(root, [URGENT_RELATIVE, CLEARANCES_RELATIVE], `urgent stop cleared (${values.reason})`, { push: true })) });
    return 0;
  }
  throw new CoachError("USAGE", USAGE);
}
