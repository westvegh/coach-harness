#!/usr/bin/env node
// Hook latency bench (docs/contracts.md §20 item 27). Spawns each guard hook as Claude Code does (`node
// <hook>.ts`, JSON on stdin) and prints the median wall time of N runs per case, against
// the targets. Usage:
//   node scripts/bench-hooks.mjs [--repo <checkout>] [--runs 10] [--check]
// --repo runs the hooks of another checkout (with its own node_modules), for a
// before/after comparison. --check exits 1 when a target is missed.
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { saveSnapshot } from "../engine/snapshot.ts";
import { NOW, SESSION, snapDay, snapshot, v } from "../tests/guard/fixtures.ts";

const HERE = new URL("..", import.meta.url).pathname;
const { values } = parseArgs({ options: { repo: { type: "string" }, runs: { type: "string" }, check: { type: "boolean" } } });
const REPO = resolve(values.repo ?? HERE);
const RUNS = Number(values.runs ?? 10);
const D = "2026-10-15";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR"].includes(k)));

function git(dir, ...args) {
  execFileSync("git", args, { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "b", GIT_AUTHOR_EMAIL: "b@b", GIT_COMMITTER_NAME: "b", GIT_COMMITTER_EMAIL: "b@b" } });
}

/** A temporary instance: with `coach`, coach.yaml, limits, hold, methods, a snapshot and a git repo. */
function instance(coach) {
  const dir = mkdtempSync(join(tmpdir(), "coach-bench-"));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  if (coach) {
    cpSync(join(HERE, "coach.example.yaml"), join(dir, "coach.yaml"));
    cpSync(join(HERE, "templates/athlete/limits.yaml"), join(dir, "athlete/limits.yaml"));
    cpSync(join(HERE, "templates/athlete/hold.yaml"), join(dir, "athlete/hold.yaml"));
    cpSync(join(HERE, "methods"), join(dir, "methods"), { recursive: true });
  }
  writeFileSync(join(dir, ".gitignore"), "athlete/.cache/\n");
  saveSnapshot(dir, snapshot({ [D]: snapDay(D) }));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "bench");
  return dir;
}

function time(args, input, root, extra = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, args, { input, encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: root, COACH_NOW: NOW, ...extra } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, r };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

const UNATTENDED = { COACH_UNATTENDED: "1" };
const bare = instance(false);
// The floor for a hook: settings.json runs `node <hook>.ts`, and any .ts file loads Node's
// type stripper (about 35 ms) before a line runs.
const floorTs = join(bare, "floor.ts");
writeFileSync(floorTs, "const x: number = 0;\nexport { x };\n");
const athlete = instance(true);
// The same instance with an active regional hold, for the session-start row (P3).
const held = instance(true);
writeFileSync(join(held, "athlete/hold.yaml"), "active: true\nset_at: '2026-10-13T08:00:00-07:00'\nreason: bench fixture\nregions: [left-shoulder]\nset_by: safety-agent\n");
const trim = { date: D, expectedVersion: v(`r-${D}`, "t0"), operations: [{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 2 } }] };
const tallyWrite = { session_id: SESSION, hook_event_name: "PreToolUse", tool_name: "mcp__claude_ai_Tally_Workout__update_planned_workout", tool_input: trim, tool_use_id: "toolu_bench" };
const edit = (root) => ({ session_id: SESSION, tool_name: "Edit", tool_input: { file_path: join(root, "docs/notes.md"), old_string: "a", new_string: "b" } });
const bash = (command) => ({ session_id: SESSION, tool_name: "Bash", tool_input: { command } });

const cases = [
  { name: "bare node start", args: ["-e", ""], input: "", root: bare, target: null },
  { name: "one-line .ts file (the floor for a .ts hook)", args: [floorTs], input: "", root: bare, target: null },
  { name: "guard-files Edit, no coach.yaml", hook: "guard-files", input: edit(bare), root: bare, target: 60 },
  { name: "guard-writes Tally write, no coach.yaml", hook: "guard-writes", input: tallyWrite, root: bare, target: 60 },
  { name: "guard-files Edit (unprotected), coach.yaml", hook: "guard-files", input: edit(athlete), root: athlete, target: 80 },
  { name: "guard-files Bash (unprotected), coach.yaml", hook: "guard-files", input: bash("npm test"), root: athlete, target: 80 },
  { name: "guard-files Edit athlete/limits.yaml, coach.yaml", hook: "guard-files", input: { ...edit(athlete), tool_input: { file_path: join(athlete, "athlete/limits.yaml"), old_string: "a", new_string: "b" } }, root: athlete, target: null },
  { name: "guard-writes Tally write, coach.yaml", hook: "guard-writes", input: tallyWrite, root: athlete, target: 200 },
  { name: "session-context, no hold", hook: "session-context", input: { session_id: SESSION }, root: athlete, target: null },
  { name: "session-context, regional hold", hook: "session-context", input: { session_id: SESSION }, root: held, target: null },
  // Unattended (COACH_UNATTENDED=1, as a launchd run): the fast path never decides, so these
  // take the engine path.
  { name: "unattended: Edit athlete/log/x.md", hook: "guard-files", input: { session_id: SESSION, tool_name: "Edit", tool_input: { file_path: join(athlete, "athlete/log/x.md"), old_string: "a", new_string: "b" } }, root: athlete, target: null, env: UNATTENDED },
  { name: "unattended: Write .tmp/coach/x.json", hook: "guard-files", input: { session_id: SESSION, tool_name: "Write", tool_input: { file_path: join(athlete, ".tmp/coach/x.json"), content: "{}" } }, root: athlete, target: null, env: UNATTENDED },
  { name: "unattended: Bash node engine/cli.ts mode", hook: "guard-files", input: bash("node engine/cli.ts mode"), root: athlete, target: null, env: UNATTENDED },
  { name: "unattended: Bash git switch main", hook: "guard-files", input: bash("git switch main"), root: athlete, target: null, env: UNATTENDED },
];

console.log(`hooks: ${REPO}/.claude/hooks  runs: ${RUNS}  node ${process.version}`);
let missed = 0;
for (const c of cases) {
  const args = c.hook ? [join(REPO, ".claude/hooks", `${c.hook}.ts`)] : c.args;
  const input = typeof c.input === "string" ? c.input : JSON.stringify(c.input);
  time(args, input, c.root, c.env); // warm the file cache
  const runs = [];
  let last;
  for (let i = 0; i < RUNS; i++) {
    const t = time(args, input, c.root, c.env);
    runs.push(t.ms);
    last = t.r;
  }
  const m = median(runs);
  const ok = c.target === null || m < c.target;
  if (!ok) missed++;
  const out = (last.stdout.trim() || `exit ${last.status}${last.stderr ? `: ${last.stderr.trim().split("\n")[0]}` : ""}`).slice(0, 70);
  console.log(`${m.toFixed(0).padStart(5)} ms  ${c.target === null ? "      " : `<${String(c.target).padEnd(4)}${ok ? "ok" : "MISS"}`.padEnd(10)}  ${c.name.padEnd(50)} ${out}`);
}
rmSync(bare, { recursive: true, force: true });
rmSync(athlete, { recursive: true, force: true });
rmSync(held, { recursive: true, force: true });
if (values.check && missed > 0) process.exitCode = 1;
