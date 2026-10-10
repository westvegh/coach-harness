// Spawn tests for the safety-detect hook (UserPromptSubmit) with stdin fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname;
const HOOK = join(REPO, ".claude/hooks/safety-detect.ts");

function runHook(stdin: string, root: string, hook = HOOK) {
  const r = spawnSync(process.execPath, [hook], { input: stdin, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root }, timeout: 10_000 });
  let json: any = null;
  try {
    json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {
    /* not JSON */
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const fixture = (prompt: unknown, root: string) =>
  JSON.stringify({ session_id: "s1", hook_event_name: "UserPromptSubmit", cwd: root, permission_mode: "default", prompt });
const tempRoot = () => mkdtempSync(join(tmpdir(), "coach-hook-"));
const pendingPath = (root: string) => join(root, "athlete/.safety-pending");
const context = (r: ReturnType<typeof runHook>) => r.json?.hookSpecificOutput?.additionalContext as string;

test("urgent: writes the pending file and a context that starts with SAFETY FIRST (urgent)", () => {
  const root = tempRoot();
  const r = runHook(fixture("Tight chest and I nearly fainted on the bike", root), root);
  assert.equal(r.code, 0);
  assert.equal(r.json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(context(r), /^SAFETY FIRST \(urgent\)/);
  assert.match(context(r), /Stop all training talk/);
  assert.match(context(r), /emergency number/);
  assert.match(context(r), /`safety` agent/);
  const p = JSON.parse(readFileSync(pendingPath(root), "utf8"));
  assert.equal(p.source, "prompt");
  assert.ok(p.terms.includes("chest pain") && p.terms.includes("fainting"));
  assert.deepEqual(Object.keys(p).sort(), ["at", "source", "terms"]);
});

test("pain: writes the pending file and a SAFETY FIRST context that runs the safety agent first", () => {
  const root = tempRoot();
  const r = runHook(fixture("my left knee hurts after yesterday", root), root);
  assert.equal(r.code, 0);
  assert.match(context(r), /^SAFETY FIRST\. /);
  assert.doesNotMatch(context(r), /urgent/);
  assert.match(context(r), /run the `safety` agent/);
  const p = JSON.parse(readFileSync(pendingPath(root), "utf8"));
  assert.deepEqual(p.terms, ["hurt", "region:left-knee"]);
});

test("the user's words are never stored", () => {
  const root = tempRoot();
  runHook(fixture("my knee hurts since the zorblax incident", root), root);
  assert.doesNotMatch(readFileSync(pendingPath(root), "utf8"), /zorblax|incident|since/);
});

test("negated pain: no output and no pending file", () => {
  const root = tempRoot();
  const r = runHook(fixture("no pain at all, the knee doesn't hurt anymore", root), root);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal(existsSync(pendingPath(root)), false);
});

test("no match: no output and no pending file (including the routine prompt)", () => {
  const root = tempRoot();
  for (const prompt of ["what's on for today?", "Read .claude/skills/today/SKILL.md and follow it exactly. Unattended run."]) {
    const r = runHook(fixture(prompt, root), root);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  }
  assert.equal(existsSync(pendingPath(root)), false);
});

test("a missing prompt field is no match", () => {
  const root = tempRoot();
  const r = runHook(JSON.stringify({ hook_event_name: "UserPromptSubmit" }), root);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("an existing pending file keeps its terms (union)", () => {
  const root = tempRoot();
  runHook(fixture("my shoulder hurts", root), root);
  runHook(fixture("and my back went out", root), root);
  const p = JSON.parse(readFileSync(pendingPath(root), "utf8"));
  assert.ok(p.terms.includes("region:shoulder") && p.terms.includes("went out") && p.terms.includes("region:low-back"));
});

test("crash (malformed stdin): exit 0, a pending file with detector-error, and a SAFETY FIRST context", () => {
  const root = tempRoot();
  const r = runHook("{not json", root);
  assert.equal(r.code, 0);
  assert.match(context(r), /^SAFETY FIRST\. The safety detector failed/);
  assert.deepEqual(JSON.parse(readFileSync(pendingPath(root), "utf8")).terms, ["detector-error"]);
});

test("pending file cannot be written: exit 0, the context still goes to Claude", () => {
  const root = tempRoot();
  writeFileSync(join(root, "athlete"), "a file where the athlete folder should be");
  const r = runHook(fixture("my wrist hurts", root), root);
  assert.equal(r.code, 0);
  assert.match(context(r), /^SAFETY FIRST\. /);
  assert.match(context(r), /could not be written/);
});

test("crash and the pending file cannot be written: exit 0, the message goes through", () => {
  const root = tempRoot();
  writeFileSync(join(root, "athlete"), "not a folder");
  const r = runHook("{not json", root);
  assert.equal(r.code, 0);
  assert.match(context(r), /could not be written/);
});

test("if .claude/settings.json registers safety-detect, it uses onFailure continue and a timeout of 10 s or less", () => {
  const path = join(REPO, ".claude/settings.json");
  if (!existsSync(path)) return; // registered by the guard-hooks chunk (B)
  const settings = JSON.parse(readFileSync(path, "utf8"));
  const entries = (settings.hooks?.UserPromptSubmit ?? []).flatMap((m: any) => m.hooks ?? []);
  const mine = entries.filter((h: any) => String(h.command ?? "").includes("safety-detect"));
  assert.equal(mine.length, 1, "safety-detect must be registered once under UserPromptSubmit");
  assert.equal(mine[0].onFailure, "continue");
  assert.ok(typeof mine[0].timeout === "number" && mine[0].timeout <= 10);
});

// ---------- detector regressions ----------

for (const [prompt, urgent] of [
  ["New weakness in my left arm", true],
  ["Chest: pressure", true],
  ["My knee: sore", false],
  ["No improvement in pain", false],
  ["The pain has not gone", false],
] as const) {
  test(`detector: ${JSON.stringify(prompt)} writes the pending file and a SAFETY FIRST context`, () => {
    const root = tempRoot();
    const r = runHook(fixture(prompt, root), root);
    assert.equal(r.code, 0);
    assert.match(context(r), urgent ? /^SAFETY FIRST \(urgent\)/ : /^SAFETY FIRST\. /);
    assert.ok(existsSync(pendingPath(root)));
  });
}

/** A copy of the hook in a fake repo whose engine modules are missing or broken. */
function brokenRepo(kind: "missing-engine" | "broken-text"): string {
  const repo = mkdtempSync(join(tmpdir(), "coach-hook-repo-"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module" }));
  mkdirSync(join(repo, ".claude/hooks"), { recursive: true });
  copyFileSync(HOOK, join(repo, ".claude/hooks/safety-detect.ts"));
  if (kind === "broken-text") {
    mkdirSync(join(repo, "engine"));
    writeFileSync(join(repo, "engine/safety.ts"), "export const detect = () => ({ urgent: [], pain: [], regions: [] });\n");
    writeFileSync(join(repo, "engine/safety-text.ts"), "throw new Error('cannot load');\n");
  }
  return repo;
}

for (const kind of ["missing-engine", "broken-text"] as const) {
  test(`an engine import failure (${kind}) in an athlete instance still writes detector-error and exits 0`, () => {
    const root = tempRoot();
    writeFileSync(join(root, "coach.yaml"), "version: 1\n");
    const repo = brokenRepo(kind);
    const r = runHook(fixture("chest pain, I nearly fainted", root), root, join(repo, ".claude/hooks/safety-detect.ts"));
    assert.equal(r.code, 0);
    assert.match(context(r), /^SAFETY FIRST\. The safety detector failed/);
    const p = JSON.parse(readFileSync(pendingPath(root), "utf8"));
    assert.deepEqual([p.terms, p.source], [["detector-error"], "prompt"]);
    assert.doesNotMatch(readFileSync(pendingPath(root), "utf8"), /fainted/);
  });
}

for (const kind of ["missing-engine", "broken-text"] as const) {
  test(`review finding 6: an engine import failure (${kind}) without coach.yaml writes no pending file`, () => {
    const root = tempRoot();
    const repo = brokenRepo(kind);
    const r = runHook(fixture("chest pain, I nearly fainted", root), root, join(repo, ".claude/hooks/safety-detect.ts"));
    assert.equal(r.code, 0);
    assert.equal(existsSync(pendingPath(root)), false, "no pending file before setup");
    assert.equal(context(r), "SAFETY: the pain and red-flag detector could not run (packages are not installed). Ask about pain and red flags before any plan.");
  });
}

// Eval re-run addendum B2: a background agent's report reaches UserPromptSubmit as a task
// notification. Only the athlete's own words are scanned.
const NOTIFICATION = [
  "<task-notification>",
  "<task-id>a7c1</task-id>",
  "<status>completed</status>",
  "<summary>Agent \"method-expert\" completed</summary>",
  "<result>Goal: a pain-free left knee. L-001 caps knee pain loads; the chest and shoulder volume is fine.</result>",
  "</task-notification>",
].join("\n");

test("B2: a task notification that names pain and body regions writes no pending file", () => {
  const root = tempRoot();
  const r = runHook(fixture(NOTIFICATION, root), root);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal(existsSync(pendingPath(root)), false);
  // Two notifications in one prompt.
  const two = runHook(fixture(`${NOTIFICATION}\n${NOTIFICATION}`, root), root);
  assert.equal(two.stdout, "");
  assert.equal(existsSync(pendingPath(root)), false);
});

test("B2: the athlete's own words still count, next to a notification or in an unclosed one", () => {
  for (const prompt of ["My left knee has a sharp pain today", `${NOTIFICATION}\nMy left knee has a sharp pain today`, "<task-notification>My left knee has a sharp pain today"]) {
    const root = tempRoot();
    const r = runHook(fixture(prompt, root), root);
    assert.equal(r.code, 0);
    assert.match(context(r), /^SAFETY FIRST/, prompt);
    assert.ok(existsSync(pendingPath(root)), prompt);
  }
});
