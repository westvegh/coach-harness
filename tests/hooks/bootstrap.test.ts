// The hooks work before `npm ci` (docs/contracts.md §20 item 27). Each hook runs from a copy of the repo with
// no node_modules (so `yaml` and every engine module that needs it cannot load) and
// decides with Node built-ins only.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { PLAN_MUTATIONS } from "../../.claude/hooks/urgent-list.ts";
import { loadAdapterConfig } from "../../engine/logger.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const FORMS = ["mcp__tally__", "mcp__Tally_Workout__", "mcp__claude_ai_Tally_Workout__"];
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR", "COACH_NOW", "NODE_PATH"].includes(k)));
const MISSING = /coach-harness packages are missing\. Run `npm ci`\./;

// The suite also runs in an athlete's copy (the update skill runs `npm test`), so a bare
// copy leaves out the athlete's own files: coach.yaml decides the "no coach.yaml" cases,
// and athlete data never goes to the temp folder.
const LEFT_OUT = /^(node_modules|\.git|coach\.yaml|athlete|plans|\.tmp|\.claude\/settings\.local\.json)(\/|$)/;
const copies: string[] = [];
after(() => {
  for (const d of copies) rmSync(d, { recursive: true, force: true });
});

/** A copy of the repo without node_modules, .git or the athlete's files; with `coach`, an athlete instance. */
function bareCopy(opts: { coach: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-bare-"));
  copies.push(dir);
  cpSync(REPO, dir, {
    recursive: true,
    filter: (src) => !LEFT_OUT.test(relative(REPO, src)),
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
const edit = (root: string, rel = "engine/cli.ts") => ({ session_id: "s1", tool_name: "Edit", tool_input: { file_path: join(root, rel), old_string: "a", new_string: "b" } });
const bash = (command: string) => ({ session_id: "s1", tool_name: "Bash", tool_input: { command } });
const tally = (tool: string) => ({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: tool, tool_input: { date: "2026-10-15" }, tool_use_id: "toolu_1" });
const prompt = (root: string, text: string) => ({ session_id: "s1", hook_event_name: "UserPromptSubmit", cwd: root, prompt: text });
const stopFile = (root: string) => join(root, "athlete/.urgent-stop");
const writeStopFile = (root: string) => {
  mkdirSync(join(root, "athlete"), { recursive: true });
  writeFileSync(stopFile(root), JSON.stringify({ version: 1, at: "2026-10-12T07:00:00Z", terms: ["chest pain"], sources: ["chat"] }));
};

// ---------- no coach.yaml (a fresh clone) ----------

test("no coach.yaml, no packages: the v0.1 guard stubs allow everything", () => {
  const root = bareCopy({ coach: false });
  for (const name of ["guard-files", "guard-writes"]) {
    silent(hook(name, root, edit(root)), `${name} Edit`);
    silent(hook(name, root, bash("rm -rf athlete")), `${name} Bash`);
    silent(hook(name, root, tally("mcp__tally__plan_workout_day")), `${name} Tally write`);
    silent(hook(name, root, "{"), `${name} bad input`);
  }
});

test("no coach.yaml, no packages: the urgent gate allows with no stop, and denies a plan write with one", () => {
  const root = bareCopy({ coach: false });
  for (const f of FORMS) silent(hook("urgent-gate", root, tally(f + "plan_workout_day")), f);
  silent(hook("urgent-gate", root, edit(root, "plans/2026-W42.csv")), "plans/ edit");
  writeStopFile(root);
  for (const f of [...FORMS, "mcp__some_other_server__"]) {
    const r = hook("urgent-gate", root, tally(f + "update_planned_workout"));
    assert.equal(decision(r), "deny", f);
    assert.match(reason(r), /URGENT STOP/);
  }
  assert.equal(decision(hook("urgent-gate", root, edit(root, "plans/2026-W42.csv"))), "deny", "plans/ edit");
  silent(hook("urgent-gate", root, edit(root, "athlete/log/2026-10.md")), "an edit outside plans/");
  silent(hook("urgent-gate", root, tally("mcp__tally__get_planned_workout")), "a read");
});

test("no coach.yaml, no packages: safety-detect writes no file and says the detector could not run", () => {
  const root = bareCopy({ coach: false });
  const r = hook("safety-detect", root, prompt(root, "I have chest pain"));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(stopFile(root)), false, "no stop file before setup when the detector cannot run");
  assert.equal(r.json?.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.match(context(r), /^SAFETY: the urgent warning-sign detector could not run \(packages are not installed\)/);
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

test("coach.yaml, no packages: the guard stubs allow; the urgent gate still denies a plan write under a stop", () => {
  const root = bareCopy({ coach: true });
  for (const name of ["guard-files", "guard-writes"]) silent(hook(name, root, tally("mcp__tally__update_planned_workout")), name);
  silent(hook("urgent-gate", root, tally("mcp__tally__update_planned_workout")), "no stop");
  writeStopFile(root);
  assert.equal(decision(hook("urgent-gate", root, tally("mcp__tally__update_planned_workout"))), "deny");
});

test("coach.yaml, no packages: safety-detect exits 0 and asks the coach to check for urgent signs itself", () => {
  const root = bareCopy({ coach: true });
  const r = hook("safety-detect", root, prompt(root, "I have chest pain"));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(stopFile(root)), false);
  assert.match(context(r), /^SAFETY: the urgent warning-sign detector failed/);
  assert.match(context(r), /node engine\/cli\.ts urgent set/);
});

test("coach.yaml, no packages: session-context, capture-reads and log-writes report the missing packages; commit-check needs none", () => {
  const root = bareCopy({ coach: true });
  const s = hook("session-context", root, { session_id: "s1", hook_event_name: "SessionStart" });
  assert.equal(s.code, 0, s.stderr);
  assert.match(context(s), MISSING);
  for (const name of ["capture-reads", "log-writes"]) {
    const r = hook(name, root, { ...tally("mcp__tally__plan_workout_day"), tool_response: [] });
    assert.equal(r.code, 2, `${name}: exit ${r.code}`);
    assert.match(r.stderr, new RegExp(`^${name}: coach-harness packages are missing\\. Run \`npm ci\`\\.`));
  }
  // Built-ins only, and the bare copy is no git repository: nothing to record, no output.
  silent(hook("commit-check", root, { session_id: "s1", stop_hook_active: false }), "commit-check");
  rmSync(root, { recursive: true, force: true });
});

// ---------- the shared mutation list ----------

test("the urgent gate's mutation list is the Tally adapter's whole mutation set", () => {
  const adapter = parse(readFileSync(join(REPO, "adapters/loggers/tally/adapter.yaml"), "utf8"));
  const mutations = [...Object.values(adapter.tools.mutations), ...Object.values(adapter.tools.limits ?? {})] as string[];
  assert.ok(mutations.includes("update_training_limits"));
  assert.deepEqual([...PLAN_MUTATIONS].sort(), [...mutations].sort());
});

test("settings.json dispatches every mutation to the urgent gate (any server name), log-writes and capture-reads (the Tally forms)", () => {
  const settings = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf8"));
  type Entry = { matcher?: string; hooks: { command: string }[] };
  const matcherOf = (event: string, hook: string) => {
    const e = (settings.hooks[event] as Entry[]).find((x) => x.hooks.some((h) => h.command.includes(`/.claude/hooks/${hook}.ts`)));
    assert.ok(e?.matcher, `${hook} is registered on ${event} with a matcher`);
    return new RegExp(e!.matcher!);
  };
  const gate = matcherOf("PreToolUse", "urgent-gate");
  const records = [matcherOf("PostToolUse", "log-writes"), matcherOf("PostToolUse", "capture-reads")];
  const adapter = loadAdapterConfig("tally");
  for (const t of PLAN_MUTATIONS) {
    for (const f of [...FORMS, "mcp__google_sheets__", "mcp__x__"]) assert.ok(gate.test(f + t), `the gate selects ${f}${t}`);
    for (const f of FORMS) {
      for (const re of records) assert.ok(re.test(f + t), `settings ${re.source} selects ${f}${t}`);
      assert.ok(new RegExp(adapter.matcher).test(f + t), `adapter matcher selects ${f}${t}`);
    }
  }
  for (const t of ["Edit", "Write", "MultiEdit"]) assert.ok(gate.test(t), t);
  for (const t of ["Bash", "Read", "mcp__tally__get_planned_workout", "mcp__tally__plan_workout_day_x", "plan_workout_day"]) assert.ok(!gate.test(t), t);
});
