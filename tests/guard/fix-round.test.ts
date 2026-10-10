// The guard fix round after the launch-hardening review (contracts §23). One test per
// finding, each with the reviewer's probe; each fails on the code before this round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { classifyChange } from "../../engine/classify.ts";
import { readHold, setHold } from "../../engine/hold.ts";
import { createProposal } from "../../engine/proposals.ts";
import { fileGuard, unattendedBash } from "../../engine/protect.ts";
import { loadLogger } from "../../engine/logger.ts";
import { guard, urgentEvent, type GuardInput } from "../../engine/validate.ts";
import * as fast from "../../.claude/hooks/fast-files.ts";
import { block, config, emptyDay, guardInput, NOW, REPO, rules, snapDay, snapshot, squat, tax, v } from "./fixtures.ts";

const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR"].includes(k)));
const GIT_ENV = { ...BASE_ENV, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV }).trim();

function instance(origin: string | null = "https://github.com/alex/coach.git"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coach-round-")));
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  mkdirSync(join(dir, "athlete/log"), { recursive: true });
  mkdirSync(join(dir, ".tmp/coach"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  if (origin) git(dir, "remote", "add", "origin", origin);
  return dir;
}

type Mode = "interactive" | "unattended";
const guardCall = (root: string, tool_name: string, tool_input: Record<string, unknown>, mode: Mode) => fileGuard({ tool_name, tool_input, mode, root, branch: "main", proposalsOnMain: [] });
const bash = (root: string, command: string, mode: Mode = "unattended") => guardCall(root, "Bash", { command }, mode);

function cli(root: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), ...args, "--root", root], { cwd: root, encoding: "utf8", env: { ...GIT_ENV, ...env } });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stderr: r.stderr };
}

test("finding 1: brace expansion, globs and other shell syntax deny unattended; git read options are an allowlist", () => {
  const root = instance();
  for (const c of [
    "git log -1 --format='%nhello' --{output,output}=outside.txt",
    "git log --format='%nhello' --{output,output}=.tmp/coach/script.js",
    "git diff --{ext-diff,ext-diff}",
    "git log engine/*",
    "git diff ~/x",
    "git log [a]",
    "git log !x",
    "git status #x",
    "git log --out",
    "git log --graph",
    "git status --ignored",
    "git diff --no-index a b",
    "git log --pretty=format:x",
  ]) {
    assert.notEqual(unattendedBash(c, root), null, c);
    assert.equal(bash(root, c).decision, "deny", c);
  }
  for (const c of ["git status", "git status --porcelain", "git status -s -b", "git diff --stat", "git diff --cached --name-only", "git log --oneline -5", "git log -n 3 --format=%h", "git log --format='%h %s' --since=2026-10-01", "git log --stat -- athlete/log", "git diff main -- athlete"]) {
    assert.equal(unattendedBash(c, root), null, c);
  }
});

test("finding 2: a backslash-newline continuation cannot hide install-launchd or checkin; install-launchd refuses itself unattended", () => {
  const root = instance();
  for (const c of ["node engine/cli.ts in\\\nstall-launchd --kind daily --yes --load", "node engine/cli.ts ch\\\neckin --date 2026-10-14", "node engine/cli.ts mo\\de"]) {
    assert.equal(bash(root, c).decision, "deny", JSON.stringify(c));
  }
  const r = cli(root, ["install-launchd", "--kind", "daily", "--yes"], { COACH_UNATTENDED: "1" });
  assert.notEqual(r.code, 0);
  assert.equal(r.json?.error?.code, "UNATTENDED");
});

test("finding 3: gh api reaches only origin's repository", () => {
  const root = instance();
  assert.notEqual(unattendedBash("gh api repos/other/public-repo/pulls -X POST -f title=Test -f head=branch -f base=main", root), null);
  assert.notEqual(unattendedBash("gh api repos/other/coach", root), null);
  assert.equal(unattendedBash("gh api repos/alex/coach --jq .visibility", root), null);
  assert.equal(unattendedBash("gh api repos/Alex/Coach", root), null, "case-insensitive");
  assert.equal(unattendedBash("gh api -X POST repos/alex/coach/pulls -f title=x -f head=proposal/P-1 -f base=main", root), null);
  for (const r of [instance(null), instance("/tmp/not-github.git")]) assert.notEqual(unattendedBash("gh api repos/alex/coach", r), null, "no GitHub origin");
});

test("finding 4: a field turns gh api into POST", () => {
  const root = instance();
  assert.notEqual(unattendedBash("gh api repos/alex/coach/pulls/1 -f state=closed", root), null);
  assert.notEqual(unattendedBash("gh api repos/alex/coach -F visibility=public", root), null);
  assert.notEqual(unattendedBash("gh api repos/alex/coach/pulls/1 --raw-field state=closed", root), null);
  assert.equal(unattendedBash("gh api repos/alex/coach/pulls -f title=x -f head=b -f base=main", root), null, "POST to pulls passes");
  assert.equal(unattendedBash("gh api -X GET repos/alex/coach/pulls -f state=open", root), null, "an explicit GET with query fields passes");
});

test("finding 5: date takes only +FORMAT operands and -u", () => {
  const root = instance();
  for (const c of ["date 100914302026", "date -r 0", "date -s 2026-10-10", "date -f x y", "TZ=UTC date 1009"]) assert.notEqual(unattendedBash(c, root), null, c);
  for (const c of ["date -u +%Y-%m-%dT%H:%M:%SZ", "TZ=America/Los_Angeles date +%F", "date", "date '+%F %H:%M'"]) assert.equal(unattendedBash(c, root), null, c);
});

test("finding 6: $ denies even in quotes; node engine/hold.ts is the documented hold entry", () => {
  const root = instance();
  assert.notEqual(unattendedBash("git log --format='x$HOME'", root), null);
  assert.notEqual(unattendedBash('git commit -m "a $(id)"', root), null);
  assert.equal(unattendedBash("node engine/hold.ts status", root), null);
  assert.match(readFileSync(join(REPO, "docs/contracts.md"), "utf8"), /`node engine\/hold\.ts <command>`/);
});

test("finding 7 (rejected, with a doc fix): package-lock.json is an executable file; the prompt names the npm ci repair", async () => {
  const root = instance();
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  assert.equal(guardCall(root, "Write", { file_path: "package-lock.json", content: "{}" }, "interactive").decision, "ask");
  assert.equal(guardCall(root, "Write", { file_path: "package-lock.json", content: "{}" }, "unattended").decision, "deny");
  assert.equal(fast.fastFileDecision("Write", { file_path: "package-lock.json", content: "{}" }, root), null);
  const { routinePrompt } = await import("../../engine/automation.ts");
  assert.match(routinePrompt("daily", "cloud"), /If node_modules is missing, run npm ci first\./);
  assert.match(readFileSync(join(REPO, "automation/routine.md"), "utf8"), /If node_modules is missing, run npm ci first\./);
  assert.match(readFileSync(join(REPO, "docs/contracts.md"), "utf8"), /\*\*Package repair:\*\*/);
});

test("finding 8: a dangling symlink cannot point a write or a redirect outside, or at a script", () => {
  const root = instance();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "coach-outside-")));
  symlinkSync(join(outside, "new.js"), join(root, ".tmp/coach/link.json"));
  symlinkSync(join(outside, "x.md"), join(root, "athlete/log/2026-11.md"));
  symlinkSync(join(root, "engine/x.ts"), join(root, ".tmp/coach/inside.json"));
  symlinkSync(join(root, ".tmp/coach/loop-b"), join(root, ".tmp/coach/loop-a"));
  symlinkSync(join(root, ".tmp/coach/loop-a"), join(root, ".tmp/coach/loop-b"));
  for (const f of [".tmp/coach/link.json", "athlete/log/2026-11.md", ".tmp/coach/inside.json", ".tmp/coach/loop-a"]) {
    assert.equal(guardCall(root, "Write", { file_path: f, content: "x" }, "unattended").decision, "deny", f);
    // The fast path (interactive only) allows only what the engine allows interactive.
    if (fast.fastFileDecision("Write", { file_path: f, content: "x" }, root) === "allow") {
      assert.equal(guardCall(root, "Write", { file_path: f, content: "x" }, "interactive").decision, "allow", `fast: ${f}`);
    }
  }
  for (const f of [".tmp/coach/link.json", ".tmp/coach/inside.json", ".tmp/coach/loop-a"]) assert.equal(fast.fastFileDecision("Write", { file_path: f, content: "x" }, root), null, `fast: ${f}`);
  assert.equal(guardCall(root, "Write", { file_path: ".tmp/coach/link.json", content: "x" }, "interactive").decision, "ask", "the target is a .js file");
  assert.equal(guardCall(root, "Write", { file_path: ".tmp/coach/loop-a", content: "x" }, "interactive").decision, "ask", "a loop");
  for (const c of ["node engine/cli.ts mode > .tmp/coach/link.json", "node engine/cli.ts mode > .tmp/coach/inside.json"]) {
    assert.equal(bash(root, c).decision, "deny", c);
    assert.notEqual(bash(root, c, "interactive").decision, "allow", c);
  }
  // Ordinary files and links inside the scratch folder still pass.
  symlinkSync(join(root, ".tmp/coach/real.json"), join(root, ".tmp/coach/alias.json"));
  for (const f of [".tmp/coach/real.json", ".tmp/coach/alias.json", "athlete/log/2026-10.md"]) assert.equal(guardCall(root, "Write", { file_path: f, content: "x" }, "unattended").decision, "allow", f);
});

// ---------- finding 9: the urgent check and the classifier see every exercise field ----------

const D = "2026-10-15";
const V = v(`r-${D}`, "t0");
const bike = { exerciseId: "zone2_bike", name: "Zone 2 Bike", suggestedSets: 1, suggestedDuration: 600, distanceMeters: 1000 };
const lunge = { exerciseId: "Dumbbell_Lunge", name: "Lunge", suggestedSets: 3, suggestedReps: 10, suggestedWeight: 30 };
const days = (exercises: unknown[]) => ({ "2026-10-12": emptyDay(), "2026-10-13": emptyDay(), [D]: snapDay(D, { exercises }) });
const run = (exercises: unknown[], operations: unknown[], over: Partial<GuardInput> = {}) =>
  guard(guardInput({ tool: "update_planned_workout", args: { date: D, expectedVersion: V, operations }, snapshot: snapshot(days(exercises)), ...over }));
const urgentHold = { active: true, set_at: NOW, reason: "urgent warning sign reported 2026-10-14", regions: [], set_by: "safety-agent", urgent: true };
const chestPain = { at: NOW, terms: ["chest pain"], source: "prompt" as const };

test("finding 9a: under an urgent event, a distance or per-side change denies", () => {
  const dist = run([bike], [{ op: "modify", target: { exerciseId: "zone2_bike" }, fields: { distanceMeters: 20000 } }], { hold: urgentHold, pending: chestPain });
  assert.equal(dist.decision, "deny", dist.reasons.join("; "));
  const side = run([squat, lunge], [{ op: "modify", target: { exerciseId: "Dumbbell_Lunge" }, fields: { perSide: true } }], { hold: urgentHold });
  assert.equal(side.decision, "deny", side.reasons.join("; "));
  // A note on unchanged exercises still passes.
  const note = run([bike], [{ op: "modify", target: { exerciseId: "zone2_bike" }, fields: { suggestedSets: 1 } }], { hold: urgentHold });
  assert.equal(note.decision, "allow", note.reasons.join("; "));
});

test("finding 9b: a distance or per-side change on an ordinary day is a prescription change, not annotate", () => {
  const logger = loadLogger("tally");
  const ctx = { block: block(), history: [], tool: "update_planned_workout" as const, snapshotDay: null, tax: tax(), rules: rules(), config: config(), today: "2026-10-14" };
  const before = logger.toDayPlan(D, snapDay(D, { exercises: [bike] }), "lbs");
  const longer = logger.toDayPlan(D, snapDay(D, { exercises: [{ ...bike, distanceMeters: 20000 }] }), "lbs");
  assert.ok(!classifyChange(before, longer, ctx).kinds.includes("annotate"));
  const b2 = logger.toDayPlan(D, snapDay(D, { exercises: [lunge] }), "lbs");
  const sided = logger.toDayPlan(D, snapDay(D, { exercises: [{ ...lunge, perSide: true }] }), "lbs");
  assert.ok(!classifyChange(b2, sided, ctx).kinds.includes("annotate"));
  assert.ok(classifyChange(before, logger.toDayPlan(D, snapDay(D, { exercises: [bike], notes: "x" }), "lbs"), ctx).kinds.includes("annotate"), "a note is still annotate");
  // Under an ordinary hold, per side is more work: not a trim.
  const ordinary = { active: true, set_at: NOW, reason: "left knee pain 5/10", regions: [], set_by: "safety-agent" };
  assert.equal(run([lunge], [{ op: "modify", target: { exerciseId: "Dumbbell_Lunge" }, fields: { perSide: true } }], { hold: ordinary }).decision, "deny");
  assert.equal(run([lunge], [{ op: "modify", target: { exerciseId: "Dumbbell_Lunge" }, fields: { suggestedSets: 2 } }], { hold: ordinary }).decision, "allow", "a real trim still passes");
});

test("finding 10: extending a reason-derived urgent hold keeps it urgent (the reviewer's probe)", () => {
  const root = mkdtempSync(join(tmpdir(), "coach-round-hold-"));
  mkdirSync(join(root, "athlete"));
  writeFileSync(join(root, "athlete/hold.yaml"), stringify({ active: true, set_at: NOW, reason: "chest pain", regions: [], set_by: "safety-agent" }));
  assert.notEqual(urgentEvent(readHold(root), null), null);
  const extended = setHold(root, { reason: "recovery check", now: NOW });
  assert.equal(extended.urgent, true);
  assert.notEqual(urgentEvent(readHold(root), null), null);
  const trim = run([squat], [{ op: "modify", target: { exerciseId: "Barbell_Squat" }, fields: { suggestedSets: 2 } }], { hold: readHold(root) });
  assert.equal(trim.decision, "deny", trim.reasons.join("; "));
  // A new hold whose reason names an urgent term is urgent too.
  const fresh = mkdtempSync(join(tmpdir(), "coach-round-hold-"));
  mkdirSync(join(fresh, "athlete"));
  assert.equal(setHold(fresh, { reason: "pending safety check 2026-10-14: fainting", now: NOW }).urgent, true);
});

// ---------- finding 11: a drafted block never reaches main uncommitted ----------

function proposalRepo(): { root: string; id: string } {
  const root = instance();
  writeFileSync(join(root, "athlete/block.yaml"), stringify(block()));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const p = createProposal({ kind: "new_block", summary: "block B-002", writes: [{ tool: "plan_workout_day", input: {} }], base: {}, limits_hash: "a".repeat(64), rule_ids: [] }, { root, now: "2026-10-11T17:07:00Z" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "proposal");
  git(root, "switch", "-q", "-c", `proposal/${p.id}`);
  writeFileSync(join(root, ".tmp/coach/block.json"), JSON.stringify(block({ id: "B-002", start: "2026-10-12" })));
  return { root, id: p.id };
}

test("finding 11a: block write commits the block on the proposal branch; a failed commit restores the files", () => {
  const { root, id } = proposalRepo();
  const r = cli(root, ["block", "write", "--input", ".tmp/coach/block.json", "--proposal", id], { COACH_UNATTENDED: "1" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.committed, true);
  assert.equal(git(root, "status", "--porcelain", "--", "athlete"), "", "nothing uncommitted under athlete/");
  assert.match(git(root, "log", "-1", "--format=%s"), new RegExp(`proposal ${id}: block B-002`));
  assert.match(git(root, "show", "--name-only", "--format=", "HEAD"), /athlete\/block\.yaml[\s\S]*athlete\/blocks\/B-001\.yaml|athlete\/blocks\/B-001\.yaml[\s\S]*athlete\/block\.yaml/);

  const failing = proposalRepo();
  const hook = join(failing.root, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const before = readFileSync(join(failing.root, "athlete/block.yaml"), "utf8");
  const f = cli(failing.root, ["block", "write", "--input", ".tmp/coach/block.json", "--proposal", failing.id]);
  assert.equal(f.json?.error?.code, "GIT_ERROR");
  assert.equal(readFileSync(join(failing.root, "athlete/block.yaml"), "utf8"), before, "the previous block is back");
  assert.equal(existsSync(join(failing.root, "athlete/blocks/B-001.yaml")), false, "no archive left behind");
  assert.equal(git(failing.root, "status", "--porcelain", "--", "athlete"), "");
});

test("finding 11b/c: git switch runs alone unattended, and no unattended Bash runs in the background", () => {
  const { root, id } = proposalRepo();
  const probe = `node engine/cli.ts block write --input .tmp/coach/block.json --proposal ${id} && git switch main`;
  assert.notEqual(unattendedBash(probe, root), null);
  assert.equal(bash(root, probe).decision, "deny");
  for (const c of ["git switch main; node engine/cli.ts mode", "node engine/cli.ts mode\ngit switch main"]) assert.equal(bash(root, c).decision, "deny", JSON.stringify(c));
  assert.equal(bash(root, "git switch main").decision, "allow");
  const bg = (mode: Mode) => guardCall(root, "Bash", { command: "node engine/cli.ts mode", run_in_background: true }, mode).decision;
  assert.equal(bg("unattended"), "deny");
  assert.equal(bg("interactive"), "allow");
});

// ---------- finding 12: unattended pushes go through node engine/cli.ts push ----------

/** A fake gh: `gh api repos/<o>/<r> --jq .visibility` prints $FAKE_VIS, or fails when it is unset. */
function fakeGh(): string {
  const bin = mkdtempSync(join(tmpdir(), "fake-gh-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nif [ -z "$FAKE_VIS" ]; then echo "HTTP 404" >&2; exit 1; fi\necho "$FAKE_VIS"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

/**
 * A clone whose GitHub origin (git@github.com:alex/coach.git) reaches a local bare
 * repository through a fake ssh. Its engine/prepush.ts is a stub (the hook's own checks are
 * tested in tests/hooks/prepush.test.ts). `env` carries the fake ssh.
 */
function pushRepo(): { root: string; bare: string; env: Record<string, string> } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "coach-push-")));
  const bare = join(base, "alex/coach.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const ssh = join(base, "fake-ssh");
  // The last argument is git's remote command, e.g. git-receive-pack 'alex/coach.git'.
  writeFileSync(ssh, `#!/bin/sh\nfor a; do last=$a; done\ncd "${base}" && exec sh -c "git \${last#git-}"\n`);
  chmodSync(ssh, 0o755);
  const root = join(base, "w");
  mkdirSync(join(root, "engine"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "engine/prepush.ts"), "process.exitCode = 0;\n");
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  git(root, "remote", "add", "origin", "git@github.com:alex/coach.git");
  return { root, bare, env: { GIT_SSH_COMMAND: ssh, GIT_SSH_VARIANT: "simple" } };
}

test("finding 12: raw git push denies unattended, also after a failed check; push checks first and pushes nothing on failure", () => {
  const root = instance();
  for (const c of ["git push origin main", "node engine/cli.ts prepush-check; git push origin main", "git push", "git push -u origin proposal/P-1"]) {
    assert.equal(bash(root, c).decision, "deny", c);
  }
  assert.equal(bash(root, "git push origin main", "interactive").decision, "allow", "interactive sessions may push");
  assert.equal(bash(root, "node engine/cli.ts push").decision, "allow");

  const bin = fakeGh();
  const env = (vis: string | null, ssh: Record<string, string>): Record<string, string> => ({ PATH: `${bin}:${process.env.PATH}`, ...ssh, ...(vis ? { FAKE_VIS: vis } : {}) });
  for (const vis of ["public", null]) {
    const { root: r, bare, env: ssh } = pushRepo();
    const out = cli(r, ["push"], env(vis, ssh));
    assert.equal(out.code, 1, JSON.stringify(out.json));
    assert.equal(out.json.pushed, false);
    assert.equal(execFileSync("git", ["--git-dir", bare, "branch", "--list"], { encoding: "utf8" }).trim(), "", `nothing pushed (${vis})`);
  }
  const { root: r, bare, env: ssh } = pushRepo();
  const ok = cli(r, ["push"], env("private", ssh));
  assert.equal(ok.code, 0, JSON.stringify(ok.json) + ok.stderr);
  assert.equal(ok.json.pushed, true);
  assert.equal(ok.json.set_upstream, true);
  assert.ok(existsSync(join(r, ".git/hooks/pre-push")), "push installed the hook first");
  assert.match(execFileSync("git", ["--git-dir", bare, "branch", "--list"], { encoding: "utf8" }), /main/);
  git(r, "switch", "-q", "-c", "proposal/P-20261011-new_block-1");
  const branch = cli(r, ["push"], env("private", ssh));
  assert.equal(branch.code, 0, JSON.stringify(branch.json));
  assert.equal(branch.json.branch, "proposal/P-20261011-new_block-1");
  assert.equal(cli(r, ["push", "--branch", "x..y"], env("private", ssh)).json?.error?.code, "USAGE");
});

test("finding 13: the bench measures unattended calls; a write outside proposals runs no git lookup", () => {
  const bench = readFileSync(join(REPO, "scripts/bench-hooks.mjs"), "utf8");
  for (const name of ["unattended: Edit athlete/log/x.md", "unattended: Write .tmp/coach/x.json", "unattended: Bash node engine/cli.ts mode", "unattended: Bash git switch main"]) assert.ok(bench.includes(name), name);
  // Outside a git repository a branch lookup would fail and count as main; with no lookup
  // the decision does not depend on it. A fake git on PATH that fails proves no call.
  const root = instance();
  const bin = mkdtempSync(join(tmpdir(), "no-git-"));
  writeFileSync(join(bin, "git"), "#!/bin/sh\necho called >> \"$0.log\"\nexit 1\n");
  chmodSync(join(bin, "git"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    for (const f of ["athlete/log/2026-10.md", ".tmp/coach/x.json", "docs/x.md"]) {
      assert.equal(fileGuard({ tool_name: "Write", tool_input: { file_path: f, content: "x" }, mode: "unattended", root }).decision, f.startsWith("docs") ? "deny" : "allow", f);
    }
  } finally {
    process.env.PATH = saved;
  }
  assert.equal(existsSync(join(bin, "git.log")), false, "no git subprocess for writes outside athlete/proposals/");
});

test("the executable-file lists of the fast path equal the engine's", async () => {
  const engine = await import("../../engine/protect.ts");
  assert.deepEqual(fast.EXECUTABLE_FILES, engine.EXECUTABLE_FILES);
  assert.deepEqual(fast.EXECUTABLE_EXTENSIONS, engine.EXECUTABLE_EXTENSIONS);
  assert.deepEqual(fast.EXECUTABLE_DIRS, engine.EXECUTABLE_DIRS);
});
