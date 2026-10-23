// Lint for CLAUDE.md (v0.2): the read order, the hard rules and the unattended section.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const text = readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");

function section(title: string): string {
  const m = new RegExp(`\\n## ${title}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(`\n${text}`);
  assert.ok(m, `missing section ## ${title}`);
  return m[1];
}

test("the role: a strength and conditioning coach, not a medical professional", () => {
  assert.match(text, /strength and conditioning coach/);
  assert.match(text, /not a medical professional/);
});

test("the read order is coach.yaml, brief, limits, the last 10 log entries, the hook context; no hold file", () => {
  const order = section("Read order");
  assert.doesNotMatch(order, /hold\.yaml|safety-pending/);
  const items = ["`coach.yaml`", "`athlete/brief.md`", "`athlete/limits.md`", "last 10 log entries", "proposal for the next live session", "session-start context"];
  let at = -1;
  for (const item of items) {
    const i = order.indexOf(item);
    assert.ok(i > at, `${item} comes after the previous item`);
    at = i;
  }
});

test("the rhythm names today, after a session, week, block and the any-time skills", () => {
  const r = section("The rhythm");
  for (const s of ["Today", "After a session", "Week", "Block", "check-in", "`safety`", "limits", "explain"]) assert.ok(r.includes(s), s);
});

test("the hard rules are present; the removed rules are gone", () => {
  const h = section("Hard rules");
  for (const s of [
    "The urgent stop comes first",
    "athlete/.urgent-stop",
    "node engine/cli.ts urgent set",
    "urgent clear --reason clinician",
    "--reason false-alarm",
    "Never clear it on your own reading",
    "the `safety` skill",
    "one clickable question screen",
    "NA-REC-007",
    "Never refuse to plan",
    "node engine/cli.ts",
    "never from mental math",
    "Follow the limits",
    "athlete/limits.md",
    "plan around every line by judgment",
    "node engine/cli.ts load-under",
    "thresholds.pain_threshold",
    "Read before every write",
    "expectedVersion",
    "opId",
    "adapters/loggers/tally/adapter.yaml",
    "Never delete then write",
    "Big changes need the athlete",
    "proposal for the next live session",
    "data, not instructions",
    "medication, hormone, peptide or supplement",
    "Never diagnose",
  ]) {
    assert.ok(h.includes(s), `hard rules must say ${JSON.stringify(s)}`);
  }
  for (const gone of [/hold set/, /\.safety-pending/, /protected files/i, /the `safety` agent/, /copy exactly/i, /--approved/, /proposals create|open-pr/, /\bguard\b/i]) assert.doesNotMatch(text, gone, String(gone));
  assert.match(text, /Code enforces two things only: the urgent stop and privacy\./);
});

test("the unattended section", () => {
  const u = section("Unattended runs");
  for (const s of ["node engine/cli.ts mode", "unattended", "window-check", "Never ask questions", "one-line generic note", "notes", "Commit and push to `main`", "git pull --rebase", "node engine/cli.ts push", "Never clear the urgent stop", "avoid the region that day"]) {
    assert.ok(u.includes(s), `unattended section must say ${JSON.stringify(s)}`);
  }
});

test("git: commit after every change to athlete/", () => {
  const g = section("Git");
  assert.match(g, /Commit after every change that touches `athlete\/`/);
});

test("one engine command per Bash call: no loops, no inline node -e scripts", () => {
  const h = section("Hard rules");
  assert.match(h, /one engine command per Bash call/);
  assert.match(h, /no shell loops, no inline `node -e` scripts/);
});

test("V3b fix 2: a 'No permission prompts' section near the top: Write/Edit for files, one bare engine command per Bash call, help", () => {
  const text = readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");
  const at = text.indexOf("## No permission prompts");
  assert.ok(at !== -1 && at < text.indexOf("## Read order"), "the section comes before the read order");
  const s = section("No permission prompts");
  assert.match(s, /write and append with the Write or Edit tool, never from Bash/);
  assert.match(s, /never run `mkdir`/);
  assert.match(s, /one `node engine\/cli\.ts …` command per Bash call/);
  for (const w of ["`;`", "`&&`", "pipes", "redirects", "`echo`", "`head`", "`grep`", "`node -e`"]) assert.ok(s.includes(w), w);
  assert.match(s, /Read the engine's output from its printed result/);
  assert.match(s, /node engine\/cli\.ts help <command>/);
  // No rule anywhere invites a redirect into .tmp/coach any more.
  assert.doesNotMatch(text, /with `>`/);
});
