import { test } from "node:test";
import assert from "node:assert/strict";
import { CoachError } from "./errors.ts";
import { serverLimitsFromContext, syncOps } from "./limits-sync.ts";
import type { ServerState } from "./limits-sync.ts";
import type { ServerRule } from "./server-match.ts";

const knee: ServerRule = {
  id: "L-001",
  label: "Left knee: No deep squats under load",
  region: "left-knee",
  kind: "ban",
  exerciseIds: ["barbell_back_squat"],
  keywords: ["back squat", "squat"],
  exceptKeywords: ["box squat"],
  allow: [{ exerciseId: "box_squat", name: "Box Squat" }],
};
const back: ServerRule = { id: "L-002", label: "Low back: Hinge capped", region: "low-back", kind: "cap", exerciseIds: [], keywords: ["deadlift"], exceptKeywords: [], allow: [], maxSetsPerWeek: 6 };
const server = (rules: ServerRule[], maxWeeklySets: number | null = null, version = 7): ServerState => ({ version, rules, maxWeeklySets });

test("no change: no ops, nothing app-only, the server version is the expected version", () => {
  // Order, case and id changes inside the lists are not content changes.
  const reordered = { ...knee, keywords: ["squat", "back squat"], exerciseIds: ["Barbell_Back_Squat"] };
  assert.deepEqual(syncOps({ rules: [reordered, back] }, server([knee, back])), { ops: [], appOnly: [], expectedVersion: 7 });
});

test("a new limit becomes add_rule; with no limits row the expected version is null", () => {
  assert.deepEqual(syncOps({ rules: [knee] }, null), { ops: [{ op: "add_rule", rule: knee }], appOnly: [], expectedVersion: null });
  const r = syncOps({ rules: [knee, back] }, server([knee]));
  assert.deepEqual(r.ops, [{ op: "add_rule", rule: back }]);
  assert.deepEqual(r.appOnly, []);
});

test("a tightened cap becomes lower_cap on the server rule", () => {
  const r = syncOps({ rules: [{ ...back, maxSetsPerWeek: 4 }] }, server([back]));
  assert.deepEqual(r.ops, [{ op: "lower_cap", ruleId: "L-002", maxSetsPerWeek: 4 }]);
  assert.deepEqual(r.appOnly, []);
});

test("a loosened cap is app only: no op, and a sentence that names the app", () => {
  const r = syncOps({ rules: [{ ...back, maxSetsPerWeek: 10 }] }, server([back]));
  assert.deepEqual(r.ops, []);
  assert.equal(r.appOnly.length, 1);
  assert.equal(r.appOnly[0].ruleId, "L-002");
  assert.equal(r.appOnly[0].reason, "looser_locally");
  assert.match(r.appOnly[0].sentence, /at 6 sets a week, but athlete\/limits\.yaml allows 10/);
  assert.match(r.appOnly[0].sentence, /Tally app: Settings → Training limits/);
});

test("a removed limit is app only", () => {
  const r = syncOps({ rules: [back] }, server([knee, back]));
  assert.deepEqual(r.ops, []);
  assert.deepEqual(r.appOnly.map((a) => [a.ruleId, a.reason]), [["L-001", "removed"]]);
  assert.match(r.appOnly[0].sentence, /Remove or relax it in the Tally app/);
});

test("a changed match list becomes a new rule with the next free id; the old rule is app only", () => {
  const changed = { ...knee, keywords: [...knee.keywords, "lunge"] };
  const r = syncOps({ rules: [changed] }, server([knee]));
  assert.deepEqual(r.ops, [{ op: "add_rule", rule: { ...changed, id: "L-001_2" } }]);
  assert.deepEqual(r.appOnly.map((a) => [a.ruleId, a.reason]), [["L-001", "replaced"]]);
  assert.match(r.appOnly[0].sentence, /added as L-001_2/);
  // _2 is taken: the next free suffix. A removed allow entry is a content change too.
  const again = syncOps({ rules: [{ ...knee, allow: [] }] }, server([knee, { ...changed, id: "L-001_2" }]));
  assert.deepEqual(again.ops.map((o) => o.op === "add_rule" && o.rule.id), ["L-001_3"]);
  assert.match(again.ops[0].op === "add_rule" ? again.ops[0].rule.id : "", /^[A-Za-z0-9_-]{1,40}$/);
});

test("a server rule with the same content under another id counts as present", () => {
  assert.deepEqual(syncOps({ rules: [knee] }, server([{ ...knee, id: "L-001_2" }])).ops, []);
});

test("a cap that changed to a ban is a new rule; the old cap is app only", () => {
  const { maxSetsPerWeek: _cap, ...rest } = back;
  const ban: ServerRule = { ...rest, kind: "ban" };
  const r = syncOps({ rules: [ban] }, server([back]));
  assert.deepEqual(r.ops.map((o) => o.op === "add_rule" && [o.rule.id, o.rule.kind]), [["L-002_2", "ban"]]);
  assert.deepEqual(r.appOnly.map((a) => a.reason), ["replaced"]);
});

test("weekly cap: a lower compiled cap is set_weekly_cap; a server cap the compiled set lacks is app only", () => {
  assert.deepEqual(syncOps({ rules: [], maxWeeklySets: 100 }, server([], 120)).ops, [{ op: "set_weekly_cap", maxWeeklySets: 100 }]);
  assert.deepEqual(syncOps({ rules: [], maxWeeklySets: 100 }, null).ops, [{ op: "set_weekly_cap", maxWeeklySets: 100 }]);
  assert.deepEqual(syncOps({ rules: [], maxWeeklySets: 100 }, server([], 100)).ops, []);
  const none = syncOps({ rules: [] }, server([], 90));
  assert.deepEqual(none.ops, []);
  assert.deepEqual(none.appOnly.map((a) => a.reason), ["weekly_cap"]);
  assert.deepEqual(syncOps({ rules: [], maxWeeklySets: 100 }, server([], 90)).appOnly.map((a) => a.reason), ["weekly_cap"]);
});

test("a sync that would pass Tally's 50 rules fails with a clear error", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ ...back, id: `S-${i}`, keywords: [`k${i}`] }));
  assert.throws(() => syncOps({ rules: [knee] }, server(many)), (e: unknown) => e instanceof CoachError && e.code === "SERVER_LIMITS_FULL");
});

test("the server limits come from a get_training_context result in any of its forms", () => {
  const ctx = { today: "2026-10-12", trainingLimits: { version: 3, rules: [knee], maxWeeklySets: null } };
  const want = { version: 3, rules: [knee], maxWeeklySets: null };
  assert.deepEqual(serverLimitsFromContext(ctx), want);
  assert.deepEqual(serverLimitsFromContext([{ type: "text", text: JSON.stringify(ctx) }]), want);
  assert.deepEqual(serverLimitsFromContext({ content: [{ type: "text", text: JSON.stringify(ctx) }] }), want);
  assert.deepEqual(serverLimitsFromContext(ctx.trainingLimits), want);
  assert.equal(serverLimitsFromContext({ today: "2026-10-12", trainingLimits: null }), null);
  assert.throws(() => serverLimitsFromContext({ today: "2026-10-12" }), (e: unknown) => e instanceof CoachError && e.code === "NO_SERVER_LIMITS");
  assert.throws(() => serverLimitsFromContext({ trainingLimits: { version: 1, rules: [{ id: "bad id!", kind: "ban" }] } }), (e: unknown) => e instanceof CoachError && e.code === "SERVER_LIMITS_INVALID");
  assert.throws(() => serverLimitsFromContext({ trainingLimits: { version: 1, rules: [{ id: "L-1", kind: "cap" }] } }), /without maxSetsPerWeek/);
});

test("compiled rules with the same content are one requirement, the strictest cap, one op per target", () => {
  const squat = (id: string, max: number): ServerRule => ({ id, label: id, kind: "cap", exerciseIds: [], keywords: ["squat"], exceptKeywords: [], allow: [], maxSetsPerWeek: max });
  // The reviewer's case: one server cap of 10, compiled caps of 4 and 6.
  const r = syncOps({ rules: [squat("L-001", 4), squat("L-002", 6)] }, server([squat("L-001", 10)]));
  assert.deepEqual(r.ops, [{ op: "lower_cap", ruleId: "L-001", maxSetsPerWeek: 4 }]);
  assert.deepEqual(r.appOnly, []);
  // The order of the compiled rules does not matter.
  assert.deepEqual(syncOps({ rules: [squat("L-002", 6), squat("L-001", 4)] }, server([squat("L-001", 10)])).ops, r.ops);
  // No server rule: one add_rule with the strictest cap.
  const fresh = syncOps({ rules: [squat("L-001", 6), squat("L-002", 4)] }, null);
  assert.deepEqual(fresh.ops, [{ op: "add_rule", rule: squat("L-001", 4) }]);
  // app-only is computed against the combined requirement (4): a server cap of 3 is stricter.
  const strict = syncOps({ rules: [squat("L-001", 4), squat("L-002", 6)] }, server([squat("L-001", 3)]));
  assert.deepEqual(strict.ops, []);
  assert.deepEqual(strict.appOnly.map((a) => a.reason), ["looser_locally"]);
  assert.match(strict.appOnly[0].sentence, /allows 4/);
  // A ban and a cap with the same lists: the ban is the requirement; a server cap of that content is app only.
  const ban: ServerRule = { ...squat("L-003", 0), kind: "ban" };
  delete (ban as { maxSetsPerWeek?: number }).maxSetsPerWeek;
  assert.deepEqual(syncOps({ rules: [ban, squat("L-001", 4)] }, server([ban])).ops, [{ op: "add_rule", rule: squat("L-001", 4) }]);
});
