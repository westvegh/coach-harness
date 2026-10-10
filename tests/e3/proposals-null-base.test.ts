// a proposal for an empty date (contracts §17, §20 item 12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchApproval, toolCallHash, type ApprovalRecord } from "../../engine/approvals.ts";
import { createProposal, prBody, readProposal } from "../../engine/proposals.ts";
import { emptyDay, snapDay, snapshot, squat } from "../guard/fixtures.ts";
import { cli, writeJson } from "./helpers.ts";

const LH = "c".repeat(64);
const WRITE = { tool: "plan_workout_day", input: { date: "2026-10-16", dayType: "legs", dayName: "Legs", exercises: [squat], timezone: "America/Los_Angeles" } };

function record(id: string, base: Record<string, string | null>): ApprovalRecord {
  return { proposal_id: id, path: `athlete/proposals/${id}.yaml`, hashes: [toolCallHash(WRITE.tool, WRITE.input)], base, limits_hash: LH };
}

test("proposals create accepts base: {date: null} for an empty date and keeps the null", () => {
  const root = mkdtempSync(join(tmpdir(), "coach-e3-prop-"));
  const { id, path } = createProposal({ kind: "new_exercise", summary: "Add a Friday legs day", writes: [WRITE], base: { "2026-10-16": null }, limits_hash: LH, rule_ids: [] }, { root, now: "2026-10-14T07:00:00-07:00", tz: "America/Los_Angeles" });
  assert.match(readFileSync(path, "utf8"), /2026-10-16: null/);
  assert.deepEqual(readProposal(id, root).base, { "2026-10-16": null });
  assert.match(prBody(readProposal(id, root)), /2026-10-16: empty/);
});

test("the CLI path for a null base succeeds", () => {
  const root = mkdtempSync(join(tmpdir(), "coach-e3-prop-"));
  const input = writeJson(root, "p.json", { kind: "new_exercise", summary: "Add a Friday legs day", writes: [WRITE], base: { "2026-10-16": null }, limits_hash: LH, rule_ids: [] });
  const r = cli(["proposals", "create", "--input", input, "--root", root, "--now", "2026-10-14T07:00:00-07:00"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.json.id, /^P-20261014-new_exercise-1$/);
});

test("an empty string is still not a version", () => {
  const root = mkdtempSync(join(tmpdir(), "coach-e3-prop-"));
  assert.throws(() => createProposal({ kind: "new_exercise", summary: "x", writes: [WRITE], base: { "2026-10-16": "" }, limits_hash: LH, rule_ids: [] }, { root }), /version string, or null/);
});

test("matchApproval: null base matches only while the date is still empty", () => {
  const rec = record("P-20261014-new_exercise-1", { "2026-10-16": null });
  const empty = snapshot({ "2026-10-16": emptyDay() });
  assert.equal(matchApproval({ tool: WRITE.tool, args: WRITE.input }, [rec], empty, LH).record?.proposal_id, rec.proposal_id);
  const filled = snapshot({ "2026-10-16": snapDay("2026-10-16") });
  const m = matchApproval({ tool: WRITE.tool, args: WRITE.input }, [rec], filled, LH);
  assert.equal(m.record, null);
  assert.match(m.problems[0], /base version of 2026-10-16 changed/);
  // Not read at all: no match either.
  assert.match(matchApproval({ tool: WRITE.tool, args: WRITE.input }, [rec], snapshot({}), LH).problems[0], /not in the snapshot/);
});
