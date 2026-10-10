// Guard CLI subcommands: classify, validate, snapshot show, proposals list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSnapshot } from "../../engine/snapshot.ts";
import { fakeGhBin, mergedPr, NOW, REPO, snapDay, snapshot, v } from "./fixtures.ts";

const CLI = join(REPO, "engine/cli.ts");
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDE_CODE_REMOTE" && k !== "COACH_UNATTENDED"));

function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...ENV, ...env } });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stderr: r.stderr };
}

function instance(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-cliguard-"));
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  cpSync(join(REPO, "templates/athlete/limits.yaml"), join(dir, "athlete/limits.yaml"));
  cpSync(join(REPO, "templates/athlete/hold.yaml"), join(dir, "athlete/hold.yaml"));
  cpSync(join(REPO, "methods"), join(dir, "methods"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

test("classify --exercise", () => {
  const r = cli(["classify", "--exercise", "Barbell Back Squat"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.patterns, ["squat", "loaded_deep_knee_flexion"]);
  assert.equal(cli(["classify"]).code, 2);
});

test("classify --input: a change's kinds", () => {
  const dir = instance();
  const day = (sets: number) => ({ date: "2026-10-15", status: "planned", source: "mcp", exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", unit: "lbs", sets: Array.from({ length: sets }, () => ({ weight: 225, reps: 5 })) }] });
  const f = join(dir, "c.json");
  writeFileSync(f, JSON.stringify({ tool: "update_planned_workout", before: day(4), after: day(3), today: "2026-10-14", snapshotDay: snapDay("2026-10-15") }));
  const r = cli(["classify", "--input", f, "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.kinds, ["trim_session"]);
  assert.equal(r.json.big, false);
});

test("validate --tool --args: the guard's verdict as JSON", () => {
  const dir = instance();
  const D = "2026-10-15";
  saveSnapshot(dir, snapshot({ [D]: snapDay(D) }));
  const args = join(dir, "a.json");
  writeFileSync(args, JSON.stringify({ date: D, expectedVersion: v(`r-${D}`, "t0"), operations: [{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 2 } }] }));
  const ok = cli(["validate", "--tool", "mcp__tally__update_planned_workout", "--args", args, "--root", dir, "--now", NOW]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json.decision, "allow");
  assert.deepEqual(ok.json.kinds, ["trim_session"]);
  // Tally T2: a skip without expectedVersion is denied in both modes; with it, allowed.
  const skip = join(dir, "s.json");
  writeFileSync(skip, JSON.stringify({ date: D }));
  assert.equal(cli(["validate", "--tool", "skip_planned_workout", "--args", skip, "--root", dir, "--now", NOW], { COACH_UNATTENDED: "1" }).json.decision, "deny");
  assert.equal(cli(["validate", "--tool", "skip_planned_workout", "--args", skip, "--root", dir, "--now", NOW, "--mode", "interactive"], { COACH_UNATTENDED: "1" }).json.decision, "deny");
  writeFileSync(skip, JSON.stringify({ date: D, expectedVersion: v(`r-${D}`, "t0") }));
  assert.equal(cli(["validate", "--tool", "skip_planned_workout", "--args", skip, "--root", dir, "--now", NOW], { COACH_UNATTENDED: "1" }).json.decision, "allow");
  assert.equal(cli(["validate", "--tool", "skip_planned_workout", "--root", dir]).code, 2);
});

test("snapshot show", () => {
  const dir = instance();
  saveSnapshot(dir, snapshot({ "2026-10-15": snapDay("2026-10-15") }));
  const s = cli(["snapshot", "show", "--root", dir, "--now", "2026-10-14T07:10:00-07:00"]);
  assert.equal(s.code, 0, s.stderr);
  assert.equal(s.json.age_minutes, 10);
});

test("proposals: create, open-pr, list (with the guard's approval status) and mark-applied under one case", () => {
  const dir = instance();
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("add", ".");
  g("commit", "-q", "-m", "instance");
  const input = join(dir, "p.json");
  writeFileSync(input, JSON.stringify({ kind: "new_block", summary: "next block", base: {}, rule_ids: [], writes: [{ tool: "plan_workout_day", input: { date: "2026-10-19" } }] }));
  const created = cli(["proposals", "create", "--input", input, "--root", dir, "--now", NOW]);
  assert.equal(created.code, 0, created.stderr);
  const id = created.json.id as string;
  g("add", ".");
  g("commit", "-q", "-m", "propose");
  assert.deepEqual(cli(["proposals", "list", "--root", dir]).json.proposals.map((p: any) => [p.id, p.status, p.approved_on_main]), [[id, "proposed", false]]);

  g("checkout", "-q", "-b", `proposal/${id}`);
  assert.equal(cli(["proposals", "approve-copy", id, "--root", dir]).code, 0);
  // open-pr through a fake gh (REST).
  const bin = fakeGhBin();
  const pr = cli(["proposals", "open-pr", id, "--repo", "o/r", "--root", dir], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(pr.code, 0, pr.stderr);
  assert.equal(pr.json.url, "https://github.com/o/r/pull/7");
  g("add", ".");
  g("commit", "-q", "-m", "approve");
  g("checkout", "-q", "main");
  g("merge", "-q", "--no-ff", `proposal/${id}`, "-m", `Merge pull request #7 from o/proposal/${id}`);
  // GitHub shows the PR merged and the fetched origin/main holds it.
  const merge = g("rev-parse", "HEAD").trim();
  g("remote", "add", "origin", "https://github.com/o/r.git");
  g("update-ref", "refs/remotes/origin/main", merge);
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_PRS: JSON.stringify([mergedPr(id, merge)]) };
  const listed = cli(["proposals", "list", "--root", dir], env).json.proposals[0];
  assert.equal(listed.status, "approved");
  assert.equal(listed.approved_on_main, true);

  const results = join(dir, "r.json");
  writeFileSync(results, JSON.stringify([{ write: 0, status: "written" }]));
  const applied = cli(["proposals", "mark-applied", id, "--input", results, "--root", dir, "--now", NOW]);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(applied.json.status, "applied");
  assert.equal(cli(["proposals", "nope", "--root", dir]).code, 2);
});
