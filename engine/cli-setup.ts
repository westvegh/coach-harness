// CLI commands for setup v2 and the files logger's housekeeping (v0.2; contracts §22a).
// engine/cli.ts dispatches here. Output is JSON on stdout; a nonzero exit is an error or
// "do not go on". `setup-check`, `init-athlete`, `allow-server` and `worktree` load built-ins
// only, so they run before `npm ci`.
//
//   setup-check                                  the silent checks: mode, versions, npm ci, timezone, name, worktree
//   init-athlete                                 copy the starting athlete files (never overwrites)
//   allow-server --server <name>                 add mcp__<name> to .claude/settings.local.json permissions.allow
//   worktree status | ff-main | ff-branch        a copy in a git worktree (fast-forward only)
//   worktree main-checkout | remove-temp         the folder where main is checked out (a temporary one when none is)
//   commit --message <text>                      commit the coach's own paths (athlete/, plans/, coach.yaml) only
//   tally-mention [--sessions <n>]               mention Tally once, after the third session logged by hand
//   logger set tally|files|other                 where plans live (the fallback to files, "move my plans to Tally")
//   history-files                                the two newest .csv files in ~/Downloads and ~/Desktop (a training export)
//
// Every command takes --root <dir> (default: the current directory).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CoachError } from "./errors.ts";
import { mode } from "./mode.ts";
import { ffBranch, ffMain, mainCheckout, removeTempCheckout, worktreeStatus } from "./worktree.ts";

export const SETUP_COMMANDS = ["setup-check", "init-athlete", "allow-server", "worktree", "commit", "tally-mention", "logger", "history-files"] as const;

/** The versions the coach needs: the urgent gate fails closed only from this Claude Code release. */
export const MIN_CLAUDE = "2.1.295";
export const MIN_NODE = "22.18.0";

/** The athlete files setup starts from (templates/athlete/). */
export const ATHLETE_TEMPLATES = ["brief.md", "limits.yaml", "baselines.json", "block.yaml"] as const;

/** The only paths `commit` (and the Stop hook) ever commits. */
export const COACH_PATHS = ["athlete", "plans", "coach.yaml"] as const;

/** The one Tally line for an athlete who logs by hand (v0.2 "Tally mention"). Said once, never repeated. */
export const TALLY_MENTION_TEXT = "If logging by hand gets old: Tally logs sets on your phone at the gym, and I read them back. Say 'switch to Tally' to try it.";
export const TALLY_MENTION_AFTER = 3;

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function args(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: "string" },
      server: { type: "string" },
      message: { type: "string" },
      sessions: { type: "string" },
    },
  });
}

/** -1, 0 or 1; missing parts count as 0 ("22.18" equals "22.18.0"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function firstLine(cmd: string, argv: string[], cwd: string): string | null {
  try {
    return execFileSync(cmd, argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

// ---------- setup-check ----------

export type SetupCheck = {
  mode: "interactive" | "unattended";
  node: { version: string; need: string; ok: boolean };
  /** version null: `claude --version` did not answer (not on PATH); ok is then null (unknown, go on). */
  claude: { version: string | null; need: string; ok: boolean | null };
  npm_ci_needed: boolean;
  timezone: string;
  /** The first word of `git config user.name`, for coach.yaml athlete.name (no typed answer). */
  name: string | null;
  coach_yaml: boolean;
  /** The last state line of athlete/log/setup.md: where a stopped setup resumes. */
  setup_progress: string | null;
  worktree: ReturnType<typeof worktreeStatus>;
  /** Problems that stop setup until they are fixed. */
  problems: string[];
};

export function setupCheck(root: string, env: NodeJS.ProcessEnv = process.env): SetupCheck {
  const node = process.versions.node;
  const claudeLine = firstLine("claude", ["--version"], root);
  const claude = claudeLine ? (/(\d+\.\d+\.\d+)/.exec(claudeLine)?.[1] ?? null) : null;
  const problems: string[] = [];
  const m = mode(env);
  if (m === "unattended") problems.push("setup needs an interactive session");
  const nodeOk = compareVersions(node, MIN_NODE) >= 0;
  if (!nodeOk) problems.push(`Node ${node} is too old: install Node ${MIN_NODE} or later (nodejs.org), then start again`);
  const claudeOk = claude === null ? null : compareVersions(claude, MIN_CLAUDE) >= 0;
  if (claudeOk === false) problems.push(`Claude Code ${claude} is too old: run "claude update" (needs ${MIN_CLAUDE} or later), then start again`);
  const log = join(root, "athlete/log/setup.md");
  const progress = existsSync(log)
    ? (readFileSync(log, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^setup: (step \S+|[a-z0-9]+) (done|stopped)\b/.test(l))
        .pop() ?? null)
    : null;
  const gitName = firstLine("git", ["config", "user.name"], root);
  return {
    mode: m,
    node: { version: node, need: MIN_NODE, ok: nodeOk },
    claude: { version: claude, need: MIN_CLAUDE, ok: claudeOk },
    npm_ci_needed: !existsSync(join(root, "node_modules/yaml")),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    name: gitName ? (gitName.split(/\s+/)[0] ?? null) : null,
    coach_yaml: existsSync(join(root, "coach.yaml")),
    setup_progress: progress,
    worktree: worktreeStatus(root),
    problems,
  };
}

// ---------- init-athlete ----------

export function initAthlete(root: string): { created: string[]; kept: string[] } {
  const created: string[] = [];
  const kept: string[] = [];
  mkdirSync(join(root, "athlete/log"), { recursive: true });
  for (const f of ATHLETE_TEMPLATES) {
    const to = join(root, "athlete", f);
    if (existsSync(to)) {
      kept.push(`athlete/${f}`);
      continue;
    }
    const from = join(root, "templates/athlete", f);
    if (!existsSync(from)) throw new CoachError("MISSING_FILE", `templates/athlete/${f} is missing`);
    copyFileSync(from, to);
    created.push(`athlete/${f}`);
  }
  return { created, kept };
}

// ---------- allow-server ----------

const SERVER_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Adds `mcp__<server>` to `permissions.allow` in `.claude/settings.local.json` (a user file the
 * update never touches), keeping everything else there. The Tally server's name varies by how
 * it was connected, so setup writes the rule for the server it found.
 */
export function allowServer(root: string, server: string | undefined): { file: string; rule: string; added: boolean } {
  if (!server || !SERVER_RE.test(server)) throw new CoachError("USAGE", "allow-server needs --server <name> (letters, digits, _ and -; the part between mcp__ and the tool name)");
  const rule = `mcp__${server}`;
  const file = join(root, ".claude/settings.local.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    if (text.trim() !== "") {
      try {
        settings = JSON.parse(text) as Record<string, unknown>;
      } catch (e) {
        throw new CoachError("SETTINGS_INVALID", `.claude/settings.local.json does not parse (${(e as Error).message}); fix it by hand, then run allow-server again`);
      }
      if (typeof settings !== "object" || settings === null || Array.isArray(settings)) throw new CoachError("SETTINGS_INVALID", ".claude/settings.local.json must hold a JSON object");
    }
  }
  const perms = (settings.permissions ?? {}) as Record<string, unknown>;
  if (typeof perms !== "object" || perms === null || Array.isArray(perms)) throw new CoachError("SETTINGS_INVALID", ".claude/settings.local.json permissions must be an object");
  const allow = perms.allow ?? [];
  if (!Array.isArray(allow)) throw new CoachError("SETTINGS_INVALID", ".claude/settings.local.json permissions.allow must be a list");
  if (allow.includes(rule)) return { file: ".claude/settings.local.json", rule, added: false };
  settings.permissions = { ...perms, allow: [...allow, rule] };
  mkdirSync(join(root, ".claude"), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, file);
  return { file: ".claude/settings.local.json", rule, added: true };
}

// ---------- tally-mention ----------

export type MentionResult = { mention: boolean; text?: string; logger: string; logged_sessions: number | null; reason?: string };

/**
 * With `logger: files` or `other`, once, after the third session the athlete logged by hand or
 * in chat: returns the Tally line and records `tally_mentioned: true` in coach.yaml first, so a
 * second call (or a crash after it) never repeats it. `files` counts the logged dates in plans/;
 * `other` takes the count the coach read from the athlete's tool (--sessions).
 */
export async function tallyMention(root: string, sessions?: number): Promise<MentionResult> {
  const path = join(root, "coach.yaml");
  if (!existsSync(path)) throw new CoachError("MISSING_FILE", "coach.yaml is missing: run the setup skill first");
  const [{ loadConfig }, { parseDocument }] = await Promise.all([import("./config.ts"), import("yaml")]);
  const cfg = loadConfig(path);
  if (cfg.logger === "tally") return { mention: false, logger: cfg.logger, logged_sessions: null, reason: "the plans are in Tally" };
  if (cfg.tally_mentioned) return { mention: false, logger: cfg.logger, logged_sessions: null, reason: "already mentioned once" };
  let count: number;
  if (cfg.logger === "files") count = (await import("./plans-files.ts")).loggedDates(root).length;
  else {
    if (sessions === undefined || !Number.isInteger(sessions) || sessions < 0) throw new CoachError("USAGE", "with logger: other, tally-mention needs --sessions <n> (the sessions logged in the athlete's tool)");
    count = sessions;
  }
  if (count < TALLY_MENTION_AFTER) return { mention: false, logger: cfg.logger, logged_sessions: count, reason: `${count} of ${TALLY_MENTION_AFTER} sessions logged` };
  const doc = parseDocument(readFileSync(path, "utf8"));
  doc.set("tally_mentioned", true);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, String(doc));
  renameSync(tmp, path);
  loadConfig(path);
  return { mention: true, text: TALLY_MENTION_TEXT, logger: cfg.logger, logged_sessions: count };
}

// ---------- logger set ----------

/**
 * Sets `coach.yaml logger` (comments kept). The coach runs it when the athlete switches, and
 * when another tool stops answering and the plans fall back to files (V2b fix 4), so the
 * engine reads the files from then on.
 */
export async function setLogger(root: string, value: string | undefined): Promise<{ logger: string; previous: string; changed: boolean }> {
  const path = join(root, "coach.yaml");
  if (!existsSync(path)) throw new CoachError("MISSING_FILE", "coach.yaml is missing: run the setup skill first");
  const [{ loadConfig, LOGGERS }, { parseDocument }] = await Promise.all([import("./config.ts"), import("yaml")]);
  if (!value || !(LOGGERS as readonly string[]).includes(value)) throw new CoachError("USAGE", `usage: logger set ${LOGGERS.join("|")}`);
  const previous = loadConfig(path).logger;
  if (previous === value) return { logger: value, previous, changed: false };
  const doc = parseDocument(readFileSync(path, "utf8"));
  doc.set("logger", value);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, String(doc));
  renameSync(tmp, path);
  loadConfig(path);
  return { logger: value, previous, changed: true };
}

// ---------- history-files ----------

/** The folders setup looks in for a training export, and how many files it offers (V2b fix 5). */
export const HISTORY_FOLDERS = ["Downloads", "Desktop"] as const;
export const HISTORY_OFFERED = 2;

/**
 * The newest `.csv` files directly in ~/Downloads and ~/Desktop (no subfolders), at most two,
 * for setup's history question. Names and times only; the coach reads the chosen file with the
 * Read tool, which the `Read(~/Downloads/*.csv)` and `Read(~/Desktop/*.csv)` allow rules cover.
 * COACH_HISTORY_HOME replaces the home folder (tests and evals: no real file name in a run).
 */
export function historyFiles(home = process.env.COACH_HISTORY_HOME || homedir()): { files: { path: string; name: string; folder: string; modified: string }[] } {
  const found: { path: string; name: string; folder: string; modified: string; ms: number }[] = [];
  for (const folder of HISTORY_FOLDERS) {
    const dir = join(home, folder);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.csv$/i.test(name)) continue;
      try {
        const st = statSync(join(dir, name));
        if (st.isFile()) found.push({ path: join(dir, name), name, folder, modified: st.mtime.toISOString(), ms: st.mtimeMs });
      } catch {
        /* gone or unreadable: skip */
      }
    }
  }
  found.sort((a, b) => b.ms - a.ms);
  return { files: found.slice(0, HISTORY_OFFERED).map(({ ms: _ms, ...f }) => f) };
}

// ---------- dispatch ----------

export async function setupCommand(cmd: string, argv: string[]): Promise<number> {
  const a = args(argv);
  const root = resolve(a.values.root ?? ".");
  switch (cmd) {
    case "setup-check": {
      const r = setupCheck(root);
      out(r);
      return 0;
    }
    case "init-athlete":
      out(initAthlete(root));
      return 0;
    case "allow-server":
      out(allowServer(root, a.values.server));
      return 0;
    case "worktree": {
      const sub = a.positionals[0];
      if (sub === "status") {
        out(worktreeStatus(root));
        return 0;
      }
      if (sub === "main-checkout") {
        const r = mainCheckout(root);
        out(r);
        return r.ok ? 0 : 1;
      }
      if (sub === "remove-temp") {
        const r = removeTempCheckout(root);
        out(r);
        return r.ok ? 0 : 1;
      }
      if (sub === "ff-main" || sub === "ff-branch") {
        const r = sub === "ff-main" ? ffMain(root) : ffBranch(root);
        out(r);
        return r.ok ? 0 : 1;
      }
      throw new CoachError("USAGE", "usage: worktree status | worktree ff-main | worktree ff-branch | worktree main-checkout | worktree remove-temp");
    }
    case "commit": {
      const message = a.values.message?.trim();
      if (!message) throw new CoachError("USAGE", "usage: commit --message <text>  (commits athlete/, plans/ and coach.yaml only)");
      const r = (await import("./urgent.ts")).commitPaths(root, [...COACH_PATHS], message);
      // V2b fix 9: "nothing to commit" is fine; any other failure (not a repository, a hook
      // that refuses, a git error) exits 1, and the skill stops and says so.
      const ok = r.committed || r.reason === "nothing to commit";
      out({ ...r, ok, paths: COACH_PATHS });
      return ok ? 0 : 1;
    }
    case "tally-mention": {
      const n = a.values.sessions !== undefined ? Number(a.values.sessions) : undefined;
      out(await tallyMention(root, n));
      return 0;
    }
    case "history-files":
      out(historyFiles());
      return 0;
    case "logger": {
      if (a.positionals[0] !== "set") throw new CoachError("USAGE", "usage: logger set tally|files|other");
      out(await setLogger(root, a.positionals[1]));
      return 0;
    }
    default:
      throw new CoachError("USAGE", `unknown setup command ${cmd}`);
  }
}
