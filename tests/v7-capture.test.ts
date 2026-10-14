// V7 phase 1: parallel Tally reads are safe (the snapshot lock), the history window contract,
// and coverage in the note scan and in `loads` (contracts §9a). Made-up fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { historyCoverage, planWindows } from "../engine/history-windows.ts";
import { withSnapshotLock } from "../engine/snapshot-lock.ts";
import { mergeResponse } from "../engine/snapshot.ts";
import type { Snapshot } from "../engine/types.ts";
import { cli, instance, REPO, writeJson } from "./e3/helpers.ts";

const NOW = "2026-10-14T15:00:00.000Z"; // 08:00 in Los Angeles: today is 2026-10-14
const NOW_MS = Date.parse(NOW);
const SESSION = "s-v7";
const LIVE = "mcp__claude_ai_Tally_Workout__";
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR", "COACH_NOW", "CLAUDE_CODE_SESSION_ID"].includes(k)));

const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];
const page = (sessions: unknown[], nextCursor?: string) => text({ count: sessions.length, sessions, ...(nextCursor ? { nextCursor } : {}) });
const sess = (date: string, id: string, notes?: string) => ({ id, date, name: `S ${id}`, weightUnit: "lbs", ...(notes ? { notes } : {}), exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", sets: [{ weight: 185, reps: 5 }] }] });
const day = (date: string) => text({ date, found: true, version: `v-${date}`, updatedAt: "t0", source: "mcp", userModified: false, skipped: false, exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", suggestedSets: 3, suggestedReps: 5, suggestedWeight: 185 }], weightUnit: "lbs", weightUnitSource: "settings" });

function merge(prev: Snapshot | null, input: Record<string, unknown>, response: unknown, now = NOW, tool = "get_workout_history"): Snapshot {
  return mergeResponse(prev, { tool, input, response, session_id: SESSION, now, timezone: "America/Los_Angeles", server: "claude_ai_Tally_Workout" });
}

const W = planWindows("2026-08-19", "2026-10-14", 14);

test("the read plan tiles 8 weeks into 2-week windows, newest first; a short remainder joins the oldest", () => {
  assert.deepEqual(
    W.map((w) => [w.since, w.until, w.limit]),
    [
      ["2026-10-01", "2026-10-14", 10],
      ["2026-09-17", "2026-09-30", 10],
      ["2026-09-03", "2026-09-16", 10],
      ["2026-08-19", "2026-09-02", 10],
    ],
  );
  assert.equal(planWindows("2026-10-01", "2026-10-14", 10).length, 1, "14 days with 10-day windows: the 4-day remainder joins");
});

test("complete tiling: four first pages cover 8 weeks; history_coverage spans them all", () => {
  let snap: Snapshot | null = null;
  W.forEach((w, i) => (snap = merge(snap, w, page([sess(w.until, `w${i}`)]))));
  const cov = historyCoverage(snap, "2026-08-19", "2026-10-14", NOW_MS, { session_id: SESSION });
  assert.equal(cov.status, "complete");
  assert.deepEqual(snap!.history_coverage, { captured_at: NOW, complete: true, since: "2026-08-19", until: "2026-10-14" });
  assert.equal(snap!.history.length, 4);
});

test("every completion order of parallel pages gives the same history and coverage", () => {
  const reads: [Record<string, unknown>, unknown][] = [
    [W[0], page([sess("2026-10-13", "a1")], "cA")],
    [{ ...W[0], cursor: "cA" }, page([sess("2026-10-02", "a2")])],
    [W[1], page([sess("2026-09-20", "b1"), sess("2026-09-30", "b2")])],
    [W[2], page([])],
    [W[3], page([sess("2026-08-25", "d1", "felt fine")])],
  ];
  // A continuation page can only arrive after the page that returned its cursor.
  const perms = (xs: number[]): number[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  const results = new Set<string>();
  for (const order of perms([0, 1, 2, 3, 4]).filter((p) => p.indexOf(0) < p.indexOf(1))) {
    let snap: Snapshot | null = null;
    for (const i of order) snap = merge(snap, reads[i][0], reads[i][1]);
    const cov = historyCoverage(snap, "2026-08-19", "2026-10-14", NOW_MS);
    results.add(JSON.stringify([snap!.history.map((s) => s.id), cov.status]));
  }
  assert.deepEqual([...results], [JSON.stringify([["d1", "b1", "b2", "a2", "a1"], "complete"])]);
});

test("a gap is missing, and the read that closes it is named", () => {
  let snap: Snapshot | null = null;
  for (const w of [W[0], W[1], W[3]]) snap = merge(snap, w, page([]));
  const cov = historyCoverage(snap, "2026-08-19", "2026-10-14", NOW_MS);
  assert.equal(cov.status, "missing");
  assert.deepEqual(cov.gaps, [{ since: "2026-09-03", until: "2026-09-16" }]);
  assert.deepEqual(cov.need, [{ since: "2026-09-03", until: "2026-09-16", limit: 10 }]);
});

test("a window with a page left: missing, with its own cursor; the next page completes it", () => {
  let snap: Snapshot | null = null;
  for (const w of W) snap = merge(snap, w, w === W[1] ? page([sess("2026-09-29", "p1")], "c-b1") : page([]));
  const cov = historyCoverage(snap, "2026-08-19", "2026-10-14", NOW_MS);
  assert.equal(cov.status, "missing");
  assert.deepEqual(cov.need, [{ ...W[1], cursor: "c-b1" }]);
  assert.equal(snap!.history_coverage?.until, "2026-10-14");
  assert.equal(snap!.history_coverage?.since, "2026-10-01", "the complete span that reaches today");
  snap = merge(snap, { ...W[1], cursor: "c-b1" }, page([sess("2026-09-18", "p2")]));
  assert.equal(historyCoverage(snap, "2026-08-19", "2026-10-14", NOW_MS).status, "complete");
});

test("an overlap counts a session once; interleaved chains of two windows stay apart", () => {
  let snap: Snapshot | null = null;
  snap = merge(snap, { since: "2026-10-01", until: "2026-10-10", limit: 10 }, page([sess("2026-10-05", "x")], "c1"));
  snap = merge(snap, { since: "2026-10-05", until: "2026-10-14", limit: 10 }, page([sess("2026-10-05", "x")], "c1"));
  // Both chains returned the cursor "c1": a cursor read without since/until is ambiguous (an orphan).
  snap = merge(snap, { cursor: "c1" }, page([sess("2026-10-09", "orphan")]));
  assert.equal(snap.history_orphans, 1);
  assert.ok(!snap.history.some((s) => s.id === "orphan"), "an orphan page's sessions are not kept");
  snap = merge(snap, { since: "2026-10-05", until: "2026-10-14", limit: 10, cursor: "c1" }, page([sess("2026-10-12", "y")]));
  snap = merge(snap, { since: "2026-10-01", until: "2026-10-10", limit: 10, cursor: "c1" }, page([sess("2026-10-02", "z")]));
  assert.deepEqual(snap.history.map((s) => s.id), ["z", "x", "y"]);
  assert.equal(historyCoverage(snap, "2026-10-01", "2026-10-14", NOW_MS).status, "complete");
});

test("an orphan final page completes nothing; a repeated page changes nothing", () => {
  let snap = merge(null, W[0], page([sess("2026-10-13", "a")], "c1"));
  snap = merge(snap, { ...W[0], cursor: "c-unknown" }, page([sess("2026-10-02", "b")]));
  assert.equal(historyCoverage(snap, W[0].since, W[0].until, NOW_MS).status, "missing");
  snap = merge(snap, { ...W[0], cursor: "c1" }, page([sess("2026-10-02", "b")]));
  const again = merge(snap, { ...W[0], cursor: "c1" }, page([sess("2026-10-02", "b")]));
  assert.deepEqual(again.history.map((s) => s.id), ["b", "a"]);
  assert.equal(again.history_windows![`${W[0].since}..${W[0].until}`].pages.length, 2);
  assert.equal(historyCoverage(again, W[0].since, W[0].until, NOW_MS).status, "complete");
});

test("a stale page: stale, with the window to read again", () => {
  const old = "2026-10-14T14:30:00.000Z";
  let snap = merge(null, W[0], page([], "c1"), old);
  snap = merge(snap, { ...W[0], cursor: "c1" }, page([]));
  const cov = historyCoverage(snap, W[0].since, W[0].until, NOW_MS);
  assert.equal(cov.status, "stale");
  assert.deepEqual(cov.need, [W[0]]);
});

test("a failed read is failed; a refresh to empty removes the window's old sessions", () => {
  let snap = merge(null, W[0], page([sess("2026-10-10", "gone")]));
  snap = merge(snap, W[0], [{ type: "text", text: "Error: server unavailable" }]);
  let cov = historyCoverage(snap, W[0].since, W[0].until, NOW_MS);
  assert.equal(cov.status, "failed");
  assert.deepEqual(cov.need, [W[0]]);
  snap = merge(snap, W[0], page([sess("2026-10-10", "gone")]));
  snap = merge(snap, W[0], page([]));
  assert.deepEqual(snap.history, [], "the server no longer has it");
  cov = historyCoverage(snap, W[0].since, W[0].until, NOW_MS);
  assert.equal(cov.status, "complete");
});

test("a saved-file notice (a page too large for the hook) is failed; the fix is two half windows", () => {
  const notice = [{ type: "text", text: "Error: result (65,819 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to /tmp/tool-results/x.txt" }];
  const snap = merge(null, W[3], notice);
  const cov = historyCoverage(snap, W[3].since, W[3].until, NOW_MS);
  assert.equal(cov.status, "failed");
  assert.match(cov.reason ?? "", /too large/);
  assert.deepEqual(cov.need, [
    { since: "2026-08-19", until: "2026-08-26", limit: 10 },
    { since: "2026-08-27", until: "2026-09-02", limit: 10 },
  ]);
});

test("more than 10 pages in one window is failed", () => {
  let snap = merge(null, W[0], page([], "c0"));
  for (let i = 0; i < 10; i++) snap = merge(snap, { ...W[0], cursor: `c${i}` }, page([], `c${i + 1}`));
  assert.equal(historyCoverage(snap, W[0].since, W[0].until, NOW_MS).status, "failed");
});

test("the old single chain still works (since and until, then a cursor alone)", () => {
  let snap = merge(null, { since: "2026-08-19", until: "2026-10-14", limit: 10 }, page([sess("2026-10-13", "a")], "c1"));
  snap = merge(snap, { cursor: "c1" }, page([sess("2026-09-01", "b")]));
  assert.equal(snap.history_coverage?.complete, true);
  assert.equal(historyCoverage(snap, "2026-08-19", "2026-10-14", NOW_MS).status, "complete");
});

// ---------- the hook under contention ----------

function runHook(root: string, payload: unknown): Promise<{ code: number | null; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [join(REPO, ".claude/hooks/capture-reads.ts")], { env: { ...BASE_ENV, CLAUDE_PROJECT_DIR: root, COACH_NOW: NOW } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stderr, ms: Date.now() - t0 }));
    child.stdin.end(JSON.stringify({ session_id: SESSION, hook_event_name: "PostToolUse", ...(payload as object) }));
  });
}

test("parallel capture hooks keep every day, every history page and every note (an urgent note too)", async () => {
  const dir = instance();
  const reads = [
    ...["2026-10-14", "2026-10-13", "2026-10-11", "2026-10-09"].map((d) => ({ tool_name: LIVE + "get_planned_workout", tool_input: { date: d }, tool_response: day(d) })),
    { tool_name: LIVE + "get_training_context", tool_input: { historyWeeks: 2 }, tool_response: text({ today: "2026-10-14", futurePlanned: [], weightUnit: "lbs", weightUnitSource: "settings" }) },
    ...W.map((w, i) => ({ tool_name: LIVE + "get_workout_history", tool_input: w, tool_response: page([sess(w.until, `h${i}`, i === 0 ? "had chest pain during the last set" : undefined)]) })),
  ];
  for (let round = 0; round < 3; round++) {
    const res = await Promise.all(reads.map((r) => runHook(dir, r)));
    for (const r of res) assert.equal(r.code, 0, r.stderr);
    const snap = JSON.parse(readFileSync(join(dir, "athlete/.cache/snapshot.json"), "utf8")) as Snapshot;
    assert.deepEqual(Object.keys(snap.days).sort(), ["2026-10-09", "2026-10-11", "2026-10-13", "2026-10-14"]);
    assert.deepEqual(snap.history.map((s) => s.id).sort(), ["h0", "h1", "h2", "h3"]);
    assert.ok(snap.planned, "the training context is kept");
    assert.equal(Object.keys(snap.history_windows ?? {}).length, 4);
  }
  assert.equal(existsSync(join(dir, "athlete/.cache/snapshot.lock")), false, "no lock is left behind");
  // A standalone note scan right after the parallel captures, without the today brief, sees the urgent note.
  const scan = cli(["safety", "scan-notes", "--since", "2026-10-11", "--now", NOW, "--dry-run", "--root", dir], { env: { CLAUDE_CODE_SESSION_ID: SESSION } });
  assert.equal(scan.code, 0, scan.stderr);
  assert.deepEqual(scan.json.urgent_terms, ["chest pain"]);
  assert.equal(scan.json.coverage, "complete");
  assert.equal(scan.json.urgent_unknown, false);
});

test("a stale lock from a dead process is broken; a live one times out with SNAPSHOT_LOCKED, and the hook records the failed read", async () => {
  const dir = instance();
  const lock = join(dir, "athlete/.cache/snapshot.lock");
  writeFileSync(lock, `999999 deadbeef ${Date.now()}`);
  assert.equal(withSnapshotLock(dir, () => 7), 7, "a dead owner's lock is broken");
  writeFileSync(lock, `${process.pid} live ${Date.now()}`);
  assert.throws(() => withSnapshotLock(dir, () => 1, { waitMs: 100 }), /SNAPSHOT_LOCKED|lock was busy/);
  writeFileSync(lock, `${process.pid} old ${Date.now() - 60_000}`);
  assert.equal(withSnapshotLock(dir, () => 8), 8, "a lock older than 30 s is broken");
  // The hook under a held lock: exit 2, and the read is recorded as failed for the brief.
  writeFileSync(lock, `${process.pid} live ${Date.now()}`);
  const r = await runHook(dir, { tool_name: LIVE + "get_planned_workout", tool_input: { date: "2026-10-14" }, tool_response: day("2026-10-14") });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /SNAPSHOT_LOCKED/);
  const failures = readFileSync(join(dir, "athlete/.cache/capture-failures.jsonl"), "utf8");
  assert.match(failures, /"date":"2026-10-14"/);
  const { tallySnapshot } = await import("../engine/coverage.ts");
  writeFileSync(lock, "");
  assert.equal(tallySnapshot(dir, SESSION), null, "no snapshot was written");
});

// ---------- coverage in the note scan and in loads ----------

test("the note scan on incomplete history: a match still finds the term; no match is unknown, not 'no urgent sign'", () => {
  const dir = instance();
  let snap = merge(null, W[0], page([sess("2026-10-13", "a", "felt dizzy and fainted")], "c1"));
  writeJson(dir, "athlete/.cache/snapshot.json", snap);
  const env = { env: { CLAUDE_CODE_SESSION_ID: SESSION } };
  const hit = cli(["safety", "scan-notes", "--since", "2026-10-11", "--now", NOW, "--dry-run", "--root", dir], env);
  assert.equal(hit.json.coverage, "incomplete");
  assert.deepEqual(hit.json.urgent_terms, ["fainting"]);
  assert.equal(hit.json.urgent_unknown, false);
  snap = merge(null, W[0], page([sess("2026-10-13", "a", "good session")], "c1"));
  writeJson(dir, "athlete/.cache/snapshot.json", snap);
  const miss = cli(["safety", "scan-notes", "--since", "2026-10-11", "--now", NOW, "--dry-run", "--root", dir], env);
  assert.equal(miss.json.coverage, "incomplete");
  assert.equal(miss.json.urgent_unknown, true);
  assert.deepEqual(miss.json.coverage_detail.need, [{ ...W[0], cursor: "c1" }]);
  snap = merge(snap, { ...W[0], cursor: "c1" }, page([]));
  writeJson(dir, "athlete/.cache/snapshot.json", snap);
  const done = cli(["safety", "scan-notes", "--since", "2026-10-11", "--now", NOW, "--dry-run", "--root", dir], env);
  assert.equal(done.json.coverage, "complete");
  assert.equal(done.json.urgent_unknown, false);
});

test("loads --from-snapshot on incomplete history holds every load; on complete history it progresses", () => {
  const dir = instance();
  const hit = { id: "h1", date: "2026-10-12", name: "Lower", weightUnit: "lbs", exercises: [{ exerciseId: "Barbell_Squat", name: "Squat", sets: [{ weight: 185, reps: 5, rpe: 7 }, { weight: 185, reps: 5, rpe: 7 }, { weight: 185, reps: 5, rpe: 7 }] }] };
  let snap = merge(null, { date: "2026-10-14" }, day("2026-10-14"), NOW, "get_planned_workout");
  snap = merge(snap, W[0], page([hit], "c1"));
  writeJson(dir, "athlete/.cache/snapshot.json", snap);
  const args = ["loads", "--from-snapshot", "2026-10-14", "--now", NOW, "--session", SESSION, "--root", dir];
  const held = cli(args);
  assert.equal(held.code, 0, held.stderr);
  assert.notEqual(held.json.coverage.status, "complete");
  assert.deepEqual(held.json.update.operations, []);
  assert.match(held.json.suggestions[0].reason, /held: the history is incomplete/);
  for (const w of W) snap = merge(snap, w === W[0] ? { ...w, cursor: "c1" } : w, page([]));
  writeJson(dir, "athlete/.cache/snapshot.json", snap);
  const ok = cli(args);
  assert.equal(ok.json.coverage.status, "complete");
  assert.equal(ok.json.update.operations.length, 1);
});
