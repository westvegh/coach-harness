// .claude/settings.json (contracts §7, §13, §14; v0.2): the hook list, the one gate (the
// urgent stop) that fails closed, the records' matchers, and the exact narrow allow rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { URGENT_GATE_MATCHER } from "../../.claude/hooks/urgent-list.ts";
import { loadAdapterConfig } from "../../engine/logger.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const settings = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf8"));
type Entry = { matcher?: string; hooks: { type: string; command: string; timeout?: number; onFailure?: string }[] };
const entries = (event: string): Entry[] => settings.hooks[event] ?? [];
const find = (event: string, name: string) => entries(event).find((e) => e.hooks.some((h) => h.command.includes(`/.claude/hooks/${name}.ts`)));

const FORMS = ["mcp__tally__", "mcp__Tally_Workout__", "mcp__claude_ai_Tally_Workout__"];
const MUTATIONS = ["plan_workout_day", "plan_workout_range", "update_planned_workout", "move_planned_workout", "skip_planned_workout", "delete_planned_workout", "update_user_profile", "update_training_limits"];
const READS = ["get_planned_workout", "get_training_context", "get_workout_history"];

/** The exact allow list (docs/build/v0.2-trust-the-coach.md "What stays"; docs/build/reports/V1-remove-gates.md). */
export const ALLOW_RULES = [
  ...[
    "mode",
    "window-check *",
    "readiness *",
    "signals *",
    "checkin *",
    "weeks *",
    "targets *",
    "block draft *",
    "ids next *",
    "adjust *",
    "loads *",
    "volume *",
    "classify *",
    "opid *",
    "oplog done *",
    "limits schema",
    "limits regions",
    "limits check *",
    "safety scan-notes *",
    "snapshot show",
    "lint-methods *",
    "config-check",
    "urgent status",
    "urgent set *",
    "urgent clear --reason clinician",
    "urgent clear --reason false-alarm",
    "install-git-hooks",
    "prepush-check",
    "push",
    "update --check",
    "help",
    "help *",
    // V2: the files logger, setup v2, worktrees and the update (docs/build/reports/V2-setup-v2.md).
    "plans write *",
    "plans read *",
    "plans done *",
    "setup-check",
    "init-athlete",
    "allow-server *",
    "worktree status",
    "worktree ff-main",
    "worktree ff-branch",
    "commit --message *",
    "tally-mention",
    "tally-mention *",
    "push --branch main",
    "update --check --root *",
    "update --yes --to *",
    // V2b: the fallback to files, the temporary main checkout, the history files.
    "logger set *",
    "worktree main-checkout",
    "worktree remove-temp",
    "history-files",
    // V4: the block write, the Tally day inputs, the snapshot reset (loads --fill and block draft --out fall under loads * and block draft *).
    "block write *",
    "tally-days *",
    "snapshot reset",
    // V7: the fast today (docs/build/reports/V7-fast-today.md).
    "today-brief --stage pre",
    "today-brief --stage post",
    "today-brief --stage post *",
    "today-write-prep --input *",
    "save --run *",
  ].map((c) => `Bash(node engine/cli.ts ${c})`),
  "Bash(npm ci)",
  "Bash(git -C * merge --ff-only *)",
  "Bash(node adapters/signals/oura/fetch.ts *)",
  "Bash(git pull --rebase)",
  // The coach's own files: no prompt to write them (the cache deny rules still win).
  ...["Edit", "Write"].flatMap((t) => ["athlete/**", "plans/**", "coach.yaml", ".tmp/coach/**"].flatMap((p) => [`${t}(${p})`, `${t}(/${p})`])),
  // V2b fix 5: setup reads a training export from Downloads or the Desktop: CSV files only.
  "Read(~/Downloads/*.csv)",
  "Read(~/Desktop/*.csv)",
];

test("the hooks: session-context, safety-detect, urgent-gate, capture-reads, log-writes, commit-check; no guard hook is registered", () => {
  assert.ok(find("SessionStart", "session-context"));
  assert.ok(find("UserPromptSubmit", "safety-detect"));
  assert.ok(find("PreToolUse", "urgent-gate"));
  assert.ok(find("PostToolUse", "capture-reads"));
  assert.ok(find("PostToolUse", "log-writes"));
  assert.ok(find("Stop", "commit-check"));
  assert.equal(entries("PreToolUse").length, 1, "the urgent gate is the only PreToolUse hook");
  const all = JSON.stringify(settings.hooks);
  assert.ok(!/guard-writes|guard-files/.test(all), "the v0.1 guard entries are stubs and not registered");
});

test("the urgent gate sets onFailure: block and timeout 10, and matches every plan mutation on any server plus Edit, Write and MultiEdit", () => {
  const e = find("PreToolUse", "urgent-gate")!;
  const h = e.hooks.find((x) => x.command.includes("urgent-gate"))!;
  assert.equal(h.onFailure, "block");
  assert.equal(h.timeout, 10);
  assert.equal(h.command, `node "$CLAUDE_PROJECT_DIR/.claude/hooks/urgent-gate.ts"`);
  assert.equal(e.matcher, URGENT_GATE_MATCHER);
  const re = new RegExp(e.matcher!);
  for (const t of MUTATIONS) for (const f of [...FORMS, "mcp__sheets__", "mcp__a__"]) assert.ok(re.test(f + t), f + t);
  for (const t of ["Edit", "Write", "MultiEdit"]) assert.ok(re.test(t), t);
  for (const f of FORMS) for (const t of READS) assert.ok(!re.test(f + t), `${f}${t} is a read`);
  for (const t of ["Bash", "Read", "NotebookEdit", "mcp__tally__plan_workout_day_x"]) assert.ok(!re.test(t), t);
});

test("log-writes matches every mutation in all three name forms, and no read", () => {
  const adapter = loadAdapterConfig("tally");
  const m = find("PostToolUse", "log-writes")!.matcher!;
  assert.equal(m, adapter.matcher, "log-writes uses the adapter's matcher");
  const re = new RegExp(m);
  for (const f of FORMS) {
    for (const t of MUTATIONS) assert.ok(re.test(f + t), `${f}${t}`);
    for (const t of READS) assert.ok(!re.test(f + t), `must not match ${f}${t}`);
  }
});

test("capture-reads matches every read and mutation in all three name forms", () => {
  const m = find("PostToolUse", "capture-reads")!.matcher!;
  assert.equal(m, loadAdapterConfig("tally").capture_matcher);
  const re = new RegExp(m);
  for (const f of FORMS) for (const t of [...READS, ...MUTATIONS]) assert.ok(re.test(f + t), `${f}${t}`);
});

test("safety-detect is registered once on UserPromptSubmit with onFailure continue and timeout 10", () => {
  const hooks = entries("UserPromptSubmit").flatMap((e) => e.hooks).filter((h) => h.command.includes("/.claude/hooks/safety-detect.ts"));
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].command, `node "$CLAUDE_PROJECT_DIR/.claude/hooks/safety-detect.ts"`);
  // A crash must never block the user's message.
  assert.equal(hooks[0].onFailure, "continue");
  assert.equal(hooks[0].timeout, 10);
});

test("every command exists; every timeout is 10 s or less", () => {
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

test("the v0.1 guard entries stay as files (a running v0.1 session still calls them until it restarts)", () => {
  for (const f of ["guard-writes.ts", "guard-files.ts"]) assert.ok(existsSync(join(REPO, ".claude/hooks", f)), f);
});

const commands: string[] = Object.values(settings.hooks as Record<string, { hooks: { command: string }[] }[]>).flatMap((list) => list.flatMap((e) => e.hooks.map((h) => h.command)));
const registered = [...new Set(commands.map((c) => /\$CLAUDE_PROJECT_DIR\/(\.claude\/hooks\/[\w-]+\.ts)/.exec(c)?.[1]))];
const staticImports = (file: string) => [...readFileSync(join(REPO, file), "utf8").matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);

test("every hook entry, and the two stubs, imports Node built-ins and the built-ins hook modules only", () => {
  const builtins = (spec: string) => spec.startsWith("node:");
  const LIBS = ["./bootstrap.ts", "./urgent-list.ts"];
  for (const lib of LIBS.map((l) => `.claude/hooks/${l.slice(2)}`)) for (const spec of staticImports(lib)) assert.ok(builtins(spec), `${lib} imports ${spec}`);
  for (const e of [...registered, ".claude/hooks/guard-writes.ts", ".claude/hooks/guard-files.ts"]) {
    for (const spec of staticImports(e!)) assert.ok(builtins(spec) || LIBS.includes(spec), `${e} imports ${spec}`);
  }
  for (const stub of ["guard-writes.ts", "guard-files.ts"]) assert.deepEqual(staticImports(`.claude/hooks/${stub}`), [], `${stub} imports nothing`);
});

test("permissions.allow is exactly the narrow list: no broad rule such as Bash(node *)", () => {
  assert.deepEqual(settings.permissions.allow, ALLOW_RULES);
  for (const r of settings.permissions.allow as string[]) {
    assert.ok(!/^Bash\((node|npm|git|gh) \*\)$/.test(r) && r !== "Bash(*)" && r !== "Bash", `${r} is broad`);
    // Each node rule names one engine subcommand.
    if (r.startsWith("Bash(node ") && r !== "Bash(node adapters/signals/oura/fetch.ts *)") assert.match(r, /^Bash\(node engine\/cli\.ts [a-z-]+( [a-z-]+)*( --reason [a-z-]+| --branch main| \*)?\)$/, r);
    // File rules name only the coach's own files.
    if (r.startsWith("Read(")) assert.match(r, /^Read\(~\/(Downloads|Desktop)\/\*\.csv\)$/, `${r}: read rules name CSV files in Downloads and Desktop only`);
    if (/^(Edit|Write)\(/.test(r)) assert.match(r, /^(Edit|Write)\(\/?(athlete\/\*\*|plans\/\*\*|coach\.yaml|\.tmp\/coach\/\*\*)\)$/, r);
  }
});

test("permissions.deny keeps the snapshot cache; the v0.1 hold and pending rules are gone", () => {
  const deny: string[] = settings.permissions.deny;
  assert.ok(deny.includes("Edit(athlete/.cache/**)") && deny.includes("Write(athlete/.cache/**)"));
  assert.ok(!deny.some((d) => /hold\.yaml|safety-pending/.test(d)), deny.join(", "));
});
