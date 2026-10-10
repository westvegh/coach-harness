// Smoke tests for the server-limits CLI: limits server-rules and limits sync-ops.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const CLI = join(REPO, "engine/cli.ts");

function cli(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: "utf8", input });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stderr: r.stderr };
}

const LIMITS = `version: 1
pain_threshold: 4
limits:
  - id: L-001
    region: left-knee
    rule: ban
    patterns: [loaded_deep_knee_flexion]
    exercises: ["Barbell Back Squat"]
    allow: ["Box Squat"]
    note: "No deep squats under load"
    source: athlete
    since: 2026-10-09
  - id: L-002
    region: low-back
    rule: cap
    patterns: [hinge]
    max_load: { value: 135, unit: lbs }
    max_sets_per_week: 6
    source: clinician-reported
    since: 2026-10-01
  - id: L-003
    region: shoulder
    rule: cap
    patterns: [overhead_press]
    max_load: { value: 50, unit: lbs }
    source: athlete
    since: 2026-10-01
`;

function root(): { dir: string; resolved: string } {
  const dir = mkdtempSync(join(tmpdir(), "coach-limits-cli-"));
  mkdirSync(join(dir, "athlete"));
  writeFileSync(join(dir, "athlete/limits.yaml"), LIMITS);
  const resolved = join(dir, "resolved.json");
  writeFileSync(resolved, JSON.stringify({ "Barbell Back Squat": { exerciseId: "barbell_back_squat", name: "Barbell Back Squat" }, "Box Squat": { exerciseId: "box_squat", name: "Box Squat" } }));
  return { dir, resolved };
}

test("limits server-rules prints the compiled rules and what was skipped", () => {
  const { dir, resolved } = root();
  const r = cli(["limits", "server-rules", "--root", dir, "--resolved", resolved]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.rules.map((x: any) => [x.id, x.kind, x.maxSetsPerWeek ?? null]), [["L-001", "ban", null], ["L-002", "cap", 6]]);
  assert.deepEqual(r.json.rules[0].allow, [{ exerciseId: "box_squat", name: "Box Squat" }]);
  assert.deepEqual(r.json.skipped.map((x: any) => x.id), ["L-003"]);
  assert.deepEqual(r.json.localOnly.map((x: any) => x.id), ["L-002"]);
  assert.deepEqual(r.json.unresolved, []);
  // Without --resolved, the allow entry is unresolved and L-001 is skipped.
  const bare = cli(["limits", "server-rules", "--root", dir]);
  assert.equal(bare.code, 0);
  assert.deepEqual(bare.json.rules.map((x: any) => x.id), ["L-002"]);
  assert.ok(bare.json.unresolved.includes("Box Squat"));
});

test("limits sync-ops reads a get_training_context result from a file or stdin", () => {
  const { dir, resolved } = root();
  const first = cli(["limits", "sync-ops", "--root", dir, "--resolved", resolved, "--server", "-"], JSON.stringify({ today: "2026-10-12", trainingLimits: null }));
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json.expectedVersion, null);
  assert.deepEqual(first.json.ops.map((o: any) => [o.op, o.rule.id]), [["add_rule", "L-001"], ["add_rule", "L-002"]]);
  assert.deepEqual(first.json.appOnly, []);

  // The server has both, with a looser hinge cap and a rule limits.yaml lacks.
  const rules = cli(["limits", "server-rules", "--root", dir, "--resolved", resolved]).json.rules;
  const extra = { id: "APP-1", label: "Wrist", kind: "ban", exerciseIds: [], keywords: ["wrist curl"], exceptKeywords: [], allow: [] };
  const ctx = [{ type: "text", text: JSON.stringify({ trainingLimits: { version: 4, rules: [rules[0], { ...rules[1], maxSetsPerWeek: 8 }, extra], maxWeeklySets: null } }) }];
  const file = join(dir, "context.json");
  writeFileSync(file, JSON.stringify(ctx));
  const next = cli(["limits", "sync-ops", "--root", dir, "--resolved", resolved, "--server", file]);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(next.json.expectedVersion, 4);
  assert.deepEqual(next.json.ops, [{ op: "lower_cap", ruleId: "L-002", maxSetsPerWeek: 6 }]);
  assert.deepEqual(next.json.appOnly.map((a: any) => [a.ruleId, a.reason]), [["APP-1", "removed"]]);
});

test("limits: usage errors exit 2; a context without trainingLimits exits 1", () => {
  const { dir } = root();
  assert.equal(cli(["limits"]).code, 2);
  assert.equal(cli(["limits", "nope", "--root", dir]).code, 2);
  assert.equal(cli(["limits", "sync-ops", "--root", dir]).code, 2);
  const r = cli(["limits", "sync-ops", "--root", dir, "--server", "-"], JSON.stringify({ today: "2026-10-12" }));
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, "NO_SERVER_LIMITS");
});
