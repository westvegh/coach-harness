// guard() (contracts §7), in check order. Each case would fail without the code that
// handles it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordOf, type Proposal } from "../../engine/approvals.ts";
import { loadLogger } from "../../engine/logger.ts";
import { mergeResponse } from "../../engine/snapshot.ts";
import { guard, type GuardInput } from "../../engine/validate.ts";
import type { LoggerExercise, Snapshot } from "../../engine/types.ts";
import { bench, block, emptyDay, guardInput, limits, NOW, row3, session, snapDay, snapshot, squat, TODAY as TODAY_, v } from "./fixtures.ts";

const D = "2026-10-15";
const V = v(`r-${D}`, "t0");
// Monday and Tuesday were read and are empty; Wednesday (today) is covered by the listing.
const day = (over: Record<string, unknown> = {}) => ({ "2026-10-12": emptyDay(), "2026-10-13": emptyDay(), [D]: snapDay(D, over) });
const upd = (operations: unknown[], extra: Record<string, unknown> = {}) => ({ date: D, expectedVersion: V, operations, ...extra });
const trim = upd([{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 2 } }]);
const run = (over: Partial<GuardInput> & { snapshot?: Snapshot | null }) =>
  guard(guardInput({ tool: "update_planned_workout", args: trim, snapshot: snapshot(day()), ...over }));
const has = (reasons: string[], re: RegExp) => assert.ok(reasons.some((r) => re.test(r)), `no reason matches ${re}:\n${reasons.join("\n")}`);

test("a small change (trim) is allowed, attended and unattended", () => {
  const a = run({});
  assert.equal(a.decision, "allow", a.reasons.join("; "));
  assert.deepEqual(a.kinds, ["trim_session"]);
  assert.equal(run({ mode: "unattended" }).decision, "allow");
});

// ---------- 1-2. inputs and snapshot ----------

test("missing inputs are a deny with code GUARD_ERROR", () => {
  const v1 = guard({ ...guardInput({ tool: "update_planned_workout", args: trim, snapshot: snapshot(day()) }), limits: undefined as never });
  assert.equal(v1.decision, "deny");
  assert.equal(v1.code, "GUARD_ERROR");
  assert.equal(run({ tool: "get_planned_workout" }).code, "GUARD_ERROR");
});

test("stale, foreign and missing snapshots are denied with 'refresh'", () => {
  for (const s of [null, snapshot(day(), { session_id: "other" }), snapshot(day(), { captured_at: "2026-10-14T06:40:00-07:00" })]) {
    const r = run({ snapshot: s });
    assert.equal(r.decision, "deny");
    has(r.reasons, /refresh: read the affected days with get_planned_workout first/);
  }
  // A date that was never read.
  const r = run({ args: { ...trim, date: "2026-10-16" } });
  has(r.reasons, /2026-10-16 was not read/);
});

// ---------- 3. versions ----------

test("a write to an existing day without expectedVersion is denied; expectedUpdatedAt alone is denied", () => {
  const { expectedVersion: _drop, ...noVersion } = trim;
  has(run({ args: noVersion }).reasons, /must carry expectedVersion/);
  const r = run({ args: { ...noVersion, expectedUpdatedAt: "t0" } as never });
  assert.equal(r.decision, "deny");
  has(r.reasons, /expectedUpdatedAt alone is denied/);
  // plan_workout_day over an existing day: the same rule.
  const p = run({ tool: "plan_workout_day", args: { date: D, dayType: "push", dayName: "Push", exercises: [bench], expectedUpdatedAt: "t0" } });
  has(p.reasons, /expectedUpdatedAt alone is denied/);
  // A version that is not the snapshot's.
  has(run({ args: { ...trim, expectedVersion: v(`r-${D}`, "t9") } }).reasons, /not the version in the snapshot/);
});

test("plan_workout_range: denied over an existing date; with T2 every day needs ifAbsent: true", () => {
  const s = snapshot({ ...day(), "2026-10-16": emptyDay() });
  const args = { days: [{ date: D, dayType: "push", dayName: "Push", exercises: [bench], ifAbsent: true }, { date: "2026-10-16", dayType: "legs", dayName: "Legs", exercises: [squat], ifAbsent: true }] };
  const r = run({ tool: "plan_workout_range", args, snapshot: s });
  assert.equal(r.decision, "deny");
  has(r.reasons, /over 2026-10-15, which already has a day/);
  const { ifAbsent: _absent, ...noFlag } = args.days[1];
  const bare = run({ tool: "plan_workout_range", args: { days: [noFlag] }, snapshot: s });
  assert.equal(bare.decision, "deny");
  has(bare.reasons, /must carry ifAbsent: true/);
  // Before T2 (an adapter without the capability), every range is denied.
  const logger = loadLogger("tally");
  const preT2 = { ...logger, config: { ...logger.config, capabilities: { ...logger.config.capabilities, rangeCreateIfAbsent: false } } };
  has(run({ tool: "plan_workout_range", args: { days: [args.days[1]] }, snapshot: s, logger: preT2 }).reasons, /denied until .*T2/);
});

test("skip and delete: with T2 they need expectedVersion; before T2 denied unattended, ask interactive", () => {
  const logger = loadLogger("tally");
  const preT2 = { ...logger, config: { ...logger.config, capabilities: { ...logger.config.capabilities, versionedSkipDelete: false } } };
  for (const tool of ["skip_planned_workout", "delete_planned_workout"]) {
    has(run({ tool, args: { date: D }, mode: "unattended" }).reasons, /must carry expectedVersion/);
    assert.equal(run({ tool, args: { date: D, expectedVersion: V }, mode: "unattended" }).decision, "allow");
    const u = run({ tool, args: { date: D }, mode: "unattended", logger: preT2 });
    assert.equal(u.decision, "deny");
    has(u.reasons, /no version until Tally T2/);
    assert.equal(run({ tool, args: { date: D }, logger: preT2 }).decision, "ask");
  }
});

// ---------- 5. safety ----------

test("hold and pending: a training write is denied; recovery is allowed; skip is not denied for the hold", () => {
  const hold = { active: true, set_at: NOW, reason: "knee pain", regions: ["left-knee"], set_by: "safety-agent" };
  const pending = { at: NOW, terms: ["pain"], source: "prompt" as const };
  for (const safety of [{ hold }, { pending }]) {
    const r = run({ ...safety, args: upd([{ op: "modify", target: { exerciseId: "Barbell_Squat" }, fields: { suggestedSets: 5 } }]) });
    assert.equal(r.decision, "deny");
    has(r.reasons, /must be a recovery or rest day/);
    // Recovery: replace the whole day with Zone 2 and mobility.
    const z2 = { exerciseId: "zone2_bike", name: "Zone 2 Bike", suggestedSets: 1, suggestedDuration: 2400 };
    const mob = { exerciseId: "mobility_flow", name: "Mobility Flow", suggestedSets: 1, suggestedDuration: 600 };
    const rec = run({
      ...safety,
      args: upd([
        { op: "replace", target: { exerciseId: "Barbell_Bench_Press" }, exercise: z2 },
        { op: "replace", target: { exerciseId: "Barbell_Squat" }, exercise: mob },
        { op: "remove", target: { exerciseId: "Cable_Row" } },
      ]),
    });
    assert.equal(rec.decision, "allow", rec.reasons.join("; "));
    // Annotating is allowed under a hold.
    assert.equal(run({ ...safety, args: { date: D, expectedVersion: V, dayName: "Push (held)", operations: [{ op: "modify", target: { exerciseId: "Cable_Row" }, fields: { suggestedSets: 3 } }] } }).decision, "allow");
    // Skip: safer, so allowed under a hold or pending file.
    const sk = run({ ...safety, tool: "skip_planned_workout", args: { date: D } });
    assert.equal(sk.decision, "allow");
  }
});

test("check-in pain at or above the threshold denies exercises that load the region (side regions match the parent)", () => {
  const r = run({ pain: [{ region: "left-knee", score: 4 }] });
  assert.equal(r.decision, "deny");
  has(r.reasons, /pain today in left-knee \(4\/10\): Squat/);
  assert.equal(run({ pain: [{ region: "left-knee", score: 3 }] }).decision, "allow");
  assert.equal(run({ pain: [{ region: "left-shoulder", score: 3 }] }).decision, "allow");
  has(run({ pain: [{ region: "left-shoulder", score: 6 }] }).reasons, /Bench Press .* loads it/);
  // A custom pain threshold.
  assert.equal(run({ pain: [{ region: "knee", score: 3 }], limits: limits([], 3) }).decision, "deny");
});

// ---------- 6. limits ----------

const L = (over: Record<string, unknown>) => ({ id: "L-001", region: "left-knee", rule: "ban", patterns: [], exercises: [], allow: [], source: "athlete", since: "2026-10-01", ...over });

test("ban by pattern, by name; allow exceptions beat patterns", () => {
  const byPattern = run({ limits: limits([L({ patterns: ["loaded_deep_knee_flexion"], note: "No deep squats under load" })]) });
  assert.equal(byPattern.decision, "deny");
  has(byPattern.reasons, /Squat .* banned by L-001 \(left-knee: No deep squats under load\)/);
  const byName = run({ limits: limits([L({ region: "shoulder", exercises: ["barbell bench press"] })]) });
  has(byName.reasons, /Bench Press .* banned by L-001/);
  // allow binds to the exerciseId; the name alone would be an identity conflict here.
  const allowed = run({ limits: limits([L({ patterns: ["loaded_deep_knee_flexion"], allow: ["Barbell_Squat"] })]) });
  assert.equal(allowed.decision, "allow", allowed.reasons.join("; "));
  // A name ban beats an allow entry.
  assert.equal(run({ limits: limits([L({ exercises: ["Squat"], allow: ["Squat"] })]) }).decision, "deny");
});

test("caps: max_load per set after unit conversion (lbs and kg)", () => {
  const rdl = (w: number) => ({ exerciseId: "Romanian_Deadlift", name: "Romanian Deadlift", suggestedSets: 3, suggestedReps: 8, suggestedWeight: w });
  const capLbs = limits([L({ id: "L-002", region: "low-back", rule: "cap", patterns: ["hinge"], max_load: { value: 135, unit: "lbs" } })]);
  // A kg day: 70 kg = 154 lbs (over); 60 kg = 132 lbs (under).
  const kgDay = (w: number) => snapshot({ [D]: snapDay(D, { exercises: [rdl(w)], weightUnit: "kg", weightUnitSource: "settings" }) });
  const t = upd([{ op: "modify", target: { exerciseId: "Romanian_Deadlift" }, fields: { suggestedSets: 2 } }]);
  const over = run({ limits: capLbs, snapshot: kgDay(70), args: t });
  assert.equal(over.decision, "deny");
  has(over.reasons, /154\.3 lbs is over the L-002 cap of 135 lbs/);
  assert.equal(run({ limits: capLbs, snapshot: kgDay(60), args: t }).decision, "allow");
  // A kg cap on an lbs day: 60 kg = 132.3 lbs; 135 lbs is over, 130 lbs is under.
  const capKg = limits([L({ id: "L-002", region: "low-back", rule: "cap", patterns: ["hinge"], max_load: { value: 60, unit: "kg" } })]);
  const lbsDay = (w: number) => snapshot({ [D]: snapDay(D, { exercises: [rdl(w)] }) });
  assert.equal(run({ limits: capKg, snapshot: lbsDay(135), args: t }).decision, "deny");
  assert.equal(run({ limits: capKg, snapshot: lbsDay(130), args: t }).decision, "allow");
});

test("caps: max_sets_per_week on the rebuilt week (only when the call raises it)", () => {
  const rdl = { exerciseId: "Romanian_Deadlift", name: "Romanian Deadlift", suggestedSets: 4, suggestedReps: 8, suggestedWeight: 95 };
  const cap = limits([L({ id: "L-002", region: "low-back", rule: "cap", patterns: ["hinge"], max_sets_per_week: 6 })]);
  const s = snapshot({ ...day(), [D]: snapDay(D, { exercises: [rdl] }), "2026-10-17": snapDay("2026-10-17", { exercises: [{ ...rdl, suggestedSets: 2 }], version: v("r-17", "t0") }) }, { planned: { captured_at: NOW, from: "2026-10-14", dates: { "2026-10-15": { dayName: "", source: "mcp", userModified: false, skipped: false, exerciseCount: 1 }, "2026-10-17": { dayName: "", source: "mcp", userModified: false, skipped: false, exerciseCount: 1 } } } });
  const up = run({ limits: cap, snapshot: s, args: upd([{ op: "modify", target: { exerciseId: "Romanian_Deadlift" }, fields: { suggestedSets: 5 } }]) });
  assert.equal(up.decision, "deny");
  has(up.reasons, /7 sets in the week of 2026-10-12 for L-002 .* cap is 6/);
  // Already over and trimmed: allowed.
  const over = snapshot({ [D]: snapDay(D, { exercises: [{ ...rdl, suggestedSets: 6 }] }), "2026-10-17": s.days["2026-10-17"] });
  assert.equal(run({ limits: cap, snapshot: over, args: upd([{ op: "modify", target: { exerciseId: "Romanian_Deadlift" }, fields: { suggestedSets: 5 } }]) }).decision, "allow");
});

test("an unclassified exercise is denied while any limit is active", () => {
  const odd = { exerciseId: "foo_bar_thing", name: "Foo Bar Thing", suggestedSets: 3, suggestedReps: 8 };
  const s = snapshot(day({ exercises: [bench, odd] }));
  const r = run({ snapshot: s, limits: limits([L({ patterns: ["loaded_deep_knee_flexion"] })]) });
  assert.equal(r.decision, "deny");
  has(r.reasons, /Foo Bar Thing .* unclassified while limits are active; classify it first/);
  assert.equal(run({ snapshot: s }).decision, "allow", "no limit: the unclassified exercise is not a limit deny");
});

// ---------- 7. hard rules ----------

const pressDays = (sets: number[]) => {
  // Monday and Tuesday were read and are empty; Wednesday (today) is covered by the listing.
  const days: Record<string, ReturnType<typeof snapDay>> = { "2026-10-12": emptyDay(), "2026-10-13": emptyDay() };
  ["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"].forEach((d, k) => {
    days[d] = snapDay(d, { version: v(`r-${d}`, "t0"), exercises: [{ exerciseId: "Barbell_Bench_Press", name: "Bench Press", suggestedSets: sets[k], suggestedReps: 8, suggestedWeight: 135 }] });
  });
  return days;
};
const planned = (dates: string[]) => ({ captured_at: NOW, from: "2026-10-14", dates: Object.fromEntries(dates.map((d) => [d, { dayName: "Push", source: "mcp", userModified: false, skipped: false, exerciseCount: 1 }])) });
const bigBlock = block({ weeks: block().weeks.map((w) => ({ ...w, targets: { chest: 80, triceps: 80 } })) });

test("volume: the real case, +8 sets on a reference of 64 (+12.5%), is denied; +6 is not", () => {
  // Reference: block week 5 (2026-10-05), 2 logged sessions of 32 sets: chest 64, triceps 64.
  const history = [session("2026-10-06", [{ name: "Bench Press", sets: 32, weight: 135 }]), session("2026-10-08", [{ name: "Bench Press", sets: 32, weight: 135 }])];
  const s = snapshot(pressDays([16, 16, 16, 16]), { history, planned: planned(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]) });
  const raise = (n: number) => upd([{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: n } }]);
  const r = run({ snapshot: s, block: bigBlock, args: raise(24) });
  assert.equal(r.decision, "deny");
  has(r.reasons, /chest: 72 sets in the week of 2026-10-12 against 64 in the reference week 2026-10-05 \(\+12\.5%\); the most allowed is 70 \[NA-PROG-001\]/);
  assert.deepEqual(r.rule_ids, ["NA-PROG-001"]);
  const ok = run({ snapshot: s, block: bigBlock, args: raise(22) });
  assert.notEqual(ok.decision, "deny", ok.reasons.join("; "));
});

test("volume: a rising week needs every planned day read, the training context and the history", () => {
  const history = [session("2026-10-06", [{ name: "Bench Press", sets: 32 }]), session("2026-10-08", [{ name: "Bench Press", sets: 32 }])];
  const days = pressDays([16, 16, 16, 16]);
  delete days["2026-10-18"];
  const raise = upd([{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 18 } }]);
  const unread = run({ snapshot: snapshot(days, { history, planned: planned(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]) }), block: bigBlock, args: raise });
  has(unread.reasons, /read 2026-10-18 with get_planned_workout first/);
  const noCtx = run({ snapshot: snapshot(pressDays([16, 16, 16, 16]), { history, planned: undefined }), block: bigBlock, args: raise });
  has(noCtx.reasons, /fresh evidence for every day of the week of 2026-10-12: read 2026-10-14/);
  const noHist = run({ snapshot: snapshot(pressDays([16, 16, 16, 16]), { history: [], history_coverage: undefined, planned: planned([]) }), block: bigBlock, args: raise });
  has(noHist.reasons, /read get_workout_history first/);
  const noBlock = run({ snapshot: snapshot(pressDays([16, 16, 16, 16]), { history, planned: planned([]) }), block: null, args: raise });
  has(noBlock.reasons, /no reference week \(no block\)/);
});

test("volume: the deload-to-build transition may return to the pre-deload level", () => {
  // Week 4 (2026-09-28) build: 60 chest. Week 5 (2026-10-05) deload: 42. Week 6 (this week) build.
  const deloadBlock = block({ weeks: bigBlock.weeks.map((w) => (w.week === 5 ? { ...w, kind: "deload" } : w)) });
  const history = [
    session("2026-09-29", [{ name: "Bench Press", sets: 30 }]),
    session("2026-10-01", [{ name: "Bench Press", sets: 30 }]),
    session("2026-10-06", [{ name: "Bench Press", sets: 21 }]),
    session("2026-10-08", [{ name: "Bench Press", sets: 21 }]),
  ];
  const s = snapshot(pressDays([15, 15, 15, 15]), { history, planned: planned([]) });
  const raise = (n: number) => upd([{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: n } }]);
  // 66 = 60 + 10%: allowed against the pre-deload week (it would be +57% over the deload week).
  assert.notEqual(run({ snapshot: s, block: deloadBlock, args: raise(21) }).decision, "deny");
  const over = run({ snapshot: s, block: deloadBlock, args: raise(23) });
  assert.equal(over.decision, "deny");
  has(over.reasons, /68 sets .* against 60 in the reference week 2026-09-28/);
});

test("top-set jump: against the last logged top set of the exercise", () => {
  const s = snapshot(day(), { history: [session("2026-10-12", [{ name: "Squat", exerciseId: "Barbell_Squat", sets: 4, weight: 225, reps: 5 }])] });
  const to = (w: number) => upd([{ op: "modify", target: { exerciseId: "Barbell_Squat" }, fields: { suggestedWeight: w } }]);
  const r = run({ snapshot: s, args: to(250) });
  assert.equal(r.decision, "deny");
  has(r.reasons, /Squat .* top set 250 lbs against the last logged 225 lbs \(\+11\.1%\); the most allowed is \+10% \[NA-PROG-003\]/);
  const ok = run({ snapshot: s, args: to(245) });
  assert.equal(ok.decision, "allow", ok.reasons.join("; "));
  assert.deepEqual(ok.kinds, ["load_progression"]);
});

// ---------- 8. consent ----------

test("overrideUserModified and a change to a user day: ask interactive, deny unattended, always", () => {
  const o = run({ args: { ...trim, overrideUserModified: true } });
  assert.equal(o.decision, "ask");
  assert.equal(run({ args: { ...trim, overrideUserModified: true }, mode: "unattended" }).decision, "deny");
  const user = snapshot(day({ userModified: true }));
  assert.equal(run({ snapshot: user }).decision, "ask");
  const u = run({ snapshot: user, mode: "unattended" });
  assert.equal(u.decision, "deny");
  has(u.reasons, /never allowed in an unattended run/);
  // An approval record cannot open it.
  const p = recordOf(proposalFor("update_planned_workout", trim), "x");
  assert.equal(run({ snapshot: user, mode: "unattended", approvals: [p], limits_hash: LH }).decision, "deny");
});

const LH = "a".repeat(64);
function proposalFor(tool: string, input: unknown): Proposal {
  return { id: "P-20261014-new_exercise-1", kind: "new_exercise", created_at: NOW, status: "approved", base: { [D]: V }, limits_hash: LH, writes: [{ tool, input }], summary: "s", rule_ids: [] };
}

test("big changes: ask interactive; unattended needs a matching approval record", () => {
  const press: LoggerExercise = { exerciseId: "Overhead_Press", name: "Overhead Press", suggestedSets: 3, suggestedReps: 5, suggestedWeight: 95 };
  const args = upd([{ op: "replace", target: { exerciseId: "Cable_Row" }, exercise: press }]);
  // The block plans shoulder work, so the volume cap passes and consent decides.
  const shoulders = block({ weeks: block().weeks.map((w) => ({ ...w, targets: { ...w.targets, shoulders: 10 } })) });
  const run = (over: Partial<GuardInput>) => guard(guardInput({ tool: "update_planned_workout", args: trim, snapshot: snapshot(day()), block: shoulders, ...over }));
  const i = run({ args });
  assert.equal(i.decision, "ask");
  assert.ok(i.kinds!.includes("new_exercise"));
  const none = run({ args, mode: "unattended", limits_hash: LH });
  assert.equal(none.decision, "deny");
  has(none.reasons, /needs an approved proposal/);
  const rec = recordOf(proposalFor("update_planned_workout", args), "athlete/proposals/x.yaml");
  const yes = run({ args, mode: "unattended", approvals: [rec], limits_hash: LH });
  assert.equal(yes.decision, "allow", yes.reasons.join("; "));
  assert.equal(yes.approval, "P-20261014-new_exercise-1");
  // The same record with another limits hash, or for another call, does not match.
  assert.equal(run({ args, mode: "unattended", approvals: [rec], limits_hash: "b".repeat(64) }).decision, "deny");
  const other = recordOf(proposalFor("update_planned_workout", { ...args, dayName: "x" }), "x");
  assert.equal(run({ args, mode: "unattended", approvals: [other], limits_hash: LH }).decision, "deny");
});

test("update_user_profile: ask interactive, deny unattended, deny clearing limits or dropping a limits.yaml region", () => {
  const lim = limits([L({ patterns: ["loaded_deep_knee_flexion"] })]);
  const s = snapshot({}, { profile: { limits: "Left knee: no deep squats." } });
  const p = (args: Record<string, unknown>, mode: "interactive" | "unattended" = "interactive") => run({ tool: "update_user_profile", args, snapshot: s, limits: lim, mode });
  assert.equal(p({ goals: "run a 10k" }).decision, "ask");
  assert.equal(p({ goals: "run a 10k" }, "unattended").decision, "deny");
  has(p({ limits: null }).reasons, /may not clear limits/);
  has(p({ injuries: null }).reasons, /may not clear injuries/);
  const drop = p({ limits: "Right shoulder is sore." });
  assert.equal(drop.decision, "deny");
  has(drop.reasons, /drops the region left-knee/);
  assert.equal(p({ limits: "Left knee: no deep squats. Right shoulder sore." }).decision, "ask");
  assert.equal(p({ limits: "left-knee and right shoulder" }).decision, "ask");
});

// ---------- 9. soft rules ----------

test("soft rules give warnings only: session_minutes_max and weekly_sets_per_muscle_range", () => {
  const long = snapshot(day({ exercises: [{ ...bench, suggestedSets: 10 }, { ...squat, suggestedSets: 10 }, { ...row3, suggestedSets: 6 }] }));
  const r = run({ snapshot: long, args: upd([{ op: "modify", target: { exerciseId: "Cable_Row" }, fields: { suggestedSets: 5 } }]) });
  assert.equal(r.decision, "allow");
  has(r.warnings, /about 75 minutes, over 60 \[NA-/);
  has(r.warnings, /upper-back: 5 sets in the week of 2026-10-12, outside 10-20 \[NA-HYP-001\]/);
});

test("volume: a day written earlier in the session must be read again before a write that raises the week", async () => {
  const { mergeResponse } = await import("../../engine/snapshot.ts");
  const history = [session("2026-10-06", [{ name: "Bench Press", sets: 32 }]), session("2026-10-08", [{ name: "Bench Press", sets: 32 }])];
  let s = snapshot(pressDays([16, 16, 16, 16]), { history, planned: planned(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]) });
  // A new day on Monday is written; its result carries no version, so the snapshot forgets it.
  s = mergeResponse(s, { tool: "plan_workout_day", input: { date: "2026-10-12" }, response: [{ type: "text", text: JSON.stringify({ results: [{ date: "2026-10-12", status: "written" }], skippedDates: [], warnings: [], batchId: "b" }) }], session_id: s.session_id, now: NOW, timezone: "America/Los_Angeles" });
  const r = run({ snapshot: s, block: bigBlock, args: upd([{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 17 } }]) });
  assert.equal(r.decision, "deny");
  has(r.reasons, /read 2026-10-12 with get_planned_workout first/);
});

test("top-set jump: a raised top set needs the history read first", () => {
  const s = snapshot(day(), { history: [], history_coverage: undefined });
  const r = run({ snapshot: s, args: upd([{ op: "modify", target: { exerciseId: "Barbell_Squat" }, fields: { suggestedWeight: 235 } }]) });
  assert.equal(r.decision, "deny");
  has(r.reasons, /read get_workout_history first/);
  // A trim needs no history.
  assert.equal(run({ snapshot: s }).decision, "allow");
});

// ---------- block_session still passes every guard check ----------

test("block_session: allowed unattended, and still denied when it breaks a limit or the 10% cap", () => {
  const E = "2026-10-16";
  const args = { date: E, dayType: "push", dayName: "Push", exercises: [bench, squat, row3] };
  const s = snapshot({ ...day(), [E]: emptyDay() }, { history: [], planned: planned([D]) });
  // Targets high enough for the cap: block week 1 bootstrap (no completed build week).
  const roomy = block({ weeks: block().weeks.map((w) => ({ ...w, targets: { chest: 20, triceps: 20, quads: 20, glutes: 20, "upper-back": 20, lats: 20, hamstrings: 20, "low-back": 20 } })) });
  const ok = run({ tool: "plan_workout_day", args, snapshot: s, block: roomy, mode: "unattended" });
  assert.equal(ok.decision, "allow", ok.reasons.join("; "));
  assert.deepEqual(ok.kinds, ["block_session"]);
  const ban = run({ tool: "plan_workout_day", args, snapshot: s, block: roomy, mode: "unattended", limits: limits([L({ patterns: ["loaded_deep_knee_flexion"] })]) });
  assert.equal(ban.decision, "deny");
  has(ban.reasons, /Squat .* banned by L-001/);
  // The fixture block's week-1 targets (chest 6 → at most 7): 6 chest sets on the 15th plus a 3-set template day = 9.
  const heavy = { date: E, dayType: "push", dayName: "Push", exercises: [{ ...bench, suggestedSets: 3 }] };
  const tight = snapshot({ ...day({ exercises: [{ ...bench, suggestedSets: 6 }] }), [E]: emptyDay() }, { history: [], planned: planned([D]) });
  const cap = run({ tool: "plan_workout_day", args: heavy, snapshot: tight, mode: "unattended" });
  assert.equal(cap.decision, "deny");
  has(cap.reasons, /chest: 9 sets .* against 6 in block week 1 as planned .* \[NA-PROG-001\]/);
});

// ---------- guard hardening (contracts §20 items 16-26) ----------

test("an allow entry matched only by the display name does not exempt a banned exerciseId", () => {
  // The reviewer's input: deep knee flexion banned, allow ["Box Squat"]; Barbell_Squat renamed "Box Squat", 4 → 3 sets.
  const lim = limits([L({ patterns: ["loaded_deep_knee_flexion"], allow: ["Box Squat"] })]);
  const renamed = { ...squat, name: "Box Squat", suggestedSets: 3 };
  const r = run({ limits: lim, args: upd([{ op: "replace", target: { exerciseId: "Barbell_Squat" }, exercise: renamed }]) });
  assert.equal(r.decision, "deny");
  has(r.reasons, /identity conflict/);
  // A real box squat (its own exerciseId) is still exempt.
  const box = { exerciseId: "Box_Squat", name: "Box Squat", suggestedSets: 3, suggestedReps: 5, suggestedWeight: 185 };
  const s = snapshot(day({ exercises: [bench, box, row3] }));
  assert.equal(run({ limits: lim, snapshot: s }).decision, "allow");
  // allow binds to the exerciseId first.
  assert.equal(run({ limits: limits([L({ patterns: ["loaded_deep_knee_flexion"], allow: ["Barbell_Squat"] })]) }).decision, "allow");
});

test("a block with NaN targets is GUARD_ERROR, also behind an approval", async () => {
  // The reviewer's input: bootstrap targets {chest: .nan, triceps: .nan}; an approved 3 → 20 set raise.
  const nanBlock = block({ weeks: block().weeks.map((w) => ({ ...w, targets: { chest: Number.NaN, triceps: Number.NaN } })) });
  const args = upd([{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 20 } }]);
  const rec = recordOf(proposalFor("update_planned_workout", args), "x");
  const s = snapshot(day(), { planned: planned([D]) });
  const r = run({ snapshot: s, block: nanBlock, args, mode: "unattended", approvals: [rec], limits_hash: LH });
  assert.equal(r.decision, "deny");
  assert.equal(r.code, "GUARD_ERROR");
  has(r.reasons, /BLOCK_INVALID/);
  // The file loader rejects YAML .nan, negative and fractional targets.
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readBlock } = await import("../../engine/guard-context.ts");
  for (const t of [".nan", "-2", "2.5", ".inf"]) {
    const root = mkdtempSync(join(tmpdir(), "coach-block-"));
    mkdirSync(join(root, "athlete"));
    writeFileSync(join(root, "athlete/block.yaml"), `version: 1\nid: B-001\nmethod: nine-adaptations\ntemplate: { days: 4, emphasis: all-around }\nstart: 2026-09-07\nweeks:\n  - { week: 1, kind: build, sessions: 2, targets: { chest: ${t} } }\ndays: []\n`);
    assert.throws(() => readBlock(root), /BLOCK_INVALID|targets/, t);
  }
});

test("under a hold or pending file, a skip is allowed for any day (user days too), unattended included", () => {
  const hold = { active: true, set_at: NOW, reason: "knee pain", regions: ["left-knee"], set_by: "safety-agent" };
  const pending = { at: NOW, terms: ["pain"], source: "prompt" as const };
  for (const safety of [{ hold }, { pending }]) {
    for (const mode of ["unattended", "interactive"] as const) {
      for (const s of [snapshot(day()), snapshot(day({ userModified: true })), snapshot(day({ source: "builder" }))]) {
        const r = run({ ...safety, mode, snapshot: s, tool: "skip_planned_workout", args: { date: D } });
        assert.equal(r.decision, "allow", `${mode}: ${r.reasons.join("; ")}`);
      }
    }
    // Restoring a skipped day is not safer.
    const restore = run({ ...safety, mode: "unattended", snapshot: snapshot(day({ skipped: true })), tool: "skip_planned_workout", args: { date: D, skip: false } });
    assert.equal(restore.decision, "deny");
  }
  // Outside a hold, skipping a user day unattended stays denied.
  assert.equal(run({ mode: "unattended", snapshot: snapshot(day({ userModified: true })), tool: "skip_planned_workout", args: { date: D } }).decision, "deny");
});

test("a trim (3 → 2 sets) is allowed under a hold; a raise is not", () => {
  const hold = { active: true, set_at: NOW, reason: "knee pain", regions: ["left-knee"], set_by: "safety-agent" };
  for (const mode of ["unattended", "interactive"] as const) {
    const r = run({ hold, mode });
    assert.equal(r.decision, "allow", `${mode}: ${r.reasons.join("; ")}`);
  }
  // A lower load with more reps is not a trim.
  const more = run({ hold, args: upd([{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedWeight: 125, suggestedReps: 12 } }]) });
  assert.equal(more.decision, "deny");
  // Hard limits still apply to a trim under a hold.
  const banned = run({ hold, limits: limits([L({ patterns: ["loaded_deep_knee_flexion"] })]) });
  assert.equal(banned.decision, "deny");
  has(banned.reasons, /banned by L-001/);
});

const merged = (s: Snapshot, tool: string, input: unknown, result: unknown, now = NOW) =>
  mergeResponse(s, { tool, input, response: [{ type: "text", text: JSON.stringify(result) }], session_id: s.session_id, now, timezone: "America/Los_Angeles" });
const benchTo = (w: number) => upd([{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedWeight: w } }]);
const benchHistory = { count: 1, sessions: [{ date: "2026-10-12", name: "Push", weightUnit: "lbs", exercises: [{ name: "Bench Press", muscle: "Chest", trackingType: "weight_reps", sets: [{ weight: 135, reps: 8 }] }] }] };

test("an error history response is not an empty history; the top-set raise is denied", () => {
  // The reviewer's input: {"error":"unavailable"} as the history read, then bench 135 → 140.
  const s = merged(snapshot(day(), { history: [], history_coverage: undefined }), "get_workout_history", {}, { error: "unavailable" });
  const r = run({ snapshot: s, args: benchTo(140) });
  assert.equal(r.decision, "deny");
  has(r.reasons, /read get_workout_history/);
  // An error after a good read invalidates that evidence too.
  const good = merged(snapshot(day(), { history: [], history_coverage: undefined }), "get_workout_history", {}, benchHistory);
  assert.equal(run({ snapshot: good, args: benchTo(140) }).decision, "allow");
  assert.equal(run({ snapshot: merged(good, "get_workout_history", {}, { error: "unavailable" }), args: benchTo(140) }).decision, "deny");
});

test("a planned-day error is not an empty date", () => {
  const s = merged(snapshot({}), "get_planned_workout", { date: D }, { error: "timeout" });
  assert.equal(s.days[D], undefined);
  const plan = run({ snapshot: s, tool: "plan_workout_day", args: { date: D, dayType: "push", dayName: "Push", exercises: [bench] } });
  has(plan.reasons, /2026-10-15 was not read/);
  // A result without the required fields is malformed too.
  assert.equal(merged(snapshot({}), "get_planned_workout", { date: D }, { date: D, found: true }).days[D], undefined);
});

test("a partial history (more pages, or a short since) is not evidence for a top-set check", () => {
  const base = snapshot(day(), { history: [], history_coverage: undefined });
  const page1 = merged(base, "get_workout_history", {}, { ...benchHistory, nextCursor: "MjA=" });
  has(run({ snapshot: page1, args: benchTo(140) }).reasons, /history .*partial|read get_workout_history/);
  const page2 = merged(page1, "get_workout_history", { cursor: "MjA=" }, { count: 0, sessions: [] });
  assert.equal(run({ snapshot: page2, args: benchTo(140) }).decision, "allow");
  const recent = merged(base, "get_workout_history", { since: "2026-10-10" }, benchHistory);
  has(run({ snapshot: recent, args: benchTo(140) }).reasons, /history .*partial|read get_workout_history/);
});

test("a stale supporting day cannot back a weekly check, even with an approval", () => {
  // The reviewer's input: today's day rises 3 → 4 sets; Friday was read 30 minutes ago (1 set; Tally now holds 8).
  const stale = "2026-10-14T06:30:00-07:00";
  const days: Record<string, ReturnType<typeof snapDay>> = {
    "2026-10-12": emptyDay(),
    "2026-10-13": emptyDay(),
    "2026-10-14": emptyDay(),
    [D]: snapDay(D),
    "2026-10-16": snapDay("2026-10-16", { version: v("r-16", "t0"), exercises: [{ ...bench, suggestedSets: 1 }] }, stale),
    "2026-10-17": emptyDay(),
    "2026-10-18": emptyDay(),
  };
  const cap = limits([L({ id: "L-002", region: "shoulder", rule: "cap", patterns: ["horizontal_push"], max_sets_per_week: 10 })]);
  const args = upd([{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 4 } }]);
  const rec = recordOf(proposalFor("update_planned_workout", args), "x");
  const s = snapshot(days, { planned: { captured_at: stale, from: TODAY_, dates: {} } });
  const r = run({ snapshot: s, args, limits: cap, mode: "unattended", approvals: [rec], limits_hash: LH, block: bigBlock });
  assert.equal(r.decision, "deny");
  has(r.reasons, /fresh evidence for every day of the week of 2026-10-12: read 2026-10-16/);
  // Fresh, it passes the cap (5 ≤ 10) and the approval applies.
  const fresh = snapshot({ ...days, "2026-10-16": snapDay("2026-10-16", { version: v("r-16", "t0"), exercises: [{ ...bench, suggestedSets: 1 }] }) }, { planned: { captured_at: NOW, from: TODAY_, dates: {} } });
  assert.equal(run({ snapshot: fresh, args, limits: cap, mode: "unattended", approvals: [rec], limits_hash: LH, block: bigBlock }).decision, "allow");
});

test("earlier weekdays need a read (the listing covers only today on); the history must be fresh", () => {
  const history = [session("2026-10-06", [{ name: "Bench Press", sets: 32 }]), session("2026-10-08", [{ name: "Bench Press", sets: 32 }])];
  const days = pressDays([16, 16, 16, 16]);
  delete days["2026-10-13"];
  const raise = upd([{ op: "modify", target: { exerciseId: "Barbell_Bench_Press" }, fields: { suggestedSets: 17 } }]);
  const listing = planned(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
  has(run({ snapshot: snapshot(days, { history, planned: listing }), block: bigBlock, args: raise }).reasons, /read 2026-10-13 with get_planned_workout/);
  const oldHistory = snapshot(pressDays([16, 16, 16, 16]), { history, planned: listing, history_coverage: { captured_at: "2026-10-14T06:30:00-07:00", complete: true } });
  has(run({ snapshot: oldHistory, block: bigBlock, args: raise }).reasons, /history read is 30 minutes old/);
});

test("a recovery swap whose Tally muscle is 'cardio' adds no muscle volume and is not volume_above_plan", () => {
  const z2 = { exerciseId: "zone2_bike", name: "Zone 2 Bike", muscle: "cardio", suggestedSets: 1, suggestedDuration: 2400 };
  const mob = { exerciseId: "mobility_flow", name: "Mobility Flow", muscle: "Mobility", suggestedSets: 1, suggestedDuration: 600 };
  const rec = run({
    mode: "unattended",
    args: upd([
      { op: "replace", target: { exerciseId: "Barbell_Bench_Press" }, exercise: z2 },
      { op: "replace", target: { exerciseId: "Barbell_Squat" }, exercise: mob },
      { op: "remove", target: { exerciseId: "Cable_Row" } },
    ]),
  });
  assert.equal(rec.decision, "allow", rec.reasons.join("; "));
  assert.deepEqual(rec.kinds, ["swap_to_recovery"]);
  assert.ok(!rec.reasons.some((r) => /cardio|mobility/.test(r)), rec.reasons.join("; "));
});
