// docs/contracts.md §20 item 27: the guard-files fast path (.claude/hooks/fast-files.ts) and the hook entry
// files. The fast path may only allow what engine/protect.ts fileGuard allows, plus the
// read-only Bash allowlist. Every entry imports built-ins only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as engine from "../../engine/protect.ts";
import * as fast from "../../.claude/hooks/fast-files.ts";
import { COMPOUND_ALLOWED, COMPOUND_ALLOWED_UNATTENDED, COMPOUND_ATTACKS } from "../guard/compound-commands.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR"].includes(k)));

function instance(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-fast-"));
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  cpSync(join(REPO, "templates/athlete/limits.yaml"), join(dir, "athlete/limits.yaml"));
  writeFileSync(join(dir, "notes.md"), "a\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

function guardFiles(root: string, input: unknown, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(REPO, ".claude/hooks/guard-files.ts")], { input: JSON.stringify(input), encoding: "utf8", env: { ...BASE_ENV, CLAUDE_PROJECT_DIR: root, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, decision: r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : undefined };
}

test("the fast path's protected lists equal engine/protect.ts", () => {
  assert.deepEqual(fast.PROTECTED_FILES, engine.PROTECTED_FILES);
  assert.deepEqual(fast.PROTECTED_DIRS, engine.PROTECTED_DIRS);
  assert.equal(fast.PROPOSALS_DIR, engine.PROPOSALS_DIR);
});

// The fast path runs only interactive: unattended it returns null (launch review finding 1; tests/guard/unattended-allowlist.test.ts).
test("every fast allow is an engine allow (Bash and file tools, interactive)", () => {
  const root = instance();
  const commands = [
    "npm test", "npm run typecheck", "echo hi", "rm -rf *", "node --version", "make build", "true", "ls", "ls -la", "pwd",
    "rm limits.yaml", "rm hold.yaml", "mv x coach.yaml", "rm .safety-pending", "cat > snapshot.json", "rm -rf engine", "rm -rf methods",
    "rm -rf adapters", "rm -rf git-hooks", "rm -rf .claude", "rm -rf .cache", "git checkout .", "git merge x", "gh pr merge 3", "git -C . reset --hard",
    "rm -rf .", "rm -rf ..", "rm -rf ./", "rm athlete/limits.yaml", "x=engine rm $x", "rm 'engine'", "rm e\\ngine", "rm `echo engine`",
    "rm $(echo engine)", "GIT merge x", "git config core.hooksPath x", "rm .git/hooks/pre-push", "cd .. && rm -rf x", "rm -rf ATHLETE",
    "node engine/cli.ts hold clear", "ls .claude", "cat athlete/limits.yaml", "cat x > athlete/limits.yaml", "grep -r x engine | tee engine/a",
    "ls; rm engine/x", "head -n 5 coach.yaml", "grep -i x methods", "tail -f athlete/hold.yaml", "wc -l engine/protect.ts", "stat .claude",
    // compound commands: engine calls and compounds
    ...COMPOUND_ALLOWED, ...COMPOUND_ATTACKS, "node engine/cli.ts hold status", "node engine/cli.ts opid; grep x adapters/loggers/tally/adapter.yaml",
    "node engine/cli.ts window-check --kind daily && node engine/cli.ts mode", "node engine/cli.ts hold clear", "node engine/cli.ts hold --approved clear",
    "node engine/cli.ts hold", "node engine/hold.ts status; ls engine", "node engine/cli.ts opid; rm engine/x", "node engine/cli.ts opid | tee x",
    "node engine/cli.ts opid\nrm -rf methods", "ls engine || node engine/cli.ts hold clear-pending", "node engine/cli.ts opid; cat athlete/limits.yaml",
  ];
  const files = ["notes.md", join(root, "notes.md"), "docs/x.md", "/tmp/outside.txt", "coach.yaml", "athlete/limits.yaml", "athlete/hold.yaml",
    "athlete/.safety-pending", "athlete/movements.local.yaml", "athlete/.cache/snapshot.json", "engine/validate.ts", "methods/x", ".claude/settings.json",
    "adapters/loggers/tally/adapter.yaml", "git-hooks/pre-push", "athlete/proposals/P-1.yaml", "athlete/log/2026-10.md", "./engine/../engine/x.ts", "athlete/../engine/x"];
  const calls: [string, Record<string, unknown>][] = [
    ...commands.map((command): [string, Record<string, unknown>] => ["Bash", { command }]),
    ...files.flatMap((file_path) => (["Edit", "Write", "MultiEdit", "NotebookEdit"] as const).map((t): [string, Record<string, unknown>] => [t, t === "NotebookEdit" ? { notebook_path: file_path } : { file_path, content: "x", old_string: "a", new_string: "b", edits: [] }])),
    ["Bash", {}],
    ["Edit", {}],
  ];
  let fastAllows = 0;
  for (const [tool, args] of calls) {
    if (fast.fastFileDecision(tool, args, root) !== "allow") continue;
    fastAllows++;
    for (const mode of ["interactive"] as const) {
      const d = engine.fileGuard({ tool_name: tool, tool_input: args, mode, root, branch: "main", proposalsOnMain: [] });
      assert.equal(d.decision, "allow", `fast allowed ${tool} ${JSON.stringify(args)} but the engine says ${d.decision}: ${d.reason}`);
    }
  }
  assert.ok(fastAllows >= 20, `the fast path allows the common cases (${fastAllows})`);
  for (const [p, base] of [
    ...engine.PROTECTED_FILES.map((f) => [f, f.split("/").at(-1)!]),
    ...engine.PROTECTED_DIRS.map((d) => [`${d}x`, d.split("/").filter(Boolean).at(-1)!]),
    ["coach.yaml", "coach.yaml"],
  ]) {
    for (const command of [`rm ${p}`, `rm ${base}`, `touch ${base}`]) assert.equal(fast.fastFileDecision("Bash", { command }, root), null, command);
    assert.equal(fast.fastFileDecision("Edit", { file_path: p }, root), null, p);
  }
});

test("compound commands: the fast path allows simple engine calls and plain compounds, and nothing the engine denies", () => {
  const root = instance();
  for (const command of ["node engine/cli.ts hold status", "node engine/cli.ts hold set --reason knee", "node engine/cli.ts opid --date 2026-10-14; grep x adapters/loggers/tally/adapter.yaml", "node engine/cli.ts mode | head -n 1", "node engine/cli.ts weeks\nnode engine/cli.ts hold status"]) {
    assert.equal(fast.fastFileDecision("Bash", { command }, root), "allow", command);
  }
  for (const command of [...COMPOUND_ATTACKS, "node engine/cli.ts hold clear", "node engine/cli.ts hold --reason status clear", "node engine/cli.ts opid; rm engine/x", "node engine/cli.ts opid #x", "node engine/cli.ts opid > x"]) {
    assert.equal(fast.fastFileDecision("Bash", { command }, root), null, JSON.stringify(command));
  }
});

test("compound commands: the engine's read-only rule equals the fast path's", () => {
  const corpus = ["ls .claude", "cat athlete/limits.yaml", "grep -rn x engine", "ls", "\tls\t-la\t", "cat x > y", "ls; rm x", "grep x | tee y", "sed -i s/a/b/ x", "find . -exec rm {} ;",
    "ls -exec", "grep --in-place x", "LC_ALL=C ls", "ls ~", "ls a\\b", "ls =ls", "grep 'x' a", "", "catx", ...SHELL_ATTACKS];
  for (const c of corpus) assert.equal(engine.isReadOnlyBash(c), fast.isReadOnlyBash(c), JSON.stringify(c));
});

test("compound commands through the hook: allowlisted engine compounds pass unattended; the attack set denies", () => {
  const root = instance();
  assert.equal(guardFiles(root, { tool_name: "Bash", tool_input: { command: 'node engine/cli.ts window-check --kind daily; echo "exit $?"' } }, { COACH_UNATTENDED: "1" }).decision, "deny", "echo is not on the unattended allowlist");
  for (const command of COMPOUND_ALLOWED_UNATTENDED.slice(0, 5)) {
    const r = guardFiles(root, { tool_name: "Bash", tool_input: { command } }, { COACH_UNATTENDED: "1" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "", command);
  }
  for (const command of ["ls; rm engine/x", "cat x > athlete/limits.yaml", "node engine/cli.ts hold clear-pending", "git checkout HEAD~1 -- .", "true && sed -i '' s/a/b/ athlete/limits.yaml", "node engine/cli.ts opid; rm ENGINE/x"]) {
    assert.equal(guardFiles(root, { tool_name: "Bash", tool_input: { command } }, { COACH_UNATTENDED: "1" }).decision, "deny", command);
    assert.equal(guardFiles(root, { tool_name: "Bash", tool_input: { command } }).decision, "ask", command);
  }
});

test("read-only Bash allowlist: single ls, cat, head, tail, wc, stat or grep with no shell operators", () => {
  for (const c of ['grep -i "a b" methods', "grep 'x' a", 'grep -n "opId" adapters/loggers/tally/adapter.yaml', "ls .claude", "cat athlete/limits.yaml", "head -n 3 coach.yaml", "tail -n 20 athlete/log/2026-10.md", "wc -l engine/protect.ts", "stat .claude", "grep -rn x engine", "ls", "ls *.ts", "ls ?ngine", "stat a+b,c@d:e", "\tls\t-la\t"]) {
    assert.ok(fast.isReadOnlyBash(c), c);
  }
  for (const c of [
    "cat x > athlete/limits.yaml", "grep -r x engine | tee engine/a", "ls; rm engine/x", "ls && rm x", "ls || rm x", "ls & rm x", "cat < x", "cat $(rm x)",
    "cat `rm x`", "ls\nrm x", "ls\rrm x", "xargs rm", "grep x | xargs rm", "cat x tee y", "sed -i s/a/b/ x", "find . -exec rm {} ;", "ls -exec", "grep --in-place x",
    "rm x", "/bin/ls", "LC_ALL=C ls", "cp a b", "echo x", "", "lsof", "catx",
    // Review finding 1: only letters, digits and . _ / - , + @ : * ? in the arguments.
    ...SHELL_ATTACKS, 'grep "a$b" x', 'grep "a*" x', 'grep "a\\b" x', `grep "a'b" x`, 'grep "x"y z', "grep 'a`b' x", 'grep "(e:x)" y', "ls ~", "ls {a,b}", "ls [ab]", "ls !x", "ls #x", "ls a\\b", "ls $HOME", "ls =ls", "grep --include=x y", "ls a%b", "ls a^b",
  ]) {
    assert.ok(!fast.isReadOnlyBash(c), JSON.stringify(c));
  }
});

test("read-only Bash allowlist through the hook: allowed interactive, denied unattended (contracts §23); writes still denied", () => {
  const root = instance();
  for (const command of ["ls .claude", "cat athlete/limits.yaml"]) {
    const r = guardFiles(root, { tool_name: "Bash", tool_input: { command } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "", command);
    assert.equal(guardFiles(root, { tool_name: "Bash", tool_input: { command } }, { COACH_UNATTENDED: "1" }).decision, "deny", command);
  }
  for (const command of ["cat x > athlete/limits.yaml", "grep -r x engine | tee engine/a", "ls; rm engine/x"]) {
    assert.equal(guardFiles(root, { tool_name: "Bash", tool_input: { command } }, { COACH_UNATTENDED: "1" }).decision, "deny", command);
    assert.equal(guardFiles(root, { tool_name: "Bash", tool_input: { command } }).decision, "ask", command);
  }
});

// ---------- review finding 1: zsh expansions run commands ----------

const SHELL_ATTACKS = ["ls engine/protect.ts(e:touch engine/pwned:)", "cat =(touch engine/pwned)", "ls engine/protect.ts(+touch)", "ls *(e:'touch engine/pwned':)"];
const zsh = spawnSync("zsh", ["-c", "true"]).status === 0;

/** Runs `command` in a scratch folder under `shell`; true when it created engine/pwned. */
function runsPayload(shell: string, command: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "coach-shell-"));
  mkdirSync(join(dir, "engine"));
  writeFileSync(join(dir, "engine/protect.ts"), "x\n");
  spawnSync(shell, ["-c", command], { cwd: dir, encoding: "utf8", env: { ...BASE_ENV, PATH: process.env.PATH ?? "" }, timeout: 5000 });
  return existsSync(join(dir, "engine/pwned"));
}

test("review finding 1: inputs that run a command under zsh never pass the read-only allowlist or the hook", () => {
  if (zsh) assert.ok(runsPayload("zsh", SHELL_ATTACKS[0]), "zsh runs the glob-qualifier payload (the premise of this test)");
  const root = instance();
  for (const command of SHELL_ATTACKS) {
    assert.ok(!fast.isReadOnlyBash(command), command);
    assert.equal(fast.fastFileDecision("Bash", { command }, root), null, command);
    assert.equal(guardFiles(root, { tool_name: "Bash", tool_input: { command } }, { COACH_UNATTENDED: "1" }).decision, "deny", command);
  }
});

test("review finding 1: every allowlisted read-only command runs nothing under bash and zsh", () => {
  const allowed = ["ls engine", "ls -la engine", "cat engine/protect.ts", "head -n 1 engine/protect.ts", "tail -n 1 engine/protect.ts", "wc -l engine/protect.ts", "stat engine/protect.ts", "grep -rn x engine", "ls *", "ls engine/*.ts", "ls ?ngine", "cat a,b+c@d:e"];
  for (const command of allowed) {
    assert.ok(fast.isReadOnlyBash(command), command);
    for (const shell of zsh ? ["bash", "zsh"] : ["bash"]) assert.equal(runsPayload(shell, command), false, `${shell}: ${command}`);
  }
  for (const command of SHELL_ATTACKS) for (const shell of zsh ? ["bash", "zsh"] : ["bash"]) runsPayload(shell, command); // must not throw
});

// ---------- review finding 4: case variants on case-insensitive volumes ----------

test("review finding 4: protected paths match without regard to case, in the fast path and the engine", () => {
  const root = instance();
  const flip = root.replace(/coach-fast-/, "COACH-FAST-");
  const files = ["ENGINE/protect.ts", "Athlete/Limits.yaml", ".CLAUDE/settings.json", "Coach.YAML", "ATHLETE/.Cache/snapshot.json", "Methods/x", `${root}/Engine/x.ts`, `${flip}/engine/x.ts`, `${flip}/athlete/limits.yaml`];
  for (const file_path of files) {
    assert.equal(fast.fastFileDecision("Write", { file_path, content: "x" }, root), null, `fast: ${file_path}`);
    for (const [mode, want] of [["interactive", "ask"], ["unattended", "deny"]] as const) {
      const d = engine.fileGuard({ tool_name: "Write", tool_input: { file_path, content: "x" }, mode, root, branch: "main", proposalsOnMain: [] });
      assert.equal(d.decision, want, `engine ${mode}: ${file_path} (${d.reason})`);
    }
    assert.equal(guardFiles(root, { tool_name: "Write", tool_input: { file_path, content: "x" } }, { COACH_UNATTENDED: "1" }).decision, "deny", `hook: ${file_path}`);
  }
  for (const command of ["rm ENGINE/protect.ts", "rm Athlete/Limits.yaml", "echo x > .CLAUDE/settings.json", "rm -rf METHODS", "mv x COACH.yaml", "git checkout -- ENGINE", `rm ${flip}/engine/x.ts`]) {
    assert.equal(fast.fastFileDecision("Bash", { command }, root), null, `fast: ${command}`);
    const d = engine.fileGuard({ tool_name: "Bash", tool_input: { command }, mode: "unattended", root, branch: "main", proposalsOnMain: [] });
    assert.equal(d.decision, "deny", `engine: ${command} (${d.reason})`);
  }
});

// ---------- the entry files ----------

const settings = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf8"));
const commands: string[] = Object.values(settings.hooks as Record<string, { hooks: { command: string }[] }[]>).flatMap((list) => list.flatMap((e) => e.hooks.map((h) => h.command)));
const entries = [...new Set(commands.map((c) => /\$CLAUDE_PROJECT_DIR\/(\.claude\/hooks\/[\w-]+\.ts)/.exec(c)?.[1]))];
const staticImports = (file: string) => [...readFileSync(join(REPO, file), "utf8").matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);

test("every hook command path in .claude/settings.json exists", () => {
  assert.ok(entries.length >= 7, String(entries.length));
  for (const e of entries) {
    assert.ok(e, "every command names .claude/hooks/<name>.ts");
    assert.ok(existsSync(join(REPO, e!)), `${e} exists`);
  }
});

test("every hook entry imports Node built-ins and the built-ins hook modules only", () => {
  const builtins = (spec: string) => spec.startsWith("node:");
  for (const lib of [".claude/hooks/bootstrap.ts", ".claude/hooks/fast-files.ts"]) {
    for (const spec of staticImports(lib)) assert.ok(builtins(spec), `${lib} imports ${spec}`);
  }
  for (const e of entries) {
    const specs = staticImports(e!);
    assert.ok(specs.length > 0, e);
    for (const spec of specs) assert.ok(builtins(spec) || spec === "./bootstrap.ts" || spec === "./fast-files.ts", `${e} imports ${spec}`);
  }
});
