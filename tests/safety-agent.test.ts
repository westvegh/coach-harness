// Lint for .claude/agents/safety.md: required sections, and no write tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const FILE = new URL("../.claude/agents/safety.md", import.meta.url);
const text = readFileSync(FILE, "utf8");
const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
const front = m ? (parse(m[1]) as Record<string, unknown>) : {};
const body = m ? m[2] : "";
const tools = String(front.tools ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const TALLY_WRITES = /(plan_workout_day|plan_workout_range|update_planned_workout|move_planned_workout|skip_planned_workout|delete_planned_workout|update_user_profile|update_training_limits)$/;

test("frontmatter: name safety, a precise description, an explicit tools list", () => {
  assert.ok(m, "the file needs YAML frontmatter");
  assert.equal(front.name, "safety");
  const d = String(front.description ?? "");
  assert.ok(d.length > 200 && d.length < 1000, `description length ${d.length}`);
  for (const w of ["SAFETY FIRST", ".safety-pending", "hold", "pain", "never diagnoses"]) assert.ok(d.includes(w), `description names ${w}`);
  assert.ok(tools.length > 0, "an explicit tools list is required: without it the agent inherits every tool");
});

test("tools exclude every Tally write tool, file writes and wildcards", () => {
  for (const t of tools) {
    assert.doesNotMatch(t, TALLY_WRITES, `${t} is a Tally write tool`);
    assert.ok(!["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task"].includes(t), `${t} is not allowed`);
    assert.ok(!t.includes("*"), `${t}: no wildcards`);
  }
  assert.ok(tools.includes("Bash") && tools.includes("Read"));
  assert.ok(tools.some((t) => t.endsWith("__get_training_context")));
});

test("the body has the required sections", () => {
  for (const h of ["## Read first", "## Ask", "## Decide", "## Clearing", "## Clinician reports", "## Never", "## Unattended runs", "## Output"]) {
    assert.ok(body.includes(`\n${h}\n`), `missing section ${h}`);
  }
});

test("the body states the safety rules", () => {
  for (const s of [
    "node engine/cli.ts hold status",
    "athlete/limits.yaml",
    "checkin.pain",
    "node engine/cli.ts hold set",
    "node engine/cli.ts hold clear-pending",
    "--approved",
    "clinician-reported",
    "Never diagnose",
    "medication, supplement, hormone or peptide",
    "URGENT_CARE_TEXT",
    "PAIN_TEXT",
    "SAFETY RESULT",
  ]) {
    assert.ok(body.includes(s), `the body must say ${JSON.stringify(s)}`);
  }
  for (const q of ["Where is it", "0 to 10", "Since when", "sharp or dull"]) assert.ok(body.includes(q), `question ${q}`);
});
