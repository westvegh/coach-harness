// V5b fix round (a diff review of V5, 8 findings). One test or more per finding; each failed
// on the V5 commit (edda5f2) before its fix. Finding 8 (scenario 30's check) is tested in
// evals/scenarios/fixtures.test.ts.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { draftBlock } from "../engine/block-draft.ts";
import type { ClusterEntry } from "../engine/clusters.ts";
import type { Template } from "../engine/methods.ts";
import { suggestLoads } from "../engine/loads.ts";
import { nextWeekTargets } from "../engine/progression.ts";
import { saveSnapshot } from "../engine/snapshot.ts";
import type { SetEntry } from "../engine/types.ts";
import { rules, snapshot, tax } from "./guard/fixtures.ts";
import { cli, REPO, writeJson } from "./e3/helpers.ts";

const TAX = tax();
const RULES = rules();
const ENTRY: ClusterEntry = { name: "EZ Bar Curl", mini_sets: 6, reps: 6, rm: 12, rest_s: 10 };
const LIST = [ENTRY];
const at = (w: number, ...r: number[]): SetEntry[] => r.map((n) => ({ weight: w, reps: n }));
const CTX = { tax: TAX, rules: RULES, units: "lbs" as const, method: "nine-adaptations", today: "2026-10-14", emphasis: "all-around" as const, templateId: "3-day" };

/** A temp athlete copy, removed after the test. `list`: the coach.yaml clusters (none: no key). `logger`: files unless given. */
function inst(t: TestContext, opts: { list?: ClusterEntry[]; config?: boolean; logger?: "files" | "tally" } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-v5b-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  symlinkSync(join(REPO, "methods"), join(dir, "methods"));
  writeFileSync(join(dir, "athlete/limits.md"), readFileSync(join(REPO, "templates/athlete/limits.md"), "utf8"));
  if (opts.config === false) return dir;
  let y = readFileSync(join(REPO, "coach.example.yaml"), "utf8").replace("logger: tally", `logger: ${opts.logger ?? "files"}`);
  if (opts.list) y += stringify({ clusters: opts.list });
  writeFileSync(join(dir, "coach.yaml"), y);
  return dir;
}

/** A 3-day template: day 1 holds `day1` (hypertrophy slots), day 2 intervals, day 3 mobility. */
function tpl(day1: { pattern: string; sets: number; reps?: number }[]): Template {
  return {
    pack: "nine-adaptations",
    version: 1,
    days: 3,
    name: "test",
    week: [
      { day: 1, focus: "Arms", slots: day1.map((s) => ({ pattern: s.pattern, adaptation: "hypertrophy" as const, sets: s.sets, reps: s.reps ?? 10, rest_s: 60 })) },
      { day: 2, focus: "Intervals", slots: [{ pattern: "intervals", adaptation: "anaerobic_capacity", sets: 8, duration: 30, rest_s: 30 }] },
      { day: 3, focus: "Mobility", slots: [{ pattern: "mobility", adaptation: "recovery", sets: 1, duration: 600, rest_s: 0 }] },
    ],
    emphasis: { "all-around": {}, strength: {}, hypertrophy: {}, endurance: {}, "general-health": {} },
  };
}
const REST = { intervals: { name: "Bike Intervals" }, mobility: { name: "Mobility Flow" } };

// ---------- 1. {days, clusters} keeps the list ----------

test("V5b 1: a {days, clusters} input keeps its list through loads --fill (35, not 30) and tally-days (the note line), like {week, clusters}", (t) => {
  const dir = inst(t);
  const day = { date: "2026-10-20", dayName: "Arms", exercises: [{ name: "EZ Bar Curl", unit: "lbs", sets: at(35, 6, 6, 6, 6, 6, 6) }] };
  const hf = writeJson(dir, "h.json", { units: "lbs", sessions: ["2026-10-06", "2026-10-13"].map((date) => ({ date, exercises: [{ name: "EZ Bar Curl", sets: at(35, 6, 6, 6, 6, 6, 5) }] })) });
  for (const [name, body] of [["days", { days: [day], clusters: LIST }], ["week", { week: { week_start: "2026-10-19", days: [day] }, clusters: LIST }]] as const) {
    const p = writeJson(dir, `${name}.json`, body);
    const td = cli(["tally-days", "--input", p, "--root", dir]);
    assert.equal(td.code, 0, td.stderr);
    assert.equal(td.json.days[0].notes, "Cluster: EZ Bar Curl: 6 × 6 at 12RM, 10 s between mini-sets", name);
    const fill = cli(["loads", "--input", p, "--fill", "--history", hf, "--root", dir]);
    assert.equal(fill.code, 0, fill.stderr);
    assert.equal(fill.json.suggestions[0].weight, 35, name);
    assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).clusters, LIST, `${name}: the saved file keeps the list`);
  }
});

// ---------- 2. name-only clusters: one rule in the draft and in volume ----------

test("V5b 2: a name-only cluster is a cluster in the draft too: planned_by_muscle equals volume on every saved week file, and the warning stays", (t) => {
  const dir = inst(t, { config: false });
  const input = { method: "nine-adaptations", days: 3, emphasis: "hypertrophy", units: "lbs", timezone: "America/Los_Angeles", logger: "none", id: "B-001", start: "2026-10-19", exercises: { elbow_flexion: { name: "EZ Bar Curl (Cluster)" }, vertical_pull: { name: "Pull-Up" }, horizontal_pull: { name: "Cable Row" } } };
  const p = writeJson(dir, "d.json", input);
  const full = cli(["block", "draft", "--weeks", "6", "--input", p, "--root", dir]);
  assert.equal(full.code, 0, full.stderr);
  assert.ok(full.json.warnings.some((w: string) => /EZ Bar Curl \(Cluster\) is a cluster by its name, but the cluster list has no entry for it: add one/.test(w)), full.json.warnings.join("\n"));
  const slot = full.json.block.days.flatMap((d: any) => d.slots).find((s: any) => s.pattern === "elbow_flexion");
  assert.equal(slot.style, "cluster");
  const out = cli(["block", "draft", "--weeks", "6", "--input", p, "--root", dir, "--out", join(dir, "b")]);
  assert.equal(out.code, 0, out.stderr);
  for (const w of out.json.weeks) {
    const vol = cli(["volume", "--input", w.file, "--root", dir]);
    // Only resolved slots are in the week files; the unresolved ones count in planned_by_muscle only.
    assert.deepEqual(vol.json.sets_by_muscle, full.json.weeks[w.week - 1].sets_by_muscle, `week ${w.week}`);
    const curl = JSON.parse(readFileSync(w.file, "utf8")).week.days.flatMap((d: any) => d.exercises).find((e: any) => /curl/i.test(e.name));
    assert.equal(curl.sets.length, w.kind === "deload" ? Math.round(slot.sets * 0.7) : slot.sets, `week ${w.week}: the template's sets every build week`);
  }
  // With every slot resolved, the plan equals volume exactly.
  const T3 = tpl([{ pattern: "elbow_flexion", sets: 4, reps: 12 }, { pattern: "squat", sets: 3 }]);
  const d = draftBlock(T3, 2, CTX, { start: "2026-10-19", exercises: { "1.1": { name: "EZ Bar Curl (Cluster)" }, "1.2": { name: "Goblet Squat" }, ...REST } });
  for (const w of d.weeks) assert.deepEqual(w.planned_by_muscle, w.sets_by_muscle, `week ${w.week}`);
  assert.equal(d.weeks[0].planned_by_muscle.biceps, 2, "4 × 12 at 24RM counts 2");
  // The template's own count wants 4 biceps sets; the cluster counts 2 and no straight slot trains biceps.
  assert.deepEqual(d.weeks[0].short, [{ muscle: "biceps", requested: 4, planned: 2, reason: "no_slot" }]);
});

// ---------- 3. duplicates before a future since ----------

test("V5b 3: two identical curl slots before the list entry's since are limited duplicates: the later one is unresolved, ready false", () => {
  const list: ClusterEntry[] = [{ ...ENTRY, since: "2026-11-02" }];
  const T3 = tpl([{ pattern: "elbow_flexion", sets: 4 }, { pattern: "elbow_flexion", sets: 3 }]);
  const d = draftBlock(T3, 4, { ...CTX, clusters: list }, { start: "2026-10-19", deload_weeks: [], exercises: { "1.1": { name: "EZ Bar Curl" }, "1.2": { name: "EZ Bar Curl" }, ...REST } });
  assert.equal(d.ready, false);
  assert.deepEqual(d.unresolved.map((u) => [u.slot, u.reason]), [["1.2", "same exercise twice on Monday: choose another exercise for this slot"]]);
  // From since on, the curl is a cluster (6 × 6), once on the day.
  assert.deepEqual(d.weeks[2].days[0].exercises.map((e) => `${e.name} ${e.sets.length}`), ["EZ Bar Curl 6"]);
  // With since before the block, both slots are clusters all block: no duplicate rule.
  const always = draftBlock(T3, 4, { ...CTX, clusters: LIST }, { start: "2026-10-19", deload_weeks: [], exercises: { "1.1": { name: "EZ Bar Curl" }, "1.2": { name: "EZ Bar Curl" }, ...REST } });
  assert.equal(always.ready, true);
});

// ---------- 4. an explicit empty list ----------

test("V5b 4: clusters: [] in the draft input overrides coach.yaml in the saved week files too: volume counts the curl straight", (t) => {
  const dir = inst(t, { list: LIST });
  const p = writeJson(dir, "d.json", { id: "B-001", start: "2026-10-19", clusters: [], exercises: { elbow_flexion: { name: "EZ Bar Curl" } } });
  const out = cli(["block", "draft", "--weeks", "2", "--input", p, "--root", dir, "--out", join(dir, "b")]);
  assert.equal(out.code, 0, out.stderr);
  const w1 = out.json.weeks[0];
  assert.deepEqual(JSON.parse(readFileSync(w1.file, "utf8")).clusters, []);
  const vol = cli(["volume", "--input", w1.file, "--root", dir]);
  assert.deepEqual(vol.json.sets_by_muscle, w1.sets_by_muscle);
  assert.equal(vol.json.clusters, undefined, "no cluster: the curl is straight");
  // Without the key, coach.yaml's list counts (the week file carries nothing).
  const p2 = writeJson(dir, "d2.json", { id: "B-001", start: "2026-10-19", exercises: { elbow_flexion: { name: "EZ Bar Curl" } } });
  const out2 = cli(["block", "draft", "--weeks", "2", "--input", p2, "--root", dir, "--out", join(dir, "b2")]);
  assert.equal("clusters" in JSON.parse(readFileSync(out2.json.weeks[0].file, "utf8")), false);
  assert.deepEqual(cli(["volume", "--input", out2.json.weeks[0].file, "--root", dir]).json.clusters.map((c: any) => c.text), ["6 × 6 cluster, counts as 3 sets"]);
});

// ---------- 5. deload weeks: requested target and the advisory ----------

test("V5b 5: a deload week keeps requested and allocated apart and lists cluster_above_target; the draft and targets agree", () => {
  const four: ClusterEntry[] = [{ ...ENTRY, mini_sets: 4 }];
  const T3 = tpl([{ pattern: "elbow_flexion", sets: 4 }, { pattern: "squat", sets: 3 }]);
  const d = draftBlock(T3, 2, { ...CTX, clusters: four }, { id: "B-001", start: "2026-10-19", deload_weeks: [2], exercises: { "1.1": { name: "EZ Bar Curl" }, "1.2": { name: "Goblet Squat" }, ...REST } });
  const [w1, w2] = d.weeks;
  assert.equal(w1.planned_by_muscle.biceps, 2, "4 × 6 at 12RM");
  assert.equal(w2.kind, "deload");
  assert.equal(w2.days[0].exercises.find((e) => e.name === "EZ Bar Curl")!.sets.length, 3);
  assert.equal(w2.planned_by_muscle.biceps, 2, "3 × 6 at 12RM rounds 1.5 up to 2");
  assert.equal(w2.targets.biceps, 1, "round(2 × 0.7)");
  assert.deepEqual(w2.cluster_above_target, [{ muscle: "biceps", target: 1, cluster_sets: 2 }]);
  const t = nextWeekTargets(d.block, null, RULES, { tax: TAX, week: 2, clusters: four });
  assert.equal(t.sets.biceps, w2.targets.biceps);
  assert.deepEqual(t.cluster_above_target, w2.cluster_above_target);
  assert.deepEqual(d.block.weeks[1].targets, w2.planned_by_muscle, "the block week's targets stay the planned sets");
});

// ---------- 6. weeks and the list ----------

test("V5b 6: weeks counts a listed 6 × 6 at rm 12 curl as 3 biceps sets: the list from --input (no coach.yaml list), and from coach.yaml through the Tally cache", (t) => {
  // --input with the list: the path that gave 6 (weeks took --input and ignored it).
  const files = inst(t);
  writeJson(files, "d.json", { days: [{ date: "2026-10-20", exercises: [{ name: "EZ Bar Curl", unit: "lbs", sets: at(35, 6, 6, 6, 6, 6, 6) }] }] });
  assert.equal(cli(["plans", "write", "--input", join(files, "d.json"), "--root", files]).code, 0);
  assert.equal(cli(["plans", "done", "--date", "2026-10-20", "--as-planned", "--root", files]).code, 0);
  const none = cli(["weeks", "--from", "2026-10-19", "--to", "2026-10-25", "--root", files]);
  assert.equal(none.json.logs[0].sets_by_muscle.biceps, 6, "no list anywhere: straight");
  const viaInput = cli(["weeks", "--from", "2026-10-19", "--to", "2026-10-25", "--input", writeJson(files, "c.json", { clusters: LIST }), "--root", files]);
  assert.equal(viaInput.code, 0, viaInput.stderr);
  assert.equal(viaInput.json.logs[0].sets_by_muscle.biceps, 3);
  // coach.yaml's list, logger tally: the history comes from the snapshot cache.
  const tally = inst(t, { list: [{ ...ENTRY, exerciseId: "custom-123" }], logger: "tally" });
  const history = [{ date: "2026-10-20", weightUnit: "lbs" as const, exercises: [{ exerciseId: "custom-123", name: "EZ Bar Curls", muscle: "biceps", sets: at(35, 6, 6, 6, 6, 6, 6).map((s) => ({ weight: s.weight!, reps: s.reps!, rpe: null })) }] }];
  saveSnapshot(tally, snapshot({}, { history }));
  const wk = cli(["weeks", "--from", "2026-10-19", "--to", "2026-10-25", "--root", tally]);
  assert.equal(wk.code, 0, wk.stderr);
  assert.equal(wk.json.logs[0].sets_by_muscle.biceps, 3, "matched by exerciseId, though the Tally name differs");
});

// ---------- 7. old history and the unit check ----------

test("V5b 7: an old straight session with no unit does not block a cluster suggestion (60 lbs, 36 of 36 → 65)", () => {
  const list: ClusterEntry[] = [{ ...ENTRY, since: "2026-10-01" }];
  const history = [
    { date: "2026-09-01", exercises: [{ exerciseId: "", name: "EZ Bar Curl", muscle: "", sets: at(30, 10, 10, 10).map((s) => ({ weight: s.weight!, reps: s.reps!, rpe: null })) }] },
    { date: "2026-10-13", weightUnit: "lbs" as const, exercises: [{ exerciseId: "", name: "EZ Bar Curl", muscle: "", sets: at(60, 6, 6, 6, 6, 6, 6).map((s) => ({ weight: s.weight!, reps: s.reps!, rpe: null })) }] },
  ];
  const plan = { exerciseId: null, name: "EZ Bar Curl", unit: "lbs" as const, sets: at(0, 6, 6, 6, 6, 6, 6).map((s) => ({ reps: s.reps })) };
  const [s] = suggestLoads([plan], history, RULES, "lbs", { tax: TAX, strictUnits: true, clusters: list, date: "2026-10-20" });
  assert.equal(s.suggestedWeight, 65, s.reason);
  // A cluster session with no unit still blocks (unknown, never a guess).
  const [u] = suggestLoads([plan], [{ ...history[1], weightUnit: undefined }], RULES, "lbs", { tax: TAX, strictUnits: true, clusters: list, date: "2026-10-20" });
  assert.equal(u.suggestedWeight, undefined);
  assert.match(u.reason, /unit of the session on 2026-10-13 is unknown/);
});
