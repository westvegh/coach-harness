// V7 phase 1-2 fix round (the review of main..00310a3, 10 findings). Each test fails on 00310a3;
// a race is made deterministic (a lock caught mid-creation, a late page, a snapshot replaced between
// two reads, a crash between the move of main and the push). Made-up data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loggerHistoryCoverage } from "../engine/coverage.ts";
import { historyCoverage, planWindows } from "../engine/history-windows.ts";
import { withSnapshotLock } from "../engine/snapshot-lock.ts";
import { mergeResponse, saveSnapshot } from "../engine/snapshot.ts";
import type { Snapshot } from "../engine/types.ts";
import { cli, instance, writeJson } from "./e3/helpers.ts";
import { athleteRepo, cliIn, fakeGh, git, linkEngine, remote, remoteCommit } from "./v7-helpers.ts";

const NOW = "2026-10-14T15:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const SESSION = "s-fix";
const W = planWindows("2026-08-19", "2026-10-14", 14);
const text = (x: unknown) => [{ type: "text", text: JSON.stringify(x) }];
const page = (sessions: unknown[], nextCursor?: string) => text({ count: sessions.length, sessions, ...(nextCursor ? { nextCursor } : {}) });
const sess = (date: string, id: string, notes?: string) => ({ id, date, name: `S ${id}`, weightUnit: "lbs", ...(notes ? { notes } : {}), exercises: [{ exerciseId: "Barbell_Squat", name: "Back Squat", sets: [{ weight: 185, reps: 5, rpe: 7 }] }] });
const at = (min: number) => new Date(NOW_MS + min * 60_000).toISOString();
function merge(prev: Snapshot | null, input: Record<string, unknown>, response: unknown, now = NOW, tool = "get_workout_history", batch?: string | null): Snapshot {
  return mergeResponse(prev, { tool, input, response, session_id: SESSION, now, timezone: "America/Los_Angeles", server: "claude_ai_Tally_Workout", ...(batch !== undefined ? { batch } : {}) });
}
const cov = (s: Snapshot, w = W[0]) => historyCoverage(s, w.since, w.until, NOW_MS + 60_000);

test("finding 1: a lock file caught between its creation and its ownership record is never broken as a dead owner", () => {
  const dir = instance();
  const lock = join(dir, "athlete/.cache/snapshot.lock");
  writeFileSync(lock, ""); // another hook has just created it and not yet written its record
  assert.throws(() => withSnapshotLock(dir, () => "entered", { waitMs: 150 }), /lock was busy/);
  writeFileSync(lock, "4"); // cut short
  assert.throws(() => withSnapshotLock(dir, () => "entered", { waitMs: 150 }), /lock was busy/);
  // An unreadable record still goes once it is older than the stale age.
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(withSnapshotLock(dir, () => "entered"), "entered");
});

test("finding 2: a late page of the previous generation never completes the refreshed window", () => {
  let s = merge(null, W[0], page([sess("2026-10-13", "old-first")], "c1"), at(-5));
  // The window is read again; its first page happens to return the same cursor.
  s = merge(s, W[0], page([sess("2026-10-13", "new-first")], "c1"), at(-1), "get_workout_history", "msg-refresh");
  // The old chain's continuation lands now (its message is not known).
  s = merge(s, { ...W[0], cursor: "c1" }, page([sess("2026-10-02", "old-delayed-tail")]), at(0));
  let c = cov(s);
  assert.notEqual(c.status, "complete", "a page that may be the old read is data, not coverage");
  assert.deepEqual(c.need, [W[0]], "V7c: restart the chain from its first page");
  // V7c: a page with an unknown binding makes the chain ambiguous: a read of its position again does
  // not clear it; only a new first page restarts the chain.
  s = merge(s, { ...W[0], cursor: "c1" }, page([sess("2026-10-03", "new-tail", "chest pain on the last set")]), at(0), "get_workout_history", "msg-later");
  assert.notEqual(cov(s).status, "complete");
  s = merge(s, W[0], page([sess("2026-10-13", "restart"), sess("2026-10-03", "new-tail", "chest pain on the last set")]), at(0), "get_workout_history", "msg-restart");
  c = cov(s);
  assert.equal(c.status, "complete");
  assert.deepEqual(s.history.map((x) => x.id), ["new-tail", "restart"]);
});

test("finding 3: a capture failure clears only by its own read again", () => {
  const dir = instance();
  const cfg = { logger: "tally", template: { days: 4 } } as never;
  const fail = (f: Record<string, unknown>) => writeFileSync(join(dir, "athlete/.cache/capture-failures.jsonl"), JSON.stringify({ session_id: SESSION, tool: "get_workout_history", reason: "the snapshot lock timed out", ...f }) + "\n");
  // A refresh's first page timed out at -2; an older chain's continuation landed at -1.
  let s = merge(null, W[0], page([sess("2026-10-13", "a")], "c1"), at(-5));
  s = merge(s, { ...W[0], cursor: "c1" }, page([sess("2026-10-02", "b")]), at(-1));
  saveSnapshot(join(dir), s);
  fail({ at: at(-2), since: W[0].since, until: W[0].until });
  assert.equal(loggerHistoryCoverage(dir, cfg, W[0].since, W[0].until, NOW, SESSION).status, "failed", "the refresh was never captured");
  // A cursor-only page timed out at -3, and its read again (in its dated window) landed at -1.
  s = merge(null, W[0], page([sess("2026-10-13", "a")], "c1"), at(-5));
  s = merge(s, { ...W[0], cursor: "c1" }, page([sess("2026-10-02", "b")]), at(-1));
  saveSnapshot(dir, s);
  fail({ at: at(-3), cursor: "c1" });
  assert.equal(loggerHistoryCoverage(dir, cfg, W[0].since, W[0].until, NOW, SESSION).status, "complete", "the retry cleared it");
});

/** Runs the engine CLI in this process, serving `replacement` for the second read of snapshot.json. */
async function withSecondRead(replacement: Snapshot, argv: string[]): Promise<any> {
  const require = createRequire(import.meta.url);
  const fs = require("node:fs");
  const orig = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (p: unknown, ...rest: unknown[]) {
    if (String(p).endsWith("athlete/.cache/snapshot.json") && ++reads === 2) return JSON.stringify(replacement);
    return orig.call(this, p, ...rest);
  };
  syncBuiltinESMExports();
  const write = process.stdout.write.bind(process.stdout);
  const envSession = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = SESSION;
  let out = "";
  (process.stdout as any).write = (chunk: string) => ((out += chunk), true);
  try {
    const { main } = await import("../engine/cli.ts");
    await main(argv);
  } finally {
    (process.stdout as any).write = write;
    if (envSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = envSession;
    fs.readFileSync = orig;
    syncBuiltinESMExports();
  }
  return JSON.parse(out);
}

test("finding 4: the note scan's coverage and the notes it scans come from one snapshot read", async () => {
  const dir = instance();
  let a: Snapshot | null = null;
  for (const w of W) a = merge(a, w, page(w === W[0] ? [sess("2026-10-12", "x"), sess("2026-10-13", "y")] : []));
  saveSnapshot(dir, a!);
  const b = merge(null, W[0], page([sess("2026-10-13", "y")], "c-more"));
  const r = await withSecondRead(b, ["safety", "scan-notes", "--since", "2026-10-11", "--now", NOW, "--dry-run", "--root", dir]);
  const consistent = (r.coverage === "complete" && r.sessions === 2) || (r.coverage === "incomplete" && r.sessions === 1);
  assert.ok(consistent, JSON.stringify(r));
});

test("finding 4: loads take their coverage from the snapshot whose history they use", async () => {
  const dir = instance();
  const day = text({ date: "2026-10-14", found: true, version: "v1", updatedAt: "t0", source: "mcp", userModified: false, skipped: false, exercises: [{ exerciseId: "Barbell_Squat", name: "Back Squat", suggestedSets: 3, suggestedReps: 5, suggestedWeight: 185 }], weightUnit: "lbs", weightUnitSource: "settings" });
  // On disk: an incomplete history (a page is left) with a hit at 185.
  let a = merge(null, { date: "2026-10-14" }, day, NOW, "get_planned_workout");
  a = merge(a, W[0], page([sess("2026-10-12", "x")], "c-more"));
  saveSnapshot(dir, a);
  // The second read would see a complete one.
  let b = merge(null, { date: "2026-10-14" }, day, NOW, "get_planned_workout");
  for (const w of W) b = merge(b, w, page(w === W[0] ? [sess("2026-10-12", "x")] : []));
  const r = await withSecondRead(b, ["loads", "--from-snapshot", "2026-10-14", "--now", NOW, "--session", SESSION, "--root", dir]);
  assert.notEqual(r.coverage.status, "complete", JSON.stringify(r.coverage));
  assert.deepEqual(r.update.operations, [], "no load goes up on the incomplete history it read");
});

test("finding 5: a bare --input list is scanned, but its coverage is unknown", () => {
  const dir = instance();
  const r = cli(["safety", "scan-notes", "--since", "2026-10-11", "--input", writeJson(dir, ".tmp/coach/h.json", []), "--now", NOW, "--root", dir]);
  assert.equal(r.json.coverage, "incomplete");
  assert.equal(r.json.urgent_unknown, true);
  const ok = cli(["safety", "scan-notes", "--since", "2026-10-11", "--input", writeJson(dir, ".tmp/coach/h2.json", { history: [], complete: true }), "--now", NOW, "--root", dir]);
  assert.equal(ok.json.coverage, "complete");
});

// ---------- save ----------

const GH = fakeGh();
const ENV = { PATH: `${GH}:${process.env.PATH}`, FAKE_VIS: "private" };
const today = () => new Date().toISOString();
let seq = 0;
const runId = (date = today().slice(0, 10)) => `r-${date.replace(/-/g, "")}-0800-${(0xb000 + seq++).toString(16)}`;
const input = (dir: string) => writeJson(dir, ".tmp/coach/save.json", { lines: ["- proposal for the next live session: swap split squats for step-ups"] });
const remoteMain = (bare: string) => git(bare, "rev-parse", "refs/heads/main");

/** A worktree on a branch; `mainOut`: main stays checked out in the main checkout. */
function worktreeLayout(mainOut: boolean) {
  const r = remote();
  const main = athleteRepo(r);
  if (!mainOut) git(main, "switch", "-q", "-c", "elsewhere");
  const wt = join(mkdtempSync(join(tmpdir(), "v7-fix-wt-")), "wt");
  git(main, "worktree", "add", "-q", "-b", "coach", wt, "main");
  linkEngine(wt);
  return { r, main, wt };
}

for (const mainOut of [true, false]) {
  test(`finding 6: a failed push after main moved recovers on the retry (main ${mainOut ? "checked out elsewhere" : "not checked out"})`, () => {
    const { r, main, wt } = worktreeLayout(mainOut);
    writeFileSync(join(r.bare, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(r.bare, "hooks/pre-receive"), 0o755);
    const run = runId();
    assert.equal(cliIn(wt, ["save", "--run", run, "--message", "today", "--input", input(wt)], ENV).json.outcome, "not_published");
    rmSync(join(r.bare, "hooks/pre-receive"));
    remoteCommit(r, "athlete/log/cloud.md", "a cloud run\n");
    const retry = cliIn(wt, ["save", "--run", run, "--message", "today", "--input", input(wt)], ENV);
    assert.equal(retry.json.outcome, "published", JSON.stringify(retry.json));
    const head = git(wt, "rev-parse", "HEAD");
    assert.equal(remoteMain(r.bare), head);
    assert.equal(git(wt, "rev-parse", "refs/heads/main"), head);
    if (mainOut) assert.equal(git(main, "status", "--porcelain", "--untracked-files=no"), "");
  });
}

test("finding 6: a crash between the move of main and the push recovers on the retry", () => {
  const { r, wt } = worktreeLayout(false);
  // A gh that kills the save at the privacy check, after main moved and before git push.
  const killer = mkdtempSync(join(tmpdir(), "v7-kill-gh-"));
  writeFileSync(join(killer, "gh"), "#!/bin/sh\nkill -9 $PPID\nexit 1\n");
  chmodSync(join(killer, "gh"), 0o755);
  const run = runId();
  const crash = cliIn(wt, ["save", "--run", run, "--message", "today", "--input", input(wt)], { ...ENV, PATH: `${killer}:${process.env.PATH}` });
  assert.notEqual(crash.code, 0, "the save was killed");
  assert.equal(git(wt, "rev-parse", "refs/heads/main"), git(wt, "rev-parse", "HEAD"), "main had moved");
  remoteCommit(r, "athlete/log/cloud.md", "a cloud run\n");
  const retry = cliIn(wt, ["save", "--run", run, "--message", "today", "--input", input(wt)], ENV);
  assert.equal(retry.json.outcome, "published", JSON.stringify(retry.json));
  assert.equal(remoteMain(r.bare), git(wt, "rev-parse", "HEAD"));
});

test("finding 7: a page that is read again takes the sessions of the replaced and cut pages with it", () => {
  let s = merge(null, W[0], page([sess("2026-10-13", "a")], "c1"));
  s = merge(s, { ...W[0], cursor: "c1" }, page([sess("2026-10-10", "b"), sess("2026-10-09", "c")], "c2"));
  s = merge(s, { ...W[0], cursor: "c2" }, page([sess("2026-10-05", "d")]));
  // Page 2 again, now the last page with other content.
  s = merge(s, { ...W[0], cursor: "c1" }, page([sess("2026-10-08", "replacement")]));
  assert.deepEqual(s.history.map((x) => x.id), ["replacement", "a"]);
  assert.equal(cov(s).status, "complete");
});

test("finding 8: a push that one push URL took is published, not 'nothing reached the remote'", () => {
  const r = remote();
  const dir = athleteRepo(r);
  // Two push URLs for one repository: the fake ssh serves only the first form, so the second fails.
  git(dir, "remote", "set-url", "--add", "--push", "origin", "git@github.com:alex/coach.git");
  git(dir, "remote", "set-url", "--add", "--push", "origin", "ssh://git@github.com/alex/coach.git");
  const s = cliIn(dir, ["save", "--run", runId(), "--message", "today", "--input", input(dir)], ENV);
  assert.equal(s.json.outcome, "published", JSON.stringify(s.json));
  assert.equal(remoteMain(r.bare), git(dir, "rev-parse", "HEAD"));
  assert.doesNotMatch(readFileSync(join(dir, "athlete/log", `${today().slice(0, 7)}.md`), "utf8"), /push skipped/);
});

test("finding 9: a run saved on October 31 and retried on November 1 is in the log once, in October", () => {
  const dir = athleteRepo(remote());
  const run = runId("2026-10-31");
  assert.equal(cliIn(dir, ["save", "--run", run, "--message", "today", "--input", input(dir), "--now", "2026-11-01T06:30:00.000Z"], ENV).json.outcome, "published");
  const retry = cliIn(dir, ["save", "--run", run, "--message", "today", "--input", input(dir), "--now", "2026-11-01T08:30:00.000Z"], ENV);
  assert.equal(retry.json.log.appended, false);
  assert.equal(existsSync(join(dir, "athlete/log/2026-11.md")), false);
  assert.equal(readFileSync(join(dir, "athlete/log/2026-10.md"), "utf8").split("\n").filter((l) => l === `- run: ${run}`).length, 1);
});

test("finding 10: an eleventh page is failed, a last page too; a page after that does not clear it", () => {
  let s = merge(null, W[0], page([], "c0"));
  for (let i = 0; i < 9; i++) s = merge(s, { ...W[0], cursor: `c${i}` }, page([], `c${i + 1}`));
  assert.equal(cov(s).status, "missing", "10 pages, one left");
  s = merge(s, { ...W[0], cursor: "c9" }, page([]));
  assert.equal(cov(s).status, "failed", "the 11th page ends the chain but breaks the limit");
  assert.equal(s.history_windows![`${W[0].since}..${W[0].until}`].pages.length, 11);
  s = merge(s, { ...W[0], cursor: "c9" }, page([]));
  assert.equal(cov(s).status, "failed", "the same last page again does not clear it");
  s = merge(s, W[0], page([]));
  assert.equal(cov(s).status, "complete", "a new first page does");
});
