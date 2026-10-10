// .claude/settings.json (contracts §7, §13, §14): every hook is registered; the guard
// hooks fail closed; each matcher matches all three observed tool-name forms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAdapterConfig } from "../../engine/logger.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const settings = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf8"));
type Entry = { matcher?: string; hooks: { type: string; command: string; timeout?: number; onFailure?: string }[] };
const entries = (event: string): Entry[] => settings.hooks[event] ?? [];
const find = (event: string, name: string) => entries(event).find((e) => e.hooks.some((h) => h.command.includes(`/.claude/hooks/${name}.ts`)));

const FORMS = ["mcp__tally__", "mcp__Tally_Workout__", "mcp__claude_ai_Tally_Workout__"];
const MUTATIONS = ["plan_workout_day", "plan_workout_range", "update_planned_workout", "move_planned_workout", "skip_planned_workout", "delete_planned_workout", "update_user_profile", "update_training_limits"];
const READS = ["get_planned_workout", "get_training_context", "get_workout_history"];

test("both guard hooks set onFailure: block and timeout 10", () => {
  for (const name of ["guard-writes", "guard-files"]) {
    const e = find("PreToolUse", name);
    assert.ok(e, `${name} is registered on PreToolUse`);
    const h = e!.hooks.find((x) => x.command.includes(name))!;
    assert.equal(h.onFailure, "block", name);
    assert.equal(h.timeout, 10, name);
    assert.equal(h.command, `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${name}.ts"`);
  }
});

test("guard-writes and log-writes match every mutation in all three name forms, and no read", () => {
  const adapter = loadAdapterConfig("tally");
  for (const [event, name] of [["PreToolUse", "guard-writes"], ["PostToolUse", "log-writes"]] as const) {
    const m = find(event, name)!.matcher!;
    assert.equal(m, adapter.matcher, `${name} uses the adapter's matcher`);
    const re = new RegExp(m);
    for (const f of FORMS) {
      for (const t of MUTATIONS) assert.ok(re.test(f + t), `${name}: ${f}${t}`);
      for (const t of READS) assert.ok(!re.test(f + t), `${name} must not match ${f}${t}`);
    }
    assert.ok(!re.test("mcp__github__update_planned_workout_x"));
  }
});

test("capture-reads matches every read and mutation in all three name forms", () => {
  const m = find("PostToolUse", "capture-reads")!.matcher!;
  assert.equal(m, loadAdapterConfig("tally").capture_matcher);
  const re = new RegExp(m);
  for (const f of FORMS) for (const t of [...READS, ...MUTATIONS]) assert.ok(re.test(f + t), `${f}${t}`);
});

test("guard-files covers Edit, Write, MultiEdit, NotebookEdit and Bash", () => {
  const re = new RegExp(find("PreToolUse", "guard-files")!.matcher!);
  for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]) assert.ok(re.test(t), t);
  assert.ok(!re.test("Read"));
});

test("safety-detect is registered once on UserPromptSubmit with onFailure continue and timeout 10", () => {
  const hooks = entries("UserPromptSubmit").flatMap((e) => e.hooks).filter((h) => h.command.includes("/.claude/hooks/safety-detect.ts"));
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].command, `node "$CLAUDE_PROJECT_DIR/.claude/hooks/safety-detect.ts"`);
  // A crash must never block the user's message; the hook writes its own detector-error pending file.
  assert.equal(hooks[0].onFailure, "continue");
  assert.equal(hooks[0].timeout, 10);
});

test("session-context, commit-check registered; every command exists; every timeout is 10 s or less", () => {
  assert.ok(find("SessionStart", "session-context"));
  assert.ok(find("Stop", "commit-check"));
  for (const list of Object.values(settings.hooks) as Entry[][]) {
    for (const e of list) {
      for (const h of e.hooks) {
        const file = /\$CLAUDE_PROJECT_DIR\/(\.claude\/hooks\/[\w-]+\.ts)/.exec(h.command)?.[1];
        assert.ok(file && existsSync(join(REPO, file)), h.command);
        assert.ok(typeof h.timeout === "number" && h.timeout <= 10, h.command);
      }
    }
  }
});

test("permissions.deny covers the files no skill edits", () => {
  const deny: string[] = settings.permissions.deny;
  for (const p of ["athlete/hold.yaml", "athlete/.safety-pending", "athlete/.cache/**"]) {
    assert.ok(deny.includes(`Edit(${p})`) && deny.includes(`Write(${p})`), p);
  }
});
