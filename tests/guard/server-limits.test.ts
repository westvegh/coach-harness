// Tally T3 server limits (contracts §21): the
// adapter capability, refusals in the log and the snapshot, and the guard's verdict on
// update_training_limits. The last tests run the real hooks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAdapterConfig, loadLogger, serverLimits } from "../../engine/logger.ts";
import { reconcile } from "../../engine/oplog.ts";
import { mergeResponse, saveSnapshot } from "../../engine/snapshot.ts";
import { guard } from "../../engine/validate.ts";
import { emptyDay, guardInput, NOW, REPO, SESSION, snapDay, snapshot, v } from "./fixtures.ts";

const D = "2026-10-15";
const E = "2026-10-16";
const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];
const limit = { ruleId: "L-001", label: "Left knee: No deep squats under load", kind: "ban" };
const refusedDay = (date: string) => ({ date, status: "refused", code: "training_limit", limit, week: { start: "2026-10-12", after: 4, limit: 0 }, exercises: ["Back Squat"] });
const tighten = { ops: [{ op: "lower_cap", ruleId: "L-002", maxSetsPerWeek: 4 }], expectedVersion: 3 };

// ---------- adapter ----------

test("adapter: server_limits is true only when the tool list holds update_training_limits; the tool map names it", () => {
  const cfg = loadAdapterConfig("tally");
  assert.deepEqual(cfg.capabilities.server_limits, { when_tool: "update_training_limits" });
  assert.equal(cfg.tools.limits?.update, "update_training_limits");
  assert.ok(serverLimits(cfg, ["mcp__claude_ai_Tally_Workout__get_training_context", "mcp__claude_ai_Tally_Workout__update_training_limits"]));
  assert.ok(serverLimits(cfg, ["mcp__tally__update_training_limits"]));
  assert.ok(!serverLimits(cfg, ["mcp__tally__get_training_context", "mcp__tally__plan_workout_day"]));
  assert.ok(!serverLimits(cfg, ["mcp__github__update_training_limits"]), "another server's tool of the same name does not count");
  assert.ok(new RegExp(cfg.matcher).test("mcp__tally__update_training_limits"));
  assert.ok(loadLogger("tally").isMutation("update_training_limits"));
});

// ---------- the log ----------

test("reconcile: a refused single day is status refused, names the rule, and is not retried", () => {
  const r = reconcile("mcp__tally__plan_workout_day", { date: D, exercises: [] }, text(refusedDay(D)));
  assert.equal(r.status, "refused");
  assert.deepEqual(r.dates, [D]);
  assert.match(r.detail, /limit L-001 "Left knee: No deep squats under load" \(ban\) on 2026-10-15: Back Squat/);
  assert.match(r.detail, /Not retried: only the user can change a Tally limit, in the Tally app/);
  // Flagged as an error, a refusal is still read as a refusal.
  assert.equal(reconcile("mcp__tally__update_planned_workout", { date: D }, { isError: true, content: text(refusedDay(D)) }).status, "refused");
});

test("reconcile: an opId call refused as a whole lists every date not written and the weekly cap", () => {
  const resp = { status: "refused", code: "training_limit", violatingDate: E, limit: { weeklyCap: true }, week: { start: "2026-10-12", after: 130, limit: 120 }, exercises: ["Bench Press"], notWritten: [D, E] };
  const r = reconcile("mcp__tally__plan_workout_range", { days: [{ date: D }, { date: E }] }, text(resp));
  assert.equal(r.status, "refused");
  assert.deepEqual(r.dates, [D, E]);
  assert.match(r.detail, /the weekly cap on 2026-10-16: Bench Press; week of 2026-10-12: 130 sets, limit 120; not written: 2026-10-15, 2026-10-16/);
});

test("reconcile: a range without opId can be written in part; the refused day is named", () => {
  const resp = { results: [{ date: D, status: "written" }, refusedDay(E)], skippedDates: [] };
  const r = reconcile("mcp__tally__plan_workout_range", { days: [{ date: D }, { date: E }] }, text(resp));
  assert.equal(r.status, "written");
  assert.match(r.detail, /^written: 2026-10-15; refused by Tally: limit L-001 .* on 2026-10-16/);
  const all = reconcile("mcp__tally__plan_workout_range", { days: [{ date: E }] }, text({ results: [refusedDay(E)], skippedDates: [] }));
  assert.equal(all.status, "refused");
});

test("reconcile: update_training_limits results", () => {
  const t = "mcp__tally__update_training_limits";
  assert.deepEqual(reconcile(t, tighten, text({ status: "updated", version: 4, limits: {} })).status, "written");
  assert.match(reconcile(t, tighten, text({ status: "conflict", version: 5 })).detail, /read get_training_context again/);
  assert.equal(reconcile(t, tighten, text({ status: "invalid", reason: "not lower" })).status, "skipped");
});

// ---------- the snapshot: the after-write week check sees a refused day as unchanged ----------

test("snapshot: a refused write leaves its days as they were; a partial range forgets only the written days", () => {
  const prev = snapshot({ [D]: snapDay(D), [E]: emptyDay() });
  const m = (tool: string, input: unknown, response: unknown) => mergeResponse(prev, { session_id: SESSION, tool, input, response, now: NOW, timezone: "America/Los_Angeles" });
  for (const [tool, input] of [
    ["update_planned_workout", { date: D }],
    ["plan_workout_day", { date: D }],
    ["move_planned_workout", { fromDate: D, toDate: E }],
  ] as const) {
    const after = m(tool, input, text(refusedDay(D)));
    assert.deepEqual(after.days, prev.days, tool);
  }
  const range = m("plan_workout_range", { days: [{ date: D }, { date: E }] }, text({ results: [{ date: E, status: "written" }, refusedDay(D)], skippedDates: [] }));
  assert.deepEqual(range.days[D], prev.days[D], "the refused day stays");
  assert.equal(range.days[E], undefined, "the written day must be read again");
  // Without a refusal, a plan write still forgets the day (unchanged behavior).
  assert.equal(m("plan_workout_day", { date: D }, text({ results: [{ date: D }], skippedDates: [] })).days[D], undefined);
  assert.deepEqual(m("update_training_limits", tighten, text({ status: "updated", version: 4 })).days, prev.days);
});

// ---------- the guard ----------

test("guard: update_training_limits is a limit change — ask interactive, deny unattended", () => {
  const s = snapshot({});
  const run = (args: unknown, mode: "interactive" | "unattended" = "interactive") => guard(guardInput({ tool: "update_training_limits", args, snapshot: s, mode }));
  const ask = run(tighten);
  assert.equal(ask.decision, "ask");
  assert.deepEqual(ask.kinds, ["limit_change"]);
  const deny = run(tighten, "unattended");
  assert.equal(deny.decision, "deny");
  assert.match(deny.reasons.join(" "), /never allowed in an unattended run/);
  // Only tightening ops have a shape the guard passes on to the user.
  assert.equal(run({ ops: [{ op: "remove_rule", ruleId: "L-001" }], expectedVersion: 3 }).decision, "deny");
  assert.equal(run({ ops: [], expectedVersion: 3 }).decision, "deny");
  assert.equal(run({ ops: tighten.ops, expectedVersion: 3, force: true }).decision, "deny");
  assert.equal(run({ ops: tighten.ops, expectedVersion: null }).decision, "ask");
});

// ---------- the real hooks ----------

const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR", "COACH_NOW"].includes(k)));
const TALLY = "mcp__claude_ai_Tally_Workout__";

function instance(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-t3-"));
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  cpSync(join(REPO, "templates/athlete/limits.yaml"), join(dir, "athlete/limits.yaml"));
  cpSync(join(REPO, "templates/athlete/hold.yaml"), join(dir, "athlete/hold.yaml"));
  cpSync(join(REPO, "methods"), join(dir, "methods"), { recursive: true });
  return dir;
}

function hook(name: string, root: string, input: unknown, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(REPO, ".claude/hooks", `${name}.ts`)], { input: JSON.stringify(input), encoding: "utf8", env: { ...BASE_ENV, CLAUDE_PROJECT_DIR: root, COACH_NOW: NOW, ...env } });
  return { code: r.status, stderr: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

test("hooks: guard-writes asks for update_training_limits, denies it unattended; log-writes logs a refusal as refused", () => {
  const root = instance();
  saveSnapshot(root, snapshot({ [D]: snapDay(D) }));
  const pre = (tool: string, tool_input: unknown, id = "toolu_1") => ({ session_id: SESSION, hook_event_name: "PreToolUse", tool_name: TALLY + tool, tool_input, tool_use_id: id });

  const ask = hook("guard-writes", root, pre("update_training_limits", tighten));
  assert.equal(ask.code, 0, ask.stderr);
  assert.equal(ask.json.hookSpecificOutput.permissionDecision, "ask");
  const deny = hook("guard-writes", root, pre("update_training_limits", tighten), { COACH_UNATTENDED: "1" });
  assert.equal(deny.json.hookSpecificOutput.permissionDecision, "deny");

  const logged = hook("log-writes", root, { ...pre("update_training_limits", tighten), hook_event_name: "PostToolUse", tool_response: text({ status: "updated", version: 4 }) });
  assert.equal(logged.code, 0, logged.stderr);
  assert.match(logged.json.hookSpecificOutput.additionalContext, /written \(Tally limits saved \(version 4\)\)/);

  const trim = { date: D, expectedVersion: v(`r-${D}`, "t0"), operations: [{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 2 } }] };
  const g = hook("guard-writes", root, pre("update_planned_workout", trim, "toolu_2"));
  assert.equal(g.code, 0, g.stderr);
  const l = hook("log-writes", root, { ...pre("update_planned_workout", trim, "toolu_2"), hook_event_name: "PostToolUse", tool_response: text(refusedDay(D)) });
  assert.equal(l.code, 0, l.stderr);
  assert.match(l.json.hookSpecificOutput.additionalContext, /refused \(refused by Tally: limit L-001 .*\)\..* Nothing was written\./);
  const log = readFileSync(join(root, "athlete/log/2026-10.md"), "utf8");
  assert.match(log, /- result: refused: refused by Tally: limit L-001 "Left knee: No deep squats under load" \(ban\) on 2026-10-15: Back Squat/);

  // capture-reads keeps the refused day in the snapshot.
  const c = hook("capture-reads", root, { session_id: SESSION, tool_name: TALLY + "update_planned_workout", tool_input: trim, tool_response: text(refusedDay(D)) });
  assert.equal(c.code, 0, c.stderr);
  const snap = JSON.parse(readFileSync(join(root, "athlete/.cache/snapshot.json"), "utf8"));
  assert.equal(snap.days[D].version, v(`r-${D}`, "t0"));
});

test("a mixed range keeps the written dates, the refusal guidance and the week check", () => {
  const W = "2026-10-14";
  const resp = { results: [{ date: W, status: "written" }, refusedDay(D)], skippedDates: [{ date: E, code: "version_conflict", reason: "changed" }] };
  const r = reconcile("mcp__tally__plan_workout_range", { days: [{ date: W }, { date: D }, { date: E }] }, text(resp));
  assert.equal(r.status, "written", "a day was written: the week check must run");
  assert.match(r.detail, /written: 2026-10-14/);
  assert.match(r.detail, /refused by Tally: limit L-001 .* on 2026-10-15/);
  assert.match(r.detail, /Not retried: only the user can change a Tally limit/);
  assert.match(r.detail, /version conflict on 2026-10-16/);
  // Nothing written: a conflict still keeps the refusal guidance.
  const none = reconcile("mcp__tally__plan_workout_range", { days: [{ date: D }, { date: E }] }, text({ results: [refusedDay(D)], skippedDates: [{ date: E, code: "version_conflict", reason: "changed" }] }));
  assert.equal(none.status, "conflict");
  assert.match(none.detail, /Not retried/);
});
