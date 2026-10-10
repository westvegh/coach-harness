// guard-files Bash rules for engine calls: read-only hold subcommands,
// compound commands classified segment by segment, and git add/commit of protected files.
// Every attack in the second half must still deny unattended and ask interactive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileGuard, splitCommand } from "../../engine/protect.ts";
import { COMPOUND_ALLOWED, COMPOUND_ALLOWED_UNATTENDED, COMPOUND_ATTACKS } from "./compound-commands.ts";
import { REPO } from "./fixtures.ts";

function instance(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coach-compound-")));
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  mkdirSync(join(dir, "engine"));
  mkdirSync(join(dir, "athlete/log"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

const bash = (root: string, command: string, mode: "interactive" | "unattended") =>
  fileGuard({ tool_name: "Bash", tool_input: { command }, mode, root, branch: "main", proposalsOnMain: [] });

test("compound commands: read-only hold commands, engine compounds and git add/commit pass interactive; unattended only on the allowlist", () => {
  const root = instance();
  for (const c of COMPOUND_ALLOWED) {
    const d = bash(root, c, "interactive");
    assert.equal(d.decision, "allow", `interactive: ${JSON.stringify(c)} → ${d.reason}`);
    const u = bash(root, c, "unattended");
    assert.equal(u.decision, COMPOUND_ALLOWED_UNATTENDED.includes(c) ? "allow" : "deny", `unattended: ${JSON.stringify(c)} → ${u.reason}`);
  }
});

test("compound commands: the attack set still denies unattended and asks interactive", () => {
  const root = instance();
  for (const c of COMPOUND_ATTACKS) {
    assert.equal(bash(root, c, "unattended").decision, "deny", JSON.stringify(c));
    assert.equal(bash(root, c, "interactive").decision, "ask", JSON.stringify(c));
  }
});

test("compound commands: splitCommand splits at unquoted separators and refuses what it cannot split", () => {
  assert.deepEqual(splitCommand('a "x; y" && b | c || d; e\nf & g'), ['a "x; y" ', " b ", " c ", " d", " e", "f ", " g"]);
  assert.deepEqual(splitCommand("a 2>&1; b &> c"), ["a 2>&1", " b &> c"]);
  assert.deepEqual(splitCommand("a 'it''s; fine' \\; b"), ["a 'it''s; fine' \\; b"]);
  for (const c of ["a $(b)", "a `b`", "a <(b)", "a >(b)", "cat <<EOF\nx\nEOF", "a 'b", 'a "b', "(a)", "a #x", "a $'b'", 'a "$(b)"', 'a "`b`"']) {
    assert.equal(splitCommand(c), null, JSON.stringify(c));
  }
  assert.notEqual(splitCommand("echo a#b"), null, "a # inside a word is not a comment");
});

test("compound commands: a word-start # hides a newline from a quote scan; the shell runs the next line (the premise), the guard denies it", () => {
  const payload = "true opid #'\ntouch pwned #'";
  for (const shell of spawnSync("zsh", ["-c", "true"]).status === 0 ? ["bash", "zsh"] : ["bash"]) {
    const dir = mkdtempSync(join(tmpdir(), "coach-comment-"));
    spawnSync(shell, ["-c", payload], { cwd: dir, timeout: 5000 });
    assert.ok(existsSync(join(dir, "pwned")), `${shell} runs the line after the comment`);
  }
  const root = instance();
  assert.equal(bash(root, "node engine/cli.ts opid #'\ntouch engine/pwned #'", "unattended").decision, "deny");
});
