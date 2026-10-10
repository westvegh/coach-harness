// guard-files decisions (engine/protect.ts): absolute and ./ ../ path operands,
// and broad git restores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileGuard } from "../../engine/protect.ts";
import { REPO } from "./fixtures.ts";

function instance(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coach-protect-")));
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  mkdirSync(join(dir, "engine"));
  mkdirSync(join(dir, "athlete/log"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

const bash = (root: string, command: string, mode: "interactive" | "unattended" = "unattended") =>
  fileGuard({ tool_name: "Bash", tool_input: { command }, mode, root, branch: "main", proposalsOnMain: [] });

test("absolute, ./, ../ and $CLAUDE_PROJECT_DIR path operands into protected folders", () => {
  const root = instance();
  const cases = [
    `cp /tmp/replacement.ts ${root}/engine/validate.ts`, // the reviewer's input
    "cp /tmp/x.ts ./engine/validate.ts",
    `cp /tmp/x.ts ../${basename(root)}/methods/nine-adaptations/rules.yaml`,
    'cp /tmp/x.ts "$CLAUDE_PROJECT_DIR/adapters/loggers/tally/adapter.yaml"',
    "rm -rf engine",
    `mv /tmp/l.yaml ${root}/athlete/limits.yaml`,
  ];
  for (const c of cases) {
    assert.equal(bash(root, c).decision, "deny", c);
    assert.equal(bash(root, c, "interactive").decision, "ask", c);
  }
  for (const c of ["cp /tmp/a /tmp/b", `cat ${root}/athlete/log/2026-10.md`, "git add athlete/log && git commit -m log", "ls ./athlete/log"]) {
    assert.equal(bash(root, c, "interactive").decision, "allow", c);
  }
  // Unattended: only the allowlist (launch review finding 1).
  assert.equal(bash(root, "git add athlete/log && git commit -m log").decision, "allow");
  for (const c of ["cp /tmp/a /tmp/b", "ls ./athlete/log"]) assert.equal(bash(root, c).decision, "deny", c);
});

test("broad git restores are denied unattended and asked interactive", () => {
  const root = instance();
  const broad = [
    "git checkout HEAD~1 -- .", // the reviewer's input
    "git checkout HEAD~1 -- engine/validate.ts",
    "git checkout main",
    "git restore --source HEAD~3 athlete/limits.yaml",
    "git restore .",
    "git reset --hard HEAD~1",
    "git reset --hard",
    "git stash",
    "git stash push -m x",
    "git clean -fdx",
    "git clean -fd athlete",
    "git -C . checkout HEAD~1 -- .",
    "git add -A && git checkout HEAD~1 -- .",
  ];
  for (const c of broad) {
    assert.equal(bash(root, c).decision, "deny", c);
    assert.equal(bash(root, c, "interactive").decision, "ask", c);
  }
  const narrow = ["git checkout -b proposal/P-20261014-new_block-1", "git stash list", "git restore --staged athlete/log/2026-10.md", "git restore athlete/log/2026-10.md", "git status", "git log --oneline -3"];
  for (const c of narrow) assert.equal(bash(root, c, "interactive").decision, "allow", c);
  // Unattended: git status and log are on the allowlist; checkout, stash and restore are not (launch review finding 1).
  for (const c of narrow) assert.equal(bash(root, c).decision, /^git (status|log)/.test(c) ? "allow" : "deny", c);
});

test("an unattended run never merges (git merge, gh pr merge, gh api …/merge); interactive asks", () => {
  const root = instance();
  for (const c of ["git merge --no-ff proposal/P-20261014-new_block-1", "git -C . merge x", "git fetch && git merge origin/main", "gh pr merge 3 --merge", "gh api -X PUT repos/o/r/pulls/3/merge"]) {
    assert.equal(bash(root, c).decision, "deny", c);
    assert.equal(bash(root, c, "interactive").decision, "ask", c);
  }
  for (const c of ["git merge-base --is-ancestor a b", "git pull --rebase", "git fetch origin"]) assert.equal(bash(root, c, "interactive").decision, "allow", c);
  assert.equal(bash(root, "git pull --rebase").decision, "allow");
});
