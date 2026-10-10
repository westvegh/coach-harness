// launch review finding 2: the evidence that authorizes training is
// protected. athlete/block.yaml changes only through setup or the block skill with the
// user's yes (the guard asks), through `block write` on a proposal branch, or through the
// merge of an approved proposal; the guard reads main's block. athlete/signals/** is
// written only by the athlete's Shortcut (through GitHub) and trusted CLI commands, and
// `checkin` refuses to run unattended.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { fileGuard } from "../../engine/protect.ts";
import { headBranch, readApprovedBlock } from "../../engine/guard-context.ts";
import { createProposal } from "../../engine/proposals.ts";
import { fastFileDecision } from "../../.claude/hooks/fast-files.ts";
import { block, REPO } from "./fixtures.ts";

const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR"].includes(k)));
const GIT_ENV = { ...BASE_ENV, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV }).trim();

function instance(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coach-evidence-")));
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  mkdirSync(join(dir, "athlete/signals"), { recursive: true });
  writeFileSync(join(dir, "athlete/block.yaml"), stringify(block()));
  writeFileSync(join(dir, "athlete/signals/2026-10-14.json"), JSON.stringify({ date: "2026-10-14", checkin: { pain: [{ region: "left-knee", score: 6 }] } }));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

type Mode = "interactive" | "unattended";
const guard = (root: string, tool_name: string, tool_input: Record<string, unknown>, mode: Mode) =>
  fileGuard({ tool_name, tool_input, mode, root, branch: "main", proposalsOnMain: [] });

function hook(root: string, input: unknown, env: Record<string, string>) {
  const r = spawnSync(process.execPath, [join(REPO, ".claude/hooks/guard-files.ts")], { input: JSON.stringify(input), encoding: "utf8", env: { ...BASE_ENV, CLAUDE_PROJECT_DIR: root, ...env } });
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : r.status === 0 ? "allow" : `exit ${r.status}`;
}

function cli(root: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), ...args, "--root", root], { cwd: root, encoding: "utf8", env: { ...GIT_ENV, ...env } });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stderr: r.stderr };
}

test("launch review finding 2: Edit and Write of athlete/block.yaml and athlete/signals/** ask interactive and deny unattended", () => {
  const root = instance();
  const files = ["athlete/block.yaml", "Athlete/Block.yaml", "athlete/signals/2026-10-14.json", "athlete/signals/2026-10-15.json", join(root, "athlete/signals/x.json")];
  for (const file_path of files) {
    for (const tool of ["Write", "Edit"]) {
      const input = { file_path, content: "{}", old_string: "6", new_string: "0" };
      assert.equal(guard(root, tool, input, "interactive").decision, "ask", `${tool} ${file_path}`);
      assert.equal(guard(root, tool, input, "unattended").decision, "deny", `${tool} ${file_path}`);
    }
    assert.equal(fastFileDecision("Write", { file_path, content: "x" }, root), null, file_path);
  }
  // The reviewer's probe: these passed the file guard before.
  assert.equal(hook(root, { tool_name: "Write", tool_input: { file_path: "athlete/signals/2026-10-14.json", content: "{}" } }, {}), "ask");
  assert.equal(hook(root, { tool_name: "Edit", tool_input: { file_path: "athlete/block.yaml", old_string: "B-001", new_string: "B-009" } }, {}), "ask");
  assert.equal(hook(root, { tool_name: "Write", tool_input: { file_path: "athlete/block.yaml", content: "x" } }, { COACH_UNATTENDED: "1" }), "deny");
});

test("launch review finding 2: Bash that names athlete/block.yaml or athlete/signals asks interactive and denies unattended", () => {
  const root = instance();
  for (const command of ["rm athlete/signals/2026-10-14.json", "echo {} > athlete/signals/2026-10-14.json", "cp /tmp/b.yaml athlete/block.yaml", "rm -rf athlete/signals", "cd athlete && rm block.yaml", "cd athlete && rm -rf signals"]) {
    assert.equal(guard(root, "Bash", { command }, "interactive").decision, "ask", command);
    assert.equal(guard(root, "Bash", { command }, "unattended").decision, "deny", command);
    assert.equal(fastFileDecision("Bash", { command }, root), null, command);
  }
  // The trusted paths still pass: the engine CLI and git add.
  for (const command of ["node engine/cli.ts signals refresh", "node engine/cli.ts signals --from 2026-10-01 --to 2026-10-14", "git add athlete/signals && git commit -m check-in"]) {
    assert.equal(guard(root, "Bash", { command }, "interactive").decision, "allow", command);
  }
});

test("launch review finding 2: checkin refuses to run unattended and writes nothing", () => {
  const root = instance();
  const args = ["checkin", "--date", "2026-10-14", "--sleep-quality", "4", "--energy", "4", "--soreness", "2", "--stress", "2"];
  const before = readFileSync(join(root, "athlete/signals/2026-10-14.json"), "utf8");
  for (const env of [{ COACH_UNATTENDED: "1" }, { CLAUDE_CODE_REMOTE: "true" }] as Record<string, string>[]) {
    const r = cli(root, args, env);
    assert.notEqual(r.code, 0, JSON.stringify(env));
    assert.equal(r.json?.error?.code, "UNATTENDED");
    assert.equal(readFileSync(join(root, "athlete/signals/2026-10-14.json"), "utf8"), before, "the pain report is kept");
  }
  const ok = cli(root, args.map((a) => (a === "2026-10-14" ? "2026-10-15" : a)));
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(existsSync(join(root, "athlete/signals/2026-10-15.json")), "interactive check-ins still work");
});

test("launch review finding 2: block write refuses on main and on other branches, and for other proposals", () => {
  const root = instance();
  const p = createProposal({ kind: "new_block", summary: "block B-002", writes: [{ tool: "plan_workout_day", input: {} }], base: {}, limits_hash: "a".repeat(64), rule_ids: [] }, { root, now: "2026-10-11T17:07:00Z" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "proposal");
  writeFileSync(join(root, "block.json"), JSON.stringify(block({ id: "B-002", start: "2026-10-12" })));
  const before = readFileSync(join(root, "athlete/block.yaml"), "utf8");
  const onMain = cli(root, ["block", "write", "--input", "block.json", "--proposal", p.id]);
  assert.equal(onMain.json?.error?.code, "WRONG_BRANCH");
  git(root, "switch", "-q", "-c", "other");
  assert.equal(cli(root, ["block", "write", "--input", "block.json", "--proposal", p.id]).json?.error?.code, "WRONG_BRANCH");
  assert.equal(readFileSync(join(root, "athlete/block.yaml"), "utf8"), before);
  git(root, "switch", "-q", "main");
  const t = createProposal({ kind: "trim_session", summary: "trim", writes: [{ tool: "plan_workout_day", input: {} }], base: {}, limits_hash: "a".repeat(64), rule_ids: [] }, { root, now: "2026-10-11T17:07:00Z" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "trim proposal");
  git(root, "switch", "-q", "-c", `proposal/${t.id}`);
  assert.equal(cli(root, ["block", "write", "--input", "block.json", "--proposal", t.id]).json?.error?.code, "PROPOSAL_STATE");
});

test("launch review finding 2: block write on proposal/<id> archives the old block; the guard still reads main's block", () => {
  const root = instance();
  const p = createProposal({ kind: "new_block", summary: "block B-002", writes: [{ tool: "plan_workout_day", input: {} }], base: {}, limits_hash: "a".repeat(64), rule_ids: [] }, { root, now: "2026-10-11T17:07:00Z" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "proposal");
  git(root, "switch", "-q", "-c", `proposal/${p.id}`);
  const expanded = block({ id: "B-002", start: "2026-10-12", days: [{ day: "mon", focus: "lower", slots: [{ pattern: "hinge", adaptation: "strength", sets: 6 }] }] });
  writeFileSync(join(root, "block.json"), JSON.stringify({ block: expanded }));
  const r = cli(root, ["block", "write", "--input", "block.json", "--proposal", p.id], { COACH_UNATTENDED: "1" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(parse(readFileSync(join(root, "athlete/block.yaml"), "utf8")).id, "B-002");
  assert.equal(parse(readFileSync(join(root, "athlete/blocks/B-001.yaml"), "utf8")).id, "B-001");
  // On the branch, the guard's block is main's: a block written on a branch authorizes nothing.
  assert.equal(headBranch(root), `proposal/${p.id}`);
  assert.equal(readApprovedBlock(root)?.id, "B-001");
  assert.equal(readApprovedBlock(root)?.days[0].slots.some((s) => s.pattern === "hinge"), false);
  // Back on main the working tree is main's block again.
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "block");
  git(root, "switch", "-q", "main");
  assert.equal(readApprovedBlock(root)?.id, "B-001");
  // Outside git, the working tree counts; a detached HEAD reads main.
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "coach-evidence-plain-")));
  mkdirSync(join(plain, "athlete"));
  writeFileSync(join(plain, "athlete/block.yaml"), stringify(block()));
  assert.equal(headBranch(plain), null);
  assert.equal(readApprovedBlock(plain)?.id, "B-001");
  git(root, "checkout", "-q", "--detach", `proposal/${p.id}`);
  assert.equal(headBranch(root), "");
  assert.equal(readApprovedBlock(root)?.id, "B-001");
  assert.ok(existsSync(join(root, "athlete/blocks/B-001.yaml")));
});
