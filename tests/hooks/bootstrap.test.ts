// The hooks work before `npm ci` (docs/contracts.md §20 item 27). Each hook runs from a copy of the repo with
// no node_modules (so `yaml` and every engine module that needs it cannot load) and
// decides with Node built-ins only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse } from "yaml";
import * as boot from "../../.claude/hooks/bootstrap.ts";
import { loadAdapterConfig, loadLogger } from "../../engine/logger.ts";

const { isLoggerMutation } = boot;

const REPO = new URL("../..", import.meta.url).pathname;
const FORMS = ["mcp__tally__", "mcp__Tally_Workout__", "mcp__claude_ai_Tally_Workout__"];
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR", "COACH_NOW", "NODE_PATH"].includes(k)));
const NOT_SET_UP = /coach-harness is not set up yet \(no coach\.yaml\)\. Run setup first\./;
const MISSING = /coach-harness packages are missing\. Run `npm ci`\./;

/** A copy of the repo without node_modules or .git; with `coach`, an athlete instance. */
function bareCopy(opts: { coach: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-bare-"));
  cpSync(REPO, dir, {
    recursive: true,
    filter: (src) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(relative(REPO, src)),
  });
  if (opts.coach) cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  // The point of the test: no package resolves from the copy.
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('yaml')"], { cwd: join(dir, "engine"), env: { ...BASE_ENV, NODE_PATH: "" }, encoding: "utf8" });
  assert.notEqual(probe.status, 0, "yaml must not resolve from the bare copy");
  return dir;
}

function hook(name: string, root: string, input: unknown, opts: { env?: Record<string, string>; projectDir?: boolean } = {}) {
  const env: Record<string, string> = { ...(BASE_ENV as Record<string, string>), NODE_PATH: "", ...opts.env };
  if (opts.projectDir !== false) env.CLAUDE_PROJECT_DIR = root;
  const r = spawnSync(process.execPath, [join(root, ".claude/hooks", `${name}.ts`)], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    cwd: tmpdir(),
    env,
    timeout: 10_000,
  });
  let json: any = null;
  try {
    json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {
    /* not JSON */
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const decision = (r: ReturnType<typeof hook>) => r.json?.hookSpecificOutput?.permissionDecision;
const reason = (r: ReturnType<typeof hook>) => String(r.json?.hookSpecificOutput?.permissionDecisionReason ?? "");
const context = (r: ReturnType<typeof hook>) => String(r.json?.hookSpecificOutput?.additionalContext ?? "");
const silent = (r: ReturnType<typeof hook>, what: string) => {
  assert.equal(r.code, 0, `${what}: exit ${r.code} ${r.stderr}`);
  assert.equal(r.stdout, "", what);
};
const edit = (root: string) => ({ session_id: "s1", tool_name: "Edit", tool_input: { file_path: join(root, "engine/validate.ts"), old_string: "a", new_string: "b" } });
const bash = (command: string) => ({ session_id: "s1", tool_name: "Bash", tool_input: { command } });
const tally = (tool: string) => ({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: tool, tool_input: { date: "2026-10-15" }, tool_use_id: "toolu_1" });
const prompt = (root: string, text: string) => ({ session_id: "s1", hook_event_name: "UserPromptSubmit", cwd: root, prompt: text });
const pending = (root: string) => join(root, "athlete/.safety-pending");

// ---------- no coach.yaml (a fresh clone) ----------

test("no coach.yaml, no packages: guard-files allows Edit and Bash", () => {
  const root = bareCopy({ coach: false });
  silent(hook("guard-files", root, edit(root)), "Edit");
  silent(hook("guard-files", root, bash("npm ci")), "Bash npm ci");
  silent(hook("guard-files", root, bash("rm -rf athlete")), "Bash rm");
  silent(hook("guard-files", root, edit(root), { env: { COACH_UNATTENDED: "1" } }), "Edit unattended");
});

// A block is exit 2 with the reason on stderr (contracts §18; the existing MISSING_FILE
// test in hooks.test.ts pins this shape with packages installed, and it is the same here).
const blocked = (r: ReturnType<typeof hook>, what: string) => {
  assert.equal(r.code, 2, `${what}: exit ${r.code} ${r.stdout}`);
  assert.equal(r.stdout, "", what);
  assert.match(r.stderr, /^guard-writes: MISSING_FILE: coach\.yaml is missing/, what);
  assert.match(r.stderr, NOT_SET_UP, what);
};

test("no coach.yaml, no packages: guard-writes blocks a Tally mutation in all three name forms and allows a read", () => {
  const root = bareCopy({ coach: false });
  for (const f of FORMS) {
    for (const t of ["plan_workout_day", "update_planned_workout", "update_training_limits"]) blocked(hook("guard-writes", root, tally(f + t)), f + t);
    silent(hook("guard-writes", root, tally(f + "get_planned_workout")), `${f}get_planned_workout`);
  }
  // The root comes from the input's cwd when CLAUDE_PROJECT_DIR is unset.
  blocked(hook("guard-writes", root, { ...tally("mcp__tally__skip_planned_workout"), cwd: root }, { projectDir: false }), "root from cwd");
});

test("no coach.yaml, no packages: safety-detect writes no pending file and says the detector could not run", () => {
  const root = bareCopy({ coach: false });
  const r = hook("safety-detect", root, prompt(root, "my left knee hurts when I squat"));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(pending(root)), false, "no pending file before setup");
  assert.equal(r.json?.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.equal(context(r), "SAFETY: the pain and red-flag detector could not run (packages are not installed). Ask about pain and red flags before any plan.");
});

test("no coach.yaml, no packages: session-context says run npm ci, then set me up", () => {
  const root = bareCopy({ coach: false });
  const r = hook("session-context", root, { session_id: "s1", hook_event_name: "SessionStart", source: "startup" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json?.hookSpecificOutput?.hookEventName, "SessionStart");
  assert.equal(context(r), "coach-harness is not set up. Run `npm ci`, then say 'set me up'.");
});

test("no coach.yaml, no packages: capture-reads, log-writes and commit-check exit 0 with no output", () => {
  const root = bareCopy({ coach: false });
  silent(hook("capture-reads", root, { ...tally("mcp__tally__get_planned_workout"), tool_response: [] }), "capture-reads");
  silent(hook("log-writes", root, { ...tally("mcp__tally__plan_workout_day"), tool_response: [] }), "log-writes");
  silent(hook("commit-check", root, { session_id: "s1", stop_hook_active: false }), "commit-check");
});

// ---------- coach.yaml present (an athlete instance), no packages ----------

test("coach.yaml, no packages: guard-files denies everything except the exact npm repair", () => {
  const root = bareCopy({ coach: true });
  for (const [what, input] of [
    ["Edit", edit(root)],
    ["Write", { session_id: "s1", tool_name: "Write", tool_input: { file_path: join(root, "athlete/limits.yaml"), content: "x" } }],
    // Review finding 2: the fast path must not allow anything while the engine cannot load.
    ["unprotected Write", { session_id: "s1", tool_name: "Write", tool_input: { file_path: join(root, "athlete/log/2026-10.md"), content: "x" } }],
    ["ls .claude", bash("ls .claude")],
    ["cat package.json", bash("cat package.json")],
    ["npm install foo", bash("npm install foo")],
    ["npm run x", bash("npm run x")],
    ["npm ci --script-shell=sh", bash("npm ci --script-shell=sh")],
    ["touch", bash("touch notes.txt")],
    ["git status", bash("git status")],
    ["rm -rf athlete", bash("rm -rf athlete")],
    ["npm ci; rm", bash("npm ci; rm -rf athlete")],
    ["npm ci && rm", bash("npm ci && rm -rf athlete")],
    // Review finding 5: a newline makes two commands.
    ["npm newline ci", bash("npm\nci")],
    ["npm ci newline rm", bash("npm ci\nrm -rf athlete")],
    ["cd elsewhere", bash("cd /tmp && npm ci")],
    ["cd $(...)", bash(`cd "$(pwd)" && npm ci`)],
    ["bare npm ci from another cwd", { ...bash("npm ci"), cwd: tmpdir() }],
    ["bad input", "{"],
  ] as [string, unknown][]) {
    const r = hook("guard-files", root, input);
    assert.equal(r.code, 0, `${what}: ${r.stderr}`);
    assert.equal(decision(r), "deny", `${what}: ${r.stdout}`);
    assert.match(reason(r), MISSING, what);
  }
  for (const cmd of ["npm ci", "npm install", "  npm ci  ", "npm\tci", `cd ${root} && npm ci`, `cd "${root}" && npm install`, `cd ${root}/ && npm ci`]) {
    silent(hook("guard-files", root, bash(cmd)), JSON.stringify(cmd));
  }
  silent(hook("guard-files", root, { ...bash("npm ci"), cwd: root }), "bare npm ci from the repo root");
});

test("coach.yaml, no packages: guard-writes denies with the run npm ci reason", () => {
  const root = bareCopy({ coach: true });
  for (const f of FORMS) {
    const r = hook("guard-writes", root, tally(f + "update_planned_workout"));
    assert.equal(decision(r), "deny", r.stdout + r.stderr);
    assert.match(reason(r), MISSING);
  }
});

test("coach.yaml, no packages: safety-detect still writes the detector-error pending file", () => {
  const root = bareCopy({ coach: true });
  const r = hook("safety-detect", root, prompt(root, "my left knee hurts when I squat"));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(pending(root), "utf8")).terms, ["detector-error"]);
  assert.match(context(r), /^SAFETY FIRST\. The safety detector failed/);
});

test("coach.yaml, no packages: session-context, capture-reads, log-writes and commit-check report the missing packages", () => {
  const root = bareCopy({ coach: true });
  const s = hook("session-context", root, { session_id: "s1", hook_event_name: "SessionStart" });
  assert.equal(s.code, 0, s.stderr);
  assert.match(context(s), MISSING);
  for (const name of ["capture-reads", "log-writes"]) {
    const r = hook(name, root, { ...tally("mcp__tally__plan_workout_day"), tool_response: [] });
    assert.equal(r.code, 2, `${name}: exit ${r.code}`);
    assert.match(r.stderr, new RegExp(`^${name}: coach-harness packages are missing\\. Run \`npm ci\`\\.`));
  }
  const first = hook("commit-check", root, { session_id: "s1", stop_hook_active: false });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json?.decision, "block");
  assert.match(first.json.reason, MISSING);
  const second = hook("commit-check", root, { session_id: "s1", stop_hook_active: true });
  assert.equal(second.code, 0);
  assert.match(second.json?.systemMessage, MISSING);
  rmSync(root, { recursive: true, force: true });
});

// ---------- the shared mutation list ----------

test("the built-ins mutation regex covers every mutation in the Tally adapter, in all three name forms, and no read", () => {
  const adapter = parse(readFileSync(join(REPO, "adapters/loggers/tally/adapter.yaml"), "utf8"));
  const mutations = [...Object.values(adapter.tools.mutations), ...Object.values(adapter.tools.limits ?? {})] as string[];
  assert.ok(mutations.includes("update_training_limits"));
  for (const f of FORMS) {
    for (const t of mutations) assert.ok(isLoggerMutation(f + t), `${f}${t}`);
    for (const t of Object.values(adapter.tools.reads) as string[]) assert.ok(!isLoggerMutation(f + t), `${f}${t} is a read`);
  }
  for (const t of ["mcp__github__update_planned_workout", "mcp__tally__plan_workout_day_x", "Edit", "Bash"]) assert.ok(!isLoggerMutation(t), t);
});

test("review finding 3: settings.json dispatches every mutation in the bootstrap list to guard-writes, log-writes and capture-reads", () => {
  const list = boot.LOGGER_MUTATIONS as readonly string[] | undefined;
  assert.ok(Array.isArray(list) && list.includes("update_training_limits"), "bootstrap exports its mutation list");
  const settings = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf8"));
  type Entry = { matcher?: string; hooks: { command: string }[] };
  const matcherOf = (event: string, hook: string) => {
    const e = (settings.hooks[event] as Entry[]).find((x) => x.hooks.some((h) => h.command.includes(`/.claude/hooks/${hook}.ts`)));
    assert.ok(e?.matcher, `${hook} is registered on ${event} with a matcher`);
    return new RegExp(e!.matcher!);
  };
  const dispatch = [matcherOf("PreToolUse", "guard-writes"), matcherOf("PostToolUse", "log-writes"), matcherOf("PostToolUse", "capture-reads")];
  const adapter = loadAdapterConfig("tally");
  const logger = loadLogger("tally");
  for (const t of list!) {
    for (const f of FORMS) {
      for (const re of dispatch) assert.ok(re.test(f + t), `settings ${re.source} selects ${f}${t}`);
      assert.ok(new RegExp(adapter.matcher).test(f + t), `adapter matcher selects ${f}${t}`);
      assert.ok(boot.LOGGER_MUTATION.test(f + t), `bootstrap regex selects ${f}${t}`);
    }
    assert.ok(logger.isMutation(t), `the adapter treats ${t} as a mutation`);
  }
  // The other direction: the list is the adapter's whole mutation set.
  const yaml = parse(readFileSync(join(REPO, "adapters/loggers/tally/adapter.yaml"), "utf8"));
  assert.deepEqual([...list!].sort(), [...Object.values(yaml.tools.mutations), ...Object.values(yaml.tools.limits ?? {})].sort());
});

test("review finding 5: the repair command is exactly npm ci or npm install, horizontal whitespace only", () => {
  const root = "/repo/root";
  const ok = ["npm ci", "npm install", " npm ci ", "npm\tci", "npm  install", "cd /repo/root && npm ci", 'cd "/repo/root" && npm install', "cd '/repo/root' && npm ci", "cd /repo/root/ && npm ci"];
  const bad = ["npm\nci", "npm ci\n", "npm\r\nci", "npm ci\nrm x", "npm ci --script-shell=sh", "npm install foo", "npm i", "npm run x", "cd /tmp && npm ci",
    "cd $HOME && npm ci", 'cd "$(pwd)" && npm ci', "cd `pwd` && npm ci", 'cd "/repo/root\\" && npm ci', "cd /repo/root\n&& npm ci", "cd /repo/root && npm ci; rm x", "npm ci & rm x"];
  for (const c of ok) assert.ok(boot.isRepairCommand(c, root), JSON.stringify(c));
  for (const c of bad) assert.ok(!boot.isRepairCommand(c, root), JSON.stringify(c));
});
