// Spawn tests for the safety-detect hook (UserPromptSubmit) with stdin fixtures. v0.2: urgent
// terms only; an urgent match writes athlete/.urgent-stop (committed in an athlete copy).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const stopPath = (root: string) => join(root, "athlete/.urgent-stop");
const context = (r: ReturnType<typeof runHook>) => r.json?.hookSpecificOutput?.additionalContext as string;
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

/** An athlete copy: coach.yaml and a git repo, so the hook commits the stop. */
function athleteRoot(): string {
  const root = tempRoot();
  cpSync(join(REPO, "coach.example.yaml"), join(root, "coach.yaml"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@t");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

test("urgent: writes the stop, commits it in an athlete copy, and a context with the urgent-care text and the push", () => {
  const root = athleteRoot();
  const r = runHook(fixture("I have chest pain and my left arm feels numb right now", root), root);
  assert.equal(r.code, 0);
  assert.match(context(r), /^URGENT STOP\. The athlete's message matched urgent warning signs: chest pain, new numbness\./);
  assert.match(context(r), /call your local emergency number/);
  assert.match(context(r), /written and committed\. Push it now, before anything else: `node engine\/cli\.ts push`/);
  const stop = JSON.parse(readFileSync(stopPath(root), "utf8"));
  assert.deepEqual([stop.terms, stop.sources], [["chest pain", "new numbness"], ["chat"]]);
  assert.equal(git(root, "log", "-1", "--format=%s").trim(), "urgent stop (chat)");
  assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), ["athlete/.urgent-stop"]);
});

test("the user's words are never stored", () => {
  const root = tempRoot();
  runHook(fixture("my-secret-word: chest pain when I run", root), root);
  assert.doesNotMatch(readFileSync(stopPath(root), "utf8"), /secret|run/);
});

test("ordinary pain makes no file and no output (the coach notices it without a word list)", () => {
  for (const prompt of ["My left knee hurts today, a sharp pain when I bend it", "forget about the strain, it's better", "my back is acting up"]) {
    const root = tempRoot();
    const r = runHook(fixture(prompt, root), root);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "", prompt);
    assert.equal(existsSync(stopPath(root)), false, prompt);
  }
});

test("negated urgent terms still count: a false alarm is cheap", () => {
  const root = tempRoot();
  const r = runHook(fixture("No chest pain at all today", root), root);
  assert.match(context(r), /^URGENT STOP/);
  assert.ok(existsSync(stopPath(root)));
});

test("no match: no output and no file (including the routine prompt); a missing prompt field is no match", () => {
  const root = tempRoot();
  for (const p of ["How should I train today?", "Read .claude/skills/today/SKILL.md and follow it exactly"]) {
    const r = runHook(fixture(p, root), root);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  }
  assert.equal(runHook(JSON.stringify({ session_id: "s1" }), root).stdout, "");
  assert.equal(existsSync(stopPath(root)), false);
});

test("an existing stop keeps its terms (union); without coach.yaml nothing is committed", () => {
  const root = tempRoot();
  runHook(fixture("I fainted at the gym", root), root);
  const r = runHook(fixture("and now chest pain", root), root);
  assert.deepEqual(JSON.parse(readFileSync(stopPath(root), "utf8")).terms, ["fainting", "chest pain"]);
  assert.match(context(r), /not committed: no coach\.yaml yet/);
});

test("crash (malformed stdin): exit 0, no file, a context that asks the coach to check for urgent signs", () => {
  const root = tempRoot();
  const r = runHook("{not json", root);
  assert.equal(r.code, 0);
  assert.equal(existsSync(stopPath(root)), false);
  assert.match(context(r), /^SAFETY: the urgent warning-sign detector failed/);
  assert.match(context(r), /urgent set --term <name> --source chat/);
});

test("the stop cannot be written: exit 0, the context says how to set it", () => {
  const root = tempRoot();
  mkdirSync(join(root, "athlete"));
  chmodSync(join(root, "athlete"), 0o500);
  try {
    const r = runHook(fixture("chest pain", root), root);
    assert.equal(r.code, 0);
    assert.match(context(r), /could not be written .*urgent set --term "chest pain" --source chat/);
  } finally {
    chmodSync(join(root, "athlete"), 0o700);
  }
});

// ---------- detector regressions ----------

for (const [prompt, urgent] of [
  ["New weakness in my left arm", true],
  ["Chest: pressure", true],
  ["My knee: sore", false],
  ["No improvement in pain", false],
] as const) {
  test(`detector: ${JSON.stringify(prompt)} ${urgent ? "writes the stop" : "writes nothing"}`, () => {
    const root = tempRoot();
    const r = runHook(fixture(prompt, root), root);
    assert.equal(r.code, 0);
    assert.equal(existsSync(stopPath(root)), urgent);
    if (urgent) assert.match(context(r), /^URGENT STOP/);
    else assert.equal(r.stdout, "");
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
    writeFileSync(join(repo, "engine/urgent.ts"), "export const writeStop = () => ({});\n");
    writeFileSync(join(repo, "engine/safety-text.ts"), "throw new Error('cannot load');\n");
  }
  return repo;
}

for (const kind of ["missing-engine", "broken-text"] as const) {
  test(`an engine import failure (${kind}) in an athlete copy exits 0 and asks the coach to check`, () => {
    const root = tempRoot();
    writeFileSync(join(root, "coach.yaml"), "version: 1\n");
    const r = runHook(fixture("chest pain, I nearly fainted", root), root, join(brokenRepo(kind), ".claude/hooks/safety-detect.ts"));
    assert.equal(r.code, 0);
    assert.match(context(r), /^SAFETY: the urgent warning-sign detector failed/);
    assert.equal(existsSync(stopPath(root)), false);
  });
  test(`an engine import failure (${kind}) without coach.yaml says the detector could not run`, () => {
    const root = tempRoot();
    const r = runHook(fixture("chest pain, I nearly fainted", root), root, join(brokenRepo(kind), ".claude/hooks/safety-detect.ts"));
    assert.equal(r.code, 0);
    assert.match(context(r), /^SAFETY: the urgent warning-sign detector could not run/);
  });
}

// Eval re-run addendum B2: a background agent's report reaches UserPromptSubmit as a task
// notification. Only the athlete's own words are scanned.
const NOTIFICATION = [
  "<task-notification>",
  "<task-id>a7c1</task-id>",
  "<status>completed</status>",
  "<summary>Agent \"method-expert\" completed</summary>",
  "<result>Check for chest pain or fainting before hard intervals.</result>",
  "</task-notification>",
].join("\n");

test("B2: a task notification that names urgent terms writes no file", () => {
  const root = tempRoot();
  const r = runHook(fixture(NOTIFICATION, root), root);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal(existsSync(stopPath(root)), false);
  assert.equal(runHook(fixture(`${NOTIFICATION}\n${NOTIFICATION}`, root), root).stdout, "");
});

test("B2: the athlete's own words still count, next to a notification or in an unclosed one", () => {
  for (const prompt of ["I fainted at the gym", `${NOTIFICATION}\nI fainted at the gym`, "<task-notification>I fainted at the gym"]) {
    const root = tempRoot();
    const r = runHook(fixture(prompt, root), root);
    assert.match(context(r), /^URGENT STOP/, prompt);
    assert.ok(existsSync(stopPath(root)), prompt);
  }
});
