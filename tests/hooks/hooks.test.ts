// Hook processes (contracts §7, §9, §13): each hook runs as `node .claude/hooks/<name>.ts`
// with stdin JSON, in a temporary athlete instance. Asserts stdout, stderr and exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSnapshot, SNAPSHOT_RELATIVE } from "../../engine/snapshot.ts";
import { fakeGhBin, mergedPr, NOW, plannedDay, SESSION, snapDay, snapshot, v } from "../guard/fixtures.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const D = "2026-10-15";
const TALLY = "mcp__claude_ai_Tally_Workout__";
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR", "COACH_NOW"].includes(k)));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

/** A fresh athlete instance: coach.yaml, limits, hold, the method pack, a git repo on main. */
function instance(opts: { coach?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-hooks-"));
  if (opts.coach !== false) cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.example.yaml"));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  cpSync(join(REPO, "templates/athlete/limits.yaml"), join(dir, "athlete/limits.yaml"));
  cpSync(join(REPO, "templates/athlete/hold.yaml"), join(dir, "athlete/hold.yaml"));
  cpSync(join(REPO, "methods"), join(dir, "methods"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "athlete/.cache/\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "instance");
  return dir;
}

function hook(name: string, root: string, input: unknown, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(REPO, ".claude/hooks", `${name}.ts`)], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...BASE_ENV, CLAUDE_PROJECT_DIR: root, COACH_NOW: NOW, ...env },
  });
  let json: any = null;
  try {
    json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {
    /* not JSON */
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const trim = { date: D, expectedVersion: v(`r-${D}`, "t0"), operations: [{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 2 } }] };
const pre = (tool: string, tool_input: unknown, extra: Record<string, unknown> = {}) => ({ session_id: SESSION, hook_event_name: "PreToolUse", tool_name: TALLY + tool, tool_input, tool_use_id: "toolu_1", ...extra });
const withSnapshot = (root: string) => saveSnapshot(root, snapshot({ [D]: snapDay(D) }));

// ---------- guard-writes ----------

test("guard-writes: allow is exit 0 with no decision; deny and ask are JSON", () => {
  const root = instance();
  withSnapshot(root);
  const ok = hook("guard-writes", root, pre("update_planned_workout", trim));
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json?.hookSpecificOutput?.permissionDecision, undefined, ok.stdout);

  const ask = hook("guard-writes", root, pre("update_user_profile", { goals: "run a 10k" }));
  assert.equal(ask.code, 0);
  assert.equal(ask.json.hookSpecificOutput.permissionDecision, "ask");

  for (const env of [{ COACH_UNATTENDED: "1" }, { CLAUDE_CODE_REMOTE: "true" }] as Record<string, string>[]) {
    const deny = hook("guard-writes", root, pre("update_user_profile", { goals: "run a 10k" }), env);
    assert.equal(deny.code, 0);
    assert.equal(deny.json.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(deny.json.hookSpecificOutput.permissionDecision, "deny");
    assert.match(deny.json.hookSpecificOutput.permissionDecisionReason, /never allowed in an unattended run/);
  }
  // Tally T2: a skip without expectedVersion is denied in both modes.
  const skip = hook("guard-writes", root, pre("skip_planned_workout", { date: D }));
  assert.equal(skip.json.hookSpecificOutput.permissionDecision, "deny");
  assert.match(skip.json.hookSpecificOutput.permissionDecisionReason, /must carry expectedVersion/);
});

test("guard-writes: no snapshot is a deny with 'refresh'; the three tool-name forms are all guarded", () => {
  const root = instance();
  for (const prefix of ["mcp__tally__", "mcp__Tally_Workout__", "mcp__claude_ai_Tally_Workout__"]) {
    const r = hook("guard-writes", root, { ...pre("update_planned_workout", trim), tool_name: prefix + "update_planned_workout" });
    assert.equal(r.json?.hookSpecificOutput?.permissionDecision, "deny", `${prefix}: ${r.stdout}${r.stderr}`);
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /refresh: read the affected days/);
  }
});

test("guard-writes: malformed or missing files and bad input are a deny with exit 2", () => {
  const cases: [string, (root: string) => void][] = [
    ["malformed limits.yaml", (r) => writeFileSync(join(r, "athlete/limits.yaml"), "version: 1\nlimits: [oops\n")],
    ["missing limits.yaml", (r) => rmSync(join(r, "athlete/limits.yaml"))],
    ["missing coach.yaml", (r) => rmSync(join(r, "coach.yaml"))],
    ["malformed coach.yaml", (r) => writeFileSync(join(r, "coach.yaml"), "version: 2\n")],
    ["missing hold.yaml", (r) => rmSync(join(r, "athlete/hold.yaml"))],
    ["malformed hold.yaml", (r) => writeFileSync(join(r, "athlete/hold.yaml"), "active: maybe\n")],
    ["malformed snapshot", (r) => writeFileSync(join(r, SNAPSHOT_RELATIVE), "{")],
    ["malformed pending", (r) => writeFileSync(join(r, "athlete/.safety-pending"), "nope")],
    ["missing rules", (r) => rmSync(join(r, "methods/nine-adaptations/rules.yaml"))],
    ["malformed block", (r) => writeFileSync(join(r, "athlete/block.yaml"), "version: 1\nstart: 2026-10-14\nweeks: []\ndays: []\n")],
    ["malformed check-in", (r) => {
      mkdirSync(join(r, "athlete/signals"), { recursive: true });
      writeFileSync(join(r, "athlete/signals/2026-10-14.json"), "{");
    }],
  ];
  for (const [what, breakIt] of cases) {
    const root = instance();
    withSnapshot(root);
    breakIt(root);
    const r = hook("guard-writes", root, pre("update_planned_workout", trim));
    assert.equal(r.code, 2, `${what}: exit ${r.code} ${r.stdout}`);
    assert.match(r.stderr, /^guard-writes: /, what);
    assert.equal(r.stdout, "", what);
  }
  const root = instance();
  for (const bad of ["not json", "[]", JSON.stringify({ tool_name: TALLY + "skip_planned_workout" })]) {
    const r = hook("guard-writes", root, bad);
    assert.equal(r.code, 2, bad);
  }
});

// ---------- guard-files ----------

test("guard-files: inactive without coach.yaml (the development repo)", () => {
  const root = instance({ coach: false });
  const r = hook("guard-files", root, { tool_name: "Edit", tool_input: { file_path: join(root, "engine/validate.ts"), old_string: "a", new_string: "b" } }, { COACH_UNATTENDED: "1" });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("guard-files: protected paths ask interactive and deny unattended", () => {
  const root = instance();
  const cases = [
    { tool_name: "Edit", tool_input: { file_path: join(root, "engine/validate.ts"), old_string: "a", new_string: "b" } },
    { tool_name: "Write", tool_input: { file_path: "athlete/limits.yaml", content: "x" } },
    { tool_name: "Write", tool_input: { file_path: join(root, "athlete/.cache/snapshot.json"), content: "{}" } },
    { tool_name: "Edit", tool_input: { file_path: join(root, ".claude/settings.json"), old_string: "a", new_string: "b" } },
    { tool_name: "Write", tool_input: { file_path: join(root, "adapters/loggers/tally/adapter.yaml"), content: "x" } },
    { tool_name: "Bash", tool_input: { command: "rm coach.yaml" } },
    { tool_name: "Bash", tool_input: { command: "sed -i '' 's/ban/cap/' athlete/limits.yaml" } },
    { tool_name: "Bash", tool_input: { command: "node engine/cli.ts hold set --reason knee; rm athlete/hold.yaml" } },
    { tool_name: "Bash", tool_input: { command: "node engine/cli.ts hold clear --approved" } },
    { tool_name: "Bash", tool_input: { command: "gh pr merge 3 --merge" } },
    { tool_name: "Bash", tool_input: { command: "gh api -X PUT repos/o/r/pulls/3/merge" } },
  ];
  for (const c of cases) {
    const i = hook("guard-files", root, c);
    assert.equal(i.json?.hookSpecificOutput?.permissionDecision, "ask", `${JSON.stringify(c)} → ${i.stdout}${i.stderr}`);
    const u = hook("guard-files", root, c, { COACH_UNATTENDED: "1" });
    assert.equal(u.json?.hookSpecificOutput?.permissionDecision, "deny", JSON.stringify(c));
  }
});

test("guard-files: hold set, the engine CLI, ordinary files and other coach.yaml keys are allowed", () => {
  const root = instance();
  const allowed = [
    { tool_name: "Bash", tool_input: { command: 'node engine/cli.ts hold set --reason "left knee pain" --regions left-knee' } },
    { tool_name: "Bash", tool_input: { command: "node engine/hold.ts set --reason knee" } },
    { tool_name: "Bash", tool_input: { command: "node engine/cli.ts readiness --input /tmp/r.json" } },
    { tool_name: "Bash", tool_input: { command: "git add athlete/log && git commit -m log" } },
    { tool_name: "Write", tool_input: { file_path: join(root, "athlete/log/2026-10.md"), content: "x" } },
    { tool_name: "Read", tool_input: { file_path: join(root, "athlete/limits.yaml") } },
  ];
  for (const c of allowed) {
    const r = hook("guard-files", root, c, { COACH_UNATTENDED: "1" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "", JSON.stringify(c));
  }
  // Other coach.yaml keys: allowed interactive; an unattended run writes only its log, proposals and engine inputs (contracts §23).
  const name = { tool_name: "Edit", tool_input: { file_path: join(root, "coach.yaml"), old_string: "name: Alex", new_string: "name: Sam" } };
  assert.equal(hook("guard-files", root, name, {}).stdout, "");
  assert.equal(hook("guard-files", root, name, { COACH_UNATTENDED: "1" }).json.hookSpecificOutput.permissionDecision, "deny");
  const approvalEdit = { tool_name: "Edit", tool_input: { file_path: join(root, "coach.yaml"), old_string: "ask:  [new_exercise, ", new_string: "ask:  [" } };
  const approval = hook("guard-files", root, approvalEdit, {});
  assert.equal(approval.json.hookSpecificOutput.permissionDecision, "ask");
  assert.match(approval.json.hookSpecificOutput.permissionDecisionReason, /approval and thresholds are protected/);
  assert.equal(hook("guard-files", root, approvalEdit, { COACH_UNATTENDED: "1" }).json.hookSpecificOutput.permissionDecision, "deny");
});

test("guard-files: proposals are protected on main; a new proposal on a proposal branch is not", () => {
  const root = instance();
  const edit = { tool_name: "Write", tool_input: { file_path: join(root, "athlete/proposals/P-20261014-new_block-1.yaml"), content: "status: approved\n" } };
  assert.equal(hook("guard-files", root, edit, { COACH_UNATTENDED: "1" }).json.hookSpecificOutput.permissionDecision, "deny");
  git(root, "checkout", "-q", "-b", "proposal/P-20261014-new_block-1");
  const r = hook("guard-files", root, edit, { COACH_UNATTENDED: "1" });
  assert.equal(r.stdout, "");
});

test("guard-files: bad input is exit 2", () => {
  const r = hook("guard-files", instance(), "{");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /guard-files: HOOK_INPUT/);
});

// ---------- capture-reads and log-writes ----------

const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];

test("capture-reads: a read builds the snapshot; a malformed snapshot is replaced; non-logger tools are ignored", () => {
  const root = instance();
  const r = hook("capture-reads", root, { session_id: SESSION, tool_name: TALLY + "get_planned_workout", tool_input: { date: D }, tool_response: text(plannedDay(D)) });
  assert.equal(r.code, 0, r.stderr);
  const snap = JSON.parse(readFileSync(join(root, SNAPSHOT_RELATIVE), "utf8"));
  assert.equal(snap.session_id, SESSION);
  assert.equal(snap.days[D].version, v(`r-${D}`, "t0"));
  assert.equal(snap.timezone, "America/Los_Angeles");

  writeFileSync(join(root, SNAPSHOT_RELATIVE), "{");
  const again = hook("capture-reads", root, { session_id: SESSION, tool_name: "mcp__tally__get_planned_workout", tool_input: { date: D }, tool_response: text(plannedDay(D)) });
  assert.equal(again.code, 0);
  assert.match(again.stderr, /replacing a malformed snapshot/);
  assert.equal(JSON.parse(readFileSync(join(root, SNAPSHOT_RELATIVE), "utf8")).days[D].found, true);

  const other = hook("capture-reads", root, { session_id: "x", tool_name: "mcp__github__get_issue", tool_input: {}, tool_response: text({}) });
  assert.equal(other.code, 0);
  assert.equal(JSON.parse(readFileSync(join(root, SNAPSHOT_RELATIVE), "utf8")).session_id, SESSION);
  assert.equal(hook("capture-reads", root, "nope").code, 2);
});

test("guard-writes → log-writes: one log entry with the operation ID, kind, approval and result", () => {
  const root = instance();
  withSnapshot(root);
  const g = hook("guard-writes", root, pre("update_planned_workout", trim));
  assert.equal(g.code, 0, g.stderr);
  const response = text({ date: D, status: "updated", day: plannedDay(D, { updatedAt: "t1", version: v(`r-${D}`, "t1") }), warnings: [] });
  const l = hook("log-writes", root, { ...pre("update_planned_workout", trim), hook_event_name: "PostToolUse", tool_response: response });
  assert.equal(l.code, 0, l.stderr);
  assert.match(l.json.hookSpecificOutput.additionalContext, /coach log: op-2026-10-15-trim_session-[0-9a-f]{12} written/);
  const log = readFileSync(join(root, "athlete/log/2026-10.md"), "utf8");
  assert.match(log, /## 2026-10-14 07:00 · op-2026-10-15-trim_session-[0-9a-f]{12}/);
  assert.match(log, /- trigger: user/);
  assert.match(log, /- approval: auto \(trim_session\)/);
  assert.match(log, new RegExp(`- result: written: written \\(version ${v(`r-${D}`, "t1")}\\)`));
  assert.equal(readdirSync(join(root, "athlete/.cache/verdicts")).length, 0, "the verdict is consumed");

  // A conflict and an unparsable response are reconciled too.
  const c = hook("log-writes", root, { ...pre("update_planned_workout", trim), tool_use_id: "toolu_2", tool_response: text({ date: D, status: "skipped", code: "version_conflict", reason: "x" }) }, { COACH_UNATTENDED: "1" });
  assert.match(c.json.hookSpecificOutput.additionalContext, /conflict/);
  const u = hook("log-writes", root, { ...pre("update_planned_workout", trim), tool_use_id: "toolu_3", tool_response: [{ type: "text", text: "timeout" }] });
  assert.match(u.json.hookSpecificOutput.additionalContext, /uncertain/);
  const log2 = readFileSync(join(root, "athlete/log/2026-10.md"), "utf8");
  assert.match(log2, /- trigger: scheduled run \(mac\)/);
  assert.equal((log2.match(/^## /gm) ?? []).length, 3);
  rmSync(join(root, "coach.yaml"));
  assert.equal(hook("log-writes", root, { ...pre("update_planned_workout", trim), tool_response: response }).code, 2);
});

// ---------- session-context ----------

test("session-context: hold, pending, due items; no coach.yaml; a malformed hold is exit 2", () => {
  const root = instance();
  writeFileSync(join(root, "athlete/hold.yaml"), "active: true\nset_at: '2026-10-13T08:00:00-07:00'\nreason: left knee pain\nregions: [left-knee]\nset_by: safety-agent\n");
  writeFileSync(join(root, "athlete/.safety-pending"), JSON.stringify({ at: "2026-10-14T06:00:00-07:00", terms: ["pain"], source: "prompt" }));
  const r = hook("session-context", root, { session_id: SESSION, hook_event_name: "SessionStart", source: "startup" });
  assert.equal(r.code, 0, r.stderr);
  const ctx = r.json.hookSpecificOutput.additionalContext as string;
  assert.equal(r.json.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(ctx, /today is 2026-10-14 \(wed\)/);
  assert.match(ctx, /SAFETY FIRST: a safety check is pending/);
  assert.match(ctx, /HOLD ACTIVE since .*left knee pain/);
  assert.match(ctx, /Due: today's check-in; the daily run/);

  const fresh = instance({ coach: false });
  assert.match(hook("session-context", fresh, { session_id: SESSION }).json.hookSpecificOutput.additionalContext, /no coach.yaml yet/);

  writeFileSync(join(root, "athlete/hold.yaml"), "active: [\n");
  const bad = hook("session-context", root, { session_id: SESSION });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /session-context: HOLD_INVALID/);
});

test("P2 fix 7: session-context wording follows the guard's precedence: urgent, pending, systemic, regional", () => {
  const root = instance();
  const hold = (regions: string, extra = "") => writeFileSync(join(root, "athlete/hold.yaml"), `active: true\nset_at: '2026-10-13T08:00:00-07:00'\nreason: review fixture\nregions: ${regions}\nset_by: safety-agent\n${extra}`);
  const pendingFile = join(root, "athlete/.safety-pending");
  const ctx = () => {
    const r = hook("session-context", root, { session_id: SESSION });
    assert.equal(r.code, 0, r.stderr);
    return r.json.hookSpecificOutput.additionalContext as string;
  };
  const REGIONAL = /other training follows the normal rules/;
  // Urgent first: an urgent regional hold allows no exercise, whatever its regions.
  hold("[left-shoulder, right-shoulder]", "urgent: true\n");
  let c = ctx();
  assert.match(c, /HOLD ACTIVE since .*\(regions: left-shoulder, right-shoulder\)\. Urgent: no exercise\. Only a note, a rest day or a skip is allowed/);
  assert.doesNotMatch(c, REGIONAL);
  // An urgent pending term wins over a plain regional hold.
  hold("[left-shoulder]");
  writeFileSync(pendingFile, JSON.stringify({ at: "2026-10-14T06:00:00-07:00", terms: ["chest pain"], source: "prompt" }));
  c = ctx();
  assert.match(c, /SAFETY FIRST: a safety check is pending .*\. Urgent: no exercise/);
  assert.doesNotMatch(c, REGIONAL);
  // Then pending: only rest, recovery, trims and notes until the questions are answered.
  writeFileSync(pendingFile, JSON.stringify({ at: "2026-10-14T06:00:00-07:00", terms: ["pain", "region:left-shoulder"], source: "prompt" }));
  c = ctx();
  assert.match(c, /SAFETY FIRST: .*Only rest, recovery, trims and notes until the questions are answered\./);
  assert.match(c, /HOLD ACTIVE since .*\(regions: left-shoulder\)\. Only rest, recovery, trims and notes until the questions are answered/);
  assert.doesNotMatch(c, REGIONAL);
  rmSync(pendingFile);
  // Then a systemic hold, and a hold with an unknown region id (fail closed, reported).
  hold("[]");
  c = ctx();
  assert.match(c, /\(no regions\)\. Only rest, recovery, trims and notes are allowed/);
  hold("[shoulders]");
  c = ctx();
  assert.match(c, /\(regions: shoulders; unknown region id shoulders, so it holds like a hold with no regions\)\. Only rest, recovery, trims and notes are allowed/);
  assert.doesNotMatch(c, REGIONAL);
  // Last, a regional hold.
  hold("[left-shoulder]");
  assert.match(ctx(), /\(regions: left-shoulder\)\. Exercises that load a held region, and unclassified ones, are denied; other training follows the normal rules/);
});

test("P3 fix 3: a taxonomy that does not load still leaves the conservative safety context, with the error", () => {
  const root = instance();
  const hold = (regions: string, extra = "") => writeFileSync(join(root, "athlete/hold.yaml"), `active: true\nset_at: '2026-10-13T08:00:00-07:00'\nreason: review fixture\nregions: ${regions}\nset_by: safety-agent\n${extra}`);
  const pendingFile = join(root, "athlete/.safety-pending");
  // The reviewer's malformed local taxonomy.
  writeFileSync(join(root, "athlete/movements.local.yaml"), "version: 1\npatterns: bad\n");
  const ctx = () => {
    const r = hook("session-context", root, { session_id: SESSION });
    assert.equal(r.code, 0, r.stderr);
    return r.json.hookSpecificOutput.additionalContext as string;
  };
  const REGIONAL = /other training follows the normal rules/;
  // The reviewer's urgent regional hold: the urgent text.
  hold("[left-shoulder, right-shoulder]", "urgent: true\n");
  let c = ctx();
  assert.match(c, /HOLD ACTIVE since .*\(regions: left-shoulder, right-shoulder\)\. Urgent: no exercise\. Only a note, a rest day or a skip is allowed/);
  assert.doesNotMatch(c, REGIONAL);
  // A pending check: the pending text.
  hold("[left-shoulder]");
  writeFileSync(pendingFile, JSON.stringify({ at: "2026-10-14T06:00:00-07:00", terms: ["pain", "region:left-shoulder"], source: "prompt" }));
  c = ctx();
  assert.match(c, /SAFETY FIRST: .*Only rest, recovery, trims and notes until the questions are answered\./);
  assert.doesNotMatch(c, REGIONAL);
  rmSync(pendingFile);
  // A regional hold needs the taxonomy: it is read as a hold with no regions, and the error is named.
  c = ctx();
  assert.match(c, /ERROR: the movement taxonomy does not load \(TAXONOMY_INVALID: .*patterns: must be a mapping/);
  assert.match(c, /HOLD ACTIVE since .*\(regions: left-shoulder\)\. Only rest, recovery, trims and notes are allowed/);
  assert.doesNotMatch(c, REGIONAL);
});

test("session-context: an approved, merged proposal is reported for apply", () => {
  const root = instance();
  const id = "P-20261014-new_block-1";
  const body = (status: string) =>
    `id: ${id}\nkind: new_block\ncreated_at: '2026-10-14T06:00:00-07:00'\nstatus: ${status}\nbase: {}\nlimits_hash: '${"a".repeat(64)}'\nwrites:\n  - tool: plan_workout_day\n    input: { date: '2026-10-19' }\nsummary: next block\nrule_ids: []\n`;
  mkdirSync(join(root, "athlete/proposals"), { recursive: true });
  writeFileSync(join(root, `athlete/proposals/${id}.yaml`), body("proposed"));
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "propose");
  git(root, "checkout", "-q", "-b", `proposal/${id}`);
  writeFileSync(join(root, `athlete/proposals/${id}.yaml`), body("approved"));
  git(root, "commit", "-q", "-am", "approve");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--no-ff", `proposal/${id}`, "-m", `Merge pull request #4 from o/proposal/${id}`);
  const merge = git(root, "rev-parse", "HEAD").trim();
  git(root, "remote", "add", "origin", "https://github.com/o/r.git");
  // A local merge alone is not an approval.
  const bin = fakeGhBin();
  const local = hook("session-context", root, { session_id: SESSION }, { PATH: `${bin}:${process.env.PATH}`, FAKE_PRS: "[]" });
  assert.match(local.json.hookSpecificOutput.additionalContext, /not accepted as approved: .*no merged pull request/);
  // GitHub shows the PR merged, and the fetched origin/main holds the merge.
  git(root, "update-ref", "refs/remotes/origin/main", merge);
  const r = hook("session-context", root, { session_id: SESSION }, { PATH: `${bin}:${process.env.PATH}`, FAKE_PRS: JSON.stringify([mergedPr(id, merge)]) });
  assert.match(r.json.hookSpecificOutput.additionalContext, new RegExp(`Approved, not yet applied: ${id}`));
});

// ---------- commit-check ----------

test("commit-check: uncommitted athlete changes block the first stop, warn on the second; clean is silent", () => {
  const root = instance();
  assert.equal(hook("commit-check", root, { session_id: SESSION, stop_hook_active: false }).stdout, "");
  mkdirSync(join(root, "athlete/log"), { recursive: true });
  writeFileSync(join(root, "athlete/log/2026-10.md"), "x\n");
  const first = hook("commit-check", root, { session_id: SESSION, stop_hook_active: false });
  assert.equal(first.json.decision, "block");
  assert.match(first.json.reason, /athlete\/log\//);
  const second = hook("commit-check", root, { session_id: SESSION, stop_hook_active: true });
  assert.equal(second.code, 0);
  assert.match(second.json.systemMessage, /uncommitted/);
  // The ignored cache never counts.
  mkdirSync(join(root, "athlete/.cache"), { recursive: true });
  writeFileSync(join(root, "athlete/.cache/x.json"), "{}");
  git(root, "add", "athlete/log");
  git(root, "commit", "-q", "-m", "log");
  assert.equal(hook("commit-check", root, { session_id: SESSION }).stdout, "");
  assert.equal(existsSync(join(root, "athlete/.cache/x.json")), true);
  assert.equal(hook("commit-check", root, "{").code, 2);
});

test("commit-check: an uncommitted .safety-pending is to be committed, never deleted (ruling 2026-10-10)", () => {
  const root = instance();
  mkdirSync(join(root, "athlete"), { recursive: true });
  writeFileSync(join(root, "athlete/.safety-pending"), JSON.stringify({ at: "2026-10-10T07:00:00Z", terms: ["pain"], source: "prompt" }));
  const first = hook("commit-check", root, { session_id: SESSION, stop_hook_active: false });
  assert.equal(first.json.decision, "block");
  assert.match(first.json.reason, /safety-pending is committed like the other athlete files/);
  assert.match(first.json.reason, /Never delete it/);
  // Other files alone get no pending guidance.
  const other = instance();
  mkdirSync(join(other, "athlete/log"), { recursive: true });
  writeFileSync(join(other, "athlete/log/2026-10.md"), "x\n");
  assert.doesNotMatch(hook("commit-check", other, { session_id: SESSION, stop_hook_active: false }).json.reason, /safety-pending/);
});

test("contracts §18: without coach.yaml, guard-writes blocks every logger mutation and guard-files is inactive", () => {
  const root = instance({ coach: false });
  withSnapshot(root);
  const calls: [string, unknown][] = [
    ["plan_workout_day", { date: D, dayType: "push", dayName: "Push", exercises: [] }],
    ["plan_workout_range", { days: [] }],
    ["update_planned_workout", trim],
    ["move_planned_workout", { fromDate: D, toDate: "2026-10-16" }],
    ["skip_planned_workout", { date: D }],
    ["delete_planned_workout", { date: D }],
    ["update_user_profile", { goals: "x" }],
  ];
  for (const [tool, args] of calls) {
    for (const env of [{}, { COACH_UNATTENDED: "1" }] as Record<string, string>[]) {
      const r = hook("guard-writes", root, pre(tool, args), env);
      assert.equal(r.code, 2, `${tool}: ${r.stdout}`);
      assert.match(r.stderr, /guard-writes: MISSING_FILE: coach.yaml is missing/, tool);
    }
  }
  for (const c of [
    { tool_name: "Bash", tool_input: { command: "rm athlete/limits.yaml" } },
    { tool_name: "Write", tool_input: { file_path: join(root, "athlete/hold.yaml"), content: "x" } },
  ]) {
    const r = hook("guard-files", root, c, { COACH_UNATTENDED: "1" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "", JSON.stringify(c));
  }
});
