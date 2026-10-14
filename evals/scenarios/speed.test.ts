// V7b finding 13: the speed checks fail when a piece of the work is skipped. A synthetic run that
// does all the work passes; each mutation removes one piece and must fail a check. Made-up data.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunArtifacts, ToolUse } from "../lib/types.ts";
import { speedChecks } from "./_speed.ts";

const TODAY = "2026-10-14";
const RUN = "r-20261014-0800-abcd";
const W = [
  { since: "2026-10-01", until: "2026-10-14", limit: 10 },
  { since: "2026-09-17", until: "2026-09-30", limit: 10 },
  { since: "2026-09-03", until: "2026-09-16", limit: 10 },
  { since: "2026-08-19", until: "2026-09-02", limit: 10 },
];
const PAST = ["2026-10-13", "2026-10-12", "2026-10-11", "2026-10-10"];
const READS: { tool: string; args: Record<string, any> }[] = [
  { tool: "get_planned_workout", args: { date: TODAY } },
  { tool: "get_training_context", args: { historyWeeks: 2 } },
  ...PAST.map((d) => ({ tool: "get_planned_workout", args: { date: d } })),
  ...W.map((w) => ({ tool: "get_workout_history", args: w })),
];
const OPID = "op-2026-10-14-trim_session-0123456789ab";
const ok = (x: unknown) => ({ isError: false, text: JSON.stringify(x) });
let n = 0;
const tool = (name: string, input: any, result: unknown, messageId: string): ToolUse => ({ id: `t${n++}`, name, input, result: ok(result), messageId, parent: null });
const bash = (command: string, result: unknown, m: string) => tool("Bash", { command }, result, m);
const read = (r: (typeof READS)[number]) => tool(`mcp__tallymock__${r.tool}`, { ...r.args, timezone: "America/Los_Angeles" }, r.tool === "get_planned_workout" ? { date: r.args.date, found: r.args.date === TODAY } : { count: 0, sessions: [] }, "m3");

function run(write: boolean): RunArtifacts {
  const snapshot = {
    days: Object.fromEntries([TODAY, ...PAST].map((d) => [d, { found: d === TODAY }])),
    planned: { from: TODAY, dates: {} },
    history_windows: Object.fromEntries(W.map((w) => [`${w.since}..${w.until}`, { complete: true }])),
  };
  const noChange = `## ${TODAY} 08:01 · no-change\n- trigger: user\n- readiness: wearable green (HRV 52 ms), subjective unknown (no check-in for today), performance green (all hit) → none\n- rules: none\n- change: none (a calm day)\n- run: ${RUN}\n`;
  const writeEntry = `## ${TODAY} 08:01 · ${OPID}\n- trigger: user\n- rules: none\n- change: update_planned_workout on ${TODAY} (trim_session)\n- approval: the coach, in a live session\n- result: written: ${TODAY}\n`;
  const tools: ToolUse[] = [
    tool("Skill", { skill: "today" }, "ok", "m1"),
    bash("node engine/cli.ts today-brief --stage pre", { run_id: RUN, reads: READS }, "m2"),
    ...READS.map(read),
    bash("node engine/cli.ts today-brief --stage post", { coverage: { history: { status: "complete" }, safety_notes: "complete", days: { [TODAY]: "complete" } }, need_reads: [] }, "m4"),
    ...(write
      ? [
          bash("node engine/cli.ts today-write-prep --input .tmp/coach/write.json", { write: { plain: { tool: "update_planned_workout", args: { opId: OPID } } } }, "m5"),
          tool("mcp__tallymock__update_planned_workout", { date: TODAY, opId: OPID }, { status: "updated" }, "m6"),
          tool("mcp__tallymock__get_planned_workout", { date: TODAY }, { date: TODAY, found: true }, "m7"),
        ]
      : []),
    bash(`node engine/cli.ts save --run ${RUN} --message "today"${write ? "" : ' --no-change "a calm day"'}`, { outcome: "published" }, "m8"),
  ];
  return {
    scenario: "speed", run: 1, mode: "interactive", today: TODAY, tz: "America/Los_Angeles",
    seed: {} as any, mock: { calls: [] } as any,
    before: { "athlete/log/2026-10.md": "# Operation log 2026-10\n\n" },
    after: { "athlete/log/2026-10.md": `# Operation log 2026-10\n\n${write ? writeEntry : noChange}`, "athlete/.cache/snapshot.json": JSON.stringify(snapshot) },
    commits: [{ sha: "c1", subject: "today", files: ["athlete/log/2026-10.md"] }], branches: ["main"], pushedMain: ["c1"], gh: [], tools, prompts: [], verdicts: [],
    result: { text: "Train as planned.", isError: false, turns: 1, costUsd: 0, durationMs: 30_000, exitCode: 0, aborted: null },
    turns: [{ firstTool: 0, firstMessage: 0, firstScreen: 0, mockCalls: 0, after: {}, costUsd: 0, mainCalls: write ? 10 : 6, durationMs: 30_000 }],
  };
}

const failsAfter = (write: boolean, what: string, change: (a: RunArtifacts) => void, named?: RegExp) => {
  const a = run(write);
  change(a);
  const failed = speedChecks(a, write ? 11 : 7, { write }).filter((c) => !c.ok);
  assert.ok(failed.length > 0, `${what}: a check must fail`);
  if (named) assert.ok(failed.some((c) => named.test(c.name)), `${what}: ${failed.map((c) => c.name).join("; ")}`);
};
const dropTool = (a: RunArtifacts, pred: (t: ToolUse) => boolean) => (a.tools = a.tools.filter((t) => !pred(t)));
const setResult = (a: RunArtifacts, pred: (t: ToolUse) => boolean, x: unknown, isError = false) => a.tools.filter(pred).forEach((t) => (t.result = { isError, text: JSON.stringify(x) }));
const cmd = (t: ToolUse, re: RegExp) => t.name === "Bash" && re.test(t.input.command);

test("a run that does all the work passes every speed check (no write, and a write)", () => {
  for (const write of [false, true]) {
    const failed = speedChecks(run(write), write ? 11 : 7, { write }).filter((c) => !c.ok);
    assert.deepEqual(failed, [], JSON.stringify(failed));
  }
});

test("each skipped piece fails a check", () => {
  failsAfter(false, "no training-context read", (a) => dropTool(a, (t) => t.name.endsWith("__get_training_context")));
  failsAfter(false, "a past date not read", (a) => dropTool(a, (t) => t.name.endsWith("__get_planned_workout") && t.input.date === PAST[2]));
  failsAfter(false, "a window not read", (a) => dropTool(a, (t) => t.name.endsWith("__get_workout_history") && t.input.since === W[3].since));
  failsAfter(false, "a read that failed", (a) => setResult(a, (t) => t.name.endsWith("__get_workout_history") && t.input.since === W[1].since, { error: "timeout" }, true));
  failsAfter(false, "a read in a later message", (a) => a.tools.filter((t) => t.name.endsWith("__get_training_context")).forEach((t) => (t.messageId = "m9")));
  failsAfter(false, "post saw incomplete coverage", (a) => setResult(a, (t) => cmd(t, /stage post/), { coverage: { history: { status: "missing" }, safety_notes: "incomplete", days: {} }, need_reads: [{ tool: "get_workout_history" }] }));
  failsAfter(false, "post still had reads to make", (a) => setResult(a, (t) => cmd(t, /stage post/), { coverage: { history: { status: "complete" }, safety_notes: "complete", days: {} }, need_reads: [{ tool: "get_planned_workout", args: { date: TODAY } }] }));
  failsAfter(false, "no post", (a) => dropTool(a, (t) => cmd(t, /stage post/)));
  failsAfter(false, "pre failed", (a) => setResult(a, (t) => cmd(t, /stage pre/), { error: { code: "INTERNAL" } }, true));
  failsAfter(false, "save did not publish", (a) => setResult(a, (t) => cmd(t, /save --run/), { outcome: "not_published" }));
  failsAfter(false, "no save", (a) => dropTool(a, (t) => cmd(t, /save --run/)));
  failsAfter(false, "a window left incomplete in the snapshot", (a) => {
    const s = JSON.parse(a.after["athlete/.cache/snapshot.json"]!);
    s.history_windows[`${W[0].since}..${W[0].until}`].complete = false;
    a.after["athlete/.cache/snapshot.json"] = JSON.stringify(s);
  });
  failsAfter(false, "no context in the snapshot", (a) => {
    const s = JSON.parse(a.after["athlete/.cache/snapshot.json"]!);
    delete s.planned;
    a.after["athlete/.cache/snapshot.json"] = JSON.stringify(s);
  });
  failsAfter(false, "an empty log entry", (a) => (a.after["athlete/log/2026-10.md"] = `# Operation log 2026-10\n\n## ${TODAY} 08:01 · no-change\n- run: ${RUN}\n`));
  failsAfter(false, "nothing pushed", (a) => (a.pushedMain = []));
  failsAfter(false, "over the call budget", (a) => (a.turns![0].mainCalls = 8));
  failsAfter(true, "no today-write-prep", (a) => dropTool(a, (t) => cmd(t, /today-write-prep/)));
  failsAfter(true, "today-write-prep without an opId", (a) => setResult(a, (t) => cmd(t, /today-write-prep/), { write: { plain: { args: {} } } }));
  failsAfter(true, "the write without the prepared opId", (a) => a.tools.filter((t) => t.name.endsWith("__update_planned_workout")).forEach((t) => delete t.input.opId));
  failsAfter(true, "the write failed", (a) => setResult(a, (t) => t.name.endsWith("__update_planned_workout"), { error: "version conflict" }, true));
  failsAfter(true, "no read-back", (a) => dropTool(a, (t) => t.name.endsWith("__get_planned_workout") && t.messageId === "m7"));
  failsAfter(true, "a read-back that failed", (a) => setResult(a, (t) => t.messageId === "m7", { error: "timeout" }, true));
  failsAfter(true, "the read-back after save", (a) => {
    const rb = a.tools.find((t) => t.messageId === "m7")!;
    a.tools = [...a.tools.filter((t) => t !== rb), rb];
  });
  failsAfter(true, "a plan write before post's note scan", (a) => {
    const w = a.tools.find((t) => t.name.endsWith("__update_planned_workout"))!;
    const post = a.tools.findIndex((t) => cmd(t, /stage post/));
    a.tools = a.tools.filter((t) => t !== w);
    a.tools.splice(post, 0, w);
  }, /no plan write before post's note scan/);
  failsAfter(true, "no log entry for the write", (a) => (a.after["athlete/log/2026-10.md"] = "# Operation log 2026-10\n\n"));
});
