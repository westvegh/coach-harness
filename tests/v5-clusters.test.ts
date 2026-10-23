// V5 (0.2.4) part B: cluster sets. One list in coach.yaml, one recognition helper, counted sets
// (volume) against physical sets (the work to do), loads judged as one block, and the notes.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { toDayPlan } from "../adapters/loggers/tally/day.ts";
import { adjustDay } from "../engine/adjust.ts";
import { validateBlock } from "../engine/block.ts";
import { draftBlock } from "../engine/block-draft.ts";
import { clusterCount, clusterOf, countedSets, stripClusterNotes, type ClusterEntry } from "../engine/clusters.ts";
import { suggestLoads } from "../engine/loads.ts";
import { loadTemplates } from "../engine/methods.ts";
import { nextWeekTargets } from "../engine/progression.ts";
import { mergeResponse } from "../engine/snapshot.ts";
import { parseHistoryFile, tallyDays, TALLY_NOTES_MAX } from "../engine/week-file.ts";
import type { Block, DayPlan, ExerciseEntry, SetEntry, SnapshotDay } from "../engine/types.ts";
import { rules, tax } from "./guard/fixtures.ts";
import { cli, REPO, writeJson } from "./e3/helpers.ts";

const TAX = tax();
const RULES = rules();
const ENTRY: ClusterEntry = { name: "EZ Bar Curl", exerciseId: "custom-123", mini_sets: 6, reps: 6, rm: 12, rest_s: 10 };
const LIST = [ENTRY];
const reps = (...r: number[]): SetEntry[] => r.map((n) => ({ reps: n }));
const at = (w: number, ...r: number[]): SetEntry[] => r.map((n) => ({ weight: w, reps: n }));
const curl = (sets: SetEntry[], over: Partial<ExerciseEntry> = {}): ExerciseEntry => ({ exerciseId: null, name: "EZ Bar Curl", unit: "lbs", sets, ...over });

type Mode = "yaml" | "input" | "none";
const MODES: Mode[] = ["yaml", "input", "none"];

/** A temp athlete copy (removed after the test): coach.yaml from the example, logger files, the list in coach.yaml for "yaml". */
function inst(t: TestContext, mode: Mode | "bare" = "none", list: ClusterEntry[] = LIST): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-v5c-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  symlinkSync(join(REPO, "methods"), join(dir, "methods"));
  writeFileSync(join(dir, "athlete/limits.md"), readFileSync(join(REPO, "templates/athlete/limits.md"), "utf8"));
  if (mode === "bare") return dir;
  let y = readFileSync(join(REPO, "coach.example.yaml"), "utf8").replace("logger: tally", "logger: files");
  if (mode === "yaml") y += stringify({ clusters: list });
  writeFileSync(join(dir, "coach.yaml"), y);
  return dir;
}
/** The input's own list for "input"; nothing otherwise. */
const withList = (mode: Mode, v: Record<string, unknown>) => (mode === "input" ? { ...v, clusters: LIST } : v);
const isCluster = (mode: Mode) => mode !== "none";

// ---------- B.3 the count ----------

test("V5 B.3: a cluster counts max(1, round(total reps ÷ rm)); every brief example", () => {
  assert.equal(clusterCount(reps(6, 6, 6, 6, 6, 6), 12), 3);
  assert.equal(clusterCount(reps(6, 6, 6, 6, 6, 5), 12), 3, "round(35/12) = 3");
  assert.equal(clusterCount(reps(6, 6, 6, 6, 6, 6)), 3, "no rm: 2 × the largest mini-set = 12");
  assert.equal(clusterCount(reps(6, 6, 0), 12), 1);
  assert.equal(clusterCount([{ reps: 6, warmup: true }, { reps: 6, warmup: true }], 12), 0, "all warm-ups");
  assert.equal(clusterCount([{ weight: 35 }, { weight: 35 }, { weight: 35 }], 12), 3, "no reps: the number of work mini-sets");
  assert.equal(clusterCount([], 12), 0);
  assert.equal(clusterCount(reps(4, 4, 4), 8), 2, "12/8 = 1.5 rounds half up");
});

// ---------- B.2 recognition ----------

test("V5 B.2: recognition by list exerciseId, by list name, a CSV row with no exerciseId, by the name word, and none", () => {
  assert.equal(clusterOf({ exerciseId: "custom-123", name: "Curl (renamed)" }, "2026-10-20", LIST)?.by, "list");
  assert.equal(clusterOf({ exerciseId: "other-id", name: "EZ Bar Curl" }, "2026-10-20", LIST), null, "both have ids and they differ: no match, and no cluster word");
  assert.equal(clusterOf({ exerciseId: null, name: "ez-bar curl" }, "2026-10-20", LIST)?.entry, ENTRY, "a CSV row: by normalized name");
  assert.equal(clusterOf({ exerciseId: null, name: "Cable Curls (Cluster)" }, "2026-10-20", [])?.by, "name");
  assert.equal(clusterOf({ exerciseId: null, name: "Clustered Curl" }, "2026-10-20", []), null, "the whole word only");
  assert.equal(clusterOf({ exerciseId: null, name: "Bench Press" }, "2026-10-20", LIST), null);
  // Counted sets: a list cluster, a name-word cluster (rm = 2 × largest), straight sets.
  assert.equal(countedSets(curl(reps(6, 6, 6, 6, 6, 6)), "2026-10-20", LIST), 3);
  assert.equal(countedSets({ name: "Curls (Cluster)", sets: reps(5, 5, 5, 5, 5, 5) }, "2026-10-20", []), 3);
  assert.equal(countedSets({ name: "Bench Press", sets: [...reps(5, 5), { reps: 5, warmup: true }] }, "2026-10-20", LIST), 2);
});

test("V5 B.2: a list entry with since: before it the exercise is straight sets, and the name word does not apply to it", () => {
  const list: ClusterEntry[] = [{ name: "Curls (Cluster)", mini_sets: 6, reps: 6, rm: 12, since: "2026-09-01" }];
  const ex = { name: "Curls (Cluster)", sets: reps(6, 6, 6, 6, 6, 6) };
  assert.equal(clusterOf(ex, "2026-08-25", list), null);
  assert.equal(countedSets(ex, "2026-08-25", list), 6);
  assert.equal(clusterOf(ex, "2026-09-01", list)?.by, "list");
  assert.equal(countedSets(ex, "2026-09-01", list), 3);
});

test("V5 B.2: a block that crosses since: straight weeks before it, the cluster prescription from it", () => {
  const T3 = loadTemplates(join(REPO, "methods/nine-adaptations"))["3-day"];
  const list: ClusterEntry[] = [{ ...ENTRY, exerciseId: undefined, since: "2026-11-02" } as ClusterEntry];
  delete (list[0] as { exerciseId?: string }).exerciseId;
  const d = draftBlock(T3, 3, { tax: TAX, rules: RULES, units: "lbs", method: "nine-adaptations", today: "2026-10-14", emphasis: "hypertrophy", templateId: "3-day", clusters: list }, { start: "2026-10-19", deload_weeks: [], exercises: { elbow_flexion: { name: "EZ Bar Curl" } } });
  const curlIn = (w: number) => d.weeks[w].days.flatMap((x) => x.exercises).find((e) => e.name === "EZ Bar Curl")!;
  assert.equal(curlIn(0).sets.length, 4, "week 1 (before since): straight, at the maximum");
  assert.equal(curlIn(0).sets[0].reps, 15);
  assert.deepEqual(curlIn(2).sets.map((s) => s.reps), [6, 6, 6, 6, 6, 6], "week 3 (since 2026-11-02): the cluster");
  const slot = d.block.days[0].slots.find((s) => s.pattern === "elbow_flexion")!;
  assert.deepEqual([slot.style, slot.rm, slot.sets, slot.reps, slot.rest_s], ["cluster", 12, 6, 6, 10]);
  assert.equal(d.weeks[0].planned_by_muscle.biceps - d.weeks[2].planned_by_muscle.biceps, 1, "week 1: 4 straight sets; week 3: the cluster counts 3");
});

// ---------- B.5 the draft and the block ----------

test("V5 B.5: a cluster slot keeps its prescription every build week, counts first, never takes overflow; the deload keeps round(mini_sets × 0.7)", () => {
  const T3 = loadTemplates(join(REPO, "methods/nine-adaptations"))["3-day"];
  const ctx = { tax: TAX, rules: RULES, units: "lbs" as const, method: "nine-adaptations", today: "2026-10-14", emphasis: "hypertrophy" as const, templateId: "3-day", clusters: LIST };
  const d = draftBlock(T3, 6, ctx, { start: "2026-10-19", id: "B-001", exercises: { elbow_flexion: { name: "EZ Bar Curl", exerciseId: "custom-123" }, vertical_pull: { name: "Pull-Up" }, horizontal_pull: { name: "Cable Row" } } });
  for (const w of d.weeks.slice(0, 5)) {
    const c = w.days.flatMap((x) => x.exercises).find((e) => e.name === "EZ Bar Curl")!;
    assert.deepEqual(c.sets.map((s) => s.reps), [6, 6, 6, 6, 6, 6], `week ${w.week}`);
    assert.equal(w.planned_by_muscle.biceps, w.sets_by_muscle.biceps);
  }
  const deload = d.weeks[5].days.flatMap((x) => x.exercises).find((e) => e.name === "EZ Bar Curl")!;
  assert.equal(deload.sets.length, 4, "round(6 × 0.7) = 4 mini-sets");
  assert.equal(validateBlock(d.block, "test").days[0].slots.find((s) => s.style === "cluster")?.sets, 6);
  // The cluster prescription wins over a lower target: it stays, with an advisory entry.
  const low = draftBlock(T3, 1, ctx, { start: "2026-10-19", targets: { biceps: 2 }, exercises: { elbow_flexion: { name: "EZ Bar Curl" } } });
  assert.deepEqual(low.weeks[0].cluster_above_target, [{ muscle: "biceps", target: 2, cluster_sets: 3 }]);
  assert.equal(low.weeks[0].days.flatMap((x) => x.exercises).find((e) => e.name === "EZ Bar Curl")!.sets.length, 6);
});

test("V5 B.5: targets (progression.ts): the clusters' counted sets, the straight rest, and cluster_above_target (build, and deload rounding 4 → 3 mini-sets, counts 2)", () => {
  const block: Block = {
    version: 1,
    id: "B-001",
    method: "nine-adaptations",
    template: { days: 3, emphasis: "hypertrophy" },
    start: "2026-10-19",
    weeks: [
      { week: 1, kind: "build", sessions: 3, targets: { biceps: 2, lats: 6 } },
      { week: 2, kind: "deload", sessions: 3, targets: { biceps: 1 } },
    ],
    days: [{ day: "mon", focus: "Upper", slots: [{ pattern: "elbow_flexion", adaptation: "hypertrophy", sets: 6, reps: 6, exercise: "EZ Bar Curl", style: "cluster", rm: 12 }, { pattern: "vertical_pull", adaptation: "hypertrophy", sets: 3, reps: 10, exercise: "Pull-Up" }] }],
  };
  const build = nextWeekTargets(block, null, RULES, { tax: TAX, week: 1, clusters: LIST });
  assert.deepEqual(build.clusters, [{ day: "mon", exercise: "EZ Bar Curl", mini_sets: 6, reps: 6, rm: 12, counted: 3, muscles: ["biceps"] }]);
  assert.deepEqual(build.straight, { biceps: 0, lats: 6 });
  assert.deepEqual(build.cluster_above_target, [{ muscle: "biceps", target: 2, cluster_sets: 3 }]);
  const four: ClusterEntry[] = [{ ...ENTRY, mini_sets: 4 }];
  const deload = nextWeekTargets(block, null, RULES, { tax: TAX, week: 2, clusters: four });
  assert.equal(deload.sets.biceps, 1, "round(2 × 0.7)");
  assert.deepEqual(deload.clusters.map((c) => [c.mini_sets, c.counted]), [[3, 2]]);
  assert.deepEqual(deload.cluster_above_target, [{ muscle: "biceps", target: 1, cluster_sets: 2 }]);
  // No list: no clusters, and straight equals the targets.
  const none = nextWeekTargets(block, null, RULES, { tax: TAX, week: 1 });
  assert.deepEqual([none.clusters, none.straight, none.cluster_above_target], [[], { biceps: 2, lats: 6 }, []]);
});

// ---------- B.4 limits ----------
// 0.3.0: limits are plain words (athlete/limits.md) and no code counts them; the counted sets of a
// cluster stay in `volume` (above) and `weeks`.

// ---------- B.6 loads ----------

const PLAN = curl(reps(6, 6, 6, 6, 6, 6));
const hist = (sessions: { date: string; sets: SetEntry[]; name?: string }[]) => sessions.map((s) => ({ date: s.date, weightUnit: "lbs" as const, exercises: [{ exerciseId: "", name: s.name ?? "EZ Bar Curl", muscle: "", sets: s.sets.map((x) => ({ weight: x.weight ?? null, reps: x.reps ?? null, rpe: x.rpe ?? null, ...(x.warmup ? { warmup: true } : {}) })) }] }));
const load = (sessions: Parameters<typeof hist>[0], plan = PLAN, clusters = LIST) => suggestLoads([plan], hist(sessions), RULES, "lbs", { tax: TAX, clusters, date: "2026-10-20" })[0];

test("V5 B.6: 6,6,6,6,6,5 at 35 lbs in two sessions repeats 35 (base 0.2.3: −5% to 30)", () => {
  const s = load([{ date: "2026-10-06", sets: at(35, 6, 6, 6, 6, 6, 5) }, { date: "2026-10-13", sets: at(35, 6, 6, 6, 6, 6, 5) }]);
  assert.equal(s.suggestedWeight, 35);
  assert.equal(s.reason, "cluster: 35 of 36 reps at 35 lbs on 2026-10-13 → repeat");
});

test("V5 B.6: 36 of 36 at 35 lbs repeats (one 5 lb step is above the 10% cap); at 60 lbs it steps to 65", () => {
  const s35 = load([{ date: "2026-10-13", sets: at(35, 6, 6, 6, 6, 6, 6) }]);
  assert.equal(s35.suggestedWeight, 35);
  assert.match(s35.reason, /^cluster: hit every rep, but one 5 lbs step is above top_set_jump_max \(10%\); 36 of 36 reps at 35 lbs on 2026-10-13 → repeat$/);
  const s60 = load([{ date: "2026-10-13", sets: at(60, 6, 6, 6, 6, 6, 6) }]);
  assert.equal(s60.suggestedWeight, 65);
});

test("V5 B.6: mixed weights repeat the most-used weight (ties: the lighter); RPE above the target repeats", () => {
  const mixed = load([{ date: "2026-10-13", sets: [...at(35, 6, 6, 6, 6), ...at(40, 6, 6)] }]);
  assert.equal(mixed.suggestedWeight, 35);
  assert.equal(mixed.reason, "cluster: mixed weights on 2026-10-13 → repeat 35 lbs");
  const tie = load([{ date: "2026-10-13", sets: [...at(60, 6, 6, 6), ...at(65, 6, 6, 6)] }]);
  assert.equal(tie.suggestedWeight, 60);
  const hard = load([{ date: "2026-10-13", sets: at(60, 6, 6, 6, 6, 6, 6).map((x, i) => (i === 5 ? { ...x, rpe: 9.5 } : x)) }]);
  assert.equal(hard.suggestedWeight, 60);
  assert.match(hard.reason, /RPE 9.5 above the target 8/);
});

test("V5 B.6: a heavier warm-up never becomes W (cluster) or the top set (straight sets)", () => {
  const c = load([{ date: "2026-10-13", sets: [{ weight: 70, reps: 3, warmup: true }, ...at(60, 6, 6, 6, 6, 6, 6)] }]);
  assert.equal(c.suggestedWeight, 65);
  const bench: ExerciseEntry = { exerciseId: null, name: "Bench Press", unit: "lbs", sets: reps(5, 5, 5) };
  const s = suggestLoads([bench], hist([{ date: "2026-10-13", name: "Bench Press", sets: [{ weight: 225, reps: 1, warmup: true }, ...at(185, 5, 5, 5)] }]), RULES, "lbs", { tax: TAX })[0];
  assert.equal(s.suggestedWeight, 190, "the work sets at 185 hit 5 reps: +2.5% → 190 (base 0.2.3: the warm-up was the top set → repeat 225)");
});

test("V5 B.6: only sessions where the exercise was a cluster count; straight sessions before since give no suggestion", () => {
  const list: ClusterEntry[] = [{ ...ENTRY, since: "2026-10-10" }];
  const before = load([{ date: "2026-10-06", sets: at(35, 10, 10, 10) }], PLAN, list);
  assert.equal(before.suggestedWeight, undefined);
  assert.match(before.reason, /no logged cluster session/);
  const after = load([{ date: "2026-10-06", sets: at(30, 10, 10, 10) }, { date: "2026-10-13", sets: at(35, 6, 6, 6, 6, 6, 6) }], PLAN, list);
  assert.equal(after.suggestedWeight, 35);
});

test("V5 B.6: warm-up flags survive ingestion (history file and snapshot) and reach loads", () => {
  const file = parseHistoryFile({ units: "lbs", sessions: [{ date: "2026-10-13", exercises: [{ name: "EZ Bar Curl", sets: [{ weight: 70, reps: 3, warmup: true }, ...at(60, 6, 6, 6, 6, 6, 6)] }, { name: "Bench Press", sets: [{ weight: 225, reps: 1, warmup: true }, ...at(185, 5, 5, 5)] }] }] });
  assert.equal(file[0].exercises[0].sets[0].warmup, true);
  const fromFile = suggestLoads([PLAN, { name: "Bench Press", sets: reps(5, 5, 5) }], file, RULES, "lbs", { tax: TAX, clusters: LIST, date: "2026-10-20" });
  assert.deepEqual(fromFile.map((s) => s.suggestedWeight), [65, 190]);
  const response = [{ type: "text", text: JSON.stringify({ count: 1, sessions: [{ date: "2026-10-13", name: "Arms", weightUnit: "lbs", exercises: [{ exerciseId: "custom-123", name: "EZ Bar Curl", sets: [{ weight: 70, reps: 3, warmup: true }, ...at(60, 6, 6, 6, 6, 6, 6)] }] }] }) }];
  const snap = mergeResponse(null, { tool: "get_workout_history", input: { since: "2026-10-01" }, response, session_id: "s", now: "2026-10-14T12:00:00Z", timezone: "UTC" });
  assert.equal(snap.history[0].exercises[0].sets[0].warmup, true);
  assert.equal(suggestLoads([PLAN], snap.history, RULES, "lbs", { tax: TAX, clusters: LIST, date: "2026-10-20" })[0].suggestedWeight, 65);
});

// ---------- B.7 outputs ----------

test("V5 B.7 Tally: one Cluster line per cluster exercise in the day notes; a repeat conversion has no duplicate; the coach's notes are never cut (1,000 and 1,001)", () => {
  const wf = (notes?: string) => ({ week: { days: [{ date: "2026-10-20", dayName: "Arms", ...(notes !== undefined ? { notes } : {}), exercises: [curl(at(35, 6, 6, 6, 6, 6, 6), { exerciseId: "custom-123" }), { exerciseId: null, name: "Bench Press", unit: "lbs" as const, sets: at(185, 5, 5, 5) }] }] } });
  const line = "Cluster: EZ Bar Curl: 6 × 6 at 12RM, 10 s between mini-sets";
  const once = tallyDays(wf("Easy day"), "lbs", undefined, LIST);
  assert.equal(once.days[0].notes, `Easy day\n${line}`);
  const again = tallyDays(wf(once.days[0].notes), "lbs", undefined, LIST);
  assert.equal(again.days[0].notes, `Easy day\n${line}`, "the old line is replaced, not repeated");
  const stale = tallyDays(wf(`Easy day\nCluster: EZ Bar Curl: 5 × 5 at 10RM`), "lbs", undefined, LIST);
  assert.equal(stale.days[0].notes, `Easy day\n${line}`);
  assert.equal(tallyDays(wf("Easy day"), "lbs", undefined, []).days[0].notes, "Easy day", "no list: no line");
  // The boundary: the notes plus "\n" plus the line at exactly 1,000 characters fit; 1,001 do not.
  const fill = (n: number) => "x".repeat(n - line.length - 1);
  const exact = tallyDays(wf(fill(TALLY_NOTES_MAX)), "lbs", undefined, LIST);
  assert.equal(exact.days[0].notes!.length, 1000);
  assert.deepEqual(exact.warnings.filter((w) => w.includes("does not fit")), []);
  const over = tallyDays(wf(fill(TALLY_NOTES_MAX + 1)), "lbs", undefined, LIST);
  assert.equal(over.days[0].notes, fill(TALLY_NOTES_MAX + 1), "the coach's notes stay whole");
  assert.deepEqual(over.warnings.filter((w) => w.includes("does not fit")), ["2026-10-20 EZ Bar Curl: the cluster line does not fit in Tally's 1000-character day notes; it was left out"]);
  assert.equal(stripClusterNotes(`a | Cluster: x\nCluster: y\nb`), "a\nb");
});

test("V5 B.7 readback: tally-days output → toDayPlan → loads and adjust give the cluster answers", () => {
  const out = tallyDays({ week: { days: [{ date: "2026-10-20", dayName: "Arms", exercises: [curl(at(35, 6, 6, 6, 6, 6, 6), { exerciseId: "custom-123" })] }] } }, "lbs", undefined, LIST);
  const tday = out.days[0];
  assert.equal(tday.exercises[0].suggestedSets, 6, "physical sets: Tally logs each mini-set");
  const snapDay: SnapshotDay = { found: true, version: "1", updatedAt: null, source: "mcp", userModified: false, skipped: false, dayName: tday.dayName, notes: tday.notes, exercises: tday.exercises, weightUnit: "lbs", weightUnitSource: "settings", captured_at: "2026-10-14T12:00:00Z" };
  const plan = toDayPlan("2026-10-20", snapDay, "lbs");
  const ex = plan.exercises[0];
  assert.equal(countedSets(ex, plan.date, LIST), 3);
  const s = suggestLoads([ex], hist([{ date: "2026-10-13", sets: at(35, 6, 6, 6, 6, 6, 5) }]), RULES, "lbs", { tax: TAX, clusters: LIST, date: plan.date })[0];
  assert.equal(s.suggestedWeight, 35);
  assert.match(s.reason, /^cluster: 35 of 36 reps/);
  const trimmed = adjustDay(plan, "trim", { tax: TAX, thresholds: {}, clusters: LIST });
  assert.deepEqual(trimmed.changes, ["EZ Bar Curl: 6 → 5 mini-sets"]);
});

test("V5 B.7 plans CSV: the cluster note, the day note kept in a fixed order, write → read → write with no duplicate, and unequal logged reps read back exactly", (t) => {
  const dir = inst(t, "yaml");
  const day = { date: "2026-10-20", dayName: "Arms", notes: "Short session", exercises: [curl(at(35, 6, 6, 6, 6, 6, 6)), { name: "Bench Press", unit: "lbs", sets: at(185, 5, 5, 5) }] };
  const w1 = writeJson(dir, ".tmp/coach/d.json", { days: [day] });
  assert.equal(cli(["plans", "write", "--input", w1, "--root", dir]).code, 0);
  const csv1 = readFileSync(join(dir, "plans/2026-W43.csv"), "utf8");
  assert.match(csv1, /2026-10-20,Arms,EZ Bar Curl,6,6,35,lbs,"Short session \| Cluster: 6 × 6 at 12RM, 10 s between mini-sets",/);
  assert.match(csv1, /2026-10-20,Arms,Bench Press,3,5,185,lbs,,/);
  // Read back and write the day again: the same file.
  const back = cli(["plans", "read", "--week", "2026-10-20", "--root", dir]);
  assert.equal(back.code, 0, back.stderr);
  assert.equal(back.json.days[0].notes, "Short session | Cluster: 6 × 6 at 12RM, 10 s between mini-sets");
  const w2 = writeJson(dir, ".tmp/coach/d2.json", { days: back.json.days });
  assert.equal(cli(["plans", "write", "--input", w2, "--root", dir]).code, 0);
  assert.equal(readFileSync(join(dir, "plans/2026-W43.csv"), "utf8"), csv1);
  // A cluster row that is not the first row of the day carries only its own line.
  const w3 = writeJson(dir, ".tmp/coach/d3.json", { days: [{ ...day, exercises: [day.exercises[1], day.exercises[0]] }] });
  assert.equal(cli(["plans", "write", "--input", w3, "--root", dir]).code, 0);
  const csv3 = readFileSync(join(dir, "plans/2026-W43.csv"), "utf8");
  assert.match(csv3, /Bench Press,3,5,185,lbs,Short session,/);
  assert.match(csv3, /EZ Bar Curl,6,6,35,lbs,"?Cluster: 6 × 6 at 12RM, 10 s between mini-sets"?,/);
  // The athlete logs 6,6,6,6,6,5: stored and read back exactly; the files snapshot and weeks count 3.
  const done = cli(["plans", "done", "--date", "2026-10-20", "--exercise", "EZ Bar Curl", "--sets", "6", "--reps", "6,6,6,6,6,5", "--load", "35", "--root", dir]);
  assert.equal(done.code, 0, done.stderr);
  assert.match(readFileSync(join(dir, "plans/2026-W43.csv"), "utf8"), /"6,6,6,6,6,5",35,/);
  const wk = cli(["weeks", "--from", "2026-10-19", "--to", "2026-10-25", "--root", dir]);
  assert.equal(wk.code, 0, wk.stderr);
  assert.deepEqual(wk.json.logs[0].days[0].exercises[0].sets.map((s: SetEntry) => s.reps), [6, 6, 6, 6, 6, 5]);
  assert.equal(wk.json.logs[0].sets_by_muscle.biceps, 3);
  // The logged row survives a rewrite of the day.
  assert.equal(cli(["plans", "write", "--input", w2, "--root", dir]).code, 0);
  assert.match(readFileSync(join(dir, "plans/2026-W43.csv"), "utf8"), /"6,6,6,6,6,5",35,/);
});

// ---------- every command: the list in coach.yaml, in the input, or neither ----------

const WEEK = { week_start: "2026-10-19", days: [{ date: "2026-10-20", dayName: "Arms", dayType: "training", exercises: [curl(at(35, 6, 6, 6, 6, 6, 6))] }] };

for (const mode of MODES) {
  test(`V5 B.2 commands with the list ${mode === "yaml" ? "in coach.yaml" : mode === "input" ? "in the input" : "nowhere"}: volume, loads, loads --fill, tally-days, plans write, targets, adjust, classify, block draft`, (t) => {
    const dir = inst(t, mode);
    const c = isCluster(mode);
    // volume
    const vol = cli(["volume", "--input", writeJson(dir, "v.json", withList(mode, { week: WEEK })), "--root", dir]);
    assert.equal(vol.code, 0, vol.stderr);
    assert.equal(vol.json.sets_by_muscle.biceps, c ? 3 : 6);
    assert.deepEqual(vol.json.clusters?.map((x: any) => x.text), c ? ["6 × 6 cluster, counts as 3 sets"] : undefined);
    assert.equal(vol.json.session_max?.[0]?.exercise, c ? undefined : "EZ Bar Curl", "the audit: a straight 6-set exercise is advisory");
    // loads (the legacy input: exercises and history, with a date)
    const history = hist([{ date: "2026-10-06", sets: at(35, 6, 6, 6, 6, 6, 5) }, { date: "2026-10-13", sets: at(35, 6, 6, 6, 6, 6, 5) }]);
    const ld = cli(["loads", "--input", writeJson(dir, "ld.json", withList(mode, { exercises: [PLAN], history, units: "lbs", date: "2026-10-20" })), "--root", dir]);
    assert.equal(ld.code, 0, ld.stderr);
    assert.equal(ld.json.suggestions[0].suggestedWeight, c ? 35 : 30);
    // loads --fill on a week file, with a history file
    const wfPath = writeJson(dir, "wk.json", withList(mode, { week: { ...WEEK, kind: "build", load_factor: 1 } }));
    const hf = writeJson(dir, "h.json", { units: "lbs", sessions: [{ date: "2026-10-06", exercises: [{ name: "EZ Bar Curl", sets: at(35, 6, 6, 6, 6, 6, 5) }] }, { date: "2026-10-13", exercises: [{ name: "EZ Bar Curl", sets: at(35, 6, 6, 6, 6, 6, 5) }] }] });
    const fill = cli(["loads", "--input", wfPath, "--fill", "--history", hf, "--root", dir]);
    assert.equal(fill.code, 0, fill.stderr);
    assert.equal(fill.json.suggestions[0].weight, c ? 35 : 30);
    // tally-days
    const td = cli(["tally-days", "--input", wfPath, "--root", dir]);
    assert.equal(td.code, 0, td.stderr);
    assert.equal(td.json.days[0].notes, c ? "Cluster: EZ Bar Curl: 6 × 6 at 12RM, 10 s between mini-sets" : undefined);
    // plans write
    const pw = cli(["plans", "write", "--input", wfPath, "--root", dir]);
    assert.equal(pw.code, 0, pw.stderr);
    assert.equal(readFileSync(join(dir, "plans/2026-W43.csv"), "utf8").includes("Cluster: 6 × 6 at 12RM"), c);
    // targets
    const block = { version: 1, id: "B-001", method: "nine-adaptations", template: { days: 3, emphasis: "hypertrophy" }, start: "2026-10-19", weeks: [{ week: 1, kind: "build", sessions: 3, targets: { biceps: 6 } }], days: [{ day: "tue", focus: "Arms", slots: [{ pattern: "elbow_flexion", adaptation: "hypertrophy", sets: 6, reps: 6, exercise: "EZ Bar Curl" }] }] };
    const tg = cli(["targets", "--input", writeJson(dir, "t.json", withList(mode, { block, logs: [], today: "2026-10-14", target_week: 1 })), "--root", dir]);
    assert.equal(tg.code, 0, tg.stderr);
    assert.deepEqual(tg.json.targets.straight, { biceps: c ? 3 : 6 });
    // adjust (a trim names mini-sets for a cluster)
    const adj = cli(["adjust", "--input", writeJson(dir, "a.json", withList(mode, { day: WEEK.days[0], decision: "trim" })), "--root", dir]);
    assert.equal(adj.code, 0, adj.stderr);
    assert.deepEqual(adj.json.changes, [`EZ Bar Curl: 6 → 5 ${c ? "mini-sets" : "sets"}`]);
    // classify (physical sets against the slot's prescription)
    writeFileSync(join(dir, "athlete/block.yaml"), stringify({ ...block, slots: undefined, days: [{ day: "tue", focus: "Arms", slots: [{ pattern: "elbow_flexion", adaptation: "hypertrophy", sets: 4, reps: 6, exercise: "EZ Bar Curl" }] }] }));
    const cls = cli(["classify", "--input", writeJson(dir, "c.json", withList(mode, { before: null, after: WEEK.days[0], tool: "plan_workout_day", today: "2026-10-14" })), "--root", dir]);
    assert.equal(cls.code, 0, cls.stderr);
    assert.ok(cls.json.reasons.includes(`not a block session: EZ Bar Curl: 6 ${c ? "mini-sets" : "sets"}, above the slot's 4`), JSON.stringify(cls.json));
    // block draft (and block write takes the cluster slot fields)
    const bd = cli(["block", "draft", "--weeks", "2", "--input", writeJson(dir, "bd.json", withList(mode, { id: "B-002", start: "2026-10-19", exercises: { elbow_flexion: { name: "EZ Bar Curl" } } })), "--root", dir, "--out", join(dir, ".tmp/coach/b")]);
    assert.equal(bd.code, 0, bd.stderr);
    const bj = JSON.parse(readFileSync(join(dir, ".tmp/coach/b/block.json"), "utf8"));
    const slot = bj.days.flatMap((d: any) => d.slots).find((s: any) => s.pattern === "elbow_flexion");
    assert.equal(slot.style, c ? "cluster" : undefined);
    assert.equal(cli(["block", "write", "--input", join(dir, ".tmp/coach/b/block.json"), "--root", dir]).code, 0);
    assert.equal("clusters" in JSON.parse(readFileSync(join(dir, ".tmp/coach/b/week-1.json"), "utf8")), mode === "input", "the input's list travels with the week files");
  });
}

test("V5 B.2 weeks: the logged weeks count clusters from coach.yaml", (t) => {
  for (const mode of ["yaml", "none"] as const) {
    const dir = inst(t, mode);
    const p = writeJson(dir, "d.json", { days: [WEEK.days[0]] });
    assert.equal(cli(["plans", "write", "--input", p, "--root", dir]).code, 0);
    assert.equal(cli(["plans", "done", "--date", "2026-10-20", "--as-planned", "--root", dir]).code, 0);
    const wk = cli(["weeks", "--from", "2026-10-19", "--to", "2026-10-25", "--root", dir]);
    assert.equal(wk.json.logs[0].sets_by_muscle.biceps, mode === "yaml" ? 3 : 6);
  }
});

test("V5 B.2 setup: the week files block draft --out saves before coach.yaml exists carry the input's list, so volume, loads --fill and tally-days count the cluster", (t) => {
  const dir = inst(t, "bare");
  const input = { method: "nine-adaptations", days: 3, emphasis: "hypertrophy", units: "lbs", timezone: "America/Los_Angeles", logger: "none", id: "B-001", start: "2026-10-19", exercises: { elbow_flexion: { name: "EZ Bar Curl" }, vertical_pull: { name: "Pull-Up" } }, clusters: LIST };
  const r = cli(["block", "draft", "--weeks", "6", "--input", writeJson(dir, ".tmp/coach/draft.json", input), "--root", dir, "--out", join(dir, ".tmp/coach/b1")]);
  assert.equal(r.code, 0, r.stderr);
  const w1 = r.json.weeks[0].file;
  assert.deepEqual(JSON.parse(readFileSync(w1, "utf8")).clusters, LIST);
  const vol = cli(["volume", "--input", w1, "--root", dir]);
  assert.deepEqual(vol.json.sets_by_muscle, r.json.weeks[0].sets_by_muscle);
  assert.deepEqual(vol.json.clusters.map((x: any) => x.text), ["6 × 6 cluster, counts as 3 sets"]);
  const hf = writeJson(dir, "h.json", { units: "lbs", sessions: [{ date: "2026-10-13", exercises: [{ name: "EZ Bar Curl", sets: at(35, 6, 6, 6, 6, 6, 5) }] }] });
  const fill = cli(["loads", "--input", w1, "--fill", "--history", hf, "--root", dir]);
  assert.equal(fill.code, 0, fill.stderr);
  assert.equal(fill.json.suggestions.find((s: any) => s.exercise === "EZ Bar Curl").weight, 35);
  const td = cli(["tally-days", "--input", w1, "--root", dir]);
  assert.ok(td.json.days.some((d: any) => d.notes === "Cluster: EZ Bar Curl: 6 × 6 at 12RM, 10 s between mini-sets"), JSON.stringify(td.json.days.map((d: any) => d.notes)));
});

// ---------- B.1 config-check and the block slot fields ----------

test("V5 B.1: config-check validates clusters (whole numbers, rm above reps, since a date, one entry per exercise)", (t) => {
  const check = (list: unknown[]) => {
    const dir = inst(t, "yaml", list as ClusterEntry[]);
    return cli(["config-check", "--root", dir]);
  };
  const ok = check(LIST);
  assert.equal(ok.json.problems.some((p: string) => p.startsWith("clusters")), false, JSON.stringify(ok.json));
  const bad = check([
    { name: "EZ Bar Curl", mini_sets: 6, reps: 6, rm: 6 },
    { name: "Cable Curl", mini_sets: 2.5, reps: 6, rm: 12, since: "next week" },
    { name: "ez bar curl", mini_sets: 6, reps: 6, rm: 12 },
    { name: "Row", exerciseId: "x1", mini_sets: 4, reps: 5, rm: 10 },
    { name: "Row 2", exerciseId: "x1", mini_sets: 4, reps: 5, rm: 10 },
  ]);
  assert.equal(bad.code, 1);
  for (const want of ["clusters[0].rm: must be above reps (6)", "clusters[1].mini_sets: must be a whole number of 1 or more", "clusters[1].since: must be a date (YYYY-MM-DD)", "clusters[2]: a second entry for ez bar curl (first: clusters[0])", "clusters[4]: a second entry for exerciseId x1 (first: clusters[3])"]) {
    assert.ok(bad.json.problems.includes(want), `${want}\n${bad.json.problems.join("\n")}`);
  }
});

test("V5 B.5: block.ts accepts style, rm and rest_s on a slot, a legacy block without them, and a slot with 6 straight sets", () => {
  const base = { version: 1, id: "B-001", method: "nine-adaptations", template: { days: 3, emphasis: "hypertrophy" }, start: "2026-10-19", weeks: [{ week: 1, kind: "build", sessions: 3 }] };
  assert.doesNotThrow(() => validateBlock({ ...base, days: [{ day: "mon", focus: "A", slots: [{ pattern: "elbow_flexion", adaptation: "hypertrophy", sets: 6, reps: 6, rest_s: 10, exercise: "EZ Bar Curl", style: "cluster", rm: 12 }] }] }));
  assert.doesNotThrow(() => validateBlock({ ...base, days: [{ day: "mon", focus: "A", slots: [{ pattern: "squat", adaptation: "hypertrophy", sets: 6, reps: 8, rest_s: 120 }] }] }));
  assert.throws(() => validateBlock({ ...base, days: [{ day: "mon", focus: "A", slots: [{ pattern: "squat", adaptation: "hypertrophy", sets: 6, style: "giant", rm: 0 }] }] }), /style must be cluster or straight[\s\S]*rm must be a whole number/);
});
