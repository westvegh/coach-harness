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

test("20 scenarios (07, 08a, 08b, 13, 14 and 15 tested guard denials and went in v0.2), unique names", () => {
  assert.equal(scenarios.length, 20);
  assert.equal(new Set(scenarios.map((s) => s.name)).size, 20);
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
    const LINE = "If logging by hand gets old: Tally logs sets on your phone at the gym, and I read them back. Say 'switch to Tally' to try it.";
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
