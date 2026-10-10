// the Tally T2 transition (safe writes, live in Tally production since
// 2026-10-09). ifAbsent on range days, expectedVersion on skip and delete, opId passed
// and the submitted id logged, replays reconciled with a re-read. The last test runs the
// real hooks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as R from "../../adapters/loggers/tally/rebuild.ts";
import { toolCallHash } from "../../engine/approvals.ts";
import { loadAdapterConfig } from "../../engine/logger.ts";
import { opId } from "../../engine/opid.ts";
import { loggedOpId, nextStep, reconcile } from "../../engine/oplog.ts";
import { mergeResponse, saveSnapshot } from "../../engine/snapshot.ts";
import { guard, type GuardInput } from "../../engine/validate.ts";
import type { Snapshot } from "../../engine/types.ts";
import { bench, emptyDay, guardInput, NOW, REPO, SESSION, snapDay, snapshot, squat, v } from "./fixtures.ts";

const D = "2026-10-15";
const E = "2026-10-16";
const V = v(`r-${D}`, "t0");
const OP = "op-2026-10-15-trim_session-0123456789ab";
/** The call's args with its engine opId (an opId is bound to its call). */
const withOp = (tool: string, args: Record<string, unknown>, date = D, kind: Parameters<typeof opId>[1] = "trim_session") => ({ ...args, opId: opId(date, kind, { tool, args }) });
const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];
const days = () => snapshot({ "2026-10-12": emptyDay(), "2026-10-13": emptyDay(), [D]: snapDay(D), [E]: emptyDay() });
const run = (over: Partial<GuardInput> & { snapshot?: Snapshot | null }) => guard(guardInput({ tool: "update_planned_workout", args: {}, snapshot: days(), ...over }));
const has = (reasons: string[], re: RegExp) => assert.ok(reasons.some((r) => re.test(r)), `no reason matches ${re}:\n${reasons.join("\n")}`);
const trim = { date: D, expectedVersion: V, operations: [{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 2 } }] };

test("adapter: the three T2 capabilities are true", () => {
  const caps = loadAdapterConfig("tally").capabilities;
  assert.equal(caps.rangeCreateIfAbsent, true);
  assert.equal(caps.versionedSkipDelete, true);
  assert.equal(caps.opId, true);
});

test("rebuild: ifAbsent, expectedVersion and opId are accepted and checked", () => {
  const s = days();
  const day = { date: E, dayType: "legs", dayName: "Legs", exercises: [squat] };
  // ifAbsent on an empty date writes; over a day, Tally skips it (exists) and the day stays.
  assert.equal(R.planWorkoutDay({ ...day, ifAbsent: true, opId: OP }, s)[0].after?.dayName, "Legs");
  const over = R.planWorkoutDay({ ...day, date: D, ifAbsent: true }, s)[0];
  assert.deepEqual(over.after, over.before);
  const range = R.planWorkoutRange({ days: [{ ...day, date: D, ifAbsent: true }, { ...day, ifAbsent: true }], opId: OP }, s);
  assert.deepEqual(range[0].after, range[0].before, "range day over a day stays");
  assert.equal(range[1].after?.dayName, "Legs");
  // ifAbsent cannot be combined with a version, replace or an override (Tally validation error).
  for (const extra of [{ expectedVersion: V }, { replace: true }, { overrideUserModified: true }, { expectedUpdatedAt: "t0" }]) {
    assert.throws(() => R.planWorkoutDay({ ...day, ifAbsent: true, ...extra }, s), /cannot be combined/);
  }
  assert.throws(() => R.planWorkoutDay({ ...day, ifAbsent: "yes" }, s), /ifAbsent must be true or false/);
  // skip and delete take expectedVersion and opId.
  assert.equal(R.skipPlannedWorkout({ date: D, expectedVersion: V, opId: OP }, s)[0].after?.skipped, true);
  assert.equal(R.deletePlannedWorkout({ date: D, expectedVersion: V, opId: OP }, s)[0].after, null);
  assert.throws(() => R.skipPlannedWorkout({ date: D, expectedVersion: 7 }, s), /expectedVersion must be the version string/);
  // opId: 8-120 characters of letters, digits, ".", "_", ":" or "-".
  for (const bad of ["short", "x".repeat(121), "op id with spaces", 12345678]) {
    assert.throws(() => R.updatePlannedWorkout({ ...trim, opId: bad }, s), /opId must be 8-120 characters/, String(bad));
  }
  assert.doesNotThrow(() => R.movePlannedWorkout({ fromDate: D, toDate: E, expectedVersion: V, opId: OP }, s));
});

test("guard: a range needs ifAbsent: true on every day; then it is no longer denied for T2", () => {
  const legs = { date: E, dayType: "legs", dayName: "Legs", exercises: [squat] };
  const without = run({ tool: "plan_workout_range", args: { days: [legs] } });
  assert.equal(without.decision, "deny");
  has(without.reasons, /must carry ifAbsent: true/);
  const ok = run({ tool: "plan_workout_range", args: withOp("plan_workout_range", { days: [{ ...legs, ifAbsent: true }] }, E, "week") });
  assert.ok(!ok.reasons.some((r) => /T2|ifAbsent/.test(r)), ok.reasons.join("; "));
  assert.notEqual(ok.decision, "deny", ok.reasons.join("; "));
  // Over an existing day the range is still denied.
  has(run({ tool: "plan_workout_range", args: { days: [{ ...legs, date: D, ifAbsent: true }] } }).reasons, /over 2026-10-15, which already has a day/);
});

test("guard: plan_workout_day with ifAbsent over a day is denied with the reason", () => {
  const r = run({ tool: "plan_workout_day", args: { date: D, dayType: "push", dayName: "Push", exercises: [bench], ifAbsent: true } });
  assert.equal(r.decision, "deny");
  has(r.reasons, /ifAbsent: true would be skipped \(code exists\)/);
});

test("guard: skip and delete need the snapshot's expectedVersion in both modes", () => {
  for (const tool of ["skip_planned_workout", "delete_planned_workout"]) {
    for (const mode of ["interactive", "unattended"] as const) {
      const none = run({ tool, args: { date: D }, mode });
      assert.equal(none.decision, "deny", `${tool} ${mode} without a version`);
      has(none.reasons, /must carry expectedVersion/);
      has(run({ tool, args: { date: D, expectedVersion: v(`r-${D}`, "t9") }, mode }).reasons, /not the version in the snapshot/);
    }
    // With the version, an MCP day's skip or delete is a trim: allowed unattended.
    const ok = run({ tool, args: withOp(tool, { date: D, expectedVersion: V }), mode: "unattended" });
    assert.equal(ok.decision, "allow", `${tool}: ${ok.reasons.join("; ")}`);
  }
});

test("guard: a malformed opId is denied", () => {
  const r = run({ args: { ...trim, opId: "bad id" } });
  assert.equal(r.decision, "deny");
  has(r.reasons, /opId bad id is not the engine.s opId for this call/);
  assert.equal(run({ args: withOp("update_planned_workout", trim) }).decision, "allow");
});

test("opId: the hash ignores a submitted opId; the log records the submitted id", () => {
  assert.equal(toolCallHash("update_planned_workout", { ...trim, opId: OP }), toolCallHash("update_planned_workout", trim));
  assert.equal(loggedOpId(D, "trim_session", { tool: "update_planned_workout", args: { ...trim, opId: OP } }), OP);
  assert.match(loggedOpId(D, "trim_session", { tool: "update_planned_workout", args: trim }), /^op-2026-10-15-trim_session-[0-9a-f]{12}$/);
});

test("replay: reconciled as history per result, with a re-read; the snapshot forgets every named date", () => {
  const resp = { replayed: true, opId: OP, recordedAt: "2026-10-14T06:00:00Z", results: [{ date: D, status: "moved", toDate: E, id: "r1", updatedAt: "t1", version: "x" }] };
  const r = reconcile("mcp__tally__move_planned_workout", { fromDate: D, toDate: E, opId: OP }, text(resp));
  assert.equal(r.status, "replayed");
  assert.deepEqual(r.dates, [D, E]);
  assert.match(r.detail, /replay of op-2026-10-15-trim_session-0123456789ab recorded 2026-10-14T06:00:00Z: nothing new was written; the stored outcome: 2026-10-15→2026-10-16 moved/);
  assert.match(nextStep(r), /read the days again/);
  const range = reconcile("mcp__tally__plan_workout_range", { days: [{ date: D }, { date: E }], opId: OP }, text({ replayed: true, opId: OP, recordedAt: null, results: [{ date: D, status: "written" }, { date: E, status: "skipped", code: "exists" }] }));
  assert.equal(range.status, "replayed");
  assert.match(range.detail, /2026-10-15 written, 2026-10-16 skipped \(exists\)/);

  const prev = days();
  const merged = mergeResponse(prev, { session_id: SESSION, tool: "skip_planned_workout", input: { date: D, expectedVersion: V, opId: OP }, response: text({ replayed: true, opId: OP, recordedAt: null, results: [{ date: D, status: "updated" }] }), now: NOW, timezone: "America/Los_Angeles" });
  assert.equal(merged.days[D], undefined, "the replayed day must be read again");
});

// ---------- the real hooks ----------

const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR", "COACH_NOW"].includes(k)));

function hook(name: string, root: string, input: unknown, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(REPO, ".claude/hooks", `${name}.ts`)], { input: JSON.stringify(input), encoding: "utf8", env: { ...BASE_ENV, CLAUDE_PROJECT_DIR: root, COACH_NOW: NOW, ...env } });
  return { code: r.status, stderr: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

test("hooks: an unattended skip with its version and opId is allowed and logged under the submitted opId; a replay asks for a re-read", () => {
  const root = mkdtempSync(join(tmpdir(), "coach-t2-"));
  cpSync(join(REPO, "coach.example.yaml"), join(root, "coach.yaml"));
  mkdirSync(join(root, "athlete"), { recursive: true });
  cpSync(join(REPO, "templates/athlete/limits.yaml"), join(root, "athlete/limits.yaml"));
  cpSync(join(REPO, "templates/athlete/hold.yaml"), join(root, "athlete/hold.yaml"));
  cpSync(join(REPO, "methods"), join(root, "methods"), { recursive: true });
  saveSnapshot(root, days());
  const input = withOp("skip_planned_workout", { date: D, expectedVersion: V });
  const OP = input.opId;
  const call = { session_id: SESSION, hook_event_name: "PreToolUse", tool_name: "mcp__Tally_Workout__skip_planned_workout", tool_input: input, tool_use_id: "toolu_1" };
  const g = hook("guard-writes", root, call, { CLAUDE_CODE_REMOTE: "true" });
  assert.equal(g.code, 0, g.stderr);
  assert.equal(g.json?.hookSpecificOutput?.permissionDecision, undefined, JSON.stringify(g.json));
  const l = hook("log-writes", root, { ...call, hook_event_name: "PostToolUse", tool_response: text({ date: D, status: "updated", skipped: true, updatedAt: "t1" }) }, { CLAUDE_CODE_REMOTE: "true" });
  assert.equal(l.code, 0, l.stderr);
  assert.match(l.json.hookSpecificOutput.additionalContext, new RegExp(`coach log: ${OP} written`));
  assert.match(readFileSync(join(root, "athlete/log/2026-10.md"), "utf8"), new RegExp(`## 2026-10-14 07:00 · ${OP}`));
  const rp = hook("log-writes", root, { ...call, hook_event_name: "PostToolUse", tool_use_id: "toolu_2", tool_response: text({ replayed: true, opId: OP, recordedAt: "2026-10-14T06:00:00Z", results: [{ date: D, status: "updated" }] }) });
  assert.match(rp.json.hookSpecificOutput.additionalContext, /replayed .*read the days again/);
});

// ---------- an opId is bound to its call ----------

test("round 2 #1: the guard accepts an opId only when it is the engine's opId for that call", async () => {
  const { opId } = await import("../../engine/opid.ts");
  const E_V = v(`r-${E}`, "t0");
  const s = snapshot({ "2026-10-12": emptyDay(), "2026-10-13": emptyDay(), [D]: snapDay(D), [E]: snapDay(E) });
  const skipD = { date: D, expectedVersion: V };
  const skipE = { date: E, expectedVersion: E_V };
  const idD = opId(D, "trim_session", { tool: "skip_planned_workout", args: skipD });
  const ok = run({ tool: "skip_planned_workout", args: { ...skipD, opId: idD }, snapshot: s, mode: "unattended" });
  assert.equal(ok.decision, "allow", ok.reasons.join("; "));
  // The reviewer's case: one key for two different calls. The second call is denied.
  const reused = run({ tool: "skip_planned_workout", args: { ...skipE, opId: idD }, snapshot: s, mode: "unattended" });
  assert.equal(reused.decision, "deny");
  has(reused.reasons, /opId .* is not the engine's opId for this call/);
  // A free-form key is denied too, even well formed for Tally.
  for (const key of ["same-key-123", "op-2026-10-15-not_a_kind-0123456789ab", "op-2026-13-40-trim_session-0123456789ab"]) {
    const r = run({ tool: "skip_planned_workout", args: { ...skipD, opId: key }, snapshot: s, mode: "unattended" });
    assert.equal(r.decision, "deny", key);
  }
  // The opId does not change the call hash, so it can be computed before it is added.
  const trimId = opId(D, "trim_session", { tool: "update_planned_workout", args: trim });
  assert.equal(run({ args: { ...trim, opId: trimId } }).decision, "allow");
});
