// CLI tools that report: classify and snapshot show (engine/cli-core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSnapshot } from "../../engine/snapshot.ts";
import { REPO, snapDay, snapshot } from "./fixtures.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "coach-clitools-"));
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  cpSync(join(REPO, "templates/athlete/limits.yaml"), join(dir, "athlete/limits.yaml"));
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

test("snapshot show", () => {
  const dir = instance();
  saveSnapshot(dir, snapshot({ "2026-10-15": snapDay("2026-10-15") }));
  const s = cli(["snapshot", "show", "--root", dir, "--now", "2026-10-14T07:10:00-07:00"]);
  assert.equal(s.code, 0, s.stderr);
  assert.equal(s.json.age_minutes, 10);
});
