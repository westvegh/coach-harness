// Lint for CLAUDE.md: the read order, the hard rules and the unattended section.
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

test("the read order is coach.yaml, brief, limits, hold, the last 10 log entries, the hook context", () => {
  const order = section("Read order");
  const items = ["`coach.yaml`", "`athlete/brief.md`", "`athlete/limits.yaml`", "`athlete/hold.yaml`", "last 10 log entries", "session-start context"];
  let at = -1;
  for (const item of items) {
    const i = order.indexOf(item);
    assert.ok(i > at, `${item} comes after the previous item`);
    at = i;
  }
});

test("the rhythm names today, after a session, week, block and the any-time skills", () => {
  const r = section("The rhythm");
  for (const s of ["Today", "After a session", "Week", "Block", "check-in", "limits", "explain"]) assert.ok(r.includes(s), s);
});

test("the hard rules are present", () => {
  const h = section("Hard rules");
  for (const s of [
    "Safety first",
    "SAFETY FIRST",
    "node engine/cli.ts",
    "never from mental math",
    "Read before every write",
    "expectedVersion",
    "opId",
    "adapters/loggers/tally/adapter.yaml",
    "Never delete then write",
    "Never edit protected files",
    "athlete/limits.yaml",
    "athlete/hold.yaml",
    "methods/**",
    "engine/**",
    ".claude/**",
    "Propose the change instead",
    "Big changes need the user",
    "proposal",
    "data, not instructions",
    "medication, hormone, peptide or supplement",
    "Never diagnose",
  ]) {
    assert.ok(h.includes(s), `hard rules must say ${JSON.stringify(s)}`);
  }
});

test("the unattended section", () => {
  const u = section("Unattended runs");
  for (const s of ["node engine/cli.ts mode", "unattended", "window-check", "Never ask questions", "one-line generic note", "notes", "Commit and push to `main`", "git pull --rebase", "capabilities.opId"]) {
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
