// Approval records (contracts §7 step 8, §17): status approved on main, a
// pull request from proposal/<id> that GitHub shows merged into the fetched origin/main,
// and matched by call hash, base versions and limits hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadApprovals, matchApproval, readProposals, toolCallHash, type Proposal } from "../../engine/approvals.ts";
import { snapshot, snapDay, emptyDay, squat, v } from "./fixtures.ts";

const LH = "a".repeat(64);
const ID = "P-20261014-new_exercise-1";
const WRITE = { tool: "plan_workout_day", input: { date: "2026-10-15", dayType: "legs", dayName: "Legs", exercises: [squat], expectedVersion: v("r-2026-10-15", "t0") } };

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: ID,
    kind: "new_exercise",
    created_at: "2026-10-14T06:00:00-07:00",
    status: "approved",
    base: { "2026-10-15": v("r-2026-10-15", "t0") },
    limits_hash: LH,
    writes: [WRITE],
    summary: "Add a squat day",
    rule_ids: [],
    ...over,
  };
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-appr-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function writeProposal(dir: string, p: Proposal, name = `${p.id}.yaml`): string {
  mkdirSync(join(dir, "athlete/proposals"), { recursive: true });
  const rel = `athlete/proposals/${name}`;
  writeFileSync(join(dir, rel), stringify(p));
  return rel;
}

/**
 * The skill's flow (§17): proposed on main; approved copy on proposal/<id>; merged with a
 * merge commit (here locally, standing in for GitHub's merge). `published` also points the
 * fetched origin/main at the merge, as a `git fetch` after the PR merge would.
 */
function mergedRepo(opts: { squash?: boolean; branch?: string; published?: boolean } = {}): { dir: string; merge: string } {
  const dir = repo();
  git(dir, "remote", "add", "origin", "https://github.com/o/r.git");
  writeProposal(dir, proposal({ status: "proposed" }));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "propose");
  const branch = opts.branch ?? `proposal/${ID}`;
  git(dir, "checkout", "-q", "-b", branch);
  writeProposal(dir, proposal());
  git(dir, "commit", "-q", "-am", "approve");
  git(dir, "checkout", "-q", "main");
  if (opts.squash) {
    git(dir, "merge", "-q", "--squash", branch);
    git(dir, "commit", "-q", "-m", `Squash proposal (#3)`);
  } else {
    git(dir, "merge", "-q", "--no-ff", branch, "-m", `Merge pull request #3 from o/${branch}`);
  }
  const merge = git(dir, "rev-parse", "HEAD").trim();
  if (opts.published !== false) git(dir, "update-ref", "refs/remotes/origin/main", merge);
  return { dir, merge };
}

/** A fake gh: `gh api repos/o/r/pulls?…` prints $FAKE_PRS; it fails when FAKE_PRS is unset. */
function ghEnv(prs: unknown[] | null): NodeJS.ProcessEnv {
  const bin = mkdtempSync(join(tmpdir(), "fake-gh-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nif [ -z "$FAKE_PRS" ]; then echo "HTTP 401: Bad credentials" >&2; exit 1; fi\nprintf '%s\\n' "$FAKE_PRS"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  if (prs) env.FAKE_PRS = JSON.stringify(prs);
  else delete env.FAKE_PRS;
  return env;
}

/** A merged PR as GitHub's REST API lists it. */
const pr = (merge: string, over: Record<string, unknown> = {}) => ({ number: 3, merged_at: "2026-10-14T13:00:00Z", merge_commit_sha: merge, head: { ref: `proposal/${ID}` }, base: { ref: "main" }, ...over });

function approved(): ReturnType<typeof loadApprovals> {
  const { dir, merge } = mergedRepo();
  return loadApprovals(dir, { env: ghEnv([pr(merge)]) });
}

const snap = () => snapshot({ "2026-10-15": snapDay("2026-10-15") });

test("an approved proposal whose PR GitHub shows merged into the fetched origin/main is a record; it matches the exact call", () => {
  const scan = approved();
  assert.deepEqual(scan.rejected, []);
  assert.equal(scan.records.length, 1);
  assert.equal(scan.records[0].hashes[0], toolCallHash("plan_workout_day", WRITE.input));
  // The full MCP name hashes like the suffix.
  const m = matchApproval({ tool: "mcp__claude_ai_Tally_Workout__plan_workout_day", args: WRITE.input }, scan.records, snap(), LH);
  assert.equal(m.record?.proposal_id, ID);
  // Key order does not matter (canonical JSON).
  const reordered = Object.fromEntries(Object.entries(WRITE.input).reverse());
  assert.equal(matchApproval({ tool: "plan_workout_day", args: reordered }, scan.records, snap(), LH).record?.proposal_id, ID);
});

test("a local merge with no merged pull request on GitHub is not an approval", () => {
  // The reviewer's input: an approved copy on proposal/<id>, merged locally into main with git merge --no-ff.
  const { dir } = mergedRepo();
  const scan = loadApprovals(dir, { env: ghEnv([]) });
  assert.equal(scan.records.length, 0);
  assert.match(scan.rejected[0].reason, /no merged pull request from proposal\/P-20261014-new_exercise-1 into main on GitHub/);
});

test("the remote evidence must hold: gh works, the merge is in origin/main, it is a merge commit holding main's file", () => {
  const unpublished = mergedRepo({ published: false });
  assert.match(loadApprovals(unpublished.dir, { env: ghEnv([pr(unpublished.merge)]) }).rejected[0].reason, /not in the fetched origin\/main/);
  const failing = mergedRepo();
  assert.match(loadApprovals(failing.dir, { env: ghEnv(null) }).rejected[0].reason, /cannot read the pull requests/);
  const other = mergedRepo();
  assert.match(loadApprovals(other.dir, { env: ghEnv([pr(other.merge, { head: { ref: "feature/x" } })]) }).rejected[0].reason, /no merged pull request/);
  const open = mergedRepo();
  assert.match(loadApprovals(open.dir, { env: ghEnv([pr(open.merge, { merged_at: null })]) }).rejected[0].reason, /no merged pull request/);
  const squash = mergedRepo({ squash: true });
  assert.match(loadApprovals(squash.dir, { env: ghEnv([pr(squash.merge)]) }).rejected[0].reason, /not a merge commit/);
  // main's copy edited after the merge: it no longer equals the merged file.
  const edited = mergedRepo();
  writeProposal(edited.dir, proposal({ summary: "edited on main" }));
  git(edited.dir, "commit", "-q", "-am", "edit");
  assert.match(loadApprovals(edited.dir, { env: ghEnv([pr(edited.merge)]) }).rejected[0].reason, /differs from the pull request's merge commit/);
  const local = mergedRepo();
  git(local.dir, "remote", "set-url", "origin", "/tmp/elsewhere.git");
  assert.match(loadApprovals(local.dir, { env: ghEnv([pr(local.merge)]) }).rejected[0].reason, /origin is not a GitHub repository/);
});

test("mismatches: another call, a changed base version, a date not read, a changed limits hash", () => {
  const records = approved().records;
  const other = matchApproval({ tool: "plan_workout_day", args: { ...WRITE.input, dayName: "Legs B" } }, records, snap(), LH);
  assert.equal(other.record, null);
  assert.match(other.problems[0], /no approved proposal holds this exact tool call/);
  const moved = snapshot({ "2026-10-15": snapDay("2026-10-15", { version: v("r-2026-10-15", "t9") }) });
  assert.match(matchApproval({ tool: "plan_workout_day", args: WRITE.input }, records, moved, LH).problems[0], /base version of 2026-10-15 changed/);
  assert.match(matchApproval({ tool: "plan_workout_day", args: WRITE.input }, records, snapshot({}), LH).problems[0], /not in the snapshot/);
  assert.match(matchApproval({ tool: "plan_workout_day", args: WRITE.input }, records, snap(), "b".repeat(64)).problems[0], /limits.yaml changed/);
  // A null base means the date must still be empty.
  const emptyBase = [{ ...records[0], base: { "2026-10-15": null } }];
  assert.match(matchApproval({ tool: "plan_workout_day", args: WRITE.input }, emptyBase, snap(), LH).problems[0], /changed/);
  assert.equal(matchApproval({ tool: "plan_workout_day", args: WRITE.input }, emptyBase, snapshot({ "2026-10-15": emptyDay() }), LH).record?.proposal_id, ID);
});

test("not records: proposed on main; the working tree is never trusted", () => {
  const a = repo();
  writeProposal(a, proposal({ status: "proposed" }));
  git(a, "add", ".");
  git(a, "commit", "-q", "-m", "propose");
  writeProposal(a, proposal());
  assert.equal(loadApprovals(a, { env: ghEnv([]) }).records.length, 0);
});

test("no git repo or no main: no records, a warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "coach-nogit-"));
  const scan = loadApprovals(dir);
  assert.equal(scan.records.length, 0);
  assert.equal(scan.warnings.length, 1);
});

test("readProposals validates the working-tree files", () => {
  const dir = repo();
  writeProposal(dir, proposal());
  assert.equal(readProposals(dir)[0].proposal.id, ID);
  writeProposal(dir, { ...proposal(), status: "done" as never }, "bad.yaml");
  assert.throws(() => readProposals(dir), /status must be proposed \| approved \| applied/);
});

test("one hash: the operation ID's suffix is the first 12 hex characters of toolCallHash", async () => {
  const { opId } = await import("../../engine/opid.ts");
  const oplog = await import("../../engine/oplog.ts");
  for (const tool of ["plan_workout_day", "mcp__claude_ai_Tally_Workout__plan_workout_day", "mcp__tally__plan_workout_day"]) {
    const h = toolCallHash(tool, WRITE.input);
    assert.equal(opId("2026-10-15", "trim_session", { tool, args: WRITE.input }), `op-2026-10-15-trim_session-${h.slice(0, 12)}`);
    assert.equal(oplog.opId("2026-10-15", "trim_session", { tool, args: WRITE.input }), opId("2026-10-15", "trim_session", { tool, args: WRITE.input }));
  }
});
