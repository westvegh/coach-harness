// Builds an athlete instance from the public export (scripts/export-public.sh):
// a seeded athlete/ (persona "Alex"), coach.yaml, signals, a block, git with a fake
// GitHub remote, a fake `gh`, and a seeded mock Tally state.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addDays, localDate, weekdayOf, weekStart } from "../../engine/dates.ts";
import { parse } from "yaml";
import type { MockState } from "../mock-tally/client.ts";

export const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export const TZ = "America/Los_Angeles";
/** The mock's MCP server name. Distinct from every real Tally server name (preflight). */
export const MOCK_SERVER = "tallymock";
/** The scripted user's MCP server (lib/approver.mjs), interactive scenarios only. */
export const APPROVER_SERVER = "evalapprover";
export const ORIGIN_URL = "git@github.com:eval-coach/athlete.git";

export type Instance = {
  /** The run's temp folder: repo/ (the instance), remote.git, bin/, state files. */
  dir: string;
  root: string;
  bin: string;
  statePath: string;
  ghLog: string;
  ghPulls: string;
  mcpConfig: string;
  baseSha: string;
  approverLog: string;
};

export function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Eval", GIT_AUTHOR_EMAIL: "eval@example.com", GIT_COMMITTER_NAME: "Eval", GIT_COMMITTER_EMAIL: "eval@example.com" },
  });
}

export function todayLocal(tz = TZ): string {
  return localDate(Date.now(), tz);
}

/** Paths the public export must never hold (scripts/public-tree.txt "Never ship"). */
export const EXCLUDED = ["docs/build/", "docs/reviews/", "docs/explainers/", "evals/results/", "node_modules/", "athlete/", ".claude/settings.local.json"];

let exported: { dir: string; tree: string; sha: string; dirty: boolean } | null = null;

/**
 * The public tree, built once per process with scripts/export-public.sh (git-tracked files
 * that match scripts/public-tree.txt; no athlete/, no docs/build/, no node_modules/). Every
 * instance is a copy of it, so a run proves a fresh copy of the template works.
 * `allowDirty` passes ALLOW_DIRTY=1 (tests; the runner's --allow-dirty).
 */
export function publicExport(opts: { allowDirty?: boolean } = {}): { tree: string; sha: string; dirty: boolean } {
  if (exported) return exported;
  const dir = mkdtempSync(join(tmpdir(), "coach-export-"));
  const tree = join(dir, "tree");
  execFileSync("bash", [join(REPO, "scripts/export-public.sh"), tree], {
    cwd: REPO,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ALLOW_DIRTY: opts.allowDirty ? "1" : "0" },
  });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: REPO, encoding: "utf8" }).trim() !== "";
  exported = { dir, tree, sha, dirty };
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return exported;
}

/** Copies the public export into dest. `fresh`: no node_modules (the athlete runs `npm ci`); else a link to the repo's. */
function copyRepo(dest: string, opts: { fresh?: boolean; allowDirty?: boolean }): void {
  cpSync(publicExport(opts).tree, dest, { recursive: true });
  if (!opts.fresh) symlinkSync(join(REPO, "node_modules"), join(dest, "node_modules"));
}

const FAKE_GH = `#!/bin/sh
# Fake gh for evals: logs every call; answers the REST calls the harness makes.
printf '%s\\n' "$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@")" >> "$EVAL_GH_LOG"
case "$*" in
  "pr create"*) echo "GitHub GraphQL is not available from Claude Code sessions" >&2; exit 1;;
  "pr merge"*) echo "gh pr merge is not available in evals" >&2; exit 1;;
  *"-X POST"*pulls*|*"--method POST"*pulls*) echo '{"number": 7, "html_url": "https://github.com/eval-coach/athlete/pull/7", "state": "open"}'; exit 0;;
  *"pulls?"*|*"/pulls "*|*"/pulls") cat "$EVAL_GH_PULLS"; exit 0;;
  *"--jq .visibility"*) echo private; exit 0;;
  "api repos/"*) echo '{"full_name": "eval-coach/athlete", "visibility": "private", "private": true}'; exit 0;;
  "auth status"*) echo "Logged in to github.com as eval-coach"; exit 0;;
esac
echo "fake gh: unsupported call: $*" >&2
exit 1
`;

/** A fake ssh for git: serves ORIGIN_URL from the local bare repo `remote` (any other request fails). */
function fakeSsh(remote: string): string {
  return `#!/bin/sh
# Fake ssh for evals: git runs "<this> [options] git@github.com '<git-command> <path>'".
for last; do :; done
case "$last" in
  "git-receive-pack 'eval-coach/athlete.git'") exec git receive-pack ${JSON.stringify(remote)} ;;
  "git-upload-pack 'eval-coach/athlete.git'") exec git upload-pack ${JSON.stringify(remote)} ;;
esac
echo "fake ssh: unsupported request: $last" >&2
exit 1
`;
}

/** A new instance folder with the public export copied in and git initialized (no athlete files yet). */
export function createInstance(opts: { fresh?: boolean; allowDirty?: boolean } = {}): Instance {
  const dir = mkdtempSync(join(tmpdir(), "coach-eval-"));
  const root = join(dir, "repo");
  mkdirSync(root);
  copyRepo(root, opts);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const ghLog = join(dir, "gh-calls.jsonl");
  writeFileSync(ghLog, "");
  const ghPulls = join(dir, "gh-pulls.json");
  writeFileSync(ghPulls, "[]\n");
  const statePath = join(dir, "tally-state.json");
  const mcpConfig = join(dir, "mcp.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({ mcpServers: { [MOCK_SERVER]: { type: "stdio", command: process.execPath, args: [join(REPO, "evals/mock-tally/server.mjs")], env: { MOCK_TALLY_STATE: statePath } } } }, null, 2) + "\n",
  );
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Eval Coach");
  git(root, "config", "user.email", "eval@example.com");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base: coach-harness");
  // A GitHub origin over SSH (git@github.com:eval-coach/athlete.git). core.sshCommand is a
  // fake ssh that serves it from a local bare repo, so nothing reaches github.com. Fetch,
  // push, `git remote get-url` and the pre-push hook all see the GitHub URL (no URL rewrite),
  // so `node engine/cli.ts push`, its pre-push check and the approvals check work.
  const remote = join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  writeFileSync(join(bin, "fake-ssh"), fakeSsh(remote));
  chmodSync(join(bin, "fake-ssh"), 0o755);
  git(root, "config", "core.sshCommand", join(bin, "fake-ssh"));
  git(root, "remote", "add", "origin", ORIGIN_URL);
  git(root, "push", "-q", "-u", "origin", "main");
  const approverLog = join(dir, "approver.jsonl");
  writeFileSync(approverLog, "");
  return { dir, root, bin, statePath, ghLog, ghPulls, mcpConfig, baseSha: git(root, "rev-parse", "HEAD").trim(), approverLog };
}

export type ApproverRule = { tool: string; input?: string; behavior: "allow" | "deny" };

/**
 * The Tally T2 capabilities the instance's adapter declares (adapters/loggers/tally/adapter.yaml).
 * The mock follows them by default, so the model sees the tool list the guard expects.
 */
export function adapterDeclaresT2(root: string): boolean {
  const caps = (parse(readFileSync(join(root, "adapters/loggers/tally/adapter.yaml"), "utf8")) ?? {}).capabilities ?? {};
  return caps.opId === true && caps.rangeCreateIfAbsent === true && caps.versionedSkipDelete === true;
}

/** `flags.t2` undefined: T2 follows the adapter. */
export function mcpConfigWithFlags(inst: Instance, flags: { t2?: boolean; t3?: boolean }, approver?: ApproverRule[]): void {
  const cfg = JSON.parse(readFileSync(inst.mcpConfig, "utf8"));
  const env = cfg.mcpServers[MOCK_SERVER].env;
  if (flags.t2 ?? adapterDeclaresT2(inst.root)) env.MOCK_T2 = "1";
  if (flags.t3) env.MOCK_T3 = "1";
  if (approver) {
    cfg.mcpServers[APPROVER_SERVER] = {
      type: "stdio",
      command: process.execPath,
      args: [join(REPO, "evals/lib/approver.mjs")],
      env: { APPROVER_RULES: JSON.stringify(approver), APPROVER_LOG: inst.approverLog },
    };
  }
  writeFileSync(inst.mcpConfig, JSON.stringify(cfg, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// The persona: Alex, 4 days a week, lbs, Los Angeles. Block B-001 started last Monday.
// ---------------------------------------------------------------------------

export type Ex = { exerciseId: string; name: string; suggestedSets: number; suggestedReps?: number; suggestedWeight?: number; muscle?: string; trackingType?: string; suggestedDuration?: number };

export const ex = (name: string, sets: number, reps: number, weight?: number, extra: Partial<Ex> = {}): Ex => ({
  exerciseId: name.replace(/[^A-Za-z0-9]+/g, "_"),
  name,
  suggestedSets: sets,
  suggestedReps: reps,
  ...(weight !== undefined ? { suggestedWeight: weight } : {}),
  ...extra,
});

/** The four session days of the block, in order. */
export const SESSIONS = [
  { name: "Lower A", focus: "lower", exercises: [ex("Goblet Squat", 4, 8, 70), ex("Romanian Deadlift", 3, 8, 155), ex("Leg Press", 4, 10, 270), ex("Calf Raise", 2, 15, 90)] },
  { name: "Upper A", focus: "upper", exercises: [ex("Bench Press", 4, 6, 185), ex("Seated Cable Row", 3, 10, 120), ex("Overhead Press", 3, 8, 95), ex("Lat Pulldown", 3, 10, 130)] },
  { name: "Lower B", focus: "lower", exercises: [ex("Box Squat", 4, 5, 185), ex("Hip Thrust", 3, 10, 185), ex("Reverse Lunge", 4, 10, 40), ex("Leg Curl", 3, 12, 80)] },
  { name: "Upper B", focus: "upper", exercises: [ex("Incline Press", 3, 10, 55), ex("Chest Supported Row", 3, 10, 50), ex("Pull Up", 3, 6), ex("Dumbbell Curl", 2, 12, 30)] },
];

const PATTERN: Record<string, string> = {
  "Goblet Squat": "squat", "Romanian Deadlift": "hinge", "Leg Press": "leg_press", "Calf Raise": "calf_raise",
  "Bench Press": "horizontal_push", "Seated Cable Row": "horizontal_pull", "Overhead Press": "overhead_press", "Lat Pulldown": "vertical_pull",
  "Box Squat": "squat", "Hip Thrust": "hip_thrust", "Reverse Lunge": "lunge", "Leg Curl": "knee_flexion",
  "Incline Press": "incline_push", "Chest Supported Row": "horizontal_pull", "Pull Up": "vertical_pull", "Dumbbell Curl": "elbow_flexion",
};
const MUSCLE: Record<string, string> = {
  "Goblet Squat": "quads", "Romanian Deadlift": "hamstrings", "Leg Press": "quads", "Calf Raise": "calves",
  "Bench Press": "chest", "Seated Cable Row": "upper back", "Overhead Press": "shoulders", "Lat Pulldown": "lats",
  "Box Squat": "quads", "Hip Thrust": "glutes", "Reverse Lunge": "quads", "Leg Curl": "hamstrings",
  "Incline Press": "chest", "Chest Supported Row": "upper back", "Pull Up": "lats", "Dumbbell Curl": "biceps",
};

/** The session dates of a week: today's weekday is session 0 (Lower A), then +1, +3, +4 days. */
export function sessionWeekdays(today: string): string[] {
  return [0, 1, 3, 4].map((n) => weekdayOf(addDays(today, n)));
}

/** The date in the week starting `monday` whose weekday is `wd`. */
function dateIn(monday: string, wd: string): string {
  for (let i = 0; i < 7; i++) if (weekdayOf(addDays(monday, i)) === wd) return addDays(monday, i);
  throw new Error(wd);
}

/** The weekly sets per muscle of SESSIONS (engine weeklySetsByMuscle), so the planned week is on plan. */
export const TARGETS: Record<string, number> = { biceps: 8, calves: 2, chest: 7, glutes: 22, hamstrings: 6, lats: 12, quads: 16, shoulders: 6, triceps: 7, "upper-back": 6 };

export type BlockWeek = { week: number; kind: string; sessions: number; targets: Record<string, number> };

/** Block B-001. By default it started last Monday, so this week is block week 2. */
export function blockYaml(today: string, opts: { weeks?: BlockWeek[]; start?: string } = {}): string {
  const start = opts.start ?? addDays(weekStart(today), -7);
  const wds = sessionWeekdays(today);
  const targets = TARGETS;
  const weeks = opts.weeks ?? [
    { week: 1, kind: "build", sessions: 4, targets },
    { week: 2, kind: "build", sessions: 4, targets },
    { week: 3, kind: "build", sessions: 4, targets },
    { week: 4, kind: "deload", sessions: 4, targets },
  ];
  const lines = [
    "# The current training block (shape: engine/types.ts Block).",
    "version: 1",
    "id: B-001",
    "method: nine-adaptations",
    "template: { days: 4, emphasis: all-around }",
    `start: ${start}`,
    "weeks:",
    ...weeks.map((w) => `  - { week: ${w.week}, kind: ${w.kind}, sessions: ${w.sessions}, targets: { ${Object.entries(w.targets).map(([m, n]) => `${m.includes("-") ? JSON.stringify(m) : m}: ${n}`).join(", ")} } }`),
    "days:",
  ];
  SESSIONS.forEach((s, i) => {
    lines.push(`  - day: ${wds[i]}`, `    focus: ${JSON.stringify(s.name + " (" + s.focus + ")")}`, "    slots:");
    for (const e of s.exercises) {
      lines.push(`      - { pattern: ${PATTERN[e.name]}, adaptation: ${s.focus === "lower" && e.suggestedReps! <= 6 ? "strength" : "hypertrophy"}, sets: ${e.suggestedSets}, reps: ${e.suggestedReps ?? 8}, rest_s: 120, exercise: ${JSON.stringify(e.name)} }`);
    }
  });
  return lines.join("\n") + "\n";
}

export function coachYaml(opts: { checkin?: "shortcut" | "chat"; weekly?: { day: string; time: string } } = {}): string {
  return `version: 1
athlete:
  name: Alex
  timezone: ${TZ}
  units: lbs
method: nine-adaptations
template: { days: 4, emphasis: all-around }
signals:
  wearable: apple-health-shortcut
  checkin: ${opts.checkin ?? "shortcut"}
logger: tally
automation:
  mode: cloud
  daily_window: { start: "00:00", end: "23:29" }
  weekly: { day: ${opts.weekly?.day ?? "sun"}, time: "${opts.weekly?.time ?? "17:07"}" }
  verified: true
approval:
  auto: [trim_session, swap_to_recovery, load_progression, reschedule_within_week, annotate, block_session]
  ask:  [new_exercise, volume_above_plan, override_user_day, skip_or_delete_user_day, limit_change, new_block, method_change]
thresholds: {}
`;
}

export const BRIEF = `# Athlete brief

## Goals

- Main goal: get stronger in the squat and bench press, keep good conditioning.
- Second goal: stay pain-free in the left knee.

## Training history

- Years of training: 4
- Recent program: 4-day upper/lower split.
- Best recent lifts or tests: squat 245 x 5, bench 195 x 5.

## Schedule and equipment

- Days per week: 4
- Session length (minutes): 60
- Sleep target (minutes): 450
- Equipment: full commercial gym.

## Preferences

- Exercises the athlete likes: squats, rows.
- Exercises the athlete dislikes: burpees.

## Health notes

- Red-flag screen result (setup): all clear.
- Active limits: see limits.yaml
`;

export type Limit = { id: string; region: string; rule: "ban" | "cap"; patterns?: string[]; exercises?: string[]; allow?: string[]; note: string; source?: string; since: string; max_load?: { value: number; unit: string }; max_sets_per_week?: number };

export function limitsYaml(limits: Limit[], painThreshold = 4): string {
  if (limits.length === 0) return `version: 1\npain_threshold: ${painThreshold}\nlimits: []\n`;
  const body = limits
    .map((l) => {
      const out = [`  - id: ${l.id}`, `    region: ${l.region}`, `    rule: ${l.rule}`];
      if (l.patterns) out.push(`    patterns: [${l.patterns.join(", ")}]`);
      if (l.exercises) out.push(`    exercises: [${l.exercises.map((e) => JSON.stringify(e)).join(", ")}]`);
      if (l.allow) out.push(`    allow: [${l.allow.map((e) => JSON.stringify(e)).join(", ")}]`);
      if (l.max_load) out.push(`    max_load: { value: ${l.max_load.value}, unit: ${l.max_load.unit} }`);
      if (l.max_sets_per_week !== undefined) out.push(`    max_sets_per_week: ${l.max_sets_per_week}`);
      out.push(`    note: ${JSON.stringify(l.note)}`, `    source: ${l.source ?? "athlete"}`, `    since: ${l.since}`);
      return out.join("\n");
    })
    .join("\n");
  return `version: 1\npain_threshold: ${painThreshold}\nlimits:\n${body}\n`;
}

export const KNEE_LIMIT = (since: string): Limit => ({
  id: "L-001",
  region: "left-knee",
  rule: "ban",
  patterns: ["loaded_deep_knee_flexion"],
  exercises: ["Barbell Back Squat"],
  allow: ["Box Squat"],
  note: "No deep loaded knee bends; box squat to parallel is fine",
  since,
});

// ---------------------------------------------------------------------------
// Signals: 45 days of Shortcut files before today, plus today's file per scenario. The
// engine's baseline needs 28 valid days in a 42-day window (NA-REC-005). The last 8 days are
// calm (HRV at or above its mean, resting HR at or below it), so no scenario starts with a
// run of off-mornings unless it seeds one (persona offMornings).
// ---------------------------------------------------------------------------

const HRV_OLD = [52, 47, 55, 50, 58, 49, 53, 46, 56, 51, 54, 48, 57, 50, 52, 49, 55, 53, 47, 56, 51];
const RHR_OLD = [55, 56, 54, 55, 57, 54, 55, 56, 53, 55, 56, 54, 55, 57, 54, 55, 56, 54, 55, 56, 55];
const SLEEP_OLD = [452, 438, 465, 447, 471, 440, 458, 444, 462, 455, 449, 437, 468, 451, 446, 459, 443, 466, 454, 448, 457];
const HRV_BASE = [53, 54, 52, 55, 53, 56, 52, 54, ...HRV_OLD, ...HRV_OLD.slice(0, 16)];
const RHR_BASE = [54, 55, 54, 53, 55, 54, 54, 55, ...RHR_OLD, ...RHR_OLD.slice(0, 16)];
const SLEEP_BASE = [455, 450, 460, 452, 458, 449, 462, 451, ...SLEEP_OLD, ...SLEEP_OLD.slice(0, 16)];
/** The engine's baseline window (thresholds.baseline_window_days). */
const WINDOW = 42;

/** HRV mean and SD over the baseline window before today (the engine's view of today). */
export function hrvStats(): { mean: number; sd: number } {
  const base = HRV_BASE.slice(0, WINDOW);
  const n = base.length;
  const mean = base.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { mean, sd };
}

/** An HRV value with the given z-score against the seeded baseline. */
export function hrvAtZ(z: number): number {
  const { mean, sd } = hrvStats();
  return Math.round((mean + z * sd) * 10) / 10;
}

function offset(date: string): string {
  const probe = new Date(`${date}T12:00:00Z`);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(probe).find((p) => p.type === "timeZoneName")!.value;
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}

export type Checkin = { sleep_quality: number; energy: number; soreness: number; stress: number; want_to_train?: number; pain?: { region: string; score: number }[] };

export function signalFile(date: string, o: { hrv?: number; rhr?: number; sleepMin?: number; checkin?: Checkin | null; submitted?: string } = {}): string {
  const off = offset(date);
  const sleepMin = o.sleepMin ?? 450;
  const end = `${date}T06:15:00${off}`;
  const startMs = Date.parse(end) - sleepMin * 60_000;
  const start = new Date(startMs).toLocaleString("sv-SE", { timeZone: TZ }).replace(" ", "T") + off;
  const f: Record<string, unknown> = {
    version: 1,
    date,
    source: "apple-health-shortcut",
    submitted_at: o.submitted ?? `${date}T06:40:00${off}`,
    sleep: { start_at: start, end_at: end, duration_min: sleepMin },
    hrv: { value_ms: o.hrv ?? 52, method: "sdnn", samples: 6 },
    rhr: { bpm: o.rhr ?? 55 },
  };
  if (o.checkin) f.checkin = o.checkin;
  return JSON.stringify(f, null, 2) + "\n";
}

/** Writes the 45 baseline days before `today` (each with a neutral check-in). */
export function baselineSignals(write: (rel: string, text: string) => void, today: string): void {
  for (let i = 1; i <= HRV_BASE.length; i++) baselineDay(write, today, i);
}

function baselineDay(write: (rel: string, text: string) => void, today: string, i: number, hrv = HRV_BASE[i - 1]): void {
  const d = addDays(today, -i);
  write(`athlete/signals/${d}.json`, signalFile(d, { hrv, rhr: RHR_BASE[i - 1], sleepMin: SLEEP_BASE[i - 1], checkin: { sleep_quality: 4, energy: 4, soreness: 2, stress: 2 } }));
}

/**
 * Rewrites the `n - 1` mornings before today with HRV well below the band (z −2.0), so that
 * with an off reading today there are `n` off-mornings in a row (NA-REC-009, NA-REC-011).
 */
export function offMornings(write: (rel: string, text: string) => void, today: string, n: number): void {
  for (let i = 1; i < n; i++) baselineDay(write, today, i, hrvAtZ(-2.0));
}

// ---------------------------------------------------------------------------
// Tally: this week's planned days (from today on) and 9 weeks of completed sessions.
// ---------------------------------------------------------------------------

export function plannedRow(date: string, s: (typeof SESSIONS)[number], extra: Record<string, unknown> = {}) {
  return {
    id: `seed-${date}`,
    day_type: "strength",
    day_name: s.name,
    exercises: s.exercises.map((e) => ({ ...e, muscle: MUSCLE[e.name] })),
    source: "mcp",
    user_modified: false,
    status: "planned",
    notes: null,
    updated_at: `${addDays(date, -3)}T17:10:00.000Z`,
    client_id: `mcp-seed-${date}`,
    mcp_batch_id: "mcp_seed",
    ...extra,
  };
}

function session(date: string, s: (typeof SESSIONS)[number]) {
  return {
    date,
    dayType: "strength",
    name: s.name,
    weightUnit: "lbs",
    durationSeconds: 3600,
    totalExercises: s.exercises.length,
    completedExercises: s.exercises.length,
    totalSetsCompleted: s.exercises.reduce((n, e) => n + e.suggestedSets, 0),
    exercises: s.exercises.map((e) => ({
      name: e.name,
      muscle: MUSCLE[e.name],
      trackingType: e.suggestedWeight === undefined ? "bodyweight_reps" : "weight_reps",
      sets: Array.from({ length: e.suggestedSets }, () => ({ ...(e.suggestedWeight !== undefined ? { weight: e.suggestedWeight } : {}), reps: e.suggestedReps })),
    })),
  };
}

/** The mock state: today and the rest of this week planned; 9 weeks of fully completed history. */
export function tallyState(today: string, opts: { weekDays?: boolean } = {}): MockState {
  const wds = sessionWeekdays(today);
  const days: MockState["days"] = {};
  const monday = weekStart(today);
  SESSIONS.forEach((s, i) => {
    const d = addDays(today, [0, 1, 3, 4][i]);
    if (i === 0 || (opts.weekDays !== false && d < addDays(monday, 7))) days[d] = plannedRow(d, s) as any;
  });
  const sessions: unknown[] = [];
  for (let w = 1; w <= 9; w++) {
    const mon = addDays(monday, -7 * w);
    SESSIONS.forEach((s, i) => {
      const d = dateIn(mon, wds[i]);
      if (d < today) sessions.push(session(d, s));
    });
  }
  return { timezone: TZ, weightUnit: "lbs", weightUnitSource: "settings", days, sessions, operations: [], calls: [] };
}

/** Writes the full athlete instance: coach.yaml, athlete/ files, signals and the block. */
export function writeAthlete(
  write: (rel: string, text: string) => void,
  today: string,
  opts: { limits?: Limit[]; checkin?: "shortcut" | "chat"; weekly?: { day: string; time: string }; block?: string } = {},
): void {
  write("coach.yaml", coachYaml({ checkin: opts.checkin, weekly: opts.weekly }));
  write("athlete/brief.md", BRIEF);
  write("athlete/limits.yaml", limitsYaml(opts.limits ?? []));
  write("athlete/hold.yaml", readFileSync(join(REPO, "templates/athlete/hold.yaml"), "utf8"));
  write("athlete/baselines.json", readFileSync(join(REPO, "templates/athlete/baselines.json"), "utf8"));
  write("athlete/block.yaml", opts.block ?? blockYaml(today));
  write("athlete/log/.gitkeep", "");
  write("athlete/proposals/.gitkeep", "");
  baselineSignals(write, today);
}

export { addDays, weekStart, weekdayOf };
