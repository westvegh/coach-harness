// V7d: a split window's parts replace it only inside their own ranges (its other sessions stay as
// data, not coverage, so a sibling that fails cannot hide an urgent note), and the cursor chain's
// last gaps (an unbound continuation; one restart for every consumer). Made-up data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicCoverage, historyCoverage } from "../engine/history-windows.ts";
import { mergeResponse, saveSnapshot } from "../engine/snapshot.ts";
import type { Snapshot } from "../engine/types.ts";
import { cli, instance } from "./e3/helpers.ts";

const NOW = "2026-10-14T15:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const SESSION = "s-v7d";
const ENV = { env: { CLAUDE_CODE_SESSION_ID: SESSION } };
const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];
const page = (sessions: unknown[], nextCursor?: string) => text({ count: sessions.length, sessions, ...(nextCursor ? { nextCursor } : {}) });
const sess = (date: string, id: string, notes?: string) => ({ id, date, name: `S ${id}`, weightUnit: "lbs", ...(notes ? { notes } : {}), exercises: [{ exerciseId: "Barbell_Squat", name: "Back Squat", sets: [{ weight: 185, reps: 5 }] }] });
const ERROR = [{ type: "text", text: "Error: timeout" }];
function merge(prev: Snapshot | null, input: Record<string, unknown>, response: unknown, batch?: string | null): Snapshot {
  return mergeResponse(prev, { tool: "get_workout_history", input, response, session_id: SESSION, now: NOW, timezone: "America/Los_Angeles", server: "tallymock", ...(batch !== undefined ? { batch } : {}) });
}

// The split window and its halves (the daily run's atomic windows).
const PARENT = { since: "2026-10-08", until: "2026-10-14", limit: 10 };
const A = { since: "2026-10-08", until: "2026-10-11", limit: 10 };
const B = { since: "2026-10-12", until: "2026-10-14", limit: 10 };
const ids = (s: Snapshot) => s.history.map((x) => x.id).sort();

test("a split window's half that succeeds replaces it only inside its range; the failed sibling's range keeps the parent's notes, and coverage stays incomplete", () => {
  let s = merge(null, PARENT, page([sess("2026-10-09", "a1"), sess("2026-10-13", "b1", "chest pain during the warm-up")], "c1"));
  s = merge(s, A, page([sess("2026-10-09", "a1")]));
  s = merge(s, B, ERROR);
  assert.deepEqual(ids(s), ["a1", "b1"], "the parent's session in the failed half stays as data");
  assert.notEqual(atomicCoverage(s, PARENT.since, PARENT.until, NOW_MS).status, "complete");
  // The note scan, right after these captures, finds the urgent note and sets the stop.
  const dir = instance();
  saveSnapshot(dir, s);
  const scan = cli(["safety", "scan-notes", "--since", "2026-10-11", "--now", NOW, "--root", dir], ENV);
  assert.equal(scan.code, 0, scan.stderr);
  assert.deepEqual(scan.json.urgent_terms, ["chest pain"]);
  assert.ok(existsSync(join(dir, "athlete/.urgent-stop")), "the urgent stop is set");
  assert.equal(scan.json.coverage, "incomplete");
});

test("both halves succeed: the split window is gone and nothing counts twice", () => {
  let s = merge(null, PARENT, page([sess("2026-10-09", "a1"), sess("2026-10-13", "b1")], "c1"));
  s = merge(s, A, page([sess("2026-10-09", "a1")]));
  s = merge(s, B, page([sess("2026-10-13", "b1")]));
  assert.equal(s.history_windows![`${PARENT.since}..${PARENT.until}`], undefined);
  assert.deepEqual(ids(s), ["a1", "b1"]);
  assert.equal(s.history.length, 2);
  assert.equal(atomicCoverage(s, PARENT.since, PARENT.until, NOW_MS).status, "complete");
});

test("precedence: inside its range the newer half wins over the older split window; outside it the parent stays until its own half arrives", () => {
  let s = merge(null, PARENT, page([sess("2026-10-09", "a1", "old note"), sess("2026-10-10", "gone"), sess("2026-10-13", "b1")], "c1"));
  s = merge(s, A, page([sess("2026-10-09", "a1", "new note")]));
  assert.equal(s.history.find((x) => x.id === "a1")?.notes, "new note", "the newer read wins");
  assert.ok(!s.history.some((x) => x.id === "gone"), "a session the half no longer returns leaves");
  assert.ok(s.history.some((x) => x.id === "b1"), "outside the half's range the parent's session stays");
  assert.ok(s.history_windows![`${PARENT.since}..${PARENT.until}`], "the parent stays until its dates are all covered");
  // A half whose own response has a nextCursor replaces nothing.
  let t = merge(null, PARENT, page([sess("2026-10-09", "a1"), sess("2026-10-10", "a2", "dizzy and fainted")], "c1"));
  t = merge(t, A, page([sess("2026-10-09", "a1")], "c2"));
  assert.ok(t.history.some((x) => x.id === "a2"), "a split half is not whole: the parent's session stays");
});

// ---------- the cursor chain (other skills, old routine prompts) ----------

const CW = { since: "2026-10-01", until: "2026-10-14", limit: 10 };
const ccov = (s: Snapshot) => historyCoverage(s, CW.since, CW.until, NOW_MS);

test("chain: a continuation with no known message (the hook found no binding) never completes coverage, first generation included", () => {
  let s = merge(null, CW, page([sess("2026-10-13", "a")], "c1"), "m1");
  s = merge(s, { ...CW, cursor: "c1" }, page([sess("2026-10-03", "b")]), null);
  assert.notEqual(ccov(s).status, "complete");
  assert.deepEqual(ccov(s).need, [CW], "restart from the first page");
  // A bound continuation completes it.
  let t = merge(null, CW, page([sess("2026-10-13", "a")], "c1"), "m1");
  t = merge(t, { ...CW, cursor: "c1" }, page([sess("2026-10-03", "b")]), "m2");
  assert.equal(ccov(t).status, "complete");
});

test("chain: one restart, then the read is given up (unknown) for every consumer of the chain coverage (shown through the note scan)", () => {
  let s = merge(null, CW, page([], "c1"), "m1");
  s = merge(s, { ...CW, cursor: "c1" }, page([]), null); // ambiguous
  s = merge(s, CW, page([], "c1"), "m3"); // the one restart
  assert.equal(ccov(s).status, "missing");
  s = merge(s, { ...CW, cursor: "c1" }, page([]), null); // ambiguous again
  const c = ccov(s);
  assert.equal(c.status, "failed");
  assert.deepEqual(c.need, [], "no second restart");
  assert.match(c.reason ?? "", /restarted once and still ambiguous: given up/);
  // A consumer sees it: the note scan cannot say "no urgent sign".
  const dir = instance();
  saveSnapshot(dir, s);
  const scan = cli(["safety", "scan-notes", "--since", "2026-10-11", "--now", NOW, "--dry-run", "--root", dir], ENV).json;
  assert.equal(scan.coverage, "incomplete");
  assert.equal(scan.urgent_unknown, true);
  assert.deepEqual(scan.coverage_detail.need, []);
  assert.equal(scan.coverage_detail.status, "failed");
});
