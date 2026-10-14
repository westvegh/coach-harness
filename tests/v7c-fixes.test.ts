// V7c: atomic history windows for the daily run (split, never continue), the last cursor-chain
// fixes, one save marker per safety event, and the annotate placeholder. Made-up data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localDate } from "../engine/dates.ts";
import { ATOMIC_WINDOW_DAYS, atomicCoverage, historyCoverage, planWindows } from "../engine/history-windows.ts";
import { mergeResponse, saveSnapshot } from "../engine/snapshot.ts";
import { placeholderOperation } from "../engine/today-write-prep.ts";
import type { Snapshot } from "../engine/types.ts";
import { cli, instance, writeJson } from "./e3/helpers.ts";
import { athleteRepo, cliIn, fakeGh, remote } from "./v7-helpers.ts";

const NOW = "2026-10-14T15:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const TODAY = "2026-10-14";
const SINCE = "2026-08-19";
const SESSION = "s-v7c";
const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];
const page = (sessions: unknown[], nextCursor?: string) => text({ count: sessions.length, sessions, ...(nextCursor ? { nextCursor } : {}) });
const sess = (date: string, id: string, notes?: string) => ({ id, date, name: `S ${id}`, weightUnit: "lbs", ...(notes ? { notes } : {}), exercises: [{ exerciseId: "Barbell_Squat", name: "Back Squat", sets: [{ weight: 185, reps: 5 }] }] });
function merge(prev: Snapshot | null, input: Record<string, unknown>, response: unknown, o: { now?: string; batch?: string | null; tool_use_id?: string; resolve?: (id: string) => string | null } = {}): Snapshot {
  return mergeResponse(prev, { tool: "get_workout_history", input, response, session_id: SESSION, now: o.now ?? NOW, timezone: "America/Los_Angeles", server: "tallymock", ...("batch" in o ? { batch: o.batch } : {}), ...(o.tool_use_id ? { tool_use_id: o.tool_use_id } : {}), ...(o.resolve ? { resolve: o.resolve } : {}) });
}
const W = planWindows(SINCE, TODAY, ATOMIC_WINDOW_DAYS);
const atomicAll = (s: Snapshot | null) => atomicCoverage(s, SINCE, TODAY, NOW_MS, { session_id: SESSION });
const readEvery = (over: (w: (typeof W)[number], i: number) => unknown = () => page([])) => {
  let s: Snapshot | null = null;
  W.forEach((w, i) => (s = merge(s, w, over(w, i))));
  return s!;
};

// ---------- 1: atomic windows ----------

test("atomic: 7-day windows tile the 8 weeks (the oldest takes the remainder); every window read once is complete", () => {
  assert.equal(ATOMIC_WINDOW_DAYS, 7);
  assert.equal(W.length, 8);
  assert.deepEqual([W[0].since, W[0].until, W[7].since, W[7].until], ["2026-10-08", TODAY, SINCE, "2026-08-26"]);
  assert.equal(atomicAll(readEvery()).status, "complete");
});

test("atomic: a response with a nextCursor is split into halves, never continued; the halves replace it", () => {
  let s = readEvery((w, i) => (i === 0 ? page([sess("2026-10-12", "a"), sess("2026-10-09", "b")], "c1") : page([])));
  let c = atomicAll(s);
  assert.equal(c.status, "missing");
  assert.deepEqual(c.split, [{ since: W[0].since, until: W[0].until }]);
  assert.deepEqual(c.need, [
    { since: "2026-10-08", until: "2026-10-11", limit: 10 },
    { since: "2026-10-12", until: TODAY, limit: 10 },
  ]);
  assert.ok(c.need.every((r) => r.cursor === undefined), "never a cursor");
  // A continuation page is not coverage here.
  const cont = merge(s, { ...W[0], cursor: "c1" }, page([]));
  assert.notEqual(atomicAll(cont).status, "complete");
  // The halves arrive: they replace the split window (its sessions go with it, the halves bring theirs).
  s = merge(s, c.need[0], page([sess("2026-10-09", "b")]));
  s = merge(s, c.need[1], page([sess("2026-10-12", "a")]));
  c = atomicAll(s);
  assert.equal(c.status, "complete");
  assert.equal(s.history_windows![`${W[0].since}..${W[0].until}`], undefined, "the split window is gone");
  assert.deepEqual(s.history.map((x) => x.id), ["b", "a"]);
});

test("atomic: splits go down to one day; one day that still has a nextCursor is failed (safety unknown), with nothing to read", () => {
  let s = readEvery((w, i) => (i === 0 ? page([], "c") : page([])));
  // Split until one day is left with a nextCursor.
  for (const [a, b] of [["2026-10-12", TODAY], ["2026-10-12", "2026-10-13"], ["2026-10-12", "2026-10-12"]]) {
    s = merge(s, { since: a, until: b, limit: 10 }, page([], "c"));
  }
  for (const r of [{ since: "2026-10-08", until: "2026-10-11" }, { since: "2026-10-13", until: "2026-10-13" }, { since: TODAY, until: TODAY }]) s = merge(s, { ...r, limit: 10 }, page([]));
  const c = atomicAll(s);
  assert.equal(c.status, "failed");
  assert.match(c.reason ?? "", /2026-10-12: one day has more sessions than one page holds/);
  assert.deepEqual(c.need, []);
});

test("atomic: a gap, an overlap, a refreshed window, a stale window and a failed read", () => {
  // A gap: one window not read.
  let s: Snapshot | null = null;
  W.forEach((w, i) => i !== 3 && (s = merge(s, w, page([]))));
  let c = atomicAll(s);
  assert.equal(c.status, "missing");
  assert.deepEqual(c.need, [W[3]]);
  // An overlap: a session two windows return counts once.
  s = readEvery((w, i) => (i <= 1 ? page([sess("2026-10-07", "x")]) : page([])));
  s = merge(s, { since: "2026-10-05", until: "2026-10-09", limit: 10 }, page([sess("2026-10-07", "x")]));
  assert.equal(atomicAll(s).status, "complete");
  assert.equal(s.history.filter((x) => x.id === "x").length, 1);
  // A refreshed window: the newest response replaces the older one.
  s = readEvery((w, i) => (i === 0 ? page([sess("2026-10-10", "old")]) : page([])));
  s = merge(s, W[0], page([sess("2026-10-10", "new")]));
  assert.deepEqual(s.history.map((x) => x.id), ["new"]);
  assert.equal(atomicAll(s).status, "complete");
  // A stale window.
  s = readEvery();
  s = merge(s, W[2], page([]), { now: "2026-10-14T14:30:00.000Z" });
  c = atomicAll(s);
  assert.equal(c.status, "stale");
  assert.deepEqual(c.need, [W[2]]);
  // A failed read.
  s = merge(readEvery(), W[5], [{ type: "text", text: "Error: timeout" }]);
  c = atomicAll(s);
  assert.equal(c.status, "failed");
  assert.deepEqual(c.need, [W[5]]);
});

test("atomic, through post: a split names the halves in need_reads (no cursor); a window that fails twice is given up", () => {
  const dir = instance();
  const ENV = { env: { CLAUDE_CODE_SESSION_ID: SESSION } };
  cli(["today-brief", "--stage", "pre", "--now", NOW, "--root", dir], ENV);
  let s: Snapshot | null = mergeResponse(null, { tool: "get_planned_workout", input: { date: TODAY }, response: text({ date: TODAY, found: false, exercises: [] }), session_id: SESSION, now: NOW, timezone: "America/Los_Angeles", server: "tallymock" });
  W.forEach((w, i) => (s = merge(s, w, i === 0 ? page([], "c1") : i === 4 ? [{ type: "text", text: "Error: timeout" }] : page([]))));
  saveSnapshot(dir, s!);
  const post = () => cli(["today-brief", "--stage", "post", "--now", NOW, "--root", dir], ENV).json;
  let j = post();
  assert.deepEqual(j.coverage.history.split, [{ since: W[0].since, until: W[0].until }]);
  const hist = j.need_reads.filter((r: any) => r.tool === "get_workout_history").map((r: any) => r.args);
  const bySince = (x: any[]) => [...x].sort((a, b) => (a.since < b.since ? -1 : 1));
  assert.deepEqual(bySince(hist), bySince([{ since: "2026-10-08", until: "2026-10-11", limit: 10 }, { since: "2026-10-12", until: TODAY, limit: 10 }, W[4]]));
  assert.equal(j.urgent.unknown, true);
  j = post(); // the failed window was asked once: it is given up now (safety stays unknown)
  assert.ok(j.gave_up.some((r: any) => r.args.since === W[4].since));
});

// ---------- 2: the cursor chain (other skills, old routine prompts) ----------

const CW = { since: "2026-10-01", until: TODAY, limit: 10 };
const ccov = (s: Snapshot) => historyCoverage(s, CW.since, CW.until, NOW_MS + 60_000);

test("chain: a failed continuation keeps the generation and its remembered cursor; a late old page cannot complete it", () => {
  let s = merge(null, CW, page([sess("2026-10-13", "old-first")], "c1"), { batch: "m1" });
  s = merge(s, CW, page([sess("2026-10-13", "new-first")], "c1"), { batch: "m2" }); // the refresh
  s = merge(s, { ...CW, cursor: "c1" }, page([sess("2026-10-03", "new-tail", "chest pain")]), { batch: "m3" });
  assert.equal(ccov(s).status, "complete");
  // A failed continuation from an unknown message: the chain is ambiguous, the generation data stays.
  s = mergeResponse(s, { tool: "get_workout_history", input: { ...CW, cursor: "c1" }, response: [{ type: "text", text: "Error: timeout" }], session_id: SESSION, now: NOW, timezone: "America/Los_Angeles", server: "tallymock" });
  const w = s.history_windows![`${CW.since}..${CW.until}`];
  assert.deepEqual(w.superseded?.map((x) => x.cursor), ["c1"]);
  assert.equal(w.generation, 2);
  // The delayed old continuation lands (sent with the refresh): dropped; and the chain stays incomplete.
  s = merge(s, { ...CW, cursor: "c1" }, page([sess("2026-10-02", "old-tail")]), { batch: "m2" });
  assert.notEqual(ccov(s).status, "complete");
  assert.ok(s.history.some((x) => x.id === "new-tail"), "the urgent-bearing current tail stays");
  assert.ok(!s.history.some((x) => x.id === "old-tail"));
  assert.deepEqual(ccov(s).need, [CW], "restart from the first page");
  s = merge(s, CW, page([sess("2026-10-13", "fresh")]), { batch: "m5" });
  assert.equal(ccov(s).status, "complete");
});

test("chain: an error between replays keeps the page-limit failure", () => {
  let s = merge(null, CW, page([], "c0"));
  for (let i = 0; i < 10; i++) s = merge(s, { ...CW, cursor: `c${i}` }, page([], i < 9 ? `c${i + 1}` : undefined));
  assert.equal(ccov(s).status, "failed");
  s = mergeResponse(s, { tool: "get_workout_history", input: { ...CW, cursor: "c3" }, response: [{ type: "text", text: "Error" }], session_id: SESSION, now: NOW, timezone: "America/Los_Angeles", server: "tallymock" });
  s = merge(s, { ...CW, cursor: "c0" }, page([]));
  assert.equal(ccov(s).status, "failed", "error, then a replay of page 2: still failed");
  assert.ok(s.history_windows![`${CW.since}..${CW.until}`].failed?.overflow);
});

test("chain: a refresh whose message was not in the transcript yet is found later; a known later page then counts", () => {
  const transcript = new Map<string, string>();
  const resolve = (id: string) => transcript.get(id) ?? null;
  let s = merge(null, CW, page([sess("2026-10-13", "old-first")], "c1"), { batch: "m1" });
  // The refresh: its message is not written yet (transcript lag).
  s = merge(s, CW, page([sess("2026-10-13", "new-first")], "c1"), { batch: null, tool_use_id: "tu-refresh", resolve });
  assert.equal(s.history_windows![`${CW.since}..${CW.until}`].superseded?.[0].batch, null);
  transcript.set("tu-refresh", "m2");
  s = merge(s, { ...CW, cursor: "c1" }, page([sess("2026-10-03", "new-tail")]), { batch: "m3", resolve });
  assert.equal(ccov(s).status, "complete");
  // With the binding never found, the chain is ambiguous: one restart, no endless continuation retries.
  let t = merge(null, CW, page([], "c1"), { batch: "m1" });
  t = merge(t, CW, page([], "c1"), { batch: null, tool_use_id: "tu-x", resolve: () => null });
  t = merge(t, { ...CW, cursor: "c1" }, page([]), { batch: "m3", resolve: () => null });
  assert.deepEqual(ccov(t).need, [CW]);
});

// ---------- 4: one save marker per safety event ----------

const GH = fakeGh();
const GIT = { PATH: `${GH}:${process.env.PATH}`, FAKE_VIS: "private" };
const realToday = () => localDate(new Date().toISOString(), "America/Los_Angeles");

test("save --part per event: two regions in one run are both saved, each survives an early exit, and the run's entry is still written once", () => {
  const dir = athleteRepo(remote());
  const run = `r-${realToday().replace(/-/g, "")}-0800-e001`;
  const lines = (region: string) => writeJson(dir, `.tmp/coach/safety-${region}.json`, { lines: [`- pain handled: ${region} 2026-10-14T06:41:00-07:00`] });
  const part = (region: string) => cliIn(dir, ["save", "--run", run, "--part", `safety-${region}-2026-10-14T06:41:00-07:00`, "--message", "safety", "--input", lines(region)], GIT).json;
  assert.equal(part("left-knee").log.appended, true);
  let log = readFileSync(join(dir, "athlete/log", `${realToday().slice(0, 7)}.md`), "utf8");
  assert.match(log, /- pain handled: left-knee/, "saved before any early exit");
  assert.equal(part("low-back").log.appended, true, "the second region is its own entry");
  assert.equal(part("left-knee").log.appended, false, "the same event twice adds nothing");
  log = readFileSync(join(dir, "athlete/log", `${realToday().slice(0, 7)}.md`), "utf8");
  assert.match(log, /- pain handled: low-back/);
  const fin = cliIn(dir, ["save", "--run", run, "--message", "today", "--input", writeJson(dir, ".tmp/coach/s.json", { lines: ["- proposal for the next live session: x"] })], GIT).json;
  assert.equal(fin.log.appended, true);
  assert.equal(fin.outcome, "published");
  assert.equal(cliIn(dir, ["save", "--run", run, "--part", "safety knee", "--message", "m", "--input", lines("x")], GIT).json.error.code, "USAGE");
});

// ---------- 5: the annotate placeholder ----------

test("annotate: the placeholder restates a field the day has, never an invented set count; a day with none fails clearly", () => {
  assert.deepEqual(placeholderOperation([{ exerciseId: "Run", name: "Run", suggestedDuration: 1800 }, { exerciseId: "x", name: "X", suggestedSets: 3 }]), { op: "modify", target: { index: 0 }, fields: { suggestedDuration: 1800 } });
  assert.equal(placeholderOperation([{ exerciseId: "Walk", name: "Walk" }]), null);
  const dir = instance();
  const day = { date: TODAY, found: true, version: "v-1", updatedAt: "t0", source: "mcp", userModified: false, skipped: false, dayType: "cardio", dayName: "Easy", exercises: [{ exerciseId: "Walk", name: "Walk" }], weightUnit: "lbs", weightUnitSource: "settings" };
  saveSnapshot(dir, mergeResponse(null, { tool: "get_planned_workout", input: { date: TODAY }, response: text(day), session_id: SESSION, now: NOW, timezone: "America/Los_Angeles", server: "tallymock" }));
  const prep = (tool: string) => cli(["today-write-prep", "--input", writeJson(dir, ".tmp/coach/wp.json", { edit: { notes: "[coach] note" }, tool, kind: "annotate" }), "--now", NOW, "--root", dir], { env: { CLAUDE_CODE_SESSION_ID: SESSION } }).json;
  const bad = prep("update_planned_workout");
  assert.match(bad.error.message, /use plan_workout_day/);
  const ok = prep("plan_workout_day");
  assert.deepEqual(ok.write.plain.args.exercises, [{ exerciseId: "Walk", name: "Walk" }], "the stored day unchanged");
  assert.equal(ok.write.plain.args.notes, "[coach] note");
});
