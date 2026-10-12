// weeks (history grouped into Monday weeks) and ids next.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextWeekTargets, referenceWeek } from "../../engine/progression.ts";
import { historyWeeks } from "../../engine/weeks.ts";
import { block, rules, session, snapshot, tax } from "../guard/fixtures.ts";
import { cli, instance, writeJson } from "./helpers.ts";

const NOW = "2026-10-14T07:00:00-07:00";

test("historyWeeks: Monday-to-Sunday weeks, empty weeks kept, two sessions on a date merge", () => {
  const h = [
    session("2026-09-28", [{ name: "Squat", sets: 3 }]),
    session("2026-10-04", [{ name: "Bench Press", sets: 2 }]), // Sunday: still the week of 09-28
    session("2026-10-04", [{ name: "Cable Row", sets: 2 }]),
    session("2026-10-13", [{ name: "Squat", sets: 4 }]),
    session("2026-10-20", [{ name: "Squat", sets: 4 }]), // after --to
  ];
  const logs = historyWeeks(h, "2026-09-28", "2026-10-18");
  assert.deepEqual(logs.map((w) => w.week_start), ["2026-09-28", "2026-10-05", "2026-10-12"]);
  assert.deepEqual(logs[0].days.map((d) => [d.date, d.exercises.map((e) => e.name)]), [["2026-09-28", ["Squat"]], ["2026-10-04", ["Bench Press", "Cable Row"]]]);
  assert.deepEqual(logs[1].days, [], "a missed week is an empty week, not a missing one");
  assert.equal(logs[2].days[0].exercises[0].sets.length, 4);
});

test("weeks output feeds targets: the reference is the last completed build week", () => {
  const b = block({ weeks: block().weeks.map((w) => ({ ...w, sessions: 2 })) });
  const h = [
    session("2026-09-28", [{ name: "Back Squat", sets: 3 }]),
    session("2026-10-01", [{ name: "Back Squat", sets: 3 }]),
    session("2026-10-06", [{ name: "Back Squat", sets: 3 }]), // 1 of 2 sessions: still completed (50%)
  ];
  const logs = historyWeeks(h, "2026-09-28", "2026-10-11");
  const ref = referenceWeek(b, logs, "2026-10-14");
  assert.equal(ref?.week_start, "2026-10-05");
  const t = nextWeekTargets(b, ref, rules(), { tax: tax(), week: 7 });
  assert.equal(t.reference.source, "log");
  assert.equal(t.reference.sets.quads, 3);
});

test("CLI weeks: reads the snapshot history and reports what the history read does not cover", () => {
  const dir = instance();
  writeJson(dir, "athlete/.cache/snapshot.json", snapshot({}, { history: [session("2026-10-06", [{ name: "Squat", sets: 3 }])], history_coverage: { captured_at: NOW, complete: true, since: "2026-10-01", until: "2026-10-13" } }));
  const r = cli(["weeks", "--from", "2026-09-28", "--to", "2026-10-18", "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.logs.length, 3);
  assert.equal(r.json.logs[1].days[0].date, "2026-10-06");
  assert.ok(r.json.warnings.some((w: string) => /starts 2026-10-01/.test(w)));
  assert.ok(r.json.warnings.some((w: string) => /ends 2026-10-13/.test(w)));
  const none = cli(["weeks", "--from", "2026-10-01", "--to", "2026-10-02", "--root", instance()]);
  assert.equal(none.code, 0);
  assert.match(none.json.warnings[0], /no snapshot/);
  assert.equal(cli(["weeks", "--from", "2026-10-05", "--to", "2026-10-01", "--root", dir]).code, 2);
});

test("ids next --kind block: B-001 first, then one past the highest in block.yaml and athlete/blocks/", () => {
  const dir = instance();
  assert.equal(cli(["ids", "next", "--kind", "block", "--root", dir]).json.id, "B-001");
  writeFileSync(join(dir, "athlete/block.yaml"), "version: 1\nid: B-002\n");
  mkdirSync(join(dir, "athlete/blocks"));
  writeFileSync(join(dir, "athlete/blocks/B-007.yaml"), "version: 1\nid: B-007\n");
  const r = cli(["ids", "next", "--kind", "block", "--root", dir]);
  assert.equal(r.json.id, "B-008");
  assert.deepEqual(r.json.taken, ["B-002", "B-007"]);
});

test("ids next --kind limit reads athlete/limits.yaml", () => {
  const dir = instance();
  assert.equal(cli(["ids", "next", "--kind", "limit", "--root", dir]).json.id, "L-001");
  writeFileSync(join(dir, "athlete/limits.yaml"), "version: 1\npain_threshold: 4\nlimits:\n  - { id: L-001 }\n  - { id: L-012 }\n");
  assert.equal(cli(["ids", "next", "--kind", "limit", "--root", dir]).json.id, "L-013");
});

test("ids next: the proposal kind is gone (v0.2); an unknown kind exits 2", () => {
  const dir = instance();
  assert.equal(cli(["ids", "next", "--kind", "proposal", "--root", dir]).code, 2);
  assert.equal(cli(["ids", "next", "--kind", "plan", "--root", dir]).code, 2);
});

test("weeks are bucketed in one pass (40,000 daily sessions in well under a second)", () => {
  const h: ReturnType<typeof session>[] = [];
  let d = "1920-01-06";
  for (let i = 0; i < 40_000; i++) {
    h.push({ date: d, exercises: [] });
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    d = t.toISOString().slice(0, 10);
  }
  const t0 = performance.now();
  const logs = historyWeeks(h, "1920-01-06", d);
  const ms = performance.now() - t0;
  assert.equal(logs.reduce((a, w) => a + w.days.length, 0), 40_000);
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
});
