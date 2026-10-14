// Scheduled runs (contracts §14, §15): the cloud routine body for the RemoteTrigger tool,
// and the Mac launchd plist.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { LOGGER_TOOL_PREFIX_RE } from "./config.ts";
import { WEEKDAYS } from "./dates.ts";
import { CoachError } from "./errors.ts";
import type { CoachConfig, Weekday } from "./types.ts";

export type RoutineKind = "daily" | "weekly";
export type Connector = { uuid: string; name: string; url: string };

/** The only connector a coach routine may carry (contracts §14). */
export const TALLY_CONNECTOR_URL = "https://mcp.tallyworkout.app/api/mcp";

/** The Tally tools (the 11 the cloud connector showed in the spike, #11). */
export const TALLY_TOOLS = [
  "get_training_context",
  "get_workout_history",
  "get_planned_workout",
  "get_exercise_progress",
  "search_exercises",
  "plan_workout_day",
  "plan_workout_range",
  "update_planned_workout",
  "move_planned_workout",
  "skip_planned_workout",
  "delete_planned_workout",
] as const;

/**
 * The tools an unattended run may use (contracts §14, §15). A scheduled run has no one to
 * answer a prompt (`--permission-mode dontAsk`), so this list is what lets it work, not a
 * gate: v0.2 enforces only the urgent stop and privacy in code. Bash for the engine CLI
 * (plans, commits and pushes go through it), `npm ci` (a cloud run starts from a fresh
 * clone), the git subcommands the skills use, `gh api`
 * and the date and mode probes; Edit and Write for the athlete log and the engine inputs. A
 * change for the next live session is a log line, so there is no proposals folder.
 */
export const UNATTENDED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash(node engine/cli.ts:*)",
  "Bash(npm ci)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(git pull:*)",
  "Bash(git switch:*)",
  "Bash(gh api:*)",
  "Bash(date:*)",
  "Bash(printenv CLAUDE_CODE_REMOTE)",
  "Edit(athlete/log/**)",
  "Write(athlete/log/**)",
  "Edit(.tmp/coach/**)",
  "Write(.tmp/coach/**)",
] as const;
/** The connector's tool prefix in the local CLI (spike #10). */
export const LOCAL_TALLY_PREFIX = "mcp__claude_ai_Tally_Workout__";

// ---------- the logger's tool names (launch review finding 7) ----------

/**
 * The tool-name prefix Claude Code gives an MCP server: mcp__<name>__, where every
 * character outside letters, digits, _ and - becomes _ ("claude.ai Tally Workout" →
 * mcp__claude_ai_Tally_Workout__, "tally" → mcp__tally__).
 */
export function toolPrefixFromServer(name: string): string {
  return `mcp__${name.trim().replace(/[^A-Za-z0-9_-]/g, "_")}__`;
}

/** Throws BAD_TOOL_PREFIX unless `p` is a Tally tool prefix (mcp__tally__, mcp__Tally_Workout__, …). */
export function checkToolPrefix(p: string): string {
  if (typeof p !== "string" || !LOGGER_TOOL_PREFIX_RE.test(p)) throw new CoachError("BAD_TOOL_PREFIX", `not a Tally tool prefix: ${JSON.stringify(p)} (for example mcp__tally__ or mcp__claude_ai_Tally_Workout__)`);
  return p;
}

/** The prefixes of the connected Tally servers in `claude mcp list` output ("<name>: <url or command> - ✓ Connected"). */
export function discoverToolPrefixes(mcpList: string): string[] {
  const out: string[] = [];
  for (const line of mcpList.split("\n")) {
    const m = /^(.+?): .*\s-\s✓ Connected\s*$/.exec(line.trim());
    if (!m) continue;
    const p = toolPrefixFromServer(m[1]);
    if (LOGGER_TOOL_PREFIX_RE.test(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The environment of a scheduled Mac run: no API key (connectors need the claude.ai login), unattended. */
function scheduledEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...env, COACH_UNATTENDED: "1" };
  delete e.ANTHROPIC_API_KEY;
  delete e.ANTHROPIC_AUTH_TOKEN;
  return e;
}

/**
 * The logger tool prefixes for the Mac allowlist: --tool-prefix, else coach.yaml
 * automation.tool_prefix (setup records the prefix of the tool it called), else the
 * connected Tally servers that `claude mcp list` shows. NO_LOGGER_TOOLS when none is found.
 */
export function resolveToolPrefixes(opts: { flag?: string; config?: string; claude: string; cwd: string; env?: NodeJS.ProcessEnv }): { prefixes: string[]; source: "flag" | "coach.yaml" | "claude mcp list" } {
  if (opts.flag) return { prefixes: opts.flag.split(",").map((p) => checkToolPrefix(p.trim())), source: "flag" };
  if (opts.config) return { prefixes: [checkToolPrefix(opts.config)], source: "coach.yaml" };
  const r = spawnSync(opts.claude, ["mcp", "list"], { cwd: opts.cwd, encoding: "utf8", env: scheduledEnv(opts.env ?? process.env), timeout: 60_000 });
  const prefixes = discoverToolPrefixes(`${r.stdout ?? ""}`);
  if (prefixes.length === 0) {
    throw new CoachError("NO_LOGGER_TOOLS", "no connected Tally server in `claude mcp list`: connect Tally, or pass --tool-prefix (for example mcp__tally__)");
  }
  return { prefixes, source: "claude mcp list" };
}

export type ProbeResult = { ok: boolean; tool: string | null; reason: string };

/** The probe's prompt: one read-only call, with no other tool. */
export function probePrompt(prefixes: string[]): string {
  return `Call ${prefixes[0]}get_training_context once with historyWeeks 1. Use no other tool. Then reply with the single word OK.`;
}

/**
 * The test run before Mac automation is enabled (launch review finding 7): `claude -p` in the scheduled
 * environment (no API key, COACH_UNATTENDED=1, dontAsk), allowed only get_training_context
 * under each prefix. ok when one of those calls ran and returned without an error.
 */
export function probeLoggerTools(claude: string, prefixes: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): ProbeResult {
  const allowed = prefixes.map((p) => `${checkToolPrefix(p)}get_training_context`);
  const r = spawnSync(claude, ["-p", probePrompt(prefixes), "--permission-mode", "dontAsk", "--output-format", "stream-json", "--verbose", "--allowedTools", ...allowed], {
    cwd,
    encoding: "utf8",
    env: scheduledEnv(env),
    timeout: 300_000,
  });
  if (r.error) return { ok: false, tool: null, reason: `claude did not run: ${r.error.message}` };
  const calls = new Map<string, string>();
  const results = new Map<string, boolean>();
  for (const line of `${r.stdout ?? ""}`.split("\n")) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    for (const c of Array.isArray(ev?.message?.content) ? ev.message.content : []) {
      if (c?.type === "tool_use" && typeof c.id === "string" && typeof c.name === "string") calls.set(c.id, c.name);
      if (c?.type === "tool_result" && typeof c.tool_use_id === "string") results.set(c.tool_use_id, c.is_error === true);
    }
  }
  for (const [id, name] of calls) if (allowed.includes(name) && results.get(id) === false) return { ok: true, tool: name, reason: `${name} answered in the scheduled environment` };
  const tried = [...calls.values()].filter((n) => allowed.includes(n));
  return { ok: false, tool: tried[0] ?? null, reason: tried.length > 0 ? `${tried[0]} returned an error` : `no call to ${allowed.join(" or ")} ran (exit ${r.status}); check that Tally is connected for claude -p` };
}

const SKILL: Record<RoutineKind, string> = { daily: "today", weekly: "week" };

export function routinePrompt(kind: RoutineKind, where: "cloud" | "mac"): string {
  if (kind !== "daily" && kind !== "weekly") throw new CoachError("USAGE", `kind must be daily or weekly, got ${JSON.stringify(kind)}`);
  // V7: the daily run starts with today-brief --stage pre, which runs window-check first (exit 4
  // outside the window); the skill then goes on from pre's output. save commits, syncs and pushes.
  if (kind === "daily") {
    return [
      "First run: node engine/cli.ts today-brief --stage pre (if node_modules is missing, run npm ci first). If it exits with a nonzero code, stop and do nothing else.",
      "Otherwise read .claude/skills/today/SKILL.md and follow it exactly. Unattended run. Step 1's pre has run: use its output and do not run it again.",
      where === "cloud" ? "This is a scheduled cloud routine." : "This is a scheduled run on the Mac.",
      "If node_modules is missing, run npm ci first.",
      "Push only with node engine/cli.ts push: it installs the git hooks, checks that the repository is private, and then pushes. If it exits nonzero, nothing was pushed; log the reason and stop.",
      "Commit to the main branch with the skill's save step (node engine/cli.ts save): it runs git pull --rebase before it pushes through node engine/cli.ts push.",
    ].join(" ");
  }
  return [
    `First run: node engine/cli.ts window-check --kind ${kind}. If it exits with a nonzero code, stop and do nothing else.`,
    `Otherwise read .claude/skills/${SKILL[kind]}/SKILL.md and follow it exactly. Unattended run.`,
    where === "cloud" ? "This is a scheduled cloud routine." : "This is a scheduled run on the Mac.",
    "If node_modules is missing, run npm ci first.",
    "Push only with node engine/cli.ts push: it installs the git hooks, checks that the repository is private, and then pushes. If it exits nonzero, nothing was pushed; log the reason and stop.",
    "Commit to the main branch: run git pull --rebase before you push.",
  ].join(" ");
}

// ---------- cron (UTC) ----------

function hm(time: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new CoachError("BAD_TIME", `time must be HH:MM: ${JSON.stringify(time)}`);
  return +m[1] * 60 + +m[2];
}

/** The UTC offset of `tz` at an instant, in minutes (Los Angeles in July: −420). */
export function utcOffsetMinutes(tz: string, epochMs: number): number {
  let name: string | undefined;
  try {
    name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(epochMs)).find((p) => p.type === "timeZoneName")?.value;
  } catch {
    throw new CoachError("BAD_TIMEZONE", `unknown IANA timezone: ${tz}`);
  }
  if (!name || name === "GMT") return 0;
  const m = /^GMT([+-])(\d{2}):?(\d{2})?$/.exec(name);
  if (!m) throw new CoachError("BAD_TIMEZONE", `cannot read the offset of ${tz}: ${name}`);
  return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +(m[3] ?? 0));
}

/** The distinct offsets `tz` uses in the year of `now` (one, or two with DST). */
export function yearOffsets(tz: string, now: number): number[] {
  const y = new Date(now).getUTCFullYear();
  const offs = [0, 3, 6, 9].map((mo) => utcOffsetMinutes(tz, Date.UTC(y, mo, 15, 12)));
  return [...new Set(offs)].sort((a, b) => a - b);
}

/** "5,6,7,9" → "5-7,9". */
function hourField(hours: number[]): string {
  const hs = [...new Set(hours)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < hs.length; ) {
    let j = i;
    while (j + 1 < hs.length && hs[j + 1] === hs[j] + 1) j++;
    parts.push(j === i ? `${hs[i]}` : `${hs[i]}-${hs[j]}`);
    i = j + 1;
  }
  return parts.join(",");
}

export type CronResult = { cron: string; offsets_min: number[]; note: string };

/**
 * The daily cron: one run an hour, at the start minute, from daily_window.start to .end in
 * the athlete's timezone, as UTC. Cron in the routines API is UTC and does not follow DST,
 * so the hours cover the window under every offset the timezone uses this year (for a US
 * zone that is one extra hourly run). window-check refuses the run outside the local
 * window. The interval is never under 1 hour (one minute value).
 */
export function dailyCron(cfg: CoachConfig, now = Date.now()): CronResult {
  const tz = cfg.athlete.timezone;
  const start = hm(cfg.automation.daily_window.start);
  const end = hm(cfg.automation.daily_window.end);
  if (start >= end) throw new CoachError("BAD_TIME", "daily_window.start must be before end");
  const offsets = yearOffsets(tz, now);
  const minutes = new Set<number>();
  const hours: number[] = [];
  for (const off of offsets) {
    for (let t = start; t <= end; t += 60) {
      const utc = (((t - off) % 1440) + 1440) % 1440;
      minutes.add(utc % 60);
      hours.push(Math.floor(utc / 60));
    }
  }
  if (minutes.size !== 1) throw new CoachError("BAD_TIMEZONE", `${tz} changes its offset by a part of an hour; set the cron by hand`);
  const [minute] = [...minutes];
  return {
    cron: `${minute} ${hourField(hours)} * * *`,
    offsets_min: offsets,
    note: offsets.length > 1 ? `hours cover ${cfg.automation.daily_window.start}-${cfg.automation.daily_window.end} ${tz} in both standard and daylight time` : `no DST in ${tz}`,
  };
}

/**
 * The weekly cron: weekly.day at weekly.time in the athlete's timezone, as UTC, under every
 * offset the timezone uses this year. For Los Angeles, Sunday 17:07 is Monday
 * 00:07 UTC in daylight time and Monday 01:07 UTC in standard time, so the cron is
 * `7 0,1 * * 1`. It fires twice a week; window-check admits only the run at the local time.
 * No update is needed at a DST change.
 */
export function weeklyCron(cfg: CoachConfig, now = Date.now()): CronResult {
  const tz = cfg.athlete.timezone;
  const day = WEEKDAYS.indexOf(cfg.automation.weekly.day as Weekday);
  if (day < 0) throw new CoachError("BAD_TIME", `weekly.day is not a weekday: ${cfg.automation.weekly.day}`);
  const local = day * 1440 + hm(cfg.automation.weekly.time); // minutes from Monday 00:00
  const offsets = yearOffsets(tz, now);
  const minutes = new Set<number>();
  const hours: number[] = [];
  const dows: number[] = [];
  for (const off of offsets) {
    const utc = (((local - off) % 10080) + 10080) % 10080;
    const inDay = utc % 1440;
    minutes.add(inDay % 60);
    hours.push(Math.floor(inDay / 60));
    dows.push((Math.floor(utc / 1440) + 1) % 7); // cron: 0 = Sunday
  }
  if (minutes.size !== 1) throw new CoachError("BAD_TIMEZONE", `${tz} changes its offset by a part of an hour; set the cron by hand`);
  return {
    cron: `${[...minutes][0]} ${hourField(hours)} * * ${hourField(dows)}`,
    offsets_min: offsets,
    note: offsets.length > 1 ? `fires under both UTC offsets of ${tz}; window-check admits only ${cfg.automation.weekly.day} ${cfg.automation.weekly.time} local` : `no DST in ${tz}`,
  };
}

// ---------- window check ----------

/** A scheduled run may start this many minutes after its slot (queue delay) and still count. */
export const WINDOW_GRACE_MIN = 30;

export type WindowCheck = {
  inside: boolean;
  kind: RoutineKind;
  local: { date: string; weekday: Weekday; time: string };
  window: string;
  reason: string;
};

function localParts(epochMs: number, tz: string): { date: string; weekday: Weekday; minutes: number } {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(epochMs)) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday.toLowerCase().slice(0, 3) as Weekday, minutes: +parts.hour * 60 + +parts.minute };
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * Is `now` inside the configured window, in the athlete's local time?
 * Daily: from daily_window.start to daily_window.end + WINDOW_GRACE_MIN. Weekly: on
 * weekly.day, from weekly.time to weekly.time + WINDOW_GRACE_MIN. The UTC cron covers both
 * DST offsets, so it also fires outside the window; those runs must stop here.
 */
export function windowCheck(kind: RoutineKind, cfg: CoachConfig, now = Date.now()): WindowCheck {
  const tz = cfg.athlete.timezone;
  const l = localParts(now, tz);
  const loc = { date: l.date, weekday: l.weekday, time: hhmm(l.minutes) };
  if (kind === "daily") {
    const start = hm(cfg.automation.daily_window.start);
    const end = hm(cfg.automation.daily_window.end) + WINDOW_GRACE_MIN;
    const inside = l.minutes >= start && l.minutes <= end;
    const window = `daily ${cfg.automation.daily_window.start}-${cfg.automation.daily_window.end} ${tz} (+${WINDOW_GRACE_MIN} min late start)`;
    return { inside, kind, local: loc, window, reason: inside ? `${loc.time} is inside the window` : `${loc.time} local is outside the window` };
  }
  if (kind === "weekly") {
    const t = hm(cfg.automation.weekly.time);
    const dayOk = l.weekday === cfg.automation.weekly.day;
    const inside = dayOk && l.minutes >= t && l.minutes <= t + WINDOW_GRACE_MIN;
    const window = `weekly ${cfg.automation.weekly.day} ${cfg.automation.weekly.time} ${tz} (+${WINDOW_GRACE_MIN} min late start)`;
    const reason = inside ? `${loc.weekday} ${loc.time} is inside the window` : !dayOk ? `today is ${loc.weekday} local, not ${cfg.automation.weekly.day}` : `${loc.time} local is outside the window`;
    return { inside, kind, local: loc, window, reason };
  }
  throw new CoachError("USAGE", "kind must be daily or weekly");
}

// ---------- the routine body ----------

/** A stable UUID (v4 layout) for the routine's first event, so equal inputs give equal bodies. */
function stableUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type RoutineOptions = {
  now?: number;
  /** The claude.ai environment (env_…). Setup reads it from the account; omitted when unknown. */
  environment_id?: string;
  model?: string;
  enabled?: boolean;
};

function checkConnector(c: Connector): void {
  if (!c || typeof c.uuid !== "string" || c.uuid.trim() === "") throw new CoachError("BAD_CONNECTOR", "connector.uuid is required");
  if (typeof c.name !== "string" || !/^[A-Za-z0-9_]+$/.test(c.name)) throw new CoachError("BAD_CONNECTOR", `connector.name must be a tool-prefix name such as Tally_Workout, got ${JSON.stringify(c.name)}`);
  if (c.url !== TALLY_CONNECTOR_URL) throw new CoachError("BAD_CONNECTOR", `only the Tally connector (${TALLY_CONNECTOR_URL}) may be attached, got ${JSON.stringify(c.url)}`);
}

/**
 * The body for RemoteTrigger create or update (shape observed in the spike). It pins the
 * Tally connector as the only MCP connection (the default attaches every connector on the
 * account, spike #17), lists the allowed tools exactly, and dispatches the skill explicitly.
 */
export function routineBody(kind: RoutineKind, cfg: CoachConfig, repoUrl: string, connector: Connector | null, opts: RoutineOptions = {}): Record<string, unknown> {
  // null: the discovery body for setup's first create call. It has no mcp_connections and is
  // always disabled; the create response then lists the account's connectors.
  if (connector !== null) checkConnector(connector);
  const toolPrefix = connector?.name ?? "Tally_Workout";
  if (typeof repoUrl !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?(\.git)?$/.test(repoUrl)) {
    throw new CoachError("USAGE", `repoUrl must be https://github.com/<owner>/<repo>, got ${JSON.stringify(repoUrl)}`);
  }
  const now = opts.now ?? Date.now();
  const { cron } = kind === "daily" ? dailyCron(cfg, now) : kind === "weekly" ? weeklyCron(cfg, now) : (() => { throw new CoachError("USAGE", `kind must be daily or weekly`); })();
  const prompt = routinePrompt(kind, "cloud");
  const session_context: Record<string, unknown> = {
    sources: [{ git_repository: { url: repoUrl } }],
    allowed_tools: [...UNATTENDED_TOOLS, ...TALLY_TOOLS.map((t) => `mcp__${toolPrefix}__${t}`)],
  };
  if (opts.model) session_context.model = opts.model;
  const ccr: Record<string, unknown> = {
    session_context,
    events: [
      {
        data: {
          uuid: stableUuid(`${kind}|${repoUrl}|${prompt}`),
          session_id: "",
          type: "user",
          parent_tool_use_id: null,
          message: { role: "user", content: prompt },
        },
      },
    ],
  };
  if (opts.environment_id) ccr.environment_id = opts.environment_id;
  return {
    name: `coach-harness ${kind}`,
    cron_expression: cron,
    enabled: connector === null ? false : (opts.enabled ?? true),
    persist_session: false,
    ...(connector === null ? {} : { mcp_connections: [{ connector_uuid: connector.uuid, name: connector.name, url: connector.url, permitted_tools: [...TALLY_TOOLS] }] }),
    job_config: { ccr },
  };
}

// ---------- launchd ----------

export function launchdLabel(kind: RoutineKind): string {
  return `dev.coach-harness.${kind}`;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Launchd runs in local time, so the schedule needs no UTC conversion and follows DST. */
function calendarIntervals(kind: RoutineKind, cfg: CoachConfig): { Weekday?: number; Hour: number; Minute: number }[] {
  if (kind === "daily") {
    const start = hm(cfg.automation.daily_window.start);
    const end = hm(cfg.automation.daily_window.end);
    const out = [];
    for (let t = start; t <= end; t += 60) out.push({ Hour: Math.floor(t / 60), Minute: t % 60 });
    return out;
  }
  const t = hm(cfg.automation.weekly.time);
  const day = WEEKDAYS.indexOf(cfg.automation.weekly.day as Weekday);
  return [{ Weekday: (day + 1) % 7, Hour: Math.floor(t / 60), Minute: t % 60 }];
}

/** Throws CLAUDE_NOT_FOUND unless `path` is an absolute path to an executable file. */
export function checkClaudePath(path: string): string {
  const fail = (why: string) => new CoachError("CLAUDE_NOT_FOUND", `claude executable ${JSON.stringify(path)} ${why}; install Claude Code or pass --claude <absolute path>`);
  if (typeof path !== "string" || !isAbsolute(path)) throw fail("is not an absolute path");
  try {
    if (!statSync(path).isFile()) throw fail("is not a file");
    accessSync(path, constants.X_OK);
  } catch (e) {
    if (e instanceof CoachError) throw e;
    throw fail("does not exist or is not executable");
  }
  return path;
}

/**
 * The absolute path of `claude`, as `command -v claude` finds it on the installing shell's
 * PATH (launchd's PATH does not hold ~/.local/bin, where Claude Code installs).
 */
export function resolveClaude(env: NodeJS.ProcessEnv = process.env): string {
  let found = "";
  try {
    found = execFileSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    found = "";
  }
  if (found === "") throw new CoachError("CLAUDE_NOT_FOUND", "claude is not on PATH (command -v claude found nothing); install Claude Code or pass --claude <absolute path>");
  return checkClaudePath(found);
}

/**
 * A LaunchAgent plist. It runs
 *   env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN COACH_UNATTENDED=1 claude -p "<prompt>" --permission-mode dontAsk --allowedTools …
 * With an API key set, claude.ai connectors are disabled and usage bills to the API
 * (spike #19), so both variables are unset. COACH_UNATTENDED=1 puts the hooks in unattended mode.
 */
export function launchdPlist(kind: RoutineKind, cfg: CoachConfig, repoPath: string, opts: { claude: string; path?: string; toolPrefixes?: string[] }): string {
  if (kind !== "daily" && kind !== "weekly") throw new CoachError("USAGE", "kind must be daily or weekly");
  if (typeof opts?.claude !== "string" || !isAbsolute(opts.claude)) {
    throw new CoachError("CLAUDE_NOT_FOUND", "launchdPlist needs the absolute path of claude (see resolveClaude)");
  }
  if (typeof repoPath !== "string" || !repoPath.startsWith("/")) throw new CoachError("USAGE", `repoPath must be an absolute path, got ${JSON.stringify(repoPath)}`);
  // One argument per rule: a rule such as Bash(git status:*) holds a space.
  const prefixes = (opts.toolPrefixes ?? [cfg.automation.tool_prefix ?? LOCAL_TALLY_PREFIX]).map(checkToolPrefix);
  const tools = [...UNATTENDED_TOOLS, ...prefixes.flatMap((p) => TALLY_TOOLS.map((t) => `${p}${t}`))];
  const args = [
    "/usr/bin/env", "-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", "COACH_UNATTENDED=1",
    opts.claude, "-p", routinePrompt(kind, "mac"),
    "--permission-mode", "dontAsk",
    "--allowedTools", ...tools,
  ];
  const log = join(repoPath, "athlete/.cache", `launchd-${kind}.log`);
  const intervals = calendarIntervals(kind, cfg)
    .map((i) => {
      const keys = Object.entries(i).map(([k, v]) => `      <key>${k}</key><integer>${v}</integer>`);
      return `    <dict>\n${keys.join("\n")}\n    </dict>`;
    })
    .join("\n");
  const base = opts.path ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const path = [dirname(opts.claude), ...base.split(":").filter((d) => d !== dirname(opts.claude))].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${launchdLabel(kind)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(repoPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
    <key>COACH_UNATTENDED</key>
    <string>1</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
${intervals}
  </array>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}
