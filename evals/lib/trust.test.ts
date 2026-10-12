// Workspace trust for the permission proxy (V3c fix 15): exact restore, other changes kept,
// recovery after a crash. Runs on a temp config file, never on ~/.claude.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverTrust, trustWorkspace } from "./trust.ts";

function setup(projects: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), "coach-trust-"));
  const file = join(home, ".claude.json");
  writeFileSync(file, JSON.stringify({ numStartups: 3, projects }, null, 2));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coach-eval-inst-")));
  const rec = join(home, "recovery");
  return { file, dir, rec, read: () => JSON.parse(readFileSync(file, "utf8")) };
}

test("trust: marks the folder trusted, then restores the previous record exactly", () => {
  const prior = { allowedTools: ["x"], hasTrustDialogAccepted: false, lastCost: 1.5 };
  const t = setup({});
  writeFileSync(t.file, JSON.stringify({ numStartups: 3, projects: { [t.dir]: prior, "/other": { a: 1 } } }, null, 2));
  const undo = trustWorkspace(t.dir, t.file, t.rec);
  assert.equal(t.read().projects[t.dir].hasTrustDialogAccepted, true);
  assert.equal(readdirSync(t.rec).length, 1, "a recovery file exists during the run");
  // Another program changes the config meanwhile: kept.
  const mid = t.read();
  mid.numStartups = 4;
  mid.projects["/new"] = { b: 2 };
  writeFileSync(t.file, JSON.stringify(mid));
  undo();
  const after = t.read();
  assert.deepEqual(after.projects[t.dir], prior, "the previous record, exactly");
  assert.equal(after.numStartups, 4);
  assert.deepEqual(after.projects["/new"], { b: 2 });
  assert.deepEqual(after.projects["/other"], { a: 1 });
  assert.equal(readdirSync(t.rec).length, 0, "the recovery file is gone");
});

test("trust: a folder with no record before has none after", () => {
  const t = setup({ "/other": { a: 1 } });
  const undo = trustWorkspace(t.dir, t.file, t.rec);
  undo();
  assert.equal(t.dir in t.read().projects, false);
});

test("trust: a crashed run's record is restored at the start of the next run; a live run's is left", () => {
  const t = setup({});
  trustWorkspace(t.dir, t.file, t.rec); // no undo: the run "crashed"
  // This process is alive, so its own record is restored (pid === process.pid counts as ours).
  const [f] = readdirSync(t.rec);
  const r = JSON.parse(readFileSync(join(t.rec, f), "utf8"));
  writeFileSync(join(t.rec, f), JSON.stringify({ ...r, pid: 2 ** 22 + 12345 })); // a pid that is not running
  writeFileSync(join(t.rec, "live.json"), JSON.stringify({ pid: process.ppid, file: t.file, previous: { "/kept": "absent" } }));
  assert.equal(t.read().projects[t.dir].hasTrustDialogAccepted, true);
  const restored = recoverTrust(t.rec);
  assert.deepEqual(restored, [f]);
  assert.equal(t.dir in t.read().projects, false, "the crashed run's entry is removed");
  assert.deepEqual(readdirSync(t.rec), ["live.json"], "a live run's recovery file stays");
});
