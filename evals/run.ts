// Scenario runner.
//
//   npm run eval                                   every scenario once
//   npm run eval -- --runs 3 --only <name>[,<name>] repeated runs report pass counts
//   options: --model <id> (default claude-sonnet-5-5), --parallel <n> (default 3),
//            --timeout-min <n> (default 15), --keep (keep the temp folders), --list,
//            --allow-dirty (export uncommitted changes to tracked files; default: refuse),
//            --proxy (the permission proxy: default mode, no --allowedTools, every prompt logged and denied),
//            --rescore <results dir> (re-run the checks over saved artifacts; no model run)
//
// Each run: a copy of the public export (scripts/export-public.sh, built once per process)
// with a seeded athlete instance and mock Tally state,
// then `claude -p` (see lib/claude.ts for the isolation from the real Tally account),
// then the artifacts are collected and scored by the scenario's pure check function.
// Results go to evals/results/<stamp>/ (gitignored).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { writeState, type MockState } from "./mock-tally/client.ts";
import { apiMessagesFromEvents, BASE_TOOLS, mainCalls, messagesFromEvents, MOCK_TOOLS, runClaude, type ApiMessage } from "./lib/claude.ts";
import { check } from "./lib/checks.ts";
import { collectGh, collectGit, collectMock, collectVerdicts, snapshotFiles } from "./lib/collect.ts";
import { createInstance, git, MOCK_SERVER, mcpConfigWithFlags, publicExport, REPO, TZ, todayLocal, type Instance } from "./lib/instance.ts";
import { bootstrapProbes, type BootstrapState } from "./lib/probes.ts";
import { recoverTrust, trustWorkspace, UNTRUSTED } from "./lib/trust.ts";
import type { Check, RunArtifacts, Scenario, Screen, SetupContext, TurnRecord } from "./lib/types.ts";

const SCENARIO_DIR = join(REPO, "evals/scenarios");

export async function loadScenarios(): Promise<Scenario[]> {
  const files = readdirSync(SCENARIO_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("_")).sort();
  const out: Scenario[] = [];
  for (const f of files) out.push((await import(join(SCENARIO_DIR, f))).default as Scenario);
  return out;
}

export function missingSkills(s: Scenario, root = REPO): string[] {
  return s.skills.filter((k) => !existsSync(join(root, ".claude/skills", k, "SKILL.md")));
}

/** Builds the instance from the public export and runs the scenario's setup. */
export function prepare(s: Scenario, opts: { allowDirty?: boolean; proxy?: boolean } = {}): { inst: Instance; ctx: SetupContext; seed: MockState; instanceSha: string; bootstrap?: BootstrapState } {
  const inst = createInstance({ fresh: s.fresh, allowDirty: opts.allowDirty });
  const today = todayLocal(TZ);
  const mock: MockState = { timezone: TZ, weightUnit: "lbs", weightUnitSource: "settings", days: {}, sessions: [], operations: [], calls: [] };
  const ctx: SetupContext = {
    root: inst.root,
    today,
    tz: TZ,
    mock,
    write(rel, text) {
      mkdirSync(dirname(join(inst.root, rel)), { recursive: true });
      writeFileSync(join(inst.root, rel), text);
    },
    read: (rel) => readFileSync(join(inst.root, rel), "utf8"),
    ghPulls: (prs) => writeFileSync(inst.ghPulls, JSON.stringify(prs) + "\n"),
    git: (...args) => git(inst.root, ...args),
    historyHome: inst.historyHome,
  };
  s.setup(ctx);
  // Before any commit and before the model: the hooks of a fresh copy, with built-ins only.
  const bootstrap = s.fresh ? bootstrapProbes(inst.root) : undefined;
  writeState(inst.statePath, ctx.mock);
  // The permission proxy: the scripted user only logs each prompt and says no.
  mcpConfigWithFlags(inst, s.mock ?? {}, opts.proxy ? [] : s.approver, s.tally !== false);
  writeFileSync(inst.answersPath, JSON.stringify(s.answers ?? [], null, 2) + "\n");
  // An athlete copy after setup has an allow rule for its Tally server (setup runs allow-server).
  if (opts.proxy && !s.fresh && s.tally !== false) execFileSync(process.execPath, ["engine/cli.ts", "allow-server", "--server", MOCK_SERVER], { cwd: inst.root, stdio: "pipe" });
  git(inst.root, "add", "-A");
  try {
    git(inst.root, "commit", "-q", "-m", `instance: ${s.name}`);
  } catch {
    /* setup wrote nothing to commit */
  }
  git(inst.root, "push", "-q", "-f", "origin", "main");
  git(inst.root, "update-ref", "refs/remotes/origin/main", "main");
  const instanceSha = git(inst.root, "rev-parse", "HEAD").trim();
  return { inst, ctx, seed: JSON.parse(JSON.stringify(ctx.mock)), instanceSha, bootstrap };
}

export type RunRecord = { scenario: string; run: number; status: "pass" | "fail" | "error"; checks: Check[]; missingSkills: string[]; error?: string; costUsd: number | null; durationMs: number; dir: string; model?: string };

export async function runOnce(s: Scenario, n: number, opts: { model: string; timeoutMs: number; outDir: string; keep: boolean; allowDirty?: boolean; proxy?: boolean }): Promise<RunRecord> {
  const missing = missingSkills(s);
  // V4: a scenario may pin its model (the setup runs use West's model).
  const model = s.model ?? opts.model;
  const out = join(opts.outDir, opts.proxy ? `${s.name}+proxy` : s.name, `run-${n}`);
  mkdirSync(out, { recursive: true });
  const { inst, ctx, seed, instanceSha, bootstrap } = prepare(s, { allowDirty: opts.allowDirty, proxy: opts.proxy });
  const exp = publicExport({ allowDirty: opts.allowDirty });
  const before = snapshotFiles(inst.root, s.watch);
  const turns = [{ prompt: s.prompt, resume: false }, ...(s.turns ?? [])];
  const all = { tools: [] as RunArtifacts["tools"], events: [] as unknown[], stderr: "", text: "", isError: false, turns: 0, costUsd: null as number | null, durationMs: 0, exitCode: null as number | null, aborted: null as string | null };
  const records: TurnRecord[] = [];
  const apiMessages: (ApiMessage & { turn: number })[] = [];
  const seenMessages = new Set<string>();
  let sessionId: string | null = null;
  // The permission proxy runs in a trusted folder, as an athlete's copy is (lib/trust.ts).
  const untrust = opts.proxy ? trustWorkspace(inst.root) : () => {};
  try {
  for (const t of turns) {
    const prompt = typeof t.prompt === "function" ? t.prompt({ today: ctx.today }) : t.prompt;
    const record: TurnRecord = { firstTool: all.tools.length, firstMessage: messagesFromEvents(all.events).length, firstScreen: readScreens(inst).length, mockCalls: (collectMock(inst) as RunArtifacts["mock"]).calls.length, after: {}, costUsd: null };
    const claude = await runClaude({
      cwd: inst.root,
      prompt,
      model,
      mcpConfig: inst.mcpConfig,
      unattended: s.mode === "unattended",
      // The permission proxy allows no tool beyond the project's own settings.
      allowedTools: opts.proxy ? [] : [...BASE_TOOLS, ...MOCK_TOOLS, ...(s.allowedTools ?? [])],
      pathPrefix: inst.bin,
      env: { EVAL_GH_LOG: inst.ghLog, EVAL_GH_PULLS: inst.ghPulls, EVAL_ANSWERS: inst.answersPath, EVAL_ANSWER_LOG: inst.answerLog, COACH_HISTORY_HOME: inst.historyHome },
      timeoutMs: opts.timeoutMs,
      approver: !!s.approver || !!opts.proxy,
      settings: s.answers ? inst.settingsPath : undefined,
      resume: t.resume && sessionId ? sessionId : undefined,
    });
    sessionId = claude.sessionId ?? sessionId;
    all.tools.push(...claude.tools);
    all.events.push(...claude.events);
    all.stderr += claude.stderr;
    all.text = claude.text;
    all.isError ||= claude.isError;
    all.turns += claude.turns ?? 0;
    if (claude.costUsd !== null) all.costUsd = (all.costUsd ?? 0) + claude.costUsd;
    all.durationMs += claude.durationMs;
    all.exitCode = claude.exitCode;
    record.costUsd = claude.costUsd;
    record.exitCode = claude.exitCode;
    record.isError = claude.isError;
    // V7: main-thread API calls per turn; a resumed session's replayed message counts once.
    const msgs = apiMessagesFromEvents(claude.events, seenMessages);
    apiMessages.push(...msgs.map((m) => ({ ...m, turn: records.length })));
    record.mainCalls = mainCalls(msgs);
    record.messageIds = msgs.filter((m) => m.parent === null).map((m) => m.id);
    record.durationMs = claude.durationMs;
    record.after = snapshotFiles(inst.root, s.watch);
    record.commits = git(inst.root, "rev-list", "HEAD", `^${instanceSha}`).split("\n").filter(Boolean);
    records.push(record);
    if (claude.aborted) {
      all.aborted = claude.aborted;
      break;
    }
  }
  } finally {
    untrust();
  }
  const claude = { ...all, messages: messagesFromEvents(all.events) };
  writeFileSync(join(out, "events.jsonl"), claude.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(out, "stderr.txt"), claude.stderr);
  const g = collectGit(inst, instanceSha);
  const artifacts: RunArtifacts = {
    scenario: s.name,
    run: n,
    mode: s.mode,
    today: ctx.today,
    tz: TZ,
    seed,
    mock: collectMock(inst) as RunArtifacts["mock"],
    before,
    after: snapshotFiles(inst.root, s.watch),
    ...g,
    gh: collectGh(inst),
    tools: claude.tools,
    messages: claude.messages,
    result: { text: claude.text, isError: claude.isError, turns: claude.turns, costUsd: claude.costUsd, durationMs: claude.durationMs, exitCode: claude.exitCode, aborted: claude.aborted },
    prompts: readFileSync(inst.approverLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    verdicts: collectVerdicts(inst.root),
    screens: readScreens(inst),
    turns: records,
    ...(opts.proxy ? { proxy: true, trusted: !UNTRUSTED.test(all.stderr) } : {}),
    instance: { exportSha: exp.sha, exportDirty: exp.dirty, fresh: !!s.fresh },
    model,
    claudeVersion: claudeVersion(),
    apiMessages,
    paths: { root: inst.root, historyHome: inst.historyHome },
    ...(bootstrap ? { bootstrap } : {}),
  };
  writeFileSync(join(out, "artifacts.json"), JSON.stringify(artifacts, null, 2) + "\n");
  let rec: RunRecord;
  if (claude.aborted) {
    rec = { scenario: opts.proxy ? `${s.name}+proxy` : s.name, run: n, status: "error", checks: [], missingSkills: missing, error: claude.aborted, costUsd: claude.costUsd, durationMs: claude.durationMs, dir: out, model };
  } else {
    let checks: Check[];
    try {
      checks = [...s.check(artifacts), ...frictionChecks(s, artifacts)];
    } catch (e) {
      checks = [{ name: "check function", ok: false, detail: (e as Error).stack ?? String(e) }];
    }
    rec = { scenario: opts.proxy ? `${s.name}+proxy` : s.name, run: n, status: checks.every((c) => c.ok) ? "pass" : "fail", checks, missingSkills: missing, costUsd: claude.costUsd, durationMs: claude.durationMs, dir: out, model };
  }
  writeFileSync(join(out, "checks.json"), JSON.stringify(rec, null, 2) + "\n");
  // Claude Code keeps an auto-memory folder per project path; remove the temp instance's one.
  const memory = join(homedir(), ".claude/projects", realpathSync(inst.root).replace(/[^A-Za-z0-9]/g, "-"));
  if (memory.includes("coach-eval-")) rmSync(memory, { recursive: true, force: true });
  if (!opts.keep) rmSync(inst.dir, { recursive: true, force: true });
  else writeFileSync(join(out, "instance-path.txt"), inst.dir + "\n");
  return rec;
}

let version: string | undefined;
/** The Claude Code version (V7: recorded for every speed run). */
function claudeVersion(): string {
  if (version === undefined) {
    try {
      version = execFileSync("claude", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      version = "unknown";
    }
  }
  return version;
}

/** The screens the scripted athlete answered (one line per AskUserQuestion call). */
function readScreens(inst: Instance): Screen[] {
  return readFileSync(inst.answerLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Checks every scripted-answer or proxy run gets: each screen had a scripted answer (an
 * unanswered question fails the run, as the brief says), and under the permission proxy no
 * call reached a permission prompt (in interactive use it would be one).
 */
export function frictionChecks(s: Scenario, a: RunArtifacts): Check[] {
  const out: Check[] = [];
  // V3c: a turn that ends in an error or a nonzero exit fails the run, whatever its artifacts.
  const turns = a.turns?.length ? a.turns.map((t, i) => ({ i, exitCode: t.exitCode ?? a.result.exitCode, isError: t.isError ?? a.result.isError })) : [{ i: 0, exitCode: a.result.exitCode, isError: a.result.isError }];
  const bad = turns.filter((t) => t.isError || (t.exitCode !== null && t.exitCode !== undefined && t.exitCode !== 0));
  out.push(check("every turn ended without an error and with exit code 0", bad.length === 0, bad.map((t) => `turn ${t.i + 1}: exit ${t.exitCode}, is_error ${t.isError}`).join(" | ")));
  if (s.answers) {
    const open = (a.screens ?? []).flatMap((x) => x.unanswered);
    // A question that reached the permission host instead of the hook was not answered either.
    const viaPrompt = a.prompts.filter((p) => p.tool_name === "AskUserQuestion");
    out.push(check("every question had a scripted answer", open.length === 0 && viaPrompt.length === 0, [...open, ...viaPrompt.map((p) => JSON.stringify(p.input).slice(0, 200))].join(" | ")));
  }
  if (a.proxy) {
    out.push(check("permission proxy: the project settings were trusted", a.trusted !== false, "Claude Code ignored the project's allow rules (untrusted workspace)"));
    const asked = a.prompts.filter((p) => p.tool_name !== "AskUserQuestion");
    out.push({ ...check("permission proxy: no permission prompt", asked.length === 0, asked.map((p) => `${p.tool_name} ${p.tool_name === "Bash" ? p.input?.command : JSON.stringify(p.input).slice(0, 160)}`).join(" | ")), data: { prompts: asked.map((p) => ({ tool: p.tool_name, input: p.tool_name === "Bash" ? p.input?.command : p.input })) } });
  }
  return out;
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

export function summarize(records: RunRecord[]): string {
  const by = new Map<string, RunRecord[]>();
  for (const r of records) by.set(r.scenario, [...(by.get(r.scenario) ?? []), r]);
  const lines = ["| scenario | model | pass | fail | error | cost | missing skills | failed checks |", "|---|---|---|---|---|---|---|---|"];
  for (const [name, rs] of by) {
    const count = (s: string) => rs.filter((r) => r.status === s).length;
    const failed = [...new Set(rs.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => c.name)))];
    const errs = [...new Set(rs.filter((r) => r.error).map((r) => r.error!.slice(0, 80)))];
    const models = [...new Set(rs.map((r) => r.model ?? "?"))].join(", ");
    const c = rs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    lines.push(`| ${name} | ${models} | ${count("pass")}/${rs.length} | ${count("fail")} | ${count("error")} | $${c.toFixed(2)} | ${rs[0].missingSkills.join(", ") || "-"} | ${[...failed, ...errs].join("; ") || "-"} |`);
  }
  const cost = records.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  lines.push("", `Runs: ${records.length}. Reported cost: $${cost.toFixed(2)}.`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "1" },
      only: { type: "string" },
      model: { type: "string", default: "claude-sonnet-5-5" },
      parallel: { type: "string", default: "3" },
      "timeout-min": { type: "string", default: "15" },
      keep: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      rescore: { type: "string" },
      "allow-dirty": { type: "boolean", default: false },
      proxy: { type: "boolean", default: false },
    },
  });
  if (values.rescore) {
    // Re-runs the (pure) checks over saved artifacts: no model run.
    const dir = values.rescore;
    const byName = new Map((await loadScenarios()).map((s) => [s.name, s]));
    const records: RunRecord[] = [];
    for (const name of readdirSync(dir).filter((n) => byName.has(n.replace(/\+proxy$/, ""))).sort()) {
      // A run still in progress has no checks.json yet: skip it.
      for (const run of readdirSync(join(dir, name)).filter((r) => r.startsWith("run-") && existsSync(join(dir, name, r, "checks.json"))).sort()) {
        const old = JSON.parse(readFileSync(join(dir, name, run, "checks.json"), "utf8")) as RunRecord;
        const a = JSON.parse(readFileSync(join(dir, name, run, "artifacts.json"), "utf8")) as RunArtifacts;
        // Artifacts from before `messages` existed: rebuild it from the saved stream.
        const events = join(dir, name, run, "events.jsonl");
        if (!a.messages && existsSync(events)) {
          a.messages = messagesFromEvents(readFileSync(events, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
          writeFileSync(join(dir, name, run, "artifacts.json"), JSON.stringify(a, null, 2) + "\n");
        }
        if (old.status === "error") {
          records.push(old);
          continue;
        }
        const checks = [...byName.get(name.replace(/\+proxy$/, ""))!.check(a), ...frictionChecks(byName.get(name.replace(/\+proxy$/, ""))!, a)];
        const rec: RunRecord = { ...old, checks, status: checks.every((c) => c.ok) ? "pass" : "fail", missingSkills: missingSkills(byName.get(name.replace(/\+proxy$/, ""))!) };
        writeFileSync(join(dir, name, run, "checks.json"), JSON.stringify(rec, null, 2) + "\n");
        records.push(rec);
      }
    }
    const table = summarize(records);
    writeFileSync(join(dir, "summary.json"), JSON.stringify(records, null, 2) + "\n");
    writeFileSync(join(dir, "summary.md"), table + "\n");
    console.log(table);
    return;
  }
  // A crashed proxy run can leave a trust entry in ~/.claude.json: put the old record back first.
  const recovered = recoverTrust();
  if (recovered.length) console.log(`restored ${recovered.length} workspace trust record(s) left by a crashed run`);
  let scenarios = await loadScenarios();
  if (values.list) {
    for (const s of scenarios) console.log(`${s.name}\t${s.mode}\tskills: ${s.skills.join(",")}\tmissing: ${missingSkills(s).join(",") || "-"}`);
    return;
  }
  if (values.only) {
    const want = values.only.split(",");
    scenarios = scenarios.filter((s) => want.some((w) => s.name === w || s.name.startsWith(w)));
    if (scenarios.length === 0) throw new Error(`no scenario matches ${values.only}`);
  }
  const runs = Number(values.runs);
  const exp = publicExport({ allowDirty: values["allow-dirty"] });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(REPO, "evals/results", stamp);
  mkdirSync(outDir, { recursive: true });
  const jobs = scenarios.flatMap((s) => Array.from({ length: runs }, (_, i) => ({ s, n: i + 1 })));
  console.log(`${jobs.length} runs (${scenarios.length} scenarios x ${runs}), model ${[...new Set(scenarios.map((s) => s.model ?? values.model))].join(", ")}, export ${exp.sha.slice(0, 7)}${exp.dirty ? " (dirty)" : ""}, results in ${outDir}`);
  const records = await pool(jobs, Number(values.parallel), async ({ s, n }) => {
    const r = await runOnce(s, n, { model: values.model!, timeoutMs: Number(values["timeout-min"]) * 60_000, outDir, keep: values.keep!, allowDirty: values["allow-dirty"], proxy: values.proxy });
    console.log(`${r.status.toUpperCase()} ${s.name} run ${n}${r.error ? ` (${r.error})` : ""}${r.checks.filter((c) => !c.ok).map((c) => `\n    x ${c.name}${c.detail ? `: ${c.detail.slice(0, 200)}` : ""}`).join("")}`);
    return r;
  });
  const table = summarize(records);
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(records, null, 2) + "\n");
  writeFileSync(join(outDir, "summary.md"), table + "\n");
  console.log("\n" + table);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
