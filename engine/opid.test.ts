import { test } from "node:test";
import assert from "node:assert/strict";
import { CoachError } from "./errors.ts";
import { OPID_RE, opId } from "./opid.ts";

const call = { tool: "mcp__tally__plan_workout_day", args: { date: "2026-10-12", expectedVersion: "v3", exercises: [{ name: "Back Squat", sets: 4 }] } };

test("opId: the §9 format", () => {
  const id = opId("2026-10-12", "trim_session", call);
  assert.match(id, OPID_RE);
  assert.match(id, /^op-2026-10-12-trim_session-[0-9a-f]{12}$/);
});

test("opId: stable for equal calls, whatever the key order or connector prefix", () => {
  const a = opId("2026-10-12", "trim_session", call);
  const reordered = { tool: "mcp__Tally_Workout__plan_workout_day", args: { exercises: [{ sets: 4, name: "Back Squat" }], expectedVersion: "v3", date: "2026-10-12" } };
  assert.equal(opId("2026-10-12", "trim_session", reordered), a);
  assert.equal(opId("2026-10-12", "trim_session", { ...call, tool: "mcp__claude_ai_Tally_Workout__plan_workout_day" }), a);
});

test("opId: different payloads, tools, kinds or dates give different IDs", () => {
  const a = opId("2026-10-12", "trim_session", call);
  const b = opId("2026-10-12", "trim_session", { ...call, args: { ...call.args, expectedVersion: "v4" } });
  const c = opId("2026-10-12", "trim_session", { ...call, tool: "mcp__tally__update_planned_workout" });
  const d = opId("2026-10-12", "swap_to_recovery", call);
  const e = opId("2026-10-13", "trim_session", call);
  assert.equal(new Set([a, b, c, d, e]).size, 5);
  assert.notEqual(a.slice(-12), b.slice(-12));
});

test("opId: apply and week kinds; bad input throws", () => {
  assert.match(opId("2026-10-12", "apply", call), /^op-2026-10-12-apply-/);
  assert.match(opId("2026-10-12", "week", call), /^op-2026-10-12-week-/);
  assert.throws(() => opId("2026-13-01", "apply", call), CoachError);
  assert.throws(() => opId("2026-10-12", "nope" as never, call), CoachError);
  assert.throws(() => opId("2026-10-12", "apply", { tool: "", args: {} }), CoachError);
});
