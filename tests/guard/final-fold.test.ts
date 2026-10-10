// The final fold after the confirmation review (contracts §23, §24): line continuations
// and expansions around node, and recovery swaps that add work. Each test fails on 52d8732.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyChange, isTrimOf } from "../../engine/classify.ts";
import { fileGuard, joinContinuations } from "../../engine/protect.ts";
import { guard, type GuardInput } from "../../engine/validate.ts";
import { fastFileDecision } from "../../.claude/hooks/fast-files.ts";
import { block, config, emptyDay, guardInput, NOW, REPO, rules, snapDay, snapshot, squat, tax, v } from "./fixtures.ts";
import type { DayPlan } from "../../engine/types.ts";

const SHA = "a".repeat(40);

function instance(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coach-fold-")));
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

const decide = (root: string, command: string, mode: "interactive" | "unattended") => fileGuard({ tool_name: "Bash", tool_input: { command }, mode, root, branch: "main", proposalsOnMain: [] }).decision;

test("fix 1a: backslash-newlines are joined first, so a split script path is judged as engine/cli.ts update", () => {
  const root = instance();
  const split = `node en\\\ngine/cli.ts upda\\\nte --yes --to ${SHA}`;
  assert.equal(joinContinuations(split), `node engine/cli.ts update --yes --to ${SHA}`);
  assert.equal(decide(root, split, "interactive"), "ask");
  assert.equal(decide(root, split, "unattended"), "deny");
  assert.equal(fastFileDecision("Bash", { command: split }, root), null);
  // Single quotes keep a backslash-newline; a joined plain engine call keeps its decision.
  assert.equal(joinContinuations("echo 'a\\\nb'"), "echo 'a\\\nb'");
  assert.equal(joinContinuations('echo "a\\\nb"'), 'echo "ab"');
  assert.equal(decide(root, "node engine/cli.ts hold \\\nstatus", "interactive"), "allow");
  assert.equal(decide(root, "node engine/cli.ts hold \\\nstatus", "unattended"), "allow");
});

test("fix 1b: a node command with a glob, a backslash, $ or a backtick asks; quoted forms keep their decisions", () => {
  const root = instance();
  for (const c of [`node engin?/cli.ts update --yes --to ${SHA}`, `node engine/cli.t[s] update --yes --to ${SHA}`, `node e\\ngine/cli.ts update --yes --to ${SHA}`, `node $E/cli.ts update --yes --to ${SHA}`, "node `echo engine`/cli.ts update --yes", `node engine/cli.ts upd*te --yes --to ${SHA}`]) {
    assert.equal(decide(root, c, "interactive"), "ask", c);
    assert.equal(decide(root, c, "unattended"), "deny", c);
    assert.equal(fastFileDecision("Bash", { command: c }, root), null, `fast: ${c}`);
  }
  const keep: [string, string][] = [
    ['node engine/cli.ts hold set --reason "knee pain"', "allow"],
    ['node engine/cli.ts "update" --check', "allow"],
    ['node engine/cli.ts "up"date --yes', "ask"],
    ["node engine/cli.ts mode", "allow"],
    ["node --version", "allow"],
  ];
  for (const [c, want] of keep) {
    assert.equal(decide(root, c, "interactive"), want, c);
    if (c !== "node engine/cli.ts mode" && c !== "node --version") assert.equal(fastFileDecision("Bash", { command: c }, root), null, `fast: ${c}`);
  }
});

// ---------- fix 2: recovery swaps that add work ----------

const D = "2026-10-15";
const V = v(`r-${D}`, "t0");
const bike = { exerciseId: "zone2_bike", name: "Zone 2 Bike", suggestedSets: 2, suggestedDuration: 600, distanceMeters: 1000 };
const days = (exercises: unknown[]) => ({ "2026-10-12": emptyDay(), "2026-10-13": emptyDay(), [D]: snapDay(D, { exercises }) });
const run = (exercises: unknown[], operations: unknown[], over: Partial<GuardInput> = {}) =>
  guard(guardInput({ tool: "update_planned_workout", args: { date: D, expectedVersion: V, operations }, snapshot: snapshot(days(exercises)), ...over }));
const ordinary = { active: true, set_at: NOW, reason: "left knee pain 5/10", regions: ["left-knee"], set_by: "safety-agent" };

test("fix 2a: the reviewer's bike-only day (sets 2 → 1, distance 1000 → 20000) is big: denied unattended and under a hold", () => {
  const ops = [{ op: "modify", target: { exerciseId: "zone2_bike" }, fields: { suggestedSets: 1, distanceMeters: 20000 } }];
  const un = run([bike], ops, { mode: "unattended" });
  assert.equal(un.decision, "deny", un.reasons.join("; "));
  assert.equal(un.big, true);
  assert.ok(!(un.kinds ?? []).includes("swap_to_recovery"), JSON.stringify(un.kinds));
  const held = run([bike], ops, { hold: ordinary });
  assert.equal(held.decision, "deny", held.reasons.join("; "));
  // More duration on a recovery day adds work too.
  assert.equal(run([bike], [{ op: "modify", target: { exerciseId: "zone2_bike" }, fields: { suggestedDuration: 3600 } }], { hold: ordinary }).decision, "deny");
});

test("fix 2b: a rise below the old maximum is extra work: [1000, 100, 100] → [1000, 1000] is not a trim", () => {
  const set = (d: number) => ({ reps: 5, weight: 225, distance_m: d });
  const before: DayPlan = { date: D, exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", unit: "lbs", sets: [set(1000), set(100), set(100)] }] };
  const after: DayPlan = { date: D, exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", unit: "lbs", sets: [set(1000), set(1000)] }] };
  assert.equal(isTrimOf(before, after, "lbs"), false);
  const ctx = { block: block(), history: [], tool: "update_planned_workout" as const, snapshotDay: null, tax: tax(), rules: rules(), config: config(), today: "2026-10-14" };
  const c = classifyChange(before, after, ctx);
  assert.ok(!c.kinds.includes("trim_session"), JSON.stringify(c));
  assert.equal(c.big, true);
});

test("fix 2c: a real recovery swap still passes, unattended and under a hold", () => {
  const z2 = { exerciseId: "zone2_bike", name: "Zone 2 Bike", suggestedSets: 1, suggestedDuration: 1800 };
  const swap = [{ op: "replace", target: { exerciseId: "Barbell_Squat" }, exercise: z2 }];
  for (const over of [{ mode: "unattended" as const }, { hold: ordinary }]) {
    const r = run([squat], swap, over);
    assert.equal(r.decision, "allow", r.reasons.join("; "));
    assert.ok((r.kinds ?? []).includes("swap_to_recovery"), JSON.stringify(r.kinds));
  }
  // A shorter existing recovery session is fine too.
  const shorter = run([bike], [{ op: "modify", target: { exerciseId: "zone2_bike" }, fields: { suggestedSets: 1, distanceMeters: 500 } }], { hold: ordinary });
  assert.equal(shorter.decision, "allow", shorter.reasons.join("; "));
});
