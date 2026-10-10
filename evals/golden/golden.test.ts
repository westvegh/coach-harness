// Golden parity. Each evals/golden/*.json holds a
// stored day (or none), one mutation call and the day Tally stores afterwards, derived
// by hand from Tally's implementation and unit tests (the `source` lines, workout-app
// t2-build 0c9d680). For each golden this test:
//   1. seeds the mock with the stored days and reads them the way the harness does
//      (get_training_context, then get_planned_workout per date, merged by
//      engine/snapshot.ts mergeResponse, as capture-reads does);
//   2. runs the harness rebuild (adapters/loggers/tally/rebuild.ts) on the call;
//   3. runs the same call on the mock;
// and asserts that both results equal the golden. "$version" in the call is replaced
// by the version the read returned for the call's date.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeResponse } from "../../engine/snapshot.ts";
import { CoachError } from "../../engine/errors.ts";
import { affectedDates, rebuild, type TallyMutation } from "../../adapters/loggers/tally/rebuild.ts";
import type { Snapshot, SnapshotDay } from "../../engine/types.ts";
import { call, readState, writeState, type MockOpts } from "../mock-tally/client.ts";

const DIR = new URL(".", import.meta.url).pathname;
const NOW = "2026-10-12T14:00:00Z";
const TZ = "America/Los_Angeles";
const SESSION = "golden-session";

type Day = { dayType?: string; dayName?: string; notes?: string; source: string; userModified: boolean; skipped: boolean; exercises: unknown[] };
type Golden = {
  name: string;
  description: string;
  source: string[];
  unit: { weightUnit: "lbs" | "kg"; weightUnitSource: string };
  before: Record<string, Record<string, unknown>>;
  call: { tool: TallyMutation; args: Record<string, unknown> };
  expect: { days: Record<string, Day | null>; rebuildError?: string };
};

const goldens: Golden[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")));

function fromSnapshotDay(d: SnapshotDay | null): Day | null {
  if (!d) return null;
  return {
    ...(d.dayType !== undefined ? { dayType: d.dayType } : {}),
    ...(d.dayName !== undefined ? { dayName: d.dayName } : {}),
    ...(d.notes !== undefined && d.notes !== null ? { notes: d.notes } : {}),
    source: d.source,
    userModified: d.userModified,
    skipped: d.skipped,
    exercises: d.exercises,
  };
}

function fromRow(r: any): Day | null {
  if (!r) return null;
  return {
    dayType: r.day_type,
    dayName: r.day_name,
    ...(r.notes != null ? { notes: r.notes } : {}),
    source: r.source,
    userModified: r.user_modified,
    skipped: r.status === "skipped",
    exercises: r.exercises,
  };
}

function seed(g: Golden): MockOpts {
  const path = join(mkdtempSync(join(tmpdir(), "golden-")), "state.json");
  writeState(path, { timezone: TZ, now: NOW, ...g.unit, weightUnitSource: g.unit.weightUnitSource as any, days: structuredClone(g.before) as any });
  return { state: path };
}

/** The snapshot capture-reads would build from the harness's reads of the affected dates. */
function snapshotFor(m: MockOpts, g: Golden): Snapshot {
  let snap: Snapshot | null = null;
  const merge = (tool: string, input: Record<string, unknown>) => {
    const r = call(m, tool, input);
    snap = mergeResponse(snap, { tool, input, response: [{ type: "text", text: r.text }], session_id: SESSION, now: NOW, timezone: TZ });
  };
  merge("get_training_context", { timezone: TZ });
  for (const date of affectedDates(g.call.tool, g.call.args)) merge("get_planned_workout", { date, timezone: TZ });
  return snap!;
}

function resolveArgs(args: Record<string, unknown>, snap: Snapshot): Record<string, unknown> {
  const date = (args.date ?? args.fromDate) as string;
  return JSON.parse(JSON.stringify(args), (_k, v) => (v === "$version" ? snap.days[date]?.version : v));
}

test(`at least 25 goldens, each citing its Tally source`, () => {
  assert.ok(goldens.length >= 25, `${goldens.length} goldens`);
  for (const g of goldens) {
    assert.ok(g.source.length > 0 && g.source.every((s) => /:\d+$/.test(s)), `${g.name}: source lines`);
  }
  const tools = new Set(goldens.map((g) => g.call.tool));
  for (const t of ["plan_workout_day", "plan_workout_range", "update_planned_workout", "move_planned_workout", "skip_planned_workout", "delete_planned_workout"]) {
    assert.ok(tools.has(t as TallyMutation), `a golden for ${t}`);
  }
});

for (const g of goldens) {
  test(`golden ${g.name}: rebuild and mock both store the golden day`, () => {
    const m = seed(g);
    const snap = snapshotFor(m, g);
    const args = resolveArgs(g.call.args, snap);

    // The harness rebuild.
    if (g.expect.rebuildError) {
      assert.throws(() => rebuild(g.call.tool, args, snap), (e: unknown) => e instanceof CoachError && e.code === g.expect.rebuildError, "the rebuild refuses");
    } else {
      const changes = rebuild(g.call.tool, args, snap);
      const after = Object.fromEntries(changes.map((c) => [c.date, fromSnapshotDay(c.after)]));
      for (const [date, want] of Object.entries(g.expect.days)) {
        assert.deepEqual(after[date] ?? null, want, `rebuild ${date}`);
      }
    }

    // Tally (the mock), same call.
    const r = call(m, g.call.tool, args);
    const days = readState(m.state).days;
    for (const [date, want] of Object.entries(g.expect.days)) {
      assert.deepEqual(fromRow(days[date]), want, `mock ${date} (result: ${r.text.slice(0, 200)})`);
    }
  });
}
