// V7: `save` (contracts §22b): the end of a `today` run in one command. It appends the run's log
// entry once, runs tally-mention (logger files or other, live), commits the coach's paths, brings
// `main` up to date with the remote without ever rebasing `main` itself, and pushes `main` through
// the trusted push (engine/cli-git.ts pushBranch: the hooks, the privacy check, every push URL).
//
// Layouts:
// - this checkout is on main: commit → fetch → rebase main's new commits onto origin/main (the
//   same as `git pull --rebase`) → push main;
// - a branch (a linked worktree, with main checked out elsewhere or not at all): commit on the
//   branch → fetch → rebase the BRANCH onto origin/main → fast-forward main to the branch
//   (worktree ff-main) → push main. The branch and main then point at the same commit.
// Results: published (the remote has the commit), local_sync_failed (published, but a local check
// after the push failed), not_published (nothing reached the remote; the log gets "push skipped:
// <reason>", committed locally), publish_unknown (git push failed and the remote did not answer the
// check), nothing_to_save (nothing to commit and nothing unpushed).
// A branch layout keeps its own move of main in .tmp/coach/save-state.json until the push is
// confirmed; the next save gives main back first when the remote never got it.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COACH_PATHS, tallyMention, type MentionResult } from "./cli-setup.ts";
import { pushBranch } from "./cli-git.ts";
import { loadConfig } from "./config.ts";
import { CoachError } from "./errors.ts";
import { unattendedMarker } from "./mode.ts";
import { isRunId, localTime, postForSave } from "./today-run.ts";
import { commitPaths } from "./urgent.ts";
import { ffMain, MAIN_BRANCH, worktreeStatus } from "./worktree.ts";
import type { Instant } from "./types.ts";

export type SaveStep = { step: string; ok: boolean; detail?: string };
export type SaveOutcome = "published" | "local_sync_failed" | "not_published" | "publish_unknown" | "nothing_to_save";
export type SaveResult = {
  ok: boolean;
  outcome: SaveOutcome;
  published: boolean;
  layout: "main" | "branch" | null;
  steps: SaveStep[];
  log: { file: string | null; appended: boolean; reason?: string };
  mention?: MentionResult | { mention: false; reason: string };
  commit?: string;
  reason?: string;
};

export type SaveInput = { run_id: string; message: string; noChange?: string; lines?: string[]; part?: string; now?: Instant; sessions?: number; session_id?: string | null };

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function tryGit(root: string, args: string[]): string | null {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}
const errText = (e: unknown) => {
  const x = e as { stderr?: string; message?: string };
  return String(x.stderr || x.message || e).trim().split("\n").slice(-2).join(" | ");
};

/** The `--input` file of save: `{lines: [...]}`, the log lines exactly as the skill writes them. */
export function parseSaveInput(raw: unknown): string[] {
  const shape = 'expected {"lines": ["- proposal for the next live session: <the change>", ...]} (a whole entry may start with a "## " heading line)';
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CoachError("INPUT_ERROR", `save --input: ${shape}`);
  const lines = (raw as { lines?: unknown }).lines;
  if (!Array.isArray(lines) || lines.length === 0 || !lines.every((l) => typeof l === "string" && l.trim() !== "" && !l.includes("\n"))) throw new CoachError("INPUT_ERROR", `save --input: ${shape}`);
  if (lines.some((l) => /^- run: /.test(l))) throw new CoachError("INPUT_ERROR", "save --input: the - run: line is save's own");
  return lines as string[];
}

/** The run's local date, from its id (r-YYYYMMDD-HHMM-xxxx). */
export function runDate(run_id: string): string {
  const d = /^r-(\d{4})(\d{2})(\d{2})-/.exec(run_id);
  if (!d) throw new CoachError("USAGE", `not a run id: ${run_id}`);
  return `${d[1]}-${d[2]}-${d[3]}`;
}

/** A save's own move of main, kept until the push is confirmed (.tmp/coach/save-state.json). */
export const SAVE_STATE_RELATIVE = ".tmp/coach/save-state.json";
type SaveState = { run_id: string; main_before: string | null; main_after: string | null; at: string };

function writeState(root: string, st: SaveState): void {
  const p = join(root, SAVE_STATE_RELATIVE);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(st, null, 2) + "\n");
}
function readState(root: string): SaveState | null {
  try {
    return JSON.parse(readFileSync(join(root, SAVE_STATE_RELATIVE), "utf8")) as SaveState;
  } catch {
    return null;
  }
}
function clearState(root: string): void {
  rmSync(join(root, SAVE_STATE_RELATIVE), { force: true });
}

/**
 * Gives main back when an earlier save moved it and the remote does not have that commit (a failed
 * push, or a crash before it). Only a move this repo's saves made, and only while main is still
 * where that save left it; anything else is left alone. Null when there is nothing to recover.
 */
function recoverMain(root: string): SaveStep | null {
  const st = readState(root);
  if (!st || !st.main_after) return null;
  const main = tryGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${MAIN_BRANCH}`]);
  const published = tryGit(root, ["merge-base", "--is-ancestor", st.main_after, "refs/remotes/origin/main"]) !== null;
  if (published || main !== st.main_after || !st.main_before) {
    clearState(root);
    return null;
  }
  const status = worktreeStatus(root);
  try {
    if (status.main_checked_out_at) {
      if (tryGit(status.main_checked_out_at, ["status", "--porcelain", "--untracked-files=no"]) !== "") return { step: "recover main", ok: false, detail: `${status.main_checked_out_at} has uncommitted changes` };
      git(status.main_checked_out_at, ["reset", "--quiet", "--keep", st.main_before]);
    } else git(root, ["update-ref", `refs/heads/${MAIN_BRANCH}`, st.main_before, st.main_after]);
  } catch (e) {
    return { step: "recover main", ok: false, detail: errText(e) };
  }
  clearState(root);
  return { step: "recover main", ok: true, detail: `main back to ${st.main_before.slice(0, 7)} (an earlier save moved it and did not publish it)` };
}

/** The trigger line of a log entry, as the today skill writes it. */
function trigger(): string {
  const m = unattendedMarker(process.env);
  return m === "CLAUDE_CODE_REMOTE" ? "daily run (cloud)" : m ? "daily run (mac)" : "user";
}

export async function save(root: string, o: SaveInput): Promise<SaveResult> {
  if (!isRunId(o.run_id)) throw new CoachError("USAGE", `save --run needs the run id from today-brief --stage pre (r-YYYYMMDD-HHMM-xxxx), got ${JSON.stringify(o.run_id)}`);
  if (!o.message.trim()) throw new CoachError("USAGE", "save needs --message <text>");
  const cfgPath = join(root, "coach.yaml");
  if (!existsSync(cfgPath)) throw new CoachError("MISSING_FILE", "coach.yaml is missing: run the setup skill first");
  const cfg = loadConfig(cfgPath);
  const tz = cfg.athlete.timezone;
  const now = o.now ?? new Date().toISOString();
  const session_id = o.session_id === undefined ? process.env.CLAUDE_CODE_SESSION_ID || null : o.session_id;
  const steps: SaveStep[] = [];
  const res = (outcome: SaveOutcome, extra: Partial<SaveResult> = {}): SaveResult => ({
    ok: outcome !== "not_published" && outcome !== "publish_unknown",
    outcome,
    published: outcome === "published" || outcome === "local_sync_failed",
    layout: null,
    steps,
    log,
    ...(mention ? { mention } : {}),
    ...extra,
  });

  // ---- the log entry (once per run) ----
  // The run's own date names the log month and the entry, so a retry after midnight (or at a
  // month's end) finds the entry it already wrote (V7 review finding 9).
  const entry: string[] = [];
  const date = runDate(o.run_id);
  // V7b finding 8: a part (`--part safety-<region>-<event>`) is its own entry with its own marker, saved when that
  // work finishes; the run's final save is not blocked by it, and an early exit does not lose it.
  // V7c: one marker per event, for example safety-left-knee-2026-10-14T06:41:00-07:00, so a second
  // region in the same run is its own entry.
  if (o.part !== undefined && !/^[a-z][A-Za-z0-9:._+-]{0,100}$/.test(o.part)) throw new CoachError("USAGE", `save --part must be a name with no spaces (for example safety-<region>-<checkin_at>), got ${JSON.stringify(o.part)}`);
  if (o.part !== undefined && o.noChange !== undefined) throw new CoachError("USAGE", "save --part takes --input lines, not --no-change");
  const logFile = join(root, "athlete/log", `${date.slice(0, 7)}.md`);
  const runLine = o.part ? `- run: ${o.run_id} ${o.part}` : `- run: ${o.run_id}`;
  // V7b finding 10: an entry already in the log is not built again: a retry (the next day, too)
  // only publishes it, so its post result is not needed.
  const logged = existsSync(logFile) && readFileSync(logFile, "utf8").split("\n").includes(runLine);
  if (o.noChange !== undefined && !logged) {
    const post = postForSave(root, o.run_id, { now, timezone: tz, session_id });
    if (!post.log) throw new CoachError("POST_STALE", "the post result has no readiness line: pass the entry with --input");
    entry.push(
      `## ${date} ${localTime(now, tz)} · no-change`,
      `- trigger: ${trigger()}`,
      `- readiness: ${post.log.readiness_line}`,
      `- rules: ${post.log.rule_ids.length > 0 ? post.log.rule_ids.join(", ") : "none"}`,
      `- change: none (${o.noChange})`,
    );
  }
  if (o.lines && o.lines.length > 0) {
    if (entry.length === 0 && !o.lines[0].startsWith("## ")) entry.push(`## ${date} ${localTime(now, tz)} · today`);
    entry.push(...o.lines);
  }
  const log: SaveResult["log"] = { file: entry.length > 0 || logged ? logFile.slice(root.length + 1) : null, appended: false };
  if (logged) {
    log.reason = "this run's entry is already in the log";
    steps.push({ step: "log", ok: true, detail: log.reason });
  } else if (entry.length > 0) {
    const text = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    mkdirSync(dirname(logFile), { recursive: true });
    const head = text === "" ? `# Operation log ${date.slice(0, 7)}\n\n` : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    appendFileSync(logFile, head + [...entry, runLine].join("\n") + "\n");
    log.appended = true;
    steps.push({ step: "log", ok: true, detail: "appended" });
  }

  // ---- tally-mention (logger files or other, live only), before the commit ----
  let mention: SaveResult["mention"];
  if ((cfg.logger === "files" || cfg.logger === "other") && !unattendedMarker(process.env)) {
    if (cfg.logger === "other" && o.sessions === undefined) mention = { mention: false, reason: "logger other: pass --sessions <n> for the Tally mention" };
    else {
      try {
        mention = await tallyMention(root, o.sessions);
      } catch (e) {
        mention = { mention: false, reason: errText(e) };
      }
    }
    steps.push({ step: "tally-mention", ok: true, detail: mention.mention ? "mention" : (mention.reason ?? "no mention") });
  }

  // ---- git ----
  const st = worktreeStatus(root);
  const stop = (reason: string, layout: SaveResult["layout"]) => {
    // Nothing reached the remote: say so in the log entry and commit it locally.
    const line = `- push skipped: ${reason}`;
    if (log.file && existsSync(logFile)) {
      // Whole lines only: "- run: <id>" is a prefix of a part's "- run: <id> safety".
      const lines = readFileSync(logFile, "utf8").split("\n");
      const at = lines.lastIndexOf(runLine);
      if (at >= 0 && !lines.slice(at).includes(line)) {
        appendFileSync(logFile, line + "\n");
        const c = commitPaths(root, ["athlete"], `today ${date}: push skipped`);
        steps.push({ step: "log push skipped", ok: c.committed || c.reason === "nothing to commit", ...(c.reason ? { detail: c.reason } : {}) });
      }
    }
    return res("not_published", { layout, reason });
  };
  if (!st.git) return stop("not a git repository", null);
  if (!st.branch) return stop("this checkout has no branch (detached HEAD)", null);
  const layout: SaveResult["layout"] = st.branch === MAIN_BRANCH ? "main" : "branch";
  const c = commitPaths(root, [...COACH_PATHS], o.message);
  if (!c.committed && c.reason !== "nothing to commit") {
    steps.push({ step: "commit", ok: false, detail: c.reason });
    return res("not_published", { layout, reason: `the commit failed: ${c.reason}` });
  }
  steps.push({ step: "commit", ok: true, detail: c.committed ? "committed" : "nothing to commit" });
  if (tryGit(root, ["remote", "get-url", "origin"]) === null) return stop("no remote origin", layout);
  const head = () => tryGit(root, ["rev-parse", "HEAD"]);
  const ref = (r: string) => tryGit(root, ["rev-parse", "--verify", "--quiet", r]);
  // Nothing new: nothing committed, and this branch, main and the remote's main (as last fetched) agree.
  if (!c.committed && ref("refs/remotes/origin/main") !== null && head() === ref("refs/remotes/origin/main") && ref(`refs/heads/${MAIN_BRANCH}`) === head()) {
    return res("nothing_to_save", { layout, reason: "nothing to commit and nothing unpushed" });
  }
  try {
    git(root, ["fetch", "--quiet", "origin"]);
    steps.push({ step: "fetch", ok: true });
  } catch (e) {
    steps.push({ step: "fetch", ok: false, detail: errText(e) });
    return stop(`git fetch origin failed: ${errText(e)}`, layout);
  }
  // A branch layout: an earlier save that moved main and did not publish it gives main back first
  // (V7 review finding 6), or the rebase below would leave main on a commit the branch no longer has.
  if (layout === "branch") {
    const r = recoverMain(root);
    if (r) {
      steps.push(r);
      if (!r.ok) return stop(`main could not be given back after an earlier save: ${r.detail}`, layout);
    }
  }
  // Bring this branch (main itself in the main layout, as git pull --rebase does) onto origin/main.
  const remoteMain = ref("refs/remotes/origin/main");
  if (remoteMain !== null && tryGit(root, ["merge-base", "--is-ancestor", "refs/remotes/origin/main", "HEAD"]) === null) {
    try {
      git(root, ["rebase", "--quiet", "refs/remotes/origin/main"]);
      steps.push({ step: "rebase onto origin/main", ok: true });
    } catch (e) {
      const why = errText(e);
      tryGit(root, ["rebase", "--abort"]);
      steps.push({ step: "rebase onto origin/main", ok: false, detail: why });
      return stop(`the rebase onto origin/main stopped (${why}); it was aborted`, layout);
    }
  }
  if (layout === "branch") {
    const mainBefore = ref(`refs/heads/${MAIN_BRANCH}`);
    const branchHead = head();
    // Record the move before it happens: a failed push or a crash before it can then be undone.
    if (mainBefore !== branchHead) writeState(root, { run_id: o.run_id, main_before: mainBefore, main_after: branchHead, at: now });
    const ff = ffMain(root);
    steps.push({ step: "fast-forward main", ok: ff.ok, ...(ff.reason || ff.skipped ? { detail: ff.reason ?? ff.skipped } : {}) });
    if (!ff.ok) return stop(`main was not fast-forwarded: ${ff.reason}`, layout);
  }
  const pushed = head();
  if (remoteMain !== null && pushed === remoteMain && ref(`refs/heads/${MAIN_BRANCH}`) === pushed) return res("nothing_to_save", { layout, reason: "nothing to commit and nothing unpushed" });
  const p = pushBranch(root, MAIN_BRANCH);
  steps.push({ step: "push main", ok: p.ok, ...(p.reason ? { detail: p.reason } : {}) });
  if (!p.ok) {
    // Refused before git push ran (the hooks, the privacy check, the push URLs): nothing was sent.
    if (!/^git push /.test(p.reason ?? "")) return stop(p.reason ?? "the push was refused", layout);
    // git push failed: one push URL may have taken it, or the answer was lost. Ask the remote (V7 review finding 8).
    const remote = tryGit(root, ["ls-remote", "--quiet", "origin", `refs/heads/${MAIN_BRANCH}`]);
    const sha = remote === null ? null : (remote.split(/\s+/)[0] ?? "");
    steps.push({ step: "check the remote", ok: remote !== null, detail: remote === null ? "the remote did not answer" : `origin main is ${sha || "missing"}` });
    if (remote === null) return res("publish_unknown", { layout, reason: `${p.reason}; the remote did not answer, so it is unknown whether the commit reached it: run save again` });
    // V7b finding 11: the remote may have moved on after taking the commit (another push URL took
    // it, then a cloud run pushed): published when the commit is in the remote's history.
    if (sha !== pushed) {
      if (tryGit(root, ["fetch", "--quiet", "origin"]) === null) return res("publish_unknown", { layout, reason: `${p.reason}; the remote's main could not be fetched, so it is unknown whether it has the commit: run save again` });
      const contains = pushed !== null && tryGit(root, ["merge-base", "--is-ancestor", pushed, "refs/remotes/origin/main"]) !== null;
      steps.push({ step: "check the remote's history", ok: contains, detail: contains ? "origin main contains the commit" : "origin main does not contain the commit" });
      if (!contains) return stop(p.reason ?? "the push failed", layout);
    } else tryGit(root, ["fetch", "--quiet", "origin"]);
  }
  clearState(root);
  // After the push: main, this branch and the remote's main must be the commit that was pushed.
  const after = { main: ref(`refs/heads/${MAIN_BRANCH}`), branch: head(), remote: ref("refs/remotes/origin/main") };
  const remoteHas = after.remote === pushed || (pushed !== null && after.remote !== null && tryGit(root, ["merge-base", "--is-ancestor", pushed, after.remote]) !== null);
  const inSync = after.main === pushed && after.branch === pushed && remoteHas;
  steps.push({ step: "check after push", ok: inSync, ...(inSync ? {} : { detail: `main ${after.main}, this branch ${after.branch}, origin/main ${after.remote}` }) });
  return res(inSync ? "published" : "local_sync_failed", { layout, commit: pushed ?? undefined, ...(inSync ? {} : { reason: "published, but the local branches do not match the pushed commit" }) });
}

/** save --run <run_id> --message <text> [--no-change <reason>] [--input <file>] [--sessions <n>] [--now <instant>] [--root <dir>] */
export async function cmdSave(argv: string[]): Promise<number> {
  const { parseArgs } = await import("node:util");
  const { resolve } = await import("node:path");
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: { root: { type: "string" }, run: { type: "string" }, message: { type: "string" }, "no-change": { type: "string" }, input: { type: "string" }, part: { type: "string" }, sessions: { type: "string" }, now: { type: "string" }, session: { type: "string" } },
  });
  const usage = "usage: save --run <run_id> --message <text> [--no-change <reason>] [--input <{lines}.json>] [--part safety] [--sessions <n>]";
  if (!values.run || values.message === undefined) throw new CoachError("USAGE", usage);
  let lines: string[] | undefined;
  if (values.input) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(values.input, "utf8"));
    } catch (e) {
      throw new CoachError("INPUT_ERROR", `cannot read ${values.input}: ${(e as Error).message}`);
    }
    lines = parseSaveInput(raw);
  }
  const sessions = values.sessions !== undefined ? Number(values.sessions) : undefined;
  const r = await save(resolve(values.root ?? "."), {
    run_id: values.run,
    message: values.message,
    ...(values["no-change"] !== undefined ? { noChange: values["no-change"] } : {}),
    ...(lines ? { lines } : {}),
    ...(values.part ? { part: values.part } : {}),
    ...(values.now ? { now: values.now } : {}),
    ...(sessions !== undefined ? { sessions } : {}),
    ...(values.session ? { session_id: values.session } : {}),
  });
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  return r.ok ? 0 : 1;
}
