// Offline checks of every scenario (no model run): the setup builds a valid instance, the
// signals give the readiness the scenario needs, the approved proposal of scenario 8 is
// an approval record the guard accepts, and each check function runs and fails on a run
// that did nothing (so a check can tell a pass from a no-op).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadApprovals } from "../../engine/approvals.ts";
import { validateBlock } from "../../engine/block.ts";
import { loadConfig } from "../../engine/config.ts";
import { addDays } from "../../engine/dates.ts";
import { validateLimits } from "../../engine/limits.ts";
import { readiness } from "../../engine/readiness.ts";
import { opDone } from "../../engine/oplog.ts";
import { loadSignals } from "../../engine/signals.ts";
import { adapterDeclaresT2, createInstance, EXCLUDED, MOCK_SERVER, publicExport } from "../lib/instance.ts";
import { readState } from "../mock-tally/client.ts";
import { snapshotFiles } from "../lib/collect.ts";
import { replyText, taxonomy } from "../lib/checks.ts";
import type { RunArtifacts } from "../lib/types.ts";
import { loadScenarios, prepare } from "../run.ts";
import { questionsIn, relayed } from "./15-safety-foreground.ts";
import { changeProblems } from "./02-one-category-no-change.ts";
import { saidAlreadyAdjusted } from "./16-failed-trim-retried.ts";

const scenarios = await loadScenarios();

test("18 scenarios (scenario 8 has two halves), unique names", () => {
  assert.equal(scenarios.length, 18);
  assert.equal(new Set(scenarios.map((s) => s.name)).size, 18);
});

/** Every file under root, relative (node_modules and .git not entered). */
function filesUnder(root: string): string[] {
  return execFileSync("find", [".", "-path", "./.git", "-prune", "-o", "-path", "./node_modules", "-prune", "-o", "-print"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.length > 2)
    .map((f) => f.slice(2));
}

test("an instance is built from the public export: no excluded path (docs/build/** and the rest)", () => {
  for (const fresh of [false, true]) {
    const inst = createInstance({ fresh, allowDirty: true });
    try {
      const files = filesUnder(inst.root);
      assert.ok(files.includes("CLAUDE.md") && files.includes(".claude/settings.json") && files.includes("scripts/export-public.sh"), "the public tree is there");
      assert.ok(existsSync(join(publicExport({ allowDirty: true }).tree, "package-lock.json")), "npm ci needs the lock file");
      for (const ex of EXCLUDED) {
        if (ex === "node_modules/") continue;
        const hit = files.filter((f) => (ex.endsWith("/") ? f === ex.slice(0, -1) || f.startsWith(ex) : f === ex));
        assert.deepEqual(hit, [], `excluded path ${ex} is in the instance`);
      }
      assert.ok(!files.some((f) => f.startsWith("docs/build")), "no docs/build/**");
      // The origin is a GitHub URL (approvals and the pre-push check read it), served by a fake ssh.
      assert.equal(execFileSync("git", ["remote", "get-url", "origin"], { cwd: inst.root, encoding: "utf8" }).trim(), "git@github.com:eval-coach/athlete.git");
      // The fake GitHub origin serves fetches too: `git pull --rebase` (CLAUDE.md, unattended runs) works.
      execFileSync("git", ["pull", "--rebase", "-q"], { cwd: inst.root, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      // node_modules: a link to the repo's for normal runs; absent in a fresh copy.
      if (fresh) assert.equal(existsSync(join(inst.root, "node_modules")), false);
      else {
        assert.ok(lstatSync(join(inst.root, "node_modules")).isSymbolicLink());
        // Unattended pushes go through `node engine/cli.ts push` (hooks, the private check, the
        // pre-push hook): it must reach the bare repo, for main and for a proposal branch.
        const env = { ...process.env, PATH: `${inst.bin}:${process.env.PATH}`, EVAL_GH_LOG: inst.ghLog, EVAL_GH_PULLS: inst.ghPulls, GIT_TERMINAL_PROMPT: "0" };
        const run = (cmd: string, ...args: string[]) => execFileSync(cmd, args, { cwd: inst.root, env, encoding: "utf8", stdio: "pipe" });
        run("git", "commit", "-q", "--allow-empty", "-m", "push probe");
        assert.equal(JSON.parse(run(process.execPath, "engine/cli.ts", "push")).pushed, true);
        assert.equal(run("git", "--git-dir", join(inst.dir, "remote.git"), "log", "-1", "--format=%s", "main").trim(), "push probe");
        run("git", "switch", "-q", "-c", "proposal/P-probe");
        assert.equal(JSON.parse(run(process.execPath, "engine/cli.ts", "push", "--branch", "proposal/P-probe")).pushed, true);
      }
    } finally {
      rmSync(inst.dir, { recursive: true, force: true });
    }
  }
});

test("scenario 02 change check: a load progression passes; a trim, a swap or a load over the cap fails", () => {
  const ex = (name: string, sets: number, weight: number | null) => ({ exerciseId: name, name, suggestedSets: sets, suggestedReps: 8, ...(weight === null ? {} : { suggestedWeight: weight }) });
  const before = { status: "planned", exercises: [ex("Goblet Squat", 4, 70), ex("Pull Up", 3, null)] };
  const day = (...exercises: unknown[]) => ({ status: "planned", exercises });
  assert.deepEqual(changeProblems(before, day(ex("Goblet Squat", 4, 75), ex("Pull Up", 3, null)), 0.1), []);
  assert.deepEqual(changeProblems(before, before, 0.1), []);
  assert.ok(changeProblems(before, day(ex("Goblet Squat", 3, 70), ex("Pull Up", 3, null)), 0.1).length > 0, "trim");
  assert.ok(changeProblems(before, day(ex("Zone 2 Bike", 1, null), ex("Pull Up", 3, null)), 0.1).length > 0, "swap");
  assert.ok(changeProblems(before, day(ex("Goblet Squat", 4, 80)), 0.1).length > 0, "removed exercise");
  assert.ok(changeProblems(before, day(ex("Goblet Squat", 4, 80), ex("Pull Up", 3, null)), 0.1).length > 0, "+14% is over the cap");
  assert.ok(changeProblems(before, day(ex("Goblet Squat", 4, 65), ex("Pull Up", 3, null)), 0.1).length > 0, "a lower load");
});

test("scenario 16: only the exit statement counts as \"already adjusted\"", () => {
  assert.ok(saidAlreadyAdjusted("Today is already adjusted. I logged nothing new."));
  assert.equal(saidAlreadyAdjusted("Checking whether today is already adjusted. The earlier trim hit a conflict."), false);
  assert.equal(saidAlreadyAdjusted("I checked if today is already adjusted: it is not."), false);
});

test("scenario 15 helpers: questions are found, and relayed only when their words are in the reply", () => {
  const agent = "SAFETY QUESTIONS\n1. **Where exactly is the pain?** A) low back B) mid back\n2. Does the pain spread down a leg? A) yes, B) no\nNote: ask these.";
  const qs = questionsIn(agent);
  assert.deepEqual(qs, ["Where exactly is the pain?", "Does the pain spread down a leg?"]);
  assert.ok(relayed(qs[1], "Two questions first:\n- Does the pain *spread* down a leg? A) yes B) no"));
  // A Stop hook can add a message after the questions: the reply is every message after the agent.
  const a = { result: { text: "I committed the pending file." }, messages: [{ afterTool: 0, text: "Running the safety agent." }, { afterTool: 1, text: agent }, { afterTool: 2, text: "I committed the pending file." }] } as unknown as RunArtifacts;
  assert.ok(qs.every((q) => relayed(q, replyText(a, 0))));
  assert.equal(relayed(qs[0], replyText(a, 1)), false);
  assert.equal(relayed(qs[1], "I am waiting on your answers to the questions above."), false);
  // A plural or singular change is still word for word ("Which words fit" / "Which word fits").
  assert.ok(relayed("Which words fit the pain best?", "4. Which word fits the pain best? A) Dull, B) Sharp"));
});

const EXPECTED_DECISION: Record<string, string> = {
  "02-one-category-no-change": "note-or-none",
  "03-two-categories-trim": "trim",
  "04-two-reds-recovery": "recovery",
  "09-already-adjusted": "trim",
  "16-failed-trim-retried": "trim",
  "17-aversion-recovery": "recovery",
};

/** Scenarios where a run that does nothing is already correct. */
const NOOP_PASSES = new Set(["09-already-adjusted", "13-limits-edit-unattended"]);

for (const s of scenarios) {
  test(`fixture ${s.name}: valid instance, readiness, and a check that rejects a no-op run`, () => {
    const { inst, ctx, seed, bootstrap } = prepare(s, { allowDirty: true });
    try {
      const root = inst.root;
      assert.equal(existsSync(join(root, "athlete/.safety-pending")), false, "no safety file leaks in from the development checkout");
      if (s.name !== "01-setup-scripted") {
        const cfg = loadConfig(join(root, "coach.yaml"));
        validateBlock(parse(ctx.read("athlete/block.yaml")));
        validateLimits(parse(ctx.read("athlete/limits.yaml")), taxonomy());
        // The baseline window (42 days) plus the long pattern (7) before today.
        const sig = loadSignals({ root, from: addDays(ctx.today, -50), to: ctx.today });
        assert.deepEqual(sig.warnings, [], "signal files load cleanly");
        const r = readiness({ today: ctx.today, now: new Date().toISOString(), tz: cfg.athlete.timezone, records: sig.records, sessions: [], sleep_target_min: 450 });
        const want = EXPECTED_DECISION[s.name];
        if (want === "note-or-none") {
          assert.equal(r.wearable.state, "red", JSON.stringify(r.wearable));
          assert.equal(r.subjective.state, "unknown");
        } else if (want) {
          assert.equal(r.decision, want, JSON.stringify({ w: r.wearable, s: r.subjective }));
        } else {
          assert.equal(r.decision, "none", `${s.name}: a normal day (${JSON.stringify(r.wearable.reasons)})`);
        }
        assert.ok(seed.days[ctx.today], "today is planned in Tally");
      } else {
        assert.equal(Object.keys(seed.days).length, 0);
        // The fresh copy: no node_modules; the hooks load with built-ins and decide.
        assert.ok(s.fresh, "scenario 01 runs on a fresh copy");
        assert.equal(bootstrap?.nodeModules, false);
        assert.equal(bootstrap?.coachYaml, false);
        for (const p of bootstrap!.probes) assert.equal(p.decision === "allow", p.hook === "guard-files.ts", JSON.stringify(p));
      }
      // The mock's T2 matches the adapter, unless the scenario sets it.
      const mockEnv = JSON.parse(readFileSync(inst.mcpConfig, "utf8")).mcpServers[MOCK_SERVER].env;
      assert.equal(mockEnv.MOCK_T2 === "1", s.mock?.t2 ?? adapterDeclaresT2(root), "mock T2 follows the adapter");
      if (s.name === "09-already-adjusted") assert.equal(opDone(root, ctx.today, "trim_session").status, "done");
      if (s.name === "16-failed-trim-retried") assert.equal(opDone(root, ctx.today, "trim_session").status, "not_done", "a conflict is not done");
      if (s.name.startsWith("08")) {
        const scan = loadApprovals(root, { env: { ...process.env, PATH: `${inst.bin}:${process.env.PATH}`, EVAL_GH_LOG: inst.ghLog, EVAL_GH_PULLS: inst.ghPulls } });
        assert.deepEqual(scan.rejected, []);
        assert.equal(scan.records.length, 1, JSON.stringify(scan));
      }
      const files = snapshotFiles(root, s.watch);
      const noop: RunArtifacts = {
        scenario: s.name, run: 0, mode: s.mode, today: ctx.today, tz: ctx.tz, seed, mock: readState(inst.statePath) as RunArtifacts["mock"],
        before: files, after: files, commits: [], branches: ["main"], pushedMain: [], gh: [], tools: [], prompts: [], verdicts: [], ...(bootstrap ? { bootstrap } : {}),
        result: { text: "", isError: false, turns: 0, costUsd: 0, durationMs: 0, exitCode: 0, aborted: null },
      };
      const checks = s.check(noop);
      assert.ok(checks.length > 0);
      if (NOOP_PASSES.has(s.name)) assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
      else assert.ok(checks.some((c) => !c.ok), `${s.name}: a no-op run must fail a check`);
    } finally {
      rmSync(inst.dir, { recursive: true, force: true });
    }
  });
}
