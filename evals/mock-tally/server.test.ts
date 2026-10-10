// Unit tests for the mock Tally: every tool and semantic, driven over
// stdio. Tally references: workout-api/lib/mcp (t2-build 0c9d680) and
// the Tally server-limits spec (T3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, listTools, readState, versionOf, writeState, type MockOpts, type MockState } from "./client.ts";

const TZ = "America/Los_Angeles";
const NOW = "2026-10-12T14:00:00Z"; // Monday 2026-10-12, 07:00 in Los Angeles
const MON = "2026-10-12";
const TUE = "2026-10-13";
const WED = "2026-10-14";
const NEXT_MON = "2026-10-19";

const ex = (name: string, sets: number, extra: Record<string, unknown> = {}) => ({
  exerciseId: name.replace(/[^A-Za-z0-9]+/g, "_"),
  name,
  suggestedSets: sets,
  ...extra,
});

function mock(state: Partial<MockState> = {}, flags: { t2?: boolean; t3?: boolean } = {}): MockOpts {
  const dir = mkdtempSync(join(tmpdir(), "mock-tally-"));
  const path = join(dir, "state.json");
  writeState(path, { timezone: TZ, now: NOW, weightUnit: "lbs", weightUnitSource: "settings", days: {}, ...state });
  return { state: path, ...flags };
}

const day = (date: string, exercises: unknown[], extra: Record<string, unknown> = {}) => ({ date, dayType: "strength", dayName: "Lower A", exercises, timezone: TZ, ...extra });
const row = (o: Record<string, unknown> = {}) => ({ id: `row-${Math.random().toString(16).slice(2, 10)}`, day_type: "strength", day_name: "Lower A", exercises: [ex("Goblet Squat", 3)], ...o });
const get = (m: MockOpts, date: string) => call(m, "get_planned_workout", { date, timezone: TZ }).json;

// ---------------------------------------------------------------- tool list

test("tools/list: the pinned 11 tools; T2 off drops the T2 inputs; T3 adds update_training_limits", () => {
  const pinned = JSON.parse(readFileSync(new URL("./tools-list.json", import.meta.url), "utf8"));
  assert.equal(pinned.length, 11);
  assert.deepEqual(listTools(mock({}, { t2: true })), pinned);
  const off = listTools(mock());
  assert.deepEqual(off.map((t: any) => t.name), pinned.map((t: any) => t.name));
  const props = (n: string) => Object.keys(off.find((t: any) => t.name === n).inputSchema.properties);
  assert.ok(!props("plan_workout_day").includes("opId") && !props("plan_workout_day").includes("ifAbsent"));
  assert.ok(!props("skip_planned_workout").includes("expectedVersion"));
  assert.ok(props("update_planned_workout").includes("expectedVersion"), "expectedVersion on update predates T2");
  const t3 = listTools(mock({}, { t3: true }));
  assert.equal(t3.length, 12);
  assert.equal(t3[11].name, "update_training_limits");
});

// ---------------------------------------------------------------- reads

test("get_planned_workout: not found, then found with Tally's fields and encodeVersion", () => {
  const m = mock({ days: { [TUE]: row({ id: "r1", updated_at: "2026-10-10T10:00:00.000Z", notes: "n", exercises: [ex("Goblet Squat", 3), { suggestedSets: 2 }] }) } });
  assert.deepEqual(get(m, WED), { date: WED, found: false, exercises: [], weightUnit: "lbs", weightUnitSource: "settings" });
  const d = get(m, TUE);
  assert.equal(d.version, versionOf({ id: "r1", updated_at: "2026-10-10T10:00:00.000Z" }));
  assert.equal(d.version, Buffer.from("r1|2026-10-10T10:00:00.000Z").toString("base64url"));
  assert.deepEqual(
    { ...d, version: undefined },
    { date: TUE, found: true, dayType: "strength", dayName: "Lower A", notes: "n", source: "mcp", userModified: false, skipped: false, updatedAt: "2026-10-10T10:00:00.000Z", version: undefined, exercises: [ex("Goblet Squat", 3)], weightUnit: "lbs", weightUnitSource: "settings" },
    "an unnamed stored entry is hidden from the read",
  );
});

test("get_training_context: future days, protection flags, history window", () => {
  const m = mock({
    days: { "2026-10-10": row(), [TUE]: row({ source: "builder" }), [WED]: row({ user_modified: true, status: "skipped" }) },
    sessions: [{ date: "2026-10-10", name: "Lower A", dayType: "strength", weightUnit: "lbs", exercises: [{ name: "Goblet Squat", muscle: "quads", trackingType: "weight_reps", sets: [{ weight: 50, reps: 10 }] }] }],
  });
  const c = call(m, "get_training_context", { timezone: TZ, historyWeeks: 2 }).json;
  assert.equal(c.today, MON);
  assert.deepEqual(c.futurePlanned, [
    { date: TUE, dayName: "Lower A", source: "builder", userModified: false, exerciseCount: 1, skipped: false },
    { date: WED, dayName: "Lower A", source: "mcp", userModified: true, exerciseCount: 1, skipped: true },
  ]);
  assert.equal(c.recentHistory.length, 1);
  assert.deepEqual(c.pastPlanned, [], "a planned day with a completed session is not past-planned");
  assert.equal(c.trainingLimits, undefined, "T3 off: no trainingLimits");
});

test("get_workout_history: newest first, since/until, cursor pagination", () => {
  const sessions = ["2026-10-01", "2026-10-05", "2026-10-08", "2026-10-10"].map((date) => ({ date, name: "S", exercises: [] }));
  const m = mock({ sessions });
  const p1 = call(m, "get_workout_history", { timezone: TZ, limit: 2 }).json;
  assert.deepEqual(p1.sessions.map((s: any) => s.date), ["2026-10-10", "2026-10-08"]);
  assert.equal(typeof p1.nextCursor, "string");
  const p2 = call(m, "get_workout_history", { timezone: TZ, limit: 2, cursor: p1.nextCursor }).json;
  assert.deepEqual(p2.sessions.map((s: any) => s.date), ["2026-10-05", "2026-10-01"]);
  assert.equal(p2.nextCursor, undefined);
  const w = call(m, "get_workout_history", { timezone: TZ, since: "2026-10-04", until: "2026-10-08" }).json;
  assert.deepEqual(w.sessions.map((s: any) => s.date), ["2026-10-08", "2026-10-05"]);
});

test("get_exercise_progress and search_exercises", () => {
  const m = mock({
    days: { [TUE]: row({ exercises: [{ exerciseId: "my_custom_row", name: "My Custom Row", suggestedSets: 3 }] }) },
    sessions: [{ date: "2026-10-10", name: "S", weightUnit: "lbs", exercises: [{ name: "Goblet Squat", muscle: "quads", sets: [{ weight: 50, reps: 10 }, { weight: 55, reps: 8 }] }] }],
  });
  const p = call(m, "get_exercise_progress", { timezone: TZ, exercises: ["goblet-squat", "Nope"] }).json;
  assert.equal(p.exercises[0].found, true);
  assert.equal(p.exercises[0].sessions[0].topSet.weight, 55);
  assert.equal(p.exercises[1].found, false);
  const s = call(m, "search_exercises", { queries: ["custom row", "goblet squat", "zzzz"] }).json;
  assert.equal(s.queries[0].results[0].source, "recent");
  assert.equal(s.queries[1].results[0].exerciseId, "Goblet_Squat");
  assert.equal(s.queries[2].results.length, 0);
  assert.ok(s.queries[2].hint);
});

// ---------------------------------------------------------------- input validation

test("validation: schema errors are isError results; unknown keys are stripped", () => {
  const m = mock();
  const bad = call(m, "plan_workout_day", day(TUE, [{ exerciseId: "x", name: "X" }]));
  assert.equal(bad.isError, true);
  assert.match(bad.text, /suggestedSets: required/);
  assert.equal(call(m, "plan_workout_day", day("2026-02-30", [ex("X", 1)])).isError, true);
  assert.equal(call(m, "plan_workout_day", { ...day(TUE, [ex("X", 1)]), timezone: "Mars/Base" }).isError, true);
  const ok = call(m, "plan_workout_day", { ...day(TUE, [ex("X", 1, { junk: 1 })]), alsoJunk: true });
  assert.equal(ok.json.results[0].status, "written");
  assert.deepEqual(readState(m.state).days[TUE].exercises, [ex("X", 1)]);
  assert.equal(readState(m.state).calls.length, 4, "every call is recorded");
});

// ---------------------------------------------------------------- plan_workout_day

test("plan_workout_day: new date written; stored row has source mcp, planned, totals", () => {
  const m = mock();
  const r = call(m, "plan_workout_day", day(TUE, [ex("Goblet Squat", 3), ex("Romanian Deadlift", 4)], { notes: "easy" })).json;
  assert.deepEqual(r.results, [{ date: TUE, status: "written" }]);
  assert.deepEqual(r.skippedDates, []);
  const s = readState(m.state).days[TUE];
  assert.equal(s.source, "mcp");
  assert.equal(s.status, "planned");
  assert.equal(s.total_sets, 7);
  assert.equal(s.estimated_duration, 21);
  assert.equal(s.updated_at, null, "an inserted row has updated_at NULL");
});

test("plan_workout_day: exists guard (G5): blind write skipped; replace or a prior read passes", () => {
  const m = mock({ days: { [TUE]: row({ id: "r1", updated_at: null }) } });
  const blind = call(m, "plan_workout_day", day(TUE, [ex("Leg Press", 3)])).json;
  assert.equal(blind.skippedDates[0].code, "exists");
  const viaRead = call(m, "plan_workout_day", day(TUE, [ex("Leg Press", 3)], { expectedUpdatedAt: null })).json;
  assert.deepEqual(viaRead.results, [{ date: TUE, status: "written", replacedExisting: true }]);
  assert.ok(viaRead.warnings.some((w: string) => /replace: true/.test(w)), "replaceImplied warning");
  const replaced = call(m, "plan_workout_day", day(TUE, [ex("Hip Thrust", 3)], { replace: true })).json;
  assert.equal(replaced.results[0].status, "written");
  assert.equal(replaced.warnings.length, 0);
  assert.equal(readState(m.state).days[TUE].exercises[0].name, "Hip Thrust");
});

test("plan_workout_day: protected days skip unless overrideUserModified", () => {
  const m = mock({ days: { [TUE]: row({ source: "builder" }), [WED]: row({ user_modified: true }) } });
  for (const d of [TUE, WED]) {
    const r = call(m, "plan_workout_day", day(d, [ex("Leg Press", 3)], { replace: true })).json;
    assert.equal(r.skippedDates[0].code, "protected");
  }
  const o = call(m, "plan_workout_day", day(WED, [ex("Leg Press", 3)], { replace: true, overrideUserModified: true })).json;
  assert.equal(o.results[0].status, "written");
  assert.equal(readState(m.state).days[WED].user_modified, true, "the write keeps user_modified");
});

test("plan_workout_day: versions: a stale expectedVersion is a conflict; an update changes the version", () => {
  const m = mock({ days: { [TUE]: row({ id: "r1", updated_at: "2026-10-01T00:00:00.000Z" }) } });
  const v0 = get(m, TUE).version;
  const stale = call(m, "plan_workout_day", day(TUE, [ex("Leg Press", 3)], { expectedVersion: versionOf({ id: "r1", updated_at: null }) })).json;
  assert.equal(stale.skippedDates[0].code, "version_conflict");
  const ok = call(m, "plan_workout_day", day(TUE, [ex("Leg Press", 3)], { expectedVersion: v0 })).json;
  assert.equal(ok.results[0].status, "written");
  const v1 = get(m, TUE).version;
  assert.notEqual(v1, v0);
  assert.equal(call(m, "plan_workout_day", day(TUE, [ex("Hip Thrust", 3)], { expectedVersion: v0 })).json.skippedDates[0].code, "version_conflict");
  assert.equal(call(m, "plan_workout_day", day(TUE, [ex("Hip Thrust", 3)], { expectedVersion: "!!" })).isError, true);
});

test("plan_workout_day: past dates skip without allowPast; a skipped day is restored with clearedSkip", () => {
  const m = mock({ days: { [TUE]: row({ status: "skipped" }) } });
  assert.equal(call(m, "plan_workout_day", day("2026-10-11", [ex("X", 1)])).json.skippedDates[0].code, "past");
  assert.equal(call(m, "plan_workout_day", day("2026-10-11", [ex("X", 1)], { allowPast: true })).json.results[0].status, "written");
  const r = call(m, "plan_workout_day", day(TUE, [ex("X", 1)], { replace: true })).json;
  assert.deepEqual(r.results[0], { date: TUE, status: "written", clearedSkip: true, replacedExisting: true });
  assert.equal(readState(m.state).days[TUE].status, "planned");
});

test("plan_workout_day: weightUnit converts only against a known unit (G1)", () => {
  const m = mock({ weightUnit: "kg", weightUnitSource: "settings" });
  const r = call(m, "plan_workout_day", day(TUE, [ex("Bench Press", 3, { suggestedWeight: 225 })], { weightUnit: "lbs" })).json;
  assert.equal(readState(m.state).days[TUE].exercises[0].suggestedWeight, 102);
  assert.equal(r.warnings.length, 1);
  const u = mock({ weightUnitSource: "default" });
  const r2 = call(u, "plan_workout_day", day(TUE, [ex("Bench Press", 3, { suggestedWeight: 100 })], { weightUnit: "kg" })).json;
  assert.equal(readState(u.state).days[TUE].exercises[0].suggestedWeight, 100);
  assert.match(r2.warnings[0], /stored as given/);
});

// ---------------------------------------------------------------- plan_workout_range

test("plan_workout_range: per-day decisions; skipped days kept; no exists guard", () => {
  const m = mock({ days: { [TUE]: row({ status: "skipped" }), [WED]: row({ id: "w" }), "2026-10-15": row({ source: "builder" }) } });
  const days = [MON, TUE, WED, "2026-10-15"].map((d) => ({ date: d, dayType: "s", dayName: "D", exercises: [ex("Leg Press", 2)] }));
  const r = call(m, "plan_workout_range", { timezone: TZ, days }).json;
  assert.deepEqual(r.results, [{ date: MON, status: "written" }, { date: WED, status: "written", replacedExisting: true }]);
  assert.deepEqual(r.skippedDates.map((s: any) => [s.date, s.code]), [[TUE, "skipped_day"], ["2026-10-15", "protected"]]);
  assert.equal(call(m, "plan_workout_range", { timezone: TZ, days: [days[0], days[0]] }).isError, true, "duplicate dates");
});

// ---------------------------------------------------------------- update_planned_workout

test("update_planned_workout: operations; untouched and unnamed entries kept exactly; index needs version", () => {
  const stored = [ex("Goblet Squat", 3, { legacyField: "keep" }), { suggestedSets: 4, note: "hidden" }, ex("Leg Press", 3), ex("Calf Raise", 2)];
  const m = mock({ days: { [TUE]: row({ id: "u1", updated_at: "2026-10-01T00:00:00.000Z", exercises: stored, status: "skipped" }) } });
  const noVer = call(m, "update_planned_workout", { date: TUE, timezone: TZ, operations: [{ op: "remove", target: { index: 0 } }] });
  assert.equal(noVer.isError, true);
  assert.match(noVer.text, /expectedVersion/);
  const version = get(m, TUE).version;
  const r = call(m, "update_planned_workout", {
    date: TUE,
    timezone: TZ,
    expectedVersion: version,
    dayName: "Lower B",
    notes: "trimmed",
    operations: [
      { op: "modify", target: { index: 1 }, fields: { suggestedSets: 2, suggestedWeight: 200 } },
      { op: "replace", target: { exerciseId: "Calf_Raise" }, exercise: ex("Seated Calf Raise", 3) },
      { op: "add", afterIndex: -1, exercise: ex("Bike", 1) },
      { op: "add", exercise: ex("Plank", 2) },
    ],
  }).json;
  assert.equal(r.status, "updated");
  const s = readState(m.state).days[TUE];
  assert.deepEqual(s.exercises, [
    ex("Bike", 1),
    ex("Goblet Squat", 3, { legacyField: "keep" }),
    { suggestedSets: 4, note: "hidden" },
    ex("Leg Press", 2, { suggestedWeight: 200 }),
    ex("Seated Calf Raise", 3),
    ex("Plank", 2),
  ]);
  assert.equal(s.day_name, "Lower B");
  assert.equal(s.notes, "trimmed");
  assert.equal(s.status, "skipped", "an edit keeps the skip");
  assert.equal(r.day.exercises.length, 5, "the result's day hides the unnamed entry");
  const cleared = call(m, "update_planned_workout", { date: TUE, timezone: TZ, notes: null, operations: [{ op: "remove", target: { exerciseId: "Plank" } }] }).json;
  assert.equal(cleared.status, "updated");
  assert.equal(readState(m.state).days[TUE].notes, null);
});

test("update_planned_workout: not_found, protected, version conflict, ambiguous target, 1..30 bound", () => {
  const m = mock({ days: { [TUE]: row({ source: "builder" }), [WED]: row({ exercises: [ex("A", 1), ex("A", 1)] }) } });
  assert.equal(call(m, "update_planned_workout", { date: MON, timezone: TZ, operations: [{ op: "add", exercise: ex("X", 1) }] }).json.status, "not_found");
  assert.equal(call(m, "update_planned_workout", { date: TUE, timezone: TZ, operations: [{ op: "add", exercise: ex("X", 1) }] }).json.code, "protected");
  const amb = call(m, "update_planned_workout", { date: WED, timezone: TZ, operations: [{ op: "remove", target: { exerciseId: "A" } }] });
  assert.equal(amb.isError, true);
  const v = get(m, WED).version;
  const empty = call(m, "update_planned_workout", { date: WED, timezone: TZ, expectedVersion: v, operations: [{ op: "remove", target: { index: 0 } }, { op: "remove", target: { index: 1 } }] });
  assert.match(empty.text, /leaves 0 exercises/);
  const conflict = call(m, "update_planned_workout", { date: WED, timezone: TZ, expectedVersion: versionOf({ id: "nope" }), operations: [{ op: "add", exercise: ex("X", 1) }] }).json;
  assert.equal(conflict.code, "version_conflict");
});

// ---------------------------------------------------------------- move, skip, delete

test("move_planned_workout: content kept, status reset to planned, new version; occupied and past skip", () => {
  const m = mock({ days: { [TUE]: row({ status: "skipped", notes: "n", user_modified: false }), [WED]: row() } });
  assert.equal(call(m, "move_planned_workout", { fromDate: TUE, toDate: WED, timezone: TZ }).json.code, "destination_occupied");
  assert.equal(call(m, "move_planned_workout", { fromDate: TUE, toDate: "2026-10-01", timezone: TZ }).json.code, "past");
  assert.equal(call(m, "move_planned_workout", { fromDate: TUE, toDate: TUE, timezone: TZ }).isError, true);
  const before = readState(m.state).days[TUE];
  const r = call(m, "move_planned_workout", { fromDate: TUE, toDate: "2026-10-16", timezone: TZ }).json;
  assert.equal(r.status, "moved");
  const s = readState(m.state).days;
  assert.equal(s[TUE], undefined);
  assert.equal(s["2026-10-16"].status, "planned");
  assert.deepEqual(s["2026-10-16"].exercises, before.exercises);
  assert.equal(s["2026-10-16"].notes, "n");
  assert.equal(s["2026-10-16"].client_id, before.client_id);
  assert.notEqual(s["2026-10-16"].id, before.id);
  assert.equal(r.version, versionOf({ id: s["2026-10-16"].id, updated_at: null }));
  assert.equal(call(m, "move_planned_workout", { fromDate: MON, toDate: TUE, timezone: TZ }).json.status, "not_found");
});

test("skip_planned_workout: any day (protected too); unchanged keeps updated_at; restore with skip false", () => {
  const m = mock({ days: { [TUE]: row({ source: "builder", updated_at: "2026-10-01T00:00:00.000Z" }) } });
  const r = call(m, "skip_planned_workout", { date: TUE }).json;
  assert.equal(r.status, "updated");
  assert.equal(r.skipped, true);
  const again = call(m, "skip_planned_workout", { date: TUE }).json;
  assert.equal(again.status, "unchanged");
  assert.equal(again.updatedAt, r.updatedAt);
  assert.equal(call(m, "skip_planned_workout", { date: TUE, skip: false }).json.skipped, false);
  assert.equal(readState(m.state).days[TUE].status, "planned");
  assert.equal(call(m, "skip_planned_workout", { date: MON }).json.status, "not_found");
});

test("delete_planned_workout: deleted echo for undo; protected skip; not_found no-op", () => {
  const m = mock({ days: { [TUE]: row({ status: "skipped", notes: "x", exercises: [{ name: "Old Thing", suggestedSets: 2 }] }), [WED]: row({ user_modified: true }) } });
  const r = call(m, "delete_planned_workout", { date: TUE }).json;
  assert.equal(r.status, "deleted");
  assert.deepEqual(r.deleted, { date: TUE, dayType: "strength", dayName: "Lower A", exercises: [{ exerciseId: "old_thing", name: "Old Thing", suggestedSets: 2 }], skipped: true, notes: "x" });
  assert.equal(readState(m.state).days[TUE], undefined);
  assert.equal(call(m, "delete_planned_workout", { date: WED }).json.code, "protected");
  assert.equal(call(m, "delete_planned_workout", { date: WED, overrideUserModified: true }).json.status, "deleted");
  assert.deepEqual(call(m, "delete_planned_workout", { date: MON }).json, { date: MON, status: "not_found" });
});

// ---------------------------------------------------------------- T2

test("T2 off: opId, ifAbsent and skip/delete expectedVersion are ignored (stripped)", () => {
  const m = mock({ days: { [TUE]: row() } });
  call(m, "skip_planned_workout", { date: TUE, expectedVersion: versionOf({ id: "stale" }), opId: "op-12345678" });
  assert.equal(readState(m.state).days[TUE].status, "skipped", "the stale version did not stop it");
  assert.equal(readState(m.state).operations.length, 0, "no receipt");
  assert.equal(get(m, TUE).operations, undefined);
});

test("T2: ifAbsent writes only to an empty date and conflicts with replace", () => {
  const m = mock({ days: { [TUE]: row({ status: "skipped", source: "builder" }) } }, { t2: true });
  assert.equal(call(m, "plan_workout_day", day(TUE, [ex("X", 1)], { ifAbsent: true })).json.skippedDates[0].code, "exists");
  assert.equal(call(m, "plan_workout_day", day(WED, [ex("X", 1)], { ifAbsent: true })).json.results[0].status, "written");
  assert.equal(call(m, "plan_workout_day", day(WED, [ex("X", 1)], { ifAbsent: true, replace: true })).isError, true);
  const r = call(m, "plan_workout_range", { timezone: TZ, days: [{ date: TUE, dayType: "s", dayName: "D", exercises: [ex("X", 1)], ifAbsent: true }, { date: "2026-10-16", dayType: "s", dayName: "D", exercises: [ex("X", 1)], ifAbsent: true }] }).json;
  assert.deepEqual(r.skippedDates.map((s: any) => s.code), ["exists"]);
  assert.equal(r.results[0].date, "2026-10-16");
});

test("T2: expectedVersion on skip and delete is checked first", () => {
  const m = mock({ days: { [TUE]: row({ id: "a" }), [WED]: row({ id: "b" }) } }, { t2: true });
  assert.equal(call(m, "skip_planned_workout", { date: TUE, expectedVersion: versionOf({ id: "zz" }) }).json.status, "conflict");
  assert.equal(call(m, "skip_planned_workout", { date: MON, expectedVersion: versionOf({ id: "zz" }) }).json.status, "conflict");
  assert.equal(call(m, "skip_planned_workout", { date: TUE, expectedVersion: get(m, TUE).version }).json.status, "updated");
  assert.equal(call(m, "delete_planned_workout", { date: WED, expectedVersion: versionOf({ id: "zz" }) }).json.code, "version_conflict");
  assert.equal(call(m, "delete_planned_workout", { date: WED, expectedVersion: get(m, WED).version }).json.status, "deleted");
});

test("T2: opId replays the recorded outcome; a different input under the same opId is an error; operations listed", () => {
  const m = mock({}, { t2: true });
  const args = { ...day(TUE, [ex("Leg Press", 3)]), opId: "op-2026-10-13-block_session-aaaaaaaaaaaa" };
  const first = call(m, "plan_workout_day", args).json;
  assert.equal(first.results[0].status, "written");
  const id1 = readState(m.state).days[TUE].id;
  const again = call(m, "plan_workout_day", args).json;
  assert.equal(again.replayed, true);
  assert.deepEqual(again.results, [{ date: TUE, status: "written", id: id1, updatedAt: null, version: versionOf({ id: id1, updated_at: null }) }]);
  assert.equal(readState(m.state).days[TUE].id, id1, "nothing written again");
  const reused = call(m, "plan_workout_day", { ...args, dayName: "Other" });
  assert.equal(reused.isError, true);
  assert.match(reused.text, /opId was already used/);
  const read = call(m, "get_planned_workout", { date: TUE, timezone: TZ, opId: args.opId }).json;
  assert.equal(read.operations.length, 1);
  assert.equal(read.operations[0].tool, "plan_workout_day");
  assert.equal(read.operation.opId, args.opId);
  assert.deepEqual(get(m, WED).operations, []);
});

test("T2: a move with opId lists the receipt on both dates", () => {
  const m = mock({ days: { [TUE]: row() } }, { t2: true });
  const r = call(m, "move_planned_workout", { fromDate: TUE, toDate: WED, timezone: TZ, opId: "op-move-12345678" }).json;
  assert.equal(r.status, "moved");
  assert.equal(get(m, TUE).operations.length, 1);
  assert.equal(get(m, WED).operations[0].result[0].toDate, WED);
  assert.equal(call(m, "move_planned_workout", { fromDate: TUE, toDate: WED, timezone: TZ, opId: "op-move-12345678" }).json.replayed, true);
});

// ---------------------------------------------------------------- T3

const knee = { id: "L-001", label: "Left knee", region: "knee", kind: "ban", exerciseIds: ["barbell_squat"], keywords: ["squat", "lunge"], exceptKeywords: ["split squat"], allow: [{ exerciseId: "box_squat", name: "Box Squat" }] };
const limits = (rules: unknown[], maxWeeklySets?: number) => ({ version: 1, doc: { rules, ...(maxWeeklySets ? { maxWeeklySets } : {}) } });

test("T3 off: limits in the state are not enforced and not shown", () => {
  const m = mock({ trainingLimits: limits([knee]) });
  assert.equal(call(m, "plan_workout_day", day(TUE, [ex("Back Squat", 3)])).json.results[0].status, "written");
  assert.equal(call(m, "get_training_context", { timezone: TZ }).json.trainingLimits, undefined);
});

test("T3: get_training_context shows trainingLimits (null without a row)", () => {
  assert.equal(call(mock({}, { t3: true }), "get_training_context", { timezone: TZ }).json.trainingLimits, null);
  const c = call(mock({ trainingLimits: limits([knee], 100) }, { t3: true }), "get_training_context", { timezone: TZ }).json;
  assert.deepEqual(c.trainingLimits, { version: 1, rules: [knee], maxWeeklySets: 100 });
});

test("T3 §4.1 matching: ids, word-start keywords, masking, allow, NFKC", () => {
  const m = mock({ trainingLimits: limits([knee, { id: "L-002", label: "Back", kind: "ban", keywords: ["row"] }]) }, { t3: true });
  const verdict = (e: unknown, date: string) => {
    const r = call(m, "plan_workout_day", day(date, [e])).json.results[0];
    return r.status;
  };
  const cases: [unknown, string][] = [
    [{ exerciseId: "front_squat", name: "Front Squat", suggestedSets: 2 }, "refused"],
    [{ exerciseId: "bss", name: "Bulgarian Split Squat", suggestedSets: 2 }, "written"],
    [{ exerciseId: "split_squat", name: "Back Squat", suggestedSets: 2 }, "refused"],
    [{ exerciseId: "x1", name: "Back Squat Split Squat", suggestedSets: 2 }, "refused"],
    [{ exerciseId: "box_squat", name: "Box Squat", suggestedSets: 2 }, "written"],
    [{ exerciseId: "box_squat", name: "Box Squat Heavy", suggestedSets: 2 }, "refused"],
    [{ exerciseId: "Barbell-Squat", name: "Anything", suggestedSets: 2 }, "refused"],
    [{ exerciseId: "mbt", name: "Medicine Ball Throw", suggestedSets: 2 }, "written"],
    [{ exerciseId: "sr", name: "Seated Rows", suggestedSets: 2 }, "refused"],
    [{ exerciseId: "fw", name: "Ｂａｃｋ Squat", suggestedSets: 2 }, "refused"],
    [{ exerciseId: "rev", name: "Reverse-Lunge", suggestedSets: 2 }, "refused"],
  ];
  const dates = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"];
  cases.forEach(([e, want], i) => assert.equal(verdict(e, dates[i]), want, JSON.stringify(e)));
});

test("T3 §4.3 ban: the refused-day shape; nothing written; a trim of a banned day passes, a raise is refused", () => {
  const m = mock({ trainingLimits: limits([knee]), days: { [WED]: row({ exercises: [ex("Back Squat", 4), ex("Bench Press", 3)] }) } }, { t3: true });
  const r = call(m, "plan_workout_day", day(TUE, [ex("Back Squat", 3), ex("Bench Press", 3)])).json;
  assert.deepEqual(r.results, [{
    date: TUE,
    status: "refused",
    code: "training_limit",
    limit: { ruleId: "L-001", label: "Left knee", kind: "ban" },
    week: { start: MON, after: 7, limit: 0 },
    exercises: ["Back Squat"],
    reason: r.results[0].reason,
  }]);
  assert.match(r.results[0].reason, /Do not retry it with a renamed or relabeled exercise/);
  assert.equal(readState(m.state).days[TUE], undefined);
  const v = get(m, WED).version;
  const trim = call(m, "update_planned_workout", { date: WED, timezone: TZ, expectedVersion: v, operations: [{ op: "modify", target: { index: 0 }, fields: { suggestedSets: 2 } }] }).json;
  assert.equal(trim.status, "updated");
  const raise = call(m, "update_planned_workout", { date: WED, timezone: TZ, operations: [{ op: "modify", target: { exerciseId: "Back_Squat" }, fields: { suggestedSets: 5 } }] }).json;
  assert.equal(raise.status, "refused");
  assert.equal(readState(m.state).days[WED].exercises[0].suggestedSets, 2);
});

test("T3 §4.1: a hidden (nameless) stored entry counts", () => {
  const m = mock({ trainingLimits: limits([{ id: "C", label: "Squat cap", kind: "cap", exerciseIds: ["barbell_squat"], maxSetsPerWeek: 4 }]), days: { [TUE]: row({ exercises: [{ exerciseId: "barbell_squat", suggestedSets: 4 }, ex("Bench Press", 3)] }) } }, { t3: true });
  assert.equal(call(m, "plan_workout_day", day(WED, [ex("Barbell Squat", 1)])).json.results[0].status, "refused");
});

test("T3 cap (TL002): 4 -> 7 against 6 refused; an over-cap week can be trimmed", () => {
  const cap = { id: "L-002", label: "Hinge cap", kind: "cap", keywords: ["deadlift"], maxSetsPerWeek: 6 };
  const m = mock({ trainingLimits: limits([cap]), days: { [MON]: row({ exercises: [ex("Romanian Deadlift", 4)] }) } }, { t3: true });
  const r = call(m, "plan_workout_day", day(TUE, [ex("Deadlift", 3)])).json.results[0];
  assert.equal(r.status, "refused");
  assert.deepEqual(r.limit, { ruleId: "L-002", label: "Hinge cap", kind: "cap" });
  assert.deepEqual(r.week, { start: MON, after: 7, limit: 6 });
  assert.equal(call(m, "plan_workout_day", day(TUE, [ex("Deadlift", 2)])).json.results[0].status, "written");
  const over = mock({ trainingLimits: limits([cap]), days: { [MON]: row({ exercises: [ex("Romanian Deadlift", 8)] }) } }, { t3: true });
  const v = get(over, MON).version;
  assert.equal(call(over, "update_planned_workout", { date: MON, timezone: TZ, expectedVersion: v, operations: [{ op: "modify", target: { index: 0 }, fields: { suggestedSets: 7 } }] }).json.status, "updated");
});

test("T3 weekly cap (TL003); skip passes; an unskip into a full week is refused", () => {
  const m = mock({ trainingLimits: limits([], 10), days: { [MON]: row({ exercises: [ex("Bench Press", 6)] }), [TUE]: row({ exercises: [ex("Row", 4)], status: "skipped" }) } }, { t3: true });
  const r = call(m, "plan_workout_day", day(WED, [ex("Curl", 5)])).json.results[0];
  assert.deepEqual([r.status, r.limit, r.week], ["refused", { weeklyCap: true }, { start: MON, after: 11, limit: 10 }]);
  assert.equal(call(m, "plan_workout_day", day(WED, [ex("Curl", 4)])).json.results[0].status, "written");
  const un = call(m, "skip_planned_workout", { date: TUE, skip: false }).json;
  assert.equal(un.status, "refused");
  assert.equal(readState(m.state).days[TUE].status, "skipped");
  assert.equal(call(m, "skip_planned_workout", { date: MON }).json.status, "updated", "a skip is never refused");
  assert.equal(call(m, "delete_planned_workout", { date: WED }).json.status, "deleted");
});

test("T3 moves: same-week move of an over-cap day passes; a cross-week move into a full week is refused; ban content keeps its prior", () => {
  const m = mock({
    trainingLimits: limits([knee], 10),
    days: { [MON]: row({ exercises: [ex("Back Squat", 4), ex("Bench Press", 8)] }), [NEXT_MON]: row({ exercises: [ex("Bench Press", 8)] }) },
  }, { t3: true });
  assert.equal(call(m, "move_planned_workout", { fromDate: MON, toDate: WED, timezone: TZ }).json.status, "moved", "same week, banned content, over the weekly cap");
  const cross = call(m, "move_planned_workout", { fromDate: WED, toDate: "2026-10-20", timezone: TZ }).json;
  assert.equal(cross.status, "refused");
  assert.deepEqual([cross.fromDate, cross.toDate, cross.date, cross.limit], [WED, "2026-10-20", "2026-10-20", { weeklyCap: true }]);
  assert.ok(readState(m.state).days[WED], "nothing moved");
});

test("T3 range: without opId each day is its own transaction; with opId one refusal writes nothing", () => {
  const days = [MON, TUE, WED].map((d) => ({ date: d, dayType: "s", dayName: "D", exercises: [d === TUE ? ex("Back Squat", 3) : ex("Bench Press", 3)] }));
  const m = mock({ trainingLimits: limits([knee]) }, { t2: true, t3: true });
  const r = call(m, "plan_workout_range", { timezone: TZ, days }).json;
  assert.deepEqual(r.results.map((x: any) => [x.date, x.status]), [[MON, "written"], [TUE, "refused"], [WED, "written"]]);
  const n = mock({ trainingLimits: limits([knee]) }, { t2: true, t3: true });
  const all = call(n, "plan_workout_range", { timezone: TZ, days, opId: "op-range-12345678" }).json;
  assert.equal(all.status, "refused");
  assert.equal(all.violatingDate, TUE);
  assert.deepEqual(all.notWritten, [MON, TUE, WED]);
  assert.deepEqual(readState(n.state).days, {});
  assert.equal(readState(n.state).operations.length, 0, "no receipt");
});

test("T3 update_training_limits: add_rule, lower_cap, set_weekly_cap; stricter only; all or none; versions", () => {
  const m = mock({}, { t3: true });
  const created = call(m, "update_training_limits", { expectedVersion: null, ops: [{ op: "add_rule", rule: { id: "L-001", label: "Knee", kind: "ban", keywords: ["Back-Squat"] } }] }).json;
  assert.equal(created.status, "updated");
  assert.equal(created.version, 1);
  assert.deepEqual(created.limits.rules[0].keywords, ["back squat"], "keywords are stored in norm() form");
  assert.deepEqual(call(m, "update_training_limits", { expectedVersion: null, ops: [{ op: "set_weekly_cap", maxWeeklySets: 50 }] }).json, { status: "conflict", version: 1 });
  const two = call(m, "update_training_limits", { expectedVersion: 1, ops: [
    { op: "add_rule", rule: { id: "L-002", label: "Hinge", kind: "cap", keywords: ["deadlift"], maxSetsPerWeek: 6 } },
    { op: "set_weekly_cap", maxWeeklySets: 80 },
  ] }).json;
  assert.equal(two.version, 2);
  assert.equal(two.limits.maxWeeklySets, 80);
  assert.match(call(m, "update_training_limits", { expectedVersion: 2, ops: [{ op: "lower_cap", ruleId: "L-002", maxSetsPerWeek: 8 }] }).json.reason, /must lower the cap/);
  assert.match(call(m, "update_training_limits", { expectedVersion: 2, ops: [{ op: "lower_cap", ruleId: "L-001", maxSetsPerWeek: 1 }] }).json.reason, /not a cap rule/);
  assert.match(call(m, "update_training_limits", { expectedVersion: 2, ops: [{ op: "set_weekly_cap", maxWeeklySets: 90 }] }).json.reason, /must lower the weekly cap/);
  const bad = call(m, "update_training_limits", { expectedVersion: 2, ops: [{ op: "lower_cap", ruleId: "L-002", maxSetsPerWeek: 4 }, { op: "lower_cap", ruleId: "nope", maxSetsPerWeek: 1 }] }).json;
  assert.equal(bad.status, "invalid");
  assert.equal(readState(m.state).trainingLimits!.doc.rules[1].maxSetsPerWeek, 6, "one bad op applies nothing");
  assert.equal(call(m, "update_training_limits", { expectedVersion: 2, ops: [{ op: "lower_cap", ruleId: "L-002", maxSetsPerWeek: 4 }] }).json.version, 3);
  assert.equal(call(m, "update_training_limits", { expectedVersion: 3, ops: [{ op: "add_rule", rule: { id: "L-001", label: "Dup", kind: "ban", keywords: ["x y"] } }] }).json.status, "invalid");
  assert.equal(call(m, "update_training_limits", { expectedVersion: 3, ops: [{ op: "add_rule", rule: { id: "L-9", label: "No match", kind: "ban" } }] }).isError, true);
  assert.equal(call(m, "update_training_limits", { expectedVersion: 3, ops: [{ op: "remove_rule", ruleId: "L-001" }] }).isError, true, "no op loosens");
});

test("T3 §10.12 monotonic: a squat cap of 6 plus a new bench rule; swapping bench sets for squat sets is still refused", () => {
  const m = mock({ trainingLimits: limits([{ id: "SQ", label: "Squat cap", kind: "cap", keywords: ["squat"], maxSetsPerWeek: 6 }]), days: { [MON]: row({ exercises: [ex("Back Squat", 6), ex("Bench Press", 4)] }) } }, { t3: true });
  assert.equal(call(m, "update_training_limits", { expectedVersion: 1, ops: [{ op: "add_rule", rule: { id: "BP", label: "Bench cap", kind: "cap", keywords: ["bench"], maxSetsPerWeek: 4 } }] }).json.status, "updated");
  const v = get(m, MON).version;
  const r = call(m, "update_planned_workout", { date: MON, timezone: TZ, expectedVersion: v, operations: [{ op: "replace", target: { index: 1 }, exercise: ex("Front Squat", 4) }] }).json;
  assert.equal(r.status, "refused");
  assert.equal(r.limit.ruleId, "SQ");
});
