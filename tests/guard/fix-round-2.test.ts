// The second guard fix round (contracts §23): relative symlink paths, trims that add work,
// background commands and the push scope (items 8, 9, 11 and 12 of the first round). Each
// test holds the reviewer's inputs and fails on the code before this round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyChange } from "../../engine/classify.ts";
import { loadLogger } from "../../engine/logger.ts";
import { fileGuard, splitCommand, splitWithSeparators, unattendedBash } from "../../engine/protect.ts";
import { guard, type GuardInput } from "../../engine/validate.ts";
import * as fast from "../../.claude/hooks/fast-files.ts";
import { block, config, emptyDay, guardInput, NOW, REPO, rules, snapDay, snapshot, squat, tax, v } from "./fixtures.ts";

const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR", "NODE_PATH"].includes(k)));
const GIT_ENV = { ...BASE_ENV, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV }).trim();

function instance(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "coach-round2-")));
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  mkdirSync(join(dir, "athlete/log"), { recursive: true });
  mkdirSync(join(dir, ".tmp/coach"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", "https://github.com/alex/coach.git");
  return dir;
}

type Mode = "interactive" | "unattended";
const guardCall = (root: string, tool_name: string, tool_input: Record<string, unknown>, mode: Mode) => fileGuard({ tool_name, tool_input, mode, root, branch: "main", proposalsOnMain: [] });
const write = (root: string, file_path: string, mode: Mode) => guardCall(root, "Write", { file_path, content: "x" }, mode).decision;

// ---------- item 8: `link/..` is the parent of the link's target ----------

test("item 8: a relative symlink/.. path is resolved after the link, in Write and in redirects", () => {
  const root = instance();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "coach-outside-")));
  mkdirSync(join(outside, "subdir"));
  mkdirSync(join(root, "engine/subdir"), { recursive: true });
  symlinkSync(join(outside, "subdir"), join(root, ".tmp/coach/hop"));
  symlinkSync(join(root, "engine/subdir"), join(root, "athlete/log/hop"));

  // The reviewer's inputs: the OS destinations are <outside>/new.json and engine/private.yaml.
  assert.equal(write(root, ".tmp/coach/hop/../new.json", "unattended"), "deny");
  const redirect = "node engine/cli.ts mode > .tmp/coach/hop/../new.json";
  assert.notEqual(unattendedBash(redirect, root), null);
  assert.equal(guardCall(root, "Bash", { command: redirect }, "unattended").decision, "deny");
  assert.notEqual(guardCall(root, "Bash", { command: redirect }, "interactive").decision, "allow", "interactive: the redirect leaves the scratch folder");

  assert.equal(write(root, "athlete/log/hop/../private.yaml", "unattended"), "deny");
  assert.equal(write(root, "athlete/log/hop/../private.yaml", "interactive"), "ask");
  assert.equal(fast.fastFileDecision("Write", { file_path: "athlete/log/hop/../private.yaml", content: "x" }, root), null);

  // A missing folder before the link: a write may create it, so the walk goes on through it.
  assert.equal(write(root, "athlete/log/new/../hop/../private.yaml", "unattended"), "deny");
  assert.equal(write(root, "athlete/log/new/../hop/../private.yaml", "interactive"), "ask");
  assert.equal(fast.fastFileDecision("Write", { file_path: "athlete/log/new/../hop/../private.yaml", content: "x" }, root), null);

  // Plain `..` with no link, and links that stay inside, still pass.
  for (const f of ["athlete/log/../log/2026-10.md", ".tmp/coach/a/../b.json", "athlete/log/2026-10.md"]) {
    assert.equal(write(root, f, "unattended"), "allow", f);
    assert.equal(fast.fastFileDecision("Write", { file_path: f, content: "x" }, root), "allow", `fast: ${f}`);
  }
  assert.equal(unattendedBash("node engine/cli.ts mode > .tmp/coach/a/../b.json", root), null);
});

// ---------- item 9: a trim never adds work on any exercise ----------

const D = "2026-10-15";
const V = v(`r-${D}`, "t0");
const bike = { exerciseId: "zone2_bike", name: "Zone 2 Bike", suggestedSets: 2, suggestedDuration: 600, distanceMeters: 1000 };
const run = (exercises: unknown[], operations: unknown[], over: Partial<GuardInput> = {}) =>
  guard(guardInput({ tool: "update_planned_workout", args: { date: D, expectedVersion: V, operations }, snapshot: snapshot({ "2026-10-12": emptyDay(), "2026-10-13": emptyDay(), [D]: snapDay(D, { exercises }) }), ...over }));
const ordinaryHold = { active: true, set_at: NOW, reason: "left knee pain 5/10", regions: [], set_by: "safety-agent" };

test("item 9: a set cut with per side or a longer distance is not trim_session; a real trim still is", () => {
  const sided = [{ op: "modify", target: { exerciseId: "Barbell_Squat" }, fields: { suggestedSets: 3, perSide: true } }];
  const longer = [{ op: "modify", target: { exerciseId: "zone2_bike" }, fields: { suggestedSets: 1, distanceMeters: 20000 } }];
  const cases: [string, unknown[], unknown[]][] = [
    ["sets 4 → 3 with perSide: true", [squat], sided],
    ["a set cut with distance 1000 → 20000", [squat, bike], longer],
  ];
  for (const [what, exercises, ops] of cases) {
    const unattended = run(exercises, ops, { mode: "unattended" });
    assert.ok(!(unattended.kinds ?? []).includes("trim_session"), `${what}: ${JSON.stringify(unattended.kinds)}`);
    assert.equal(unattended.decision, "deny", `${what}: ${unattended.reasons.join("; ")}`);
    assert.equal(run(exercises, ops, { mode: "unattended", hold: ordinaryHold }).decision, "deny", `${what} under a hold`);
  }
  // A real trim: allowed unattended and under a hold.
  const trim = [{ op: "modify", target: { exerciseId: "Barbell_Squat" }, fields: { suggestedSets: 3 } }];
  const t = run([squat, bike], trim, { mode: "unattended" });
  assert.deepEqual(t.kinds, ["trim_session"]);
  assert.equal(t.decision, "allow", t.reasons.join("; "));
  assert.equal(run([squat, bike], trim, { mode: "unattended", hold: ordinaryHold }).decision, "allow");
});

test("item 9: classifyChange calls a change trim_session only when isTrimOf holds for every exercise", () => {
  const logger = loadLogger("tally");
  const ctx = { block: block(), history: [], tool: "update_planned_workout" as const, snapshotDay: null, tax: tax(), rules: rules(), config: config(), today: "2026-10-14" };
  const plan = (exercises: unknown[]) => logger.toDayPlan(D, snapDay(D, { exercises }), "lbs");
  const before = plan([squat, bike]);
  for (const [what, after] of [
    ["per side", plan([{ ...squat, suggestedSets: 3, perSide: true }, bike])],
    ["distance", plan([{ ...squat, suggestedSets: 3 }, { ...bike, distanceMeters: 20000 }])],
    ["duration", plan([{ ...squat, suggestedSets: 3 }, { ...bike, suggestedDuration: 3600 }])],
    ["rpe", plan([{ ...squat, suggestedSets: 3, rpe: 10 }, bike])],
  ] as const) {
    const c = classifyChange(before, after, ctx);
    assert.ok(!c.kinds.includes("trim_session"), `${what}: ${JSON.stringify(c)}`);
    assert.equal(c.big, true, `${what}: no small kind`);
  }
  // A load step with per side is not a load progression either.
  const step = classifyChange(before, plan([{ ...squat, suggestedWeight: 235, perSide: true }, bike]), ctx);
  assert.ok(!step.kinds.includes("load_progression"), JSON.stringify(step));
  assert.ok(classifyChange(before, plan([{ ...squat, suggestedWeight: 235 }, bike]), ctx).kinds.includes("load_progression"), "a plain load step still is one");
  assert.ok(classifyChange(before, plan([{ ...squat, suggestedSets: 3 }, { ...bike, distanceMeters: 800 }]), ctx).kinds.includes("trim_session"), "less of everything is a trim");
});

// ---------- item 11: no background command unattended ----------

test("item 11: a single & denies unattended, also at the end; && still splits as before", () => {
  const root = instance();
  for (const c of [
    "git switch main &",
    "node engine/cli.ts block write --input .tmp/coach/block.json --proposal P-20261011-new_block-1 &",
    "node engine/cli.ts mode & git status",
    "node engine/cli.ts mode 2>&1 &",
  ]) {
    assert.match(unattendedBash(c, root) ?? "", /background/, c);
    assert.equal(guardCall(root, "Bash", { command: c }, "unattended").decision, "deny", c);
  }
  for (const c of ["node engine/cli.ts mode && git status", "node engine/cli.ts mode 2>&1", "git status; git log -1"]) assert.equal(unattendedBash(c, root), null, c);
  assert.deepEqual(splitWithSeparators("a && b & c || d | e; f\ng &"), { segs: ["a ", " b ", " c ", " d ", " e", " f", "g ", ""], seps: ["&&", "&", "||", "|", ";", "\n", "&", ""] });
  assert.deepEqual(splitCommand("a && b"), ["a ", " b"]);
  assert.deepEqual(splitWithSeparators("a 2>&1 &> f"), { segs: ["a 2>&1 &> f"], seps: [""] });
});

/** A copy of the repo without node_modules or .git, with coach.yaml: the engine cannot load. */
function bareInstance(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-bare2-"));
  cpSync(REPO, dir, { recursive: true, filter: (src) => !/(^|\/)(node_modules|\.git|evals)(\/|$)/.test(src.slice(REPO.length)) });
  cpSync(join(REPO, "coach.example.yaml"), join(dir, "coach.yaml"));
  return dir;
}

test("item 11: the npm ci repair does not run in the background unattended", () => {
  const root = bareInstance();
  const hook = (tool_input: Record<string, unknown>, env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [join(root, ".claude/hooks/guard-files.ts")], {
      input: JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input, cwd: root }),
      encoding: "utf8",
      cwd: tmpdir(),
      env: { ...(BASE_ENV as Record<string, string>), NODE_PATH: "", CLAUDE_PROJECT_DIR: root, ...env },
      timeout: 10_000,
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : "allow";
  };
  assert.equal(hook({ command: "npm ci", run_in_background: true }, { COACH_UNATTENDED: "1" }), "deny");
  assert.equal(hook({ command: "npm ci", run_in_background: true }, { CLAUDE_CODE_REMOTE: "true" }), "deny");
  assert.equal(hook({ command: "npm ci" }, { COACH_UNATTENDED: "1" }), "allow", "the foreground repair still passes");
  assert.equal(hook({ command: "npm ci", run_in_background: true }, {}), "allow", "interactive may repair in the background");
});

// ---------- item 12: push names one local branch and checks the push URL ----------

/** A fake gh that reports $FAKE_VIS for any repository. */
function fakeGh(): string {
  const bin = mkdtempSync(join(tmpdir(), "fake-gh-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nif [ -z "$FAKE_VIS" ]; then echo "HTTP 404" >&2; exit 1; fi\necho "$FAKE_VIS"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

/** A clone whose origin git@github.com:alex/coach.git reaches a local bare repository through a fake ssh (stub engine/prepush.ts). */
function pushRepo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "coach-push2-")));
  const bare = join(base, "alex/coach.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const ssh = join(base, "fake-ssh");
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
  const env = { ...GIT_ENV, PATH: `${fakeGh()}:${process.env.PATH}`, FAKE_VIS: "private", GIT_SSH_COMMAND: ssh, GIT_SSH_VARIANT: "simple" };
  const push = (...args: string[]) => {
    const r = spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), "push", ...args, "--root", root], { cwd: root, encoding: "utf8", env });
    let json: any = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      /* not JSON */
    }
    return { code: r.status, json, stderr: r.stderr };
  };
  const remoteRefs = () => execFileSync("git", ["--git-dir", bare, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return { root, push, remoteRefs };
}

test("item 12: push refuses a tag or a missing branch, pushes refs/heads/<b>:refs/heads/<b>, and checks the push URL", () => {
  const { root, push, remoteRefs } = pushRepo();
  git(root, "tag", "v1");
  for (const b of ["refs/tags/v1", "v1", "no-such-branch", "refs/heads/main"]) {
    const r = push("--branch", b);
    assert.notEqual(r.code, 0, b);
    assert.equal(r.json?.error?.code, "USAGE", `${b}: ${JSON.stringify(r.json)}`);
  }
  assert.deepEqual(remoteRefs(), [], "nothing pushed");

  // remote.origin.push maps the proposal branch onto main; followTags would add v1.
  const P = "proposal/P-20261011-new_block-1";
  git(root, "switch", "-q", "-c", P);
  git(root, "config", "remote.origin.push", `refs/heads/${P}:refs/heads/main`);
  git(root, "config", "push.followTags", "true");
  git(root, "tag", "-a", "-m", "x", "v2");
  const ok = push("--branch", P);
  assert.equal(ok.code, 0, JSON.stringify(ok.json) + ok.stderr);
  assert.deepEqual(ok.json.argv, ["git", "push", "--no-follow-tags", "-u", "origin", `refs/heads/${P}:refs/heads/${P}`]);
  assert.deepEqual(remoteRefs(), [`refs/heads/${P}`], "only the same-name branch: no main, no tag");

  // A push URL that names another repository refuses, and pushes nothing.
  git(root, "switch", "-q", "main");
  for (const url of ["git@github.com:other/public.git", "/tmp/elsewhere.git"]) {
    git(root, "remote", "set-url", "--push", "origin", url);
    const r = push();
    assert.equal(r.code, 1, url);
    assert.equal(r.json.pushed, false);
    assert.match(r.json.reason, /not to alex\/coach/, url);
  }
  // A second push URL to another repository refuses too (git pushes to every one).
  git(root, "config", "--unset-all", "remote.origin.pushurl");
  git(root, "config", "--add", "remote.origin.pushurl", "git@github.com:alex/coach.git");
  git(root, "config", "--add", "remote.origin.pushurl", "git@github.com:other/public.git");
  assert.equal(push().code, 1);
  // pushInsteadOf that rewrites the push to another place refuses as well.
  git(root, "config", "--unset-all", "remote.origin.pushurl");
  git(root, "config", "url./tmp/elsewhere.git.pushInsteadOf", "git@github.com:alex/coach.git");
  assert.equal(push().code, 1);
  git(root, "config", "--unset", "url./tmp/elsewhere.git.pushInsteadOf");
  assert.deepEqual(remoteRefs(), [`refs/heads/${P}`], "main never reached the remote");
  const main = push();
  assert.equal(main.code, 0, JSON.stringify(main.json));
  assert.ok(remoteRefs().includes("refs/heads/main"));
});

// ---------- item 5 (eval friction): a line break in a quoted git commit message ----------

test("item 5: a quoted newline passes unattended only in the git commit -m or --message value", () => {
  const root = instance();
  const body = "plan: trim squat to 3 sets (NA-REC-002)\n\nReadiness 0.42 from the engine.\n\nCo-Authored-By: Coach Bot <bot@example.com>";
  for (const c of [
    `git commit -m "${body}"`,
    `git commit -m '${body}'`,
    `git commit --message "${body}"`,
    `git commit --message="${body}"`,
    `git commit -q -m "${body}"`,
    `git add -A && git commit -m "${body}"`,
  ]) {
    assert.equal(unattendedBash(c, root), null, JSON.stringify(c));
    assert.equal(guardCall(root, "Bash", { command: c }, "unattended").decision, "allow", JSON.stringify(c));
    assert.equal(splitCommand(c)!.filter((x) => x.trim() !== "").length, c.startsWith("git add") ? 2 : 1, "the splitter does not cut inside the quotes");
  }
  for (const c of [
    `git log --format="%h\n%s"`,
    `node engine/cli.ts mode "a\nb"`,
    `git commit -m x -- "a\nb"`,
    `git commit -m x "a\nb"`,
    `gh api repos/alex/coach/pulls -f body="a\nb"`,
    `git commit -m "a\n$HOME"`,
    "git commit -m \"a\n`id`\"",
    `git commit -m "a\n\\x"`,
    `git commit -m "a\r\nb"`,
  ]) {
    assert.notEqual(unattendedBash(c, root), null, JSON.stringify(c));
    assert.equal(guardCall(root, "Bash", { command: c }, "unattended").decision, "deny", JSON.stringify(c));
  }
  // An unquoted newline still splits: the second line is its own command.
  assert.deepEqual(splitCommand("git status\ngit log -1"), ["git status", "git log -1"]);
  assert.match(unattendedBash("git commit -m x\ngit switch main", root) ?? "", /switch must be the whole command/);
  assert.notEqual(unattendedBash("git commit -m x\nls", root), null);
});
