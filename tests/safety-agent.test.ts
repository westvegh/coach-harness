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

// ---------- P1 fixes 2 and 4: the release rule, and the facts the agent needs ----------

test("P1 fix 4: the agent text holds the facts and forbids reading the code", () => {
  const facts = /\n## Facts\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
  assert.ok(facts, "a Facts section");
  assert.match(facts, /Do not read `engine\/`, `adapters\/` or `docs\/contracts\.md`/);
  for (const s of ["node engine/cli.ts limits regions", "node engine/cli.ts limits schema", "node engine/cli.ts ids next --kind limit"]) assert.ok(facts.includes(s), `Facts names ${s}`);
  // One schema example per rule kind, as YAML that the engine accepts.
  const yamlBlock = /```yaml\n([\s\S]*?)\n```/.exec(facts)?.[1] ?? "";
  const entries = parse(yamlBlock) as Record<string, unknown>[];
  assert.ok(entries.some((l) => l.rule === "ban"));
  assert.ok(entries.some((l) => l.rule === "cap" && typeof l.max_sets_per_week === "number"));
  assert.ok(entries.some((l) => l.rule === "cap" && typeof l.max_load === "object"));
  // The hold effects after fix 1.
  for (const s of ["**Regional hold**", "**Systemic hold**", "**Urgent hold**", "**Pending file**"]) assert.ok(facts.includes(s), `Facts states ${s}`);
});

test("P1 fix 2: accepted limits release a regional hold in the same question, after the limits are written", () => {
  assert.match(body, /Add these limits and end the shoulder hold\? The limits keep protecting the shoulders\./);
  assert.match(body, /node engine\/cli\.ts hold clear --approved --by user --released-by-limits/);
  assert.match(body, /Never run it before the limits are written/);
  assert.match(body, /A systemic or urgent hold is never released this way/);
  assert.match(body, /Never release a systemic or urgent hold with limits/);
});

// ---------- P2 (the P1 review) ----------

test("P2 fixes 1, 2, 5 and 6: the agent text states the scope rule, the region ids, the pending-first release and the combined exercise", () => {
  const facts = /\n## Facts\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
  assert.match(facts, /\*\*Scope never narrows\.\*\* A new event never makes an active hold less strict/);
  assert.match(facts, /`hold set --regions` accepts only ids from `node engine\/cli\.ts limits regions` \(sides included\)\. An unknown id is refused/);
  assert.match(facts, /also when it is part of a combined exercise/);
  assert.match(facts, /when any safety check is pending \(`athlete\/\.safety-pending` exists, whatever its terms\)/);
  assert.match(facts, /an exercise that the engine cannot classify covers nothing/);
  const clearing = /\n## Clearing\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
  assert.match(clearing, /The release refuses while `athlete\/\.safety-pending` exists/);
  assert.match(clearing, /run `hold clear-pending --approved` first, then the release/);
  assert.match(clearing, /When the pending terms name another symptom \(for example dizziness\), go to Ask for that symptom\. Do not release until it is resolved\./);
});
