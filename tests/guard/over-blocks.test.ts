// Guard over-blocks seen in the eval re-run (contracts §23): a file-descriptor duplication
// (2>&1) names no file; engine output may go to the scratch folder .tmp/coach/; a read-only
// command may carry simple quoted arguments. The attack set stays denied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileGuard, isReadOnlyBash, normalizeSegment } from "../../engine/protect.ts";
import * as fast from "../../.claude/hooks/fast-files.ts";
import { COMPOUND_ATTACKS } from "./compound-commands.ts";
import { REPO } from "./fixtures.ts";

const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR"].includes(k)));

function instance(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coach-over-")));
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  mkdirSync(join(dir, ".tmp/coach"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

type Mode = "interactive" | "unattended";
const bash = (root: string, command: string, mode: Mode) => fileGuard({ tool_name: "Bash", tool_input: { command }, mode, root, branch: "main", proposalsOnMain: [] });

function hook(root: string, command: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(REPO, ".claude/hooks/guard-files.ts")], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8", env: { ...BASE_ENV, CLAUDE_PROJECT_DIR: root, ...env } });
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : r.status === 0 ? "allow" : `exit ${r.status}`;
}

test("A1: 2>&1, >&2 and 1>&2 on an engine call pass like the same call without them, in both modes", () => {
  const root = instance();
  const calls = ["node engine/cli.ts mode", "node engine/cli.ts weeks --from 2026-09-07 --to 2026-10-11", "node engine/cli.ts hold status"];
  for (const c of calls) {
    for (const dup of [" 2>&1", " >&2", " 1>&2"]) {
      for (const mode of ["interactive", "unattended"] as const) {
        const d = bash(root, c + dup, mode);
        assert.equal(d.decision, bash(root, c, mode).decision, `${mode}: ${c + dup} (${d.reason})`);
        assert.equal(d.decision, "allow", `${mode}: ${c + dup}`);
      }
      assert.equal(fast.fastFileDecision("Bash", { command: c + dup }, root), "allow", `fast: ${c + dup}`);
    }
  }
  // Seen in the eval runs (05, 06, 14), through the hook.
  assert.equal(hook(root, "node engine/cli.ts mode 2>&1"), "allow");
  assert.equal(hook(root, "node engine/cli.ts mode 2>&1", { COACH_UNATTENDED: "1" }), "allow");
  assert.equal(hook(root, "node engine/cli.ts opid --date 2026-10-14 2>&1 | head -n 5"), "allow");
  // A duplication never hides a write, and `hold clear` still needs the user.
  for (const c of ["node engine/cli.ts hold clear 2>&1", "node engine/cli.ts mode 2>&1 > athlete/limits.yaml", "node engine/cli.ts mode >& athlete/limits.yaml", "rm engine/x 2>&1", "node engine/cli.ts mode 2>&1; rm -rf methods"]) {
    assert.equal(bash(root, c, "interactive").decision, "ask", c);
    assert.equal(bash(root, c, "unattended").decision, "deny", c);
    assert.equal(fast.fastFileDecision("Bash", { command: c }, root), null, `fast: ${c}`);
  }
});

test("A2: engine output into .tmp/coach/ passes in both modes; any other target keeps the strict rules", () => {
  const root = instance();
  for (const c of ["node engine/cli.ts weeks --from 2026-09-07 --to 2026-10-11 > .tmp/coach/weeks.json", "node engine/cli.ts readiness --date 2026-10-14 >> .tmp/coach/r.json", "node engine/cli.ts mode 2>&1 > .tmp/coach/mode.json", `node engine/cli.ts mode > ${root}/.tmp/coach/m.json`, "node engine/cli.ts mode >.tmp/coach/m.json"]) {
    for (const mode of ["interactive", "unattended"] as const) {
      const d = bash(root, c, mode);
      assert.equal(d.decision, "allow", `${mode}: ${c} (${d.reason})`);
    }
  }
  assert.equal(hook(root, "node engine/cli.ts weeks --from 2026-09-07 --to 2026-10-11 > .tmp/coach/weeks.json", { COACH_UNATTENDED: "1" }), "allow");
  mkdirSync(join(root, "engine"));
  symlinkSync(join(root, "engine"), join(root, ".tmp/coach/link"));
  const bad = [
    "node engine/cli.ts mode > athlete/limits.yaml",
    "node engine/cli.ts mode > .tmp/coach/../../engine/x.ts",
    "node engine/cli.ts mode > .tmp/coach/x.sh",
    "node engine/cli.ts mode > .tmp/coach/link/validate.ts",
    "node engine/cli.ts mode > .tmp/coach/link/x.json",
    "node engine/cli.ts mode > .tmp/other.json",
    "node engine/cli.ts mode > coach.yaml",
    "node engine/cli.ts hold clear > .tmp/coach/x.json",
    "node engine/cli.ts mode < x > .tmp/coach/x.json",
    "node engine/cli.ts mode > .tmp/coach/a.json > athlete/limits.yaml",
  ];
  for (const c of bad) {
    assert.notEqual(bash(root, c, "unattended").decision, "allow", `unattended: ${c}`);
    assert.notEqual(bash(root, c, "interactive").decision, "allow", `interactive: ${c}`);
  }
  // Unattended, only the engine CLI may redirect, and only into .tmp/coach/.
  assert.equal(bash(root, "git log > .tmp/coach/log.txt", "unattended").decision, "deny");
  assert.equal(bash(root, "date -u > .tmp/coach/now.txt", "unattended").decision, "deny");
});

test("A3: a read-only command may carry simple quoted arguments; zsh tricks stay denied", () => {
  const root = instance();
  for (const c of ['grep -n "opId" adapters/loggers/tally/adapter.yaml', "grep -rn 'NA-REC-008' methods", 'grep -n "pain threshold" athlete/limits.yaml', 'grep -c "a:b/c@d,e+f" x']) {
    assert.ok(isReadOnlyBash(c), c);
    assert.ok(fast.isReadOnlyBash(c), `fast: ${c}`);
    assert.equal(bash(root, c, "interactive").decision, "allow", c);
  }
  assert.equal(hook(root, 'grep -n "opId" adapters/loggers/tally/adapter.yaml'), "allow");
  // Unattended keeps the narrow allowlist: read-only commands are not on it.
  assert.equal(bash(root, 'grep -n "opId" adapters/loggers/tally/adapter.yaml', "unattended").decision, "deny");
  const zshTricks = [
    'ls "engine/protect.ts"(e:touch engine/pwned:)',
    "ls engine/protect.ts(e:'touch engine/pwned':)",
    'cat =(touch engine/pwned)',
    'cat "=(touch engine/pwned)"x',
    'grep "$(touch engine/pwned)" x',
    'grep "`touch engine/pwned`" x',
    "grep 'a' 'b'(e:x)",
    'grep "a\\" b" x',
    'grep "*(e:touch engine/pwned)" x',
  ];
  for (const c of zshTricks) {
    assert.ok(!isReadOnlyBash(c), c);
    assert.ok(!fast.isReadOnlyBash(c), `fast: ${c}`);
  }
  const zsh = spawnSync("zsh", ["-c", "true"]).status === 0;
  if (zsh) {
    for (const c of ['grep -n "opId" engine/protect.ts', "grep -rn 'a b' engine"]) {
      const dir = mkdtempSync(join(tmpdir(), "coach-zsh-"));
      mkdirSync(join(dir, "engine"));
      writeFileSync(join(dir, "engine/protect.ts"), "opId\n");
      spawnSync("zsh", ["-c", c], { cwd: dir, timeout: 5000 });
      assert.equal(existsSync(join(dir, "engine/pwned")), false, c);
    }
  }
});

test("normalizeSegment: duplications go, one final redirect is split off, quotes are kept", () => {
  assert.deepEqual(normalizeSegment("node engine/cli.ts mode 2>&1"), { cmd: "node engine/cli.ts mode", redirect: null });
  assert.deepEqual(normalizeSegment("node engine/cli.ts weeks > .tmp/coach/w.json"), { cmd: "node engine/cli.ts weeks", redirect: ".tmp/coach/w.json" });
  assert.deepEqual(normalizeSegment('git commit -m "a 2>&1 b"'), { cmd: 'git commit -m "a 2>&1 b"', redirect: null });
  assert.equal(normalizeSegment("cat < x > y").redirect, null);
  assert.equal(normalizeSegment("a > b > c").cmd, "a > b > c");
});

test("the attack set still denies unattended and asks interactive", () => {
  const root = instance();
  for (const c of COMPOUND_ATTACKS) {
    assert.equal(bash(root, c, "unattended").decision, "deny", JSON.stringify(c));
    assert.equal(bash(root, c, "interactive").decision, "ask", JSON.stringify(c));
  }
});
