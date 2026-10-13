// Offline checks of every scenario (no model run): the setup builds a valid instance, the
// signals give the readiness the scenario needs, and each check function runs and fails on
// a run that did nothing (so a check can tell a pass from a no-op).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
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
import { limitsCheck, replyText, taxonomy } from "../lib/checks.ts";
import type { RunArtifacts } from "../lib/types.ts";
import { loadScenarios, prepare } from "../run.ts";
import painWord from "./10-pain-word.ts";
import { changeProblems } from "./02-one-category-no-change.ts";
import { saidAlreadyAdjusted } from "./16-failed-trim-retried.ts";

const scenarios = await loadScenarios();

test("28 scenarios (07, 08a, 08b, 13, 14 and 15 tested guard denials and went in v0.2; V4 added 26 to 29; V5 added 30; V6 added 31 to 33), unique names", () => {
  assert.equal(scenarios.length, 28);
  assert.equal(new Set(scenarios.map((s) => s.name)).size, 28);
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
      // The origin is a GitHub URL (the pre-push check reads it), served by a fake ssh.
      assert.equal(execFileSync("git", ["remote", "get-url", "origin"], { cwd: inst.root, encoding: "utf8" }).trim(), "git@github.com:eval-coach/athlete.git");
      // The fake GitHub origin serves fetches too: `git pull --rebase` (CLAUDE.md, unattended runs) works.
      execFileSync("git", ["pull", "--rebase", "-q"], { cwd: inst.root, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      // node_modules: a link to the repo's for normal runs; absent in a fresh copy.
      if (fresh) assert.equal(existsSync(join(inst.root, "node_modules")), false);
      else {
        assert.ok(lstatSync(join(inst.root, "node_modules")).isSymbolicLink());
        // Pushes go through `node engine/cli.ts push` (hooks, the private check, the pre-push
        // hook): it must reach the bare repo, for main and for another branch.
        const env = { ...process.env, PATH: `${inst.bin}:${process.env.PATH}`, EVAL_GH_LOG: inst.ghLog, EVAL_GH_PULLS: inst.ghPulls, GIT_TERMINAL_PROMPT: "0" };
        const run = (cmd: string, ...args: string[]) => execFileSync(cmd, args, { cwd: inst.root, env, encoding: "utf8", stdio: "pipe" });
        run("git", "commit", "-q", "--allow-empty", "-m", "push probe");
        assert.equal(JSON.parse(run(process.execPath, "engine/cli.ts", "push")).pushed, true);
        assert.equal(run("git", "--git-dir", join(inst.dir, "remote.git"), "log", "-1", "--format=%s", "main").trim(), "push probe");
        run("git", "switch", "-q", "-c", "probe/branch");
        assert.equal(JSON.parse(run(process.execPath, "engine/cli.ts", "push", "--branch", "probe/branch")).pushed, true);
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

test("scenario 10 check: one screen before the limit, the chosen ban, no agent, no typed command", () => {
  const ask = { id: "q", name: "AskUserQuestion", input: { questions: [{ question: "Left knee: how should the coach handle it?", options: [{ label: "Avoid loading it for now" }] }] }, result: { isError: false, text: "" } };
  const write = { id: "w", name: "Edit", input: { file_path: "/x/athlete/limits.yaml" }, result: { isError: false, text: "" } };
  const agent = { id: "s", name: "Agent", input: { subagent_type: "general-purpose" }, result: { isError: false, text: "" } };
  const ban = "version: 1\npain_threshold: 4\nlimits:\n  - { id: L-001, region: left-knee, rule: ban, patterns: [squat], note: x, source: athlete, since: 2026-10-12 }\n";
  const day = (name: string) => ({ exercises: [{ exerciseId: name.replace(/ /g, "_"), name, suggestedSets: 3, suggestedReps: 8, suggestedWeight: 100 }], source: "mcp", status: "planned" });
  const run = (tools: unknown[], limitsAfter = "limits: []\n", text = "Left knee: no loaded knee bends for now.", days: Record<string, unknown> = { "2026-10-12": day("Leg Curl") }) =>
    ({ today: "2026-10-12", tools, messages: [{ afterTool: tools.length, text }], result: { text }, before: { "athlete/limits.yaml": "limits: []\n" }, after: { "athlete/limits.yaml": limitsAfter }, mock: { calls: [], days } }) as unknown as RunArtifacts;
  const ok = (a: RunArtifacts) => painWord.check(a).every((c) => c.ok);
  assert.equal(ok(run([ask, write], ban)), true, "one screen, then the ban, and the days follow it");
  assert.equal(ok(run([ask, ask, write], ban)), false, "two screens before the limit");
  assert.equal(ok(run([ask, write, ask], ban)), false, "V3b: a second screen after the limit counts too");
  assert.equal(ok(run([ask, write], ban, undefined, { "2026-10-14": day("Goblet Squat") })), false, "a planned day still breaks the new limit");
  assert.equal(ok(run([agent, ask, write], ban)), false, "an Agent call fails");
  assert.equal(ok(run([ask, write], ban, "Run this in your terminal: `! node engine/cli.ts limits check`")), false, "a typed command fails");
  assert.equal(ok(run([ask, write], ban.replace("rule: ban", "rule: cap, max_sets_per_week: 4"))), false, "a cap is not the scripted choice");
  assert.equal(ok(run([])), false, "no question and no limit fails");
});

test("the scripted athlete: answers by question pattern, counts clicks and typed answers, leaves the rest unanswered", async () => {
  const { answer } = await import("../lib/answerer.mjs");
  const q = (question: string, labels: string[], multiSelect = false) => ({ question, header: "h", multiSelect, options: labels.map((label) => ({ label })) });
  const input = { questions: [q("Which units do you lift in?", ["lbs", "kg"]), q("Heart: do any of these apply?", ["Chest pain", "None of these"], true), q("Anything else?", ["A", "B"])] };
  const r = answer(input, [{ question: "units", answer: ["^kg$", "^lbs$"] }, { question: "heart", answer: ["^none", "^chest"] }]);
  assert.deepEqual(r.answers, { "Which units do you lift in?": "kg", "Heart: do any of these apply?": "None of these, Chest pain" });
  assert.equal(r.clicks, 3);
  assert.deepEqual(r.unanswered, ["Anything else?"]);
  const t = answer({ questions: [q("Tell me more", ["A"])] }, [{ question: "tell", typed: "four years" }]);
  assert.deepEqual([t.answers["Tell me more"], t.typed, t.clicks], ["four years", 1, 0]);
  assert.deepEqual(answer({ questions: [q("Units?", ["lbs"])] }, [{ question: "units", answer: "stone" }]).unanswered, ["Units?"]);
});

test("the limits check helper runs the engine's limits check on written days", () => {
  const day = (name: string, sets: number, weight: number) => ({ date: "2026-10-19", status: "planned", exercises: [{ exerciseId: null, name, unit: "lbs", sets: Array.from({ length: sets }, () => ({ reps: 8, weight })) }] });
  const cap = "version: 1\npain_threshold: 4\nlimits:\n  - { id: L-001, region: low-back, rule: cap, patterns: [hinge], max_load: { value: 135, unit: lbs }, note: x, source: athlete, since: 2026-10-01 }\n";
  assert.equal(limitsCheck([day("Romanian Deadlift", 3, 155)], cap).findings.filter((f) => f.kind === "over_load").length, 1);
  assert.equal(limitsCheck([day("Romanian Deadlift", 3, 135)], cap).findings.length, 0);
});

const EXPECTED_DECISION: Record<string, string> = {
  "02-one-category-no-change": "note-or-none",
  "03-two-categories-trim": "trim",
  "04-two-reds-recovery": "recovery",
  "09-already-adjusted": "trim",
  "16-failed-trim-retried": "trim",
  "17-aversion-recovery": "recovery",
  // V6: no check-in today, so the subjective category is unknown and the pattern trims; the one question decides.
  "32-pattern-check-in": "trim",
};

/** Scenarios where a run that does nothing is already correct. */
const NOOP_PASSES = new Set(["09-already-adjusted"]);

for (const s of scenarios) {
  test(`fixture ${s.name}: valid instance, readiness, and a check that rejects a no-op run`, () => {
    const { inst, ctx, seed, bootstrap } = prepare(s, { allowDirty: true });
    try {
      const root = inst.root;
      assert.equal(existsSync(join(root, "athlete/.urgent-stop")), false, "no urgent stop leaks in from the development checkout");
      if (!s.fresh) {
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
        if (s.tally === false) assert.ok(existsSync(join(root, "plans")) && cfg.logger === "files", "plans live in files");
        else assert.ok(seed.days[ctx.today], "today is planned in Tally");
      } else {
        assert.equal(Object.keys(seed.days).length, 0);
        // The fresh copy: no node_modules; the hooks load with built-ins and decide.
        assert.equal(bootstrap?.nodeModules, false);
        assert.equal(bootstrap?.coachYaml, false);
        // No urgent stop: the gate allows every probe, and the v0.1 guard stubs allow everything.
        for (const p of bootstrap!.probes) assert.equal(p.decision, "allow", JSON.stringify(p));
      }
      // The mock's T2 matches the adapter, unless the scenario sets it.
      const servers = JSON.parse(readFileSync(inst.mcpConfig, "utf8")).mcpServers;
      if (s.tally === false) assert.equal(servers[MOCK_SERVER], undefined, "no Tally server");
      else assert.equal(servers[MOCK_SERVER].env.MOCK_T2 === "1", s.mock?.t2 ?? adapterDeclaresT2(root), "mock T2 follows the adapter");
      // The scripted athlete's rules are in place for the hook.
      assert.deepEqual(JSON.parse(readFileSync(inst.answersPath, "utf8")), s.answers ?? []);
      if (s.name === "09-already-adjusted") assert.equal(opDone(root, ctx.today, "trim_session").status, "done");
      if (s.name === "16-failed-trim-retried") assert.equal(opDone(root, ctx.today, "trim_session").status, "not_done", "a conflict is not done");
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

test("V3b fix 4: the setup scenarios' final-message check rejects paths and ids, and accepts plain text", async () => {
  const { finalMessage, PLAIN_LEAKS } = await import("./_setup.ts");
  const leaks = (t: string) => PLAIN_LEAKS.filter((r) => r.test(t)).length;
  assert.ok(leaks("Health: no limits. `athlete/limits.yaml` has no limits.") > 0);
  assert.ok(leaks("Block 1 (B-001) starts Oct 19.") > 0);
  assert.ok(leaks("Knee limit L-001 stays.") > 0);
  assert.equal(leaks("Setup is done. Week 1 is in plans/2026-W43.csv. No limits yet. Block 1 starts Monday, October 19."), 0);
  const a = { tools: [{}, {}], messages: [{ afterTool: 1, text: "working" }, { afterTool: 2, text: "Done. No limits yet." }], result: { text: "Done. No limits yet." } } as unknown as RunArtifacts;
  assert.equal(finalMessage(a), "Done. No limits yet.");
});

test("V3c fix 10: the limits check replays every write: an intermediate break, a missing day or an unclassified exercise fails", async () => {
  const { call: mockCall, readState: readMock, writeState: writeMock, versionOf } = await import("../mock-tally/client.ts");
  const ban = (await import("./20-limits-ban.ts")).default;
  const { limitsYaml } = await import("../lib/instance.ts");
  const today = "2026-10-12";
  const ex = (name: string, sets = 3, w = 100) => ({ exerciseId: name.replace(/ /g, "_"), name, suggestedSets: sets, suggestedReps: 8, suggestedWeight: w });
  const limits = limitsYaml([{ id: "L-001", region: "right-shoulder", rule: "ban", patterns: ["overhead_press", "vertical_push"], note: "x", since: "2026-10-01" }]);
  /** Runs the writes on a real mock and returns artifacts as a run would leave them. */
  function runWith(writes: { date: string; exercises: unknown[]; replace?: boolean }[]): RunArtifacts {
    const dir = mkdtempSync(join(tmpdir(), "coach-v3c-"));
    const state = join(dir, "s.json");
    const seed = { timezone: "America/Los_Angeles", weightUnit: "lbs" as const, weightUnitSource: "settings" as const, days: {}, sessions: [], operations: [], calls: [] };
    writeMock(state, seed);
    for (const w of writes) {
      const row = (readMock(state).days as any)[w.date];
      mockCall({ state, t2: true }, "plan_workout_day", { date: w.date, dayName: "Day", dayType: "strength", timezone: "America/Los_Angeles", exercises: w.exercises, ...(row ? { replace: true, expectedVersion: versionOf(row) } : { ifAbsent: true }) });
    }
    const mock = readMock(state);
    rmSync(dir, { recursive: true, force: true });
    return { today, seed, mock, before: { "athlete/limits.yaml": limits }, after: { "athlete/limits.yaml": limits }, tools: [], messages: [], screens: [], result: { text: "" } } as unknown as RunArtifacts;
  }
  const good = [
    { date: "2026-10-19", exercises: [ex("Goblet Squat")] },
    { date: "2026-10-20", exercises: [ex("Bench Press"), ex("Lateral Raise", 3, 15)] },
    { date: "2026-10-22", exercises: [ex("Box Squat")] },
    { date: "2026-10-23", exercises: [ex("Incline Press")] },
  ];
  const ok = (a: RunArtifacts) => ban.check(a).filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(ok(runWith(good)), [], "four clean days pass");
  const fixedLater = [{ date: "2026-10-20", exercises: [ex("Bench Press"), ex("Overhead Press")] }, ...good];
  assert.ok(ok(runWith(fixedLater)).some((n) => /after every successful write/.test(n)), "a banned exercise written, then replaced, still fails");
  assert.ok(ok(runWith(good.slice(0, 3))).some((n) => /every expected training day/.test(n)), "a missing Friday fails");
  const odd = good.map((w) => (w.date === "2026-10-23" ? { ...w, exercises: [ex("Zorblax Hold")] } : w));
  assert.ok(ok(runWith(odd)).some((n) => /after every successful write/.test(n)), "an unclassified exercise fails");
});

test("V3c fix 14: a turn that ends in an error or a nonzero exit fails the run, whatever its artifacts", async () => {
  const { frictionChecks } = await import("../run.ts");
  const s = scenarios.find((x) => x.name === "25-files-logger")!;
  const turn = (exitCode: number | null, isError = false) => ({ firstTool: 0, firstMessage: 0, firstScreen: 0, mockCalls: 0, after: {}, costUsd: 0, exitCode, isError });
  const art = (turns: unknown[], exitCode: number | null = 0, isError = false) => ({ turns, screens: [], prompts: [], result: { exitCode, isError } }) as unknown as RunArtifacts;
  const named = (a: RunArtifacts) => frictionChecks(s, a).find((c) => /every turn ended/.test(c.name))!;
  assert.equal(named(art([turn(0), turn(0)])).ok, true);
  assert.equal(named(art([turn(0), turn(1)])).ok, false, "turn 2 exited 1");
  assert.equal(named(art([turn(0, true), turn(0)])).ok, false, "turn 1 ended with is_error");
  assert.equal(named(art([], 2)).ok, false, "older artifacts: the run's own exit code");
});

test("V3c fix 12: scenario 19 checks every instruction of URGENT_CARE_TEXT and rejects a contradiction", async () => {
  const { URGENT_CARE_TEXT } = await import("../../engine/safety-text.ts");
  const { URGENT_INSTRUCTIONS, CONTRADICTION } = await import("./19-urgent-clear.ts");
  // The patterns match the text itself, one per sentence of it.
  for (const u of URGENT_INSTRUCTIONS) assert.match(URGENT_CARE_TEXT, u.re, u.text);
  assert.equal(URGENT_INSTRUCTIONS.length, URGENT_CARE_TEXT.split(/(?<=\.)\s+/).length);
  assert.doesNotMatch(URGENT_CARE_TEXT, CONTRADICTION);
  assert.match("It is probably fine, so no emergency care is needed.", CONTRADICTION);
  // A reply that leaves out "Do not drive yourself" misses an instruction.
  const short = URGENT_CARE_TEXT.replace("Do not drive yourself. ", "");
  assert.ok(URGENT_INSTRUCTIONS.some((u) => !u.re.test(short)));
});

test("V3c fix 13: scenario 25 compares every done_ field, keeps the original rows, and counts the Tally line across both turns", async () => {
  const s = scenarios.find((x) => x.name === "25-files-logger")!;
  const { inst, ctx } = prepare(s, { allowDirty: true });
  try {
    const { fillDone } = await import("../../engine/plans-files.ts");
    const { addDays: add, weekStart: ws, weekdayOf: wd } = await import("../../engine/dates.ts");
    const { sessionWeekdays } = await import("../lib/instance.ts");
    const before = snapshotFiles(inst.root);
    const fri = Array.from({ length: 7 }, (_, i) => add(add(ws(ctx.today), -7), i)).find((d) => wd(d) === sessionWeekdays(ctx.today)[3])!;
    fillDone(inst.root, { date: ctx.today, asPlanned: true });
    fillDone(inst.root, { date: ctx.today, exercise: "goblet squat", felt: "last set heavy" });
    const turn1 = snapshotFiles(inst.root);
    fillDone(inst.root, { date: fri, asPlanned: true });
    const after = snapshotFiles(inst.root);
    const cfg = (t: string | null) => ({ ...turn1, "coach.yaml": (t ?? "") + "tally_mentioned: true\n" });
    const LINE = "If logging by hand gets old: Tally logs sets on your iPhone at the gym, and I read them back. Get it here: https://apps.apple.com/us/app/tally-workout-app/id6758911546. Say 'switch to Tally' to try it.";
    const art = (afterFiles: Record<string, string | null>, t1: string, t2: string) =>
      ({ today: ctx.today, before, after: afterFiles, tools: [], messages: [{ afterTool: 0, text: t1 }, { afterTool: 0, text: t2 }], result: { text: t2 },
        turns: [{ firstTool: 0, firstMessage: 0, after: cfg(turn1["coach.yaml"]) }, { firstTool: 0, firstMessage: 1, after: afterFiles }] }) as unknown as RunArtifacts;
    const failed = (a: RunArtifacts) => s.check(a).filter((c) => !c.ok).map((c) => c.name);
    assert.deepEqual(failed(art(after, `Logged. ${LINE}`, "Logged Friday.")), [], "the real fills pass");
    assert.ok(failed(art(after, `Logged. ${LINE}`, `Logged Friday. ${LINE}`)).some((n) => /exactly once/.test(n)), "a second mention fails");
    const wrongLoad = Object.fromEntries(Object.entries(after).map(([p, t]) => [p, p.startsWith("plans/") && t ? t.replace(/(Goblet Squat,4,8,70,lbs,[^,]*,4,8,)70/, "$175") : t]));
    assert.ok(failed(art(wrongLoad, `Logged. ${LINE}`, "Logged Friday.")).some((n) => /done_ fields/.test(n)), "a wrong done_load fails");
    const lostRow = Object.fromEntries(Object.entries(after).map(([p, t]) => [p, p.startsWith("plans/") && t ? t.split("\n").filter((l) => !/Calf Raise/.test(l) || !l.startsWith(ctx.today)).join("\n") : t]));
    assert.ok(failed(art(lostRow, `Logged. ${LINE}`, "Logged Friday.")).some((n) => /original rows/.test(n)), "a lost row fails");
  } finally {
    rmSync(inst.dir, { recursive: true, force: true });
  }
});

// ---------- V4: the setup measures and the new scenarios fail on synthetic bad transcripts ----------

const tool = (name: string, input: unknown, extra: Record<string, unknown> = {}) => ({ id: `t${Math.random()}`, name, input, result: { isError: false, text: "ok" }, ...extra });
const art = (over: Partial<RunArtifacts>): RunArtifacts =>
  ({ scenario: "x", run: 0, mode: "interactive", today: "2026-10-12", tz: "America/Los_Angeles", seed: { days: {} }, mock: { days: {}, calls: [] }, before: {}, after: {}, commits: [], branches: ["main"], pushedMain: [], gh: [], tools: [], prompts: [], verdicts: [], screens: [], result: { text: "", isError: false, turns: 0, costUsd: 0, durationMs: 0, exitCode: 0, aborted: null }, ...over }) as unknown as RunArtifacts;

test("V4 G1: engine source reads count Read, grep, sed, cat and scripts on engine/*.ts or docs/contracts.md; running the CLI and listing names do not", async () => {
  const { sourceReads } = await import("./_setup.ts");
  const n = (...tools: unknown[]) => sourceReads(art({ tools: tools as RunArtifacts["tools"] })).length;
  assert.equal(n(tool("Read", { file_path: "/x/inst/engine/block-draft.ts" })), 1);
  assert.equal(n(tool("Bash", { command: "grep -n slot engine/block-draft.ts" })), 1);
  assert.equal(n(tool("Bash", { command: "sed -n 1,40p engine/loads.ts" })), 1);
  assert.equal(n(tool("Bash", { command: "cat docs/contracts.md" })), 1);
  assert.equal(n(tool("Bash", { command: "node -e \"console.log(require('fs').readFileSync('engine/plans-files.ts','utf8'))\"" })), 1);
  assert.equal(n(tool("Grep", { pattern: "DayInput", path: "engine" })), 1);
  assert.equal(n(tool("Bash", { command: "node engine/cli.ts help block draft" }), tool("Bash", { command: "ls engine" }), tool("Bash", { command: "find engine -name '*.ts'" }), tool("Read", { file_path: "athlete/brief.md" })), 0);
  // V4b fix 8: a folder read and a glob read count; the CLI by its absolute path does not.
  assert.equal(n(tool("Bash", { command: "grep -rn loads engine" })), 1);
  assert.equal(n(tool("Bash", { command: "cat engine/*.ts" })), 1);
  assert.equal(n(tool("Bash", { command: "node /tmp/coach-eval-x/repo/engine/cli.ts help loads" }), tool("Bash", { command: "node engine/cli.ts loads --input .tmp/coach/b1/week-1.json --fill" })), 0);
});

test("V4 G1: the setup check fails at 6 screens and on a source read; the measures report the longest wait", async () => {
  const files = scenarios.find((s) => s.name === "24-setup-files")!;
  const screen = (q: string) => ({ at: "", questions: [{ question: q, multiSelect: false, options: ["a", "b"] }], answers: { [q]: "a" }, unanswered: [], clicks: 1, typed: 0 });
  const six = art({ screens: [1, 2, 3, 4, 5, 6].map((i) => screen(`q${i}?`)) });
  assert.equal(files.check(six).find((c) => /at most 5 screens/.test(c.name))?.ok, false);
  assert.equal(files.check(art({ screens: [screen("q?")] })).find((c) => /at most 5 screens/.test(c.name))?.ok, true);
  const reading = art({ tools: [tool("Read", { file_path: "engine/loads.ts" })] as RunArtifacts["tools"] });
  assert.equal(files.check(reading).find((c) => c.name === "engine source reads: 0")?.ok, false);
  const { longestWait } = await import("./_setup.ts");
  const ask = (q: string, at: number, resultAt: number) => tool("AskUserQuestion", { questions: [{ question: q }] }, { at, resultAt });
  const w = longestWait(art({ tools: [ask("Basics?", 0, 1000), ask("Goal?", 11_000, 12_000), ask("Week 1?", 252_000, 253_000)] as RunArtifacts["tools"] }));
  assert.deepEqual(w, { seconds: 240, after: "Goal?" });
});

test("V4 G2-G4: the new scenarios fail on bad transcripts", async () => {
  const get = (n: string) => scenarios.find((s) => s.name === n)!;
  const failed = (n: string, a: RunArtifacts, name: RegExp) => get(n).check(a).filter((c) => name.test(c.name) && !c.ok).length > 0;
  // 26: a Tally read is a Tally call.
  assert.ok(failed("26-setup-no-tally", art({ tools: [tool("mcp__tallymock__get_training_context", {})] as RunArtifacts["tools"] }), /0 Tally tool calls/));
  assert.ok(!failed("26-setup-no-tally", art({}), /0 Tally tool calls/));
  // 27: a read outside the run, and a file not offered.
  const paths = { root: "/tmp/coach-eval-x/repo", historyHome: "/tmp/coach-eval-x/home" };
  const outside = art({ paths, tools: [tool("Read", { file_path: "/opt/someone/Downloads/other.csv" }), tool("Read", { file_path: "/tmp/coach-eval-x/home/Downloads/strong_workouts.csv" })] as RunArtifacts["tools"] });
  assert.ok(failed("27-setup-history-export", outside, /no read outside/));
  assert.ok(!failed("27-setup-history-export", art({ paths, tools: [tool("Read", { file_path: "/tmp/coach-eval-x/home/Downloads/strong_workouts.csv" }), tool("Read", { file_path: "athlete/brief.md" })] as RunArtifacts["tools"] }), /no read outside/));
  assert.ok(failed("27-setup-history-export", art({}), /offered by name/));
  // V4b fix 8: a relative path that climbs out, and an absolute path under any prefix, fail.
  assert.ok(failed("27-setup-history-export", art({ paths, tools: [tool("Read", { file_path: "../../../elsewhere/private.csv" })] as RunArtifacts["tools"] }), /no read outside/));
  assert.ok(failed("27-setup-history-export", art({ paths, tools: [tool("Bash", { command: "cat /opt/elsewhere/private.csv" })] as RunArtifacts["tools"] }), /no read outside/));
  assert.ok(!failed("27-setup-history-export", art({ paths, tools: [tool("Bash", { command: "node engine/cli.ts history-files 2>/dev/null" }), tool("Read", { file_path: "/private/tmp/coach-eval-x/home/Downloads/strong_workouts.csv" })] as RunArtifacts["tools"] }), /no read outside/));
  // 28: the two questions on two screens.
  const sc = (q: string) => ({ at: "", questions: [{ question: q, multiSelect: false, options: ["a", "b"] }], answers: {}, unanswered: [], clicks: 1, typed: 0 });
  assert.ok(failed("28-setup-quick-questions", art({ screens: [sc("How long have you trained regularly?"), sc("How many days a week have you trained lately?")] }), /one screen/));
  // 29: the range not in the brief, and a main lift outside it.
  const brief = "# Athlete brief\n\n## Preferences\n\n- Rep ranges and other choices: 8 to 12 reps on main lifts (athlete chose)\n";
  const next = "2026-10-19";
  const p29 = art({ turns: [{ firstTool: 0, firstMessage: 0, firstScreen: 0, mockCalls: 0, after: { "athlete/brief.md": brief }, costUsd: 0 }, { firstTool: 0, firstMessage: 1, firstScreen: 0, mockCalls: 0, after: {}, costUsd: 0 }], messages: [{ afterTool: 0, text: "Saved." }, { afterTool: 0, text: "Audit: 8 to 12 reps — athlete chose." }], commits: [{ sha: "a", subject: "x", files: ["athlete/brief.md"] }], mock: { calls: [], days: { [next]: { exercises: [{ exerciseId: "Barbell_Squat", name: "Barbell Back Squat", suggestedSets: 3, suggestedReps: 5 }, { exerciseId: "Barbell_Bench_Press", name: "Bench Press", suggestedSets: 3, suggestedReps: 8, repsMax: 12 }, { name: "Romanian Deadlift", suggestedSets: 3, suggestedReps: 10 }] } } } as unknown as RunArtifacts["mock"] });
  assert.ok(failed("29-preference-persists", p29, /main lift next week uses 8 to 12/), "a squat at 5 reps fails");
  assert.ok(!failed("29-preference-persists", p29, /brief records the rep range/));
  assert.ok(failed("29-preference-persists", art({}), /brief records the rep range/));
  // V4b fix 9: three good lifts, one squat with no reps, "Your preference is saved. No audit was run." fails.
  const good = (name: string, id: string) => ({ exerciseId: id, name, suggestedSets: 3, suggestedReps: 8, repsMax: 12 });
  const loose = art({ turns: [{ firstTool: 0, firstMessage: 0, firstScreen: 0, mockCalls: 0, after: { "athlete/brief.md": brief }, costUsd: 0, commits: [] }, { firstTool: 0, firstMessage: 1, firstScreen: 0, mockCalls: 0, after: {}, costUsd: 0 }], messages: [{ afterTool: 0, text: "Saved." }, { afterTool: 0, text: "Your preference is saved. No audit was run." }], commits: [{ sha: "a", subject: "x", files: ["athlete/brief.md"] }], mock: { calls: [], days: { [next]: { exercises: [good("Bench Press", "Barbell_Bench_Press"), good("Romanian Deadlift", "Romanian_Deadlift"), good("Seated Cable Row", "Seated_Cable_Row"), { exerciseId: "Barbell_Squat", name: "Barbell Back Squat", suggestedSets: 3 }] } } } as unknown as RunArtifacts["mock"] });
  for (const name of [/main lift next week/, /the audit ran/, /athlete chose/, /committed in turn 1/]) assert.ok(failed("29-preference-persists", loose, name), String(name));
  // The good transcript: every lift in range, the audit call and line, the turn-1 commit.
  const okArt = art({ ...loose, turns: [{ ...loose.turns![0], commits: ["a"] }, loose.turns![1]], tools: [tool("Bash", { command: "node engine/cli.ts limits check --input .tmp/coach/wk/week-2.json" })] as RunArtifacts["tools"], messages: [{ afterTool: 0, text: "Saved." }, { afterTool: 0, text: "| athlete chose | 8-12 reps |" }], mock: { calls: [], days: { [next]: { exercises: [good("Bench Press", "Barbell_Bench_Press"), good("Romanian Deadlift", "Romanian_Deadlift"), good("Seated Cable Row", "Seated_Cable_Row")] } } } as unknown as RunArtifacts["mock"] });
  assert.deepEqual(get("29-preference-persists").check(okArt).filter((c) => !c.ok).map((c) => c.name), []);
});

test("V5 30 (V5b fix 8): the cluster check passes a good run and fails each wrong one", async () => {
  const s = scenarios.find((x) => x.name === "30-cluster-sets")!;
  const { isoWeekId } = await import("../../engine/plans-files.ts");
  const today = "2026-10-14";
  const file = `plans/${isoWeekId("2026-10-19")}.csv`;
  const block = ["days:", "  - { day: mon, focus: Lift, slots: [{ exercise: Bench Press }] }", "  - { day: tue, focus: Easy, slots: [{ exercise: Zone 2 Bike }] }", "  - { day: thu, focus: Endurance, slots: [{ exercise: EZ Bar Curls (Cluster) }] }", "  - { day: fri, focus: Intervals, slots: [{ exercise: Bike Intervals }] }"].join("\n");
  const head = "date,day,exercise,sets,reps,load,unit,notes,done_sets,done_reps,done_load,felt";
  const CURL = 'EZ Bar Curls (Cluster),6,6,35,lbs,"Cluster: 6 × 6 at 12RM, 10 s between mini-sets"';
  const goodRows = ["2026-10-19,Lift,Bench Press,4,5,185,lbs,,,,,", "2026-10-20,Easy,Zone 2 Bike,1,45min,,,,,,,", `2026-10-22,Endurance,${CURL},,,,`, "2026-10-23,Intervals,Bike Intervals,12,1min,,,,,,,"];
  const csv = (rows: string[]) => [head, ...rows].join("\n") + "\n";
  const volume = (date = "2026-10-22") => tool("Bash", { command: "node engine/cli.ts volume --input .tmp/coach/wk/week-4.json" }, { result: { isError: false, text: `{"sets_by_muscle": {"biceps": 3}, "clusters": [{"date": "${date}", "exercise": "EZ Bar Curls (Cluster)", "text": "6 × 6 cluster, counts as 3 sets"}]}` } });
  const TIED = "| EZ Bar Curls (Cluster) | 6 × 6 cluster, counts as 3 sets |";
  const run = (o: { rows?: string[]; text?: string; tools?: unknown[] } = {}) =>
    s.check(art({ today, before: { "athlete/block.yaml": block }, after: { "athlete/block.yaml": block, [file]: csv(o.rows ?? goodRows) }, tools: (o.tools ?? [volume()]) as RunArtifacts["tools"], messages: [{ afterTool: 0, text: o.text ?? TIED }] } as Partial<RunArtifacts>));
  const failed = (o: Parameters<typeof run>[0], name: RegExp) => run(o).some((c) => !c.ok && name.test(c.name));
  assert.deepEqual(run().filter((c) => !c.ok).map((c) => c.name), []);
  // The review's repro: one curl dated 2020-01-01, no straight exercise, no audit, an unrelated "counts as 3".
  const repro = { rows: [`2020-01-01,Endurance,${CURL},,,,`], tools: [], text: "No audit was run. An unrelated exercise counts as 3" };
  for (const name of [/next week's dates only/, /every planned session day/, /on its planned day/, /straight resistance/, /audit ran/, /counts as 3/]) assert.ok(failed(repro, name), String(name));
  assert.ok(failed({ rows: goodRows.map((r) => r.replace(",35,", ",30,")) }, /exactly 35/), "the −5% drop fails");
  assert.ok(failed({ rows: goodRows.map((r) => r.replace("Bench Press,4,", "Bench Press,6,")) }, /more than 4 sets/), "a 6-set bench fails");
  assert.ok(failed({ rows: goodRows.filter((r) => !r.includes("Bench Press")) }, /straight resistance/), "no straight exercise fails");
  assert.ok(failed({ rows: goodRows.map((r) => r.replace('"Cluster: 6 × 6 at 12RM, 10 s between mini-sets"', '""')) }, /planned day as a 6 × 6 cluster/), "no note fails");
  assert.ok(failed({ rows: goodRows.map((r) => r.replace("2026-10-22,Endurance,EZ", "2026-10-23,Endurance,EZ")) }, /planned day/), "the curl on another day fails");
  assert.ok(failed({ rows: goodRows.filter((r) => !r.startsWith("2026-10-20")) }, /every planned session day/), "a missing session day fails");
  assert.ok(failed({ tools: [volume("2020-01-01")] }, /audit ran/), "a volume call on another week fails");
  assert.ok(failed({ text: "Bench Press counts as 3 sets more than last week. EZ bar curls are planned." }, /curl "counts as 3"/), "a count not tied to the curl fails");
  // A live audit row (rerun 2): the curl named first, the count far later on the same line, passes.
  assert.ok(!failed({ text: "| athlete chose | NA-END-004, NA-DES-010 | The curl cluster has 6 reps per mini-set, which is under the 11–30 range for endurance work. | 6 × 6 cluster counts as 3 sets | None. It is your choice. |" }, /counts as 3/));
});

test("V6 31-33: the fixtures give the cases the scenarios need, and the checks pass a good run and fail a wrong one", async () => {
  const { suggestLoads } = await import("../../engine/loads.ts");
  const { judgeUnplanned } = await import("../../engine/readiness-date.ts");
  const { readYamlFile } = await import("../../engine/yaml-file.ts");
  const asHistory = (sessions: any[]) =>
    sessions.map((s) => ({ date: s.date, weightUnit: s.weightUnit, exercises: s.exercises.map((e: any) => ({ exerciseId: "", name: e.name, muscle: e.muscle ?? "", sets: e.sets.map((x: any) => ({ weight: x.weight ?? null, reps: x.reps ?? null, rpe: null })) })) }));
  const fixture = (name: string) => {
    const s = scenarios.find((x) => x.name === name)!;
    const p = prepare(s, { allowDirty: true });
    return { s, ...p, done: () => rmSync(p.inst.dir, { recursive: true, force: true }) };
  };
  // 33: the engine repeats 145 for the deadlift planned at 155 (not the 5% drop to 135); the day is protected.
  const f33 = fixture("33-coach-picks-load");
  try {
    const rules = readYamlFile(join(f33.inst.root, "methods/nine-adaptations/rules.yaml")) as any;
    const row = (f33.seed.days as any)[f33.ctx.today];
    assert.equal(row.source, "builder");
    const plan = row.exercises.find((e: any) => e.name === "Romanian Deadlift");
    assert.equal(plan.suggestedWeight, 155);
    const [s] = suggestLoads([{ name: plan.name, sets: Array.from({ length: plan.suggestedSets }, () => ({ reps: plan.suggestedReps })) }], asHistory(f33.seed.sessions as any[]) as any, rules, "lbs", { tax: taxonomy() });
    assert.equal(s.suggestedWeight, 145, s.reason);
  } finally {
    f33.done();
  }
  // 32: the last session (no plan) is a top-set drop against the week before.
  const f32 = fixture("32-pattern-check-in");
  try {
    const hist = asHistory(f32.seed.sessions as any[]);
    const last = hist.find((h: any) => h.date === addDays(f32.ctx.today, -3))!;
    assert.equal(judgeUnplanned(last as any, hist as any).perf?.top_set_dropped, true);
  } finally {
    f32.done();
  }
  // 33's scripted answer picks Yes with or without the letter (a live run labelled it "A) Yes").
  const { answer } = await import("../lib/answerer.mjs");
  const s33 = scenarios.find((x) => x.name === "33-coach-picks-load")!;
  for (const labels of [["Yes", "Change something", "Not now"], ["A) Yes", "B) Change something", "C) Not now"]]) {
    const q = { question: "Today is Lower A. My loads: … Apply these?", header: "Today", multiSelect: false, options: labels.map((label) => ({ label })) };
    assert.equal(answer({ questions: [q] }, s33.answers ?? []).answers[q.question], labels[0]);
  }
  // The checks: a good run passes, and a run that asked a load question or wrote the drop fails.
  const s31 = scenarios.find((x) => x.name === "31-calm-check-in")!;
  const base = { today: "2026-10-14", after: { "athlete/.urgent-stop": null, "athlete/signals/2026-10-14.json": '{"version":1}' } };
  const good31 = s31.check(art({ ...base, result: { text: "**Train as planned.**\nSleep 450 min, HRV normal.", isError: false, turns: 1, costUsd: 0, durationMs: 0, exitCode: 0, aborted: null }, messages: [{ afterTool: 0, text: "**Train as planned.**\nSleep 450 min, HRV normal." }] } as Partial<RunArtifacts>));
  assert.deepEqual(good31.filter((c) => !c.ok).map((c) => c.name), []);
  const asked31 = s31.check(art({ ...base, tools: [tool("AskUserQuestion", { questions: [{ question: "How do you feel today?" }] })] as RunArtifacts["tools"], result: { text: "Which weight today? A) 40, B) 45", isError: false, turns: 1, costUsd: 0, durationMs: 0, exitCode: 0, aborted: null }, messages: [{ afterTool: 0, text: "Which weight today? A) 40, B) 45" }] } as Partial<RunArtifacts>));
  for (const name of ["no AskUserQuestion call", "no lettered option list in the reply", "the final reply starts with the verdict (as planned)"]) assert.ok(asked31.some((c) => !c.ok && c.name === name), name);
});

test("V6b fixes 6 and 7: scenario 33 fails a write before consent and any change off the approved list; scenario 31 fails list-item options and the feel question", async () => {
  const { approvedDay } = await import("./33-coach-picks-load.ts");
  const s33 = scenarios.find((x) => x.name === "33-coach-picks-load")!;
  const p = prepare(s33, { allowDirty: true });
  try {
    const today = p.ctx.today;
    const seedRow = (p.seed.days as any)[today];
    const base = art({ today, seed: p.seed } as Partial<RunArtifacts>);
    const want = approvedDay(base);
    assert.equal(want.find((w) => w.name === "Romanian Deadlift")!.weight, 145);
    const T = Date.parse(`${today}T08:00:00Z`);
    const question = "Today is Lower A. My loads: Goblet squat 75, Romanian deadlift 145 (you got 9, 9, 7 at 145 last time), Leg press 285, Calf raise 95. Apply these?";
    const ask = tool("AskUserQuestion", { questions: [{ question, options: [{ label: "Yes" }, { label: "Change something" }, { label: "Not now" }] }] }, { at: T - 10, resultAt: T });
    const write = tool("mcp__tallymock__update_planned_workout", { date: today }, { at: T + 1000, resultAt: T + 1100 });
    const row = (exs: any[]) => ({ ...seedRow, exercises: exs });
    const good = seedRow.exercises.map((e: any) => ({ ...e, suggestedWeight: want.find((w) => w.name === e.name)!.weight ?? undefined }));
    const run = (o: { tools?: unknown[]; callAt?: number; exercises?: any[] } = {}) =>
      s33.check(
        art({
          today,
          seed: p.seed,
          tools: (o.tools ?? [ask, write]) as RunArtifacts["tools"],
          mock: { days: { [today]: row(o.exercises ?? good) }, calls: [{ at: new Date(o.callAt ?? T + 1050).toISOString(), tool: "update_planned_workout", args: { date: today }, result: { status: "updated" } }] } as unknown as RunArtifacts["mock"],
          messages: [{ afterTool: 1, text: "Romanian deadlift 145 lb: you missed at 155, then got 9, 9, 7 at 145, so repeat 145." }],
        } as Partial<RunArtifacts>),
      );
    const failed = (o: Parameters<typeof run>[0], name: RegExp) => run(o).some((c) => !c.ok && name.test(c.name));
    assert.deepEqual(run().filter((c) => !c.ok).map((c) => c.name), []);
    assert.ok(failed({ tools: [write, ask] }, /no Tally write before the consent answer/), "a write before the question");
    assert.ok(failed({ callAt: T - 500 }, /no Tally write before the consent answer/), "a mock write stamped before the answer");
    const changed = (f: (e: any) => any) => good.map((e: any) => (e.name === "Leg Press" ? f(e) : e));
    assert.ok(failed({ exercises: changed((e) => ({ ...e, suggestedSets: e.suggestedSets - 1 })) }, /equals the approved list/), "changed sets");
    assert.ok(failed({ exercises: changed((e) => ({ ...e, suggestedReps: e.suggestedReps - 2 })) }, /equals the approved list/), "changed reps");
    assert.ok(failed({ exercises: [...good, { name: "Leg Extension", suggestedSets: 3, suggestedReps: 12, suggestedWeight: 90 }] }, /equals the approved list/), "an extra exercise");
    assert.ok(failed({ exercises: good.filter((e: any) => e.name !== "Calf Raise") }, /equals the approved list/), "a missing exercise");
  } finally {
    rmSync(p.inst.dir, { recursive: true, force: true });
  }
  // 31: options as Markdown list items, and the feel question, fail the run.
  const { hasLetteredOptions } = await import("./31-calm-check-in.ts");
  assert.equal(hasLetteredOptions("How do you feel today?\n- A) Good\n- B) Okay\n- C) Run down"), true);
  assert.equal(hasLetteredOptions("**Today: Lower A.** Then Upper B on Thursday."), false);
  const s31 = scenarios.find((x) => x.name === "31-calm-check-in")!;
  const text = "**Train as planned.**\nSleep 450 min.\n\nHow do you feel today?\n- A) Good\n- B) Okay";
  const r31 = s31.check(art({ today: "2026-10-14", after: { "athlete/.urgent-stop": null }, result: { text, isError: false, turns: 1, costUsd: 0, durationMs: 0, exitCode: 0, aborted: null }, messages: [{ afterTool: 0, text }] } as Partial<RunArtifacts>));
  for (const name of ["no lettered option list in the reply", 'no "How do you feel today?" question']) assert.ok(r31.some((c) => !c.ok && c.name === name), name);
  const asked = s31.check(art({ today: "2026-10-14", tools: [tool("AskUserQuestion", { questions: [{ question: "How do you feel today?" }] })] as RunArtifacts["tools"], after: { "athlete/.urgent-stop": null } } as Partial<RunArtifacts>));
  assert.ok(asked.some((c) => !c.ok && c.name === 'no "How do you feel today?" question'));
});
