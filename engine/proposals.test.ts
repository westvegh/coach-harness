import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parse } from "yaml";
import { CoachError } from "./errors.ts";
import { approveOnBranch, createProposal, listProposals, markApplied, openProposalPR, readProposal, type CreateProposalInput } from "./proposals.ts";

const HASH = "a".repeat(64);
const input: CreateProposalInput = {
  kind: "new_exercise",
  summary: "Add Bulgarian split squats to Lower B",
  writes: [{ tool: "mcp__Tally_Workout__plan_workout_day", input: { date: "2026-10-14", expectedVersion: "v7", exercises: [{ name: "Bulgarian Split Squat" }] } }],
  base: { "2026-10-14": "v7" },
  limits_hash: HASH,
  rule_ids: ["NA-PROG-001"],
};
const NOW = "2026-10-12T00:30:00Z"; // 2026-10-11 in Los Angeles

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-prop-"));
  writeFileSync(join(dir, "coach.yaml"), "athlete:\n  timezone: America/Los_Angeles\n");
  return dir;
}

const isCode = (code: string) => (e: unknown) => e instanceof CoachError && e.code === code;

/** A fake gh on PATH that records its argv (one JSON line per call) and prints a canned reply. */
function fakeGh(mode: "ok" | "fail"): { env: NodeJS.ProcessEnv; calls: () => string[][] } {
  const bin = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const log = join(bin, "argv.jsonl");
  const script =
    `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
    (mode === "ok"
      ? `process.stdout.write(JSON.stringify({ number: 7, html_url: "https://github.com/alex/coach/pull/7" }));\n`
      : `process.stderr.write("gh: Validation Failed (HTTP 422)\\n"); process.exit(1);\n`);
  writeFileSync(join(bin, "gh"), script);
  chmodSync(join(bin, "gh"), 0o755);
  return {
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
  };
}

test("create: YAML under athlete/proposals, P-YYYYMMDD-<kind>-<n> in the athlete's timezone, status proposed", () => {
  const dir = root();
  const a = createProposal(input, { root: dir, now: NOW });
  assert.equal(a.id, "P-20261011-new_exercise-1");
  assert.equal(a.path, join(dir, "athlete/proposals/P-20261011-new_exercise-1.yaml"));
  const raw = parse(readFileSync(a.path, "utf8"));
  assert.deepEqual(Object.keys(raw), ["id", "kind", "created_at", "status", "summary", "base", "limits_hash", "rule_ids", "writes"]);
  assert.equal(raw.status, "proposed");
  assert.deepEqual(raw.writes, input.writes);
  assert.deepEqual(raw.base, { "2026-10-14": "v7" });
  const b = createProposal(input, { root: dir, now: NOW });
  assert.equal(b.id, "P-20261011-new_exercise-2");
  assert.equal(createProposal({ ...input, kind: "volume_above_plan" }, { root: dir, now: NOW }).id, "P-20261011-volume_above_plan-1");
});

test("create: bad input throws and writes nothing", () => {
  const dir = root();
  for (const bad of [{ ...input, kind: "nope" }, { ...input, writes: [] }, { ...input, limits_hash: "x" }, { ...input, base: { tomorrow: "v1" } }]) {
    assert.throws(() => createProposal(bad as CreateProposalInput, { root: dir, now: NOW }), isCode("PROPOSAL_INVALID"));
  }
  assert.deepEqual(listProposals(dir), []);
});

test("list filters by status", () => {
  const dir = root();
  createProposal(input, { root: dir, now: NOW });
  assert.equal(listProposals(dir).length, 1);
  assert.equal(listProposals(dir, { status: "approved" }).length, 0);
});

test("open-pr: gh api -X POST repos/{owner}/{repo}/pulls (never gh pr create), and pr_url is recorded", () => {
  const dir = root();
  const { id } = createProposal(input, { root: dir, now: NOW });
  const gh = fakeGh("ok");
  const { url } = openProposalPR(readProposal(id, dir), { owner: "alex", repo: "coach", branch: `proposal/${id}`, root: dir, env: gh.env });
  assert.equal(url, "https://github.com/alex/coach/pull/7");
  const [argv] = gh.calls();
  assert.deepEqual(argv.slice(0, 4), ["api", "-X", "POST", "repos/alex/coach/pulls"]);
  assert.ok(!argv.includes("pr") && !argv.includes("create"));
  const fields = Object.fromEntries(argv.slice(4).filter((_, i) => i % 2 === 1).map((f) => [f.slice(0, f.indexOf("=")), f.slice(f.indexOf("=") + 1)]));
  assert.ok(argv.slice(4).filter((_, i) => i % 2 === 0).every((f) => f === "-f"), "raw fields only (-f), so @ is never read as a file");
  assert.equal(fields.head, `proposal/${id}`);
  assert.equal(fields.base, "main");
  assert.match(fields.title, /^Proposal P-20261011-new_exercise-1: Add Bulgarian/);
  assert.match(fields.body, /merge commit/);
  assert.match(fields.body, /Bulgarian Split Squat/);
  const p = readProposal(id, dir);
  assert.equal(p.pr_url, url);
  assert.equal(p.status, "proposed");
});

test("open-pr: a failed PR call keeps the proposal file unchanged and reports gh's error", () => {
  const dir = root();
  const { id, path } = createProposal(input, { root: dir, now: NOW });
  const before = readFileSync(path, "utf8");
  const gh = fakeGh("fail");
  assert.throws(
    () => openProposalPR(readProposal(id, dir), { owner: "alex", repo: "coach", branch: `proposal/${id}`, root: dir, env: gh.env }),
    (e: unknown) => e instanceof CoachError && e.code === "PR_FAILED" && /HTTP 422/.test(e.message) && /kept/.test(e.message),
  );
  assert.equal(gh.calls().length, 1);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("open-pr: the head must be proposal/<id>; owner and repo are checked", () => {
  const dir = root();
  const { id } = createProposal(input, { root: dir, now: NOW });
  const gh = fakeGh("ok");
  const p = readProposal(id, dir);
  assert.throws(() => openProposalPR(p, { owner: "alex", repo: "coach", branch: "main", root: dir, env: gh.env }), isCode("WRONG_BRANCH"));
  assert.throws(() => openProposalPR(p, { owner: "alex;rm", repo: "coach", branch: `proposal/${id}`, root: dir, env: gh.env }), isCode("USAGE"));
  assert.equal(gh.calls().length, 0);
});

function gitRepo(dir: string): void {
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
}

test("approve: only on proposal/<id>; refused on main and on other branches", () => {
  const dir = root();
  gitRepo(dir);
  const { id } = createProposal(input, { root: dir, now: NOW });
  assert.throws(() => approveOnBranch(id, { root: dir }), isCode("WRONG_BRANCH"));
  execFileSync("git", ["-C", dir, "checkout", "-q", "-b", "proposal/P-20261011-new_exercise-9"]);
  assert.throws(() => approveOnBranch(id, { root: dir }), isCode("WRONG_BRANCH"));
  assert.equal(readProposal(id, dir).status, "proposed");
  execFileSync("git", ["-C", dir, "checkout", "-q", "-b", `proposal/${id}`]);
  approveOnBranch(id, { root: dir });
  assert.equal(readProposal(id, dir).status, "approved");
  assert.throws(() => approveOnBranch(id, { root: dir }), isCode("PROPOSAL_STATE"));
});

test("approve: outside a git repo it refuses", () => {
  const dir = root();
  const { id } = createProposal(input, { root: dir, now: NOW });
  assert.throws(() => approveOnBranch(id, { root: dir }), (e: unknown) => e instanceof CoachError && (e.code === "GIT_ERROR" || e.code === "WRONG_BRANCH"));
  assert.equal(readProposal(id, dir).status, "proposed");
});

test("mark applied: only an approved proposal; adds applied_at and results", () => {
  const dir = root();
  gitRepo(dir);
  const { id } = createProposal(input, { root: dir, now: NOW });
  assert.throws(() => markApplied(id, [{ ok: true }], { root: dir }), isCode("PROPOSAL_STATE"));
  execFileSync("git", ["-C", dir, "checkout", "-q", "-b", `proposal/${id}`]);
  approveOnBranch(id, { root: dir });
  const p = markApplied(id, [{ tool: "plan_workout_day", status: "written", version: "v8" }], { root: dir, now: "2026-10-13T07:07:00-07:00" });
  assert.equal(p.status, "applied");
  const raw = parse(readFileSync(join(dir, `athlete/proposals/${id}.yaml`), "utf8"));
  assert.equal(raw.applied_at, "2026-10-13T07:07:00-07:00");
  assert.deepEqual(raw.results, [{ tool: "plan_workout_day", status: "written", version: "v8" }]);
  assert.throws(() => markApplied(id, [], { root: dir }), isCode("PROPOSAL_STATE"));
  assert.throws(() => markApplied("P-20261011-new_exercise-99", [], { root: dir }), isCode("PROPOSAL_NOT_FOUND"));
});

test("approving on the branch changes one line of the file", () => {
  const dir = root();
  gitRepo(dir);
  const { id, path } = createProposal(input, { root: dir, now: NOW });
  const before = readFileSync(path, "utf8").split("\n");
  execFileSync("git", ["-C", dir, "checkout", "-q", "-b", `proposal/${id}`]);
  approveOnBranch(id, { root: dir });
  const after = readFileSync(path, "utf8").split("\n");
  assert.equal(after.length, before.length);
  assert.deepEqual(after.filter((l, i) => l !== before[i]), ["status: approved"]);
});
