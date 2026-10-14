// The run isolation (decided: option A): the preflight aborts a run whose
// init event shows any MCP server or tool that is not the mock's, before the model acts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiMessagesFromEvents, childEnv, claudeArgs, DISALLOWED, mainCalls, MOCK_TOOLS, preflight, runClaude, type ClaudeOptions } from "./claude.ts";

const init = (tools: string[], servers: string[]) => ({ type: "system", subtype: "init", tools, mcp_servers: servers.map((name) => ({ name, status: "connected" })) });
const OK = init(["Bash", "Read", "mcp__tallymock__get_planned_workout", "mcp__tallymock__plan_workout_day"], ["tallymock"]);

test("preflight passes the mock alone", () => {
  assert.equal(preflight(OK), null);
});

test("preflight aborts on any real Tally or claude.ai tool or server", () => {
  for (const bad of [
    init(["Bash", "mcp__claude_ai_Tally_Workout__plan_workout_day"], ["tallymock"]),
    init(["mcp__Tally_Workout__get_planned_workout"], ["tallymock"]),
    init(["mcp__tally__plan_workout_day"], ["tallymock"]),
    init(["mcp__gbrain__search"], ["tallymock"]),
    init(["Bash"], ["tallymock", "claude.ai Tally Workout"]),
    init(["Bash"], ["tally"]),
  ]) {
    assert.match(String(preflight(bad)), /foreign MCP (tools|servers)/, JSON.stringify(bad));
  }
});

test("preflight fails closed on a missing or malformed init event", () => {
  assert.ok(preflight(null));
  assert.ok(preflight({ type: "assistant" }));
  assert.ok(preflight({ type: "system", subtype: "init", mcp_servers: [] }));
  assert.ok(preflight({ type: "system", subtype: "init", tools: [] }));
});

function fakeClaude(lines: object[], after = ""): string[] {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const script = join(dir, "claude.mjs");
  writeFileSync(
    script,
    `const lines = ${JSON.stringify(lines)};\nfor (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");\nsetTimeout(async () => { ${after} process.stdout.write(JSON.stringify({ type: "result", result: "done", num_turns: 1 }) + "\\n"); }, 400);\n`,
  );
  chmodSync(script, 0o755);
  return [process.execPath, script];
}

const base = (command: string[], cwd: string): ClaudeOptions => ({ cwd, prompt: "p", model: "m", mcpConfig: "/x.json", unattended: true, allowedTools: ["Bash"], pathPrefix: "/bin", env: {}, timeoutMs: 10_000, command });

test("runClaude kills the process when the init event shows a real Tally tool; nothing after it is processed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-run-"));
  const marker = join(dir, "after-init");
  const cmd = fakeClaude(
    [init(["mcp__claude_ai_Tally_Workout__plan_workout_day"], ["claude.ai Tally Workout"]), { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__claude_ai_Tally_Workout__plan_workout_day", input: {} }] } }],
    `(await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, "x");`,
  );
  const r = await runClaude(base(cmd, dir));
  assert.match(String(r.aborted), /^preflight: foreign MCP tools/);
  assert.equal(r.tools.length, 0, "the tool use after the init event is never recorded");
  assert.equal(r.text, "");
  assert.equal(existsSync(marker), false, "the process was killed before it went on");
});

test("runClaude records tool uses and results on a clean run", async () => {
  const cmd = fakeClaude([
    OK,
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__tallymock__get_planned_workout", input: { date: "2026-10-12" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: [{ type: "text", text: "{}" }] }] } },
  ]);
  const r = await runClaude(base(cmd, tmpdir()));
  assert.equal(r.aborted, null);
  assert.equal(r.tools.length, 1);
  assert.deepEqual(r.tools[0].result, { isError: false, text: "{}" });
  assert.equal(r.text, "done");
});

test("the command line and environment carry every safeguard", () => {
  const o = base(["claude"], tmpdir());
  const args = claudeArgs({ ...o, allowedTools: ["Bash", ...MOCK_TOOLS] });
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--mcp-config") + 1], "/x.json");
  for (const d of ["mcp__claude_ai_*", "mcp__claude_ai_Tally_Workout", "mcp__Tally_Workout", "mcp__tally"]) assert.ok(DISALLOWED.includes(d) && args.includes(d), d);
  assert.ok(!args.some((a) => /^mcp__(?!tallymock__)/.test(a) && !DISALLOWED.includes(a)), "only mock tools are allowed");
  const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.ANTHROPIC_AUTH_TOKEN = "tok";
  try {
    const env = childEnv(o);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    assert.equal(env.COACH_UNATTENDED, "1");
  } finally {
    if (saved.k === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.k;
    if (saved.t === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = saved.t;
  }
});

test("hook events may come before the init event; any other event before it aborts", async () => {
  const hook = { type: "system", subtype: "hook_started", hook_name: "SessionStart" };
  const ok = await runClaude(base(fakeClaude([hook, { ...hook, subtype: "hook_response" }, OK]), tmpdir()));
  assert.equal(ok.aborted, null);
  const bad = await runClaude(base(fakeClaude([hook, { type: "assistant", message: { content: [] } }, OK]), tmpdir()));
  assert.match(String(bad.aborted), /preflight: the first event is not system\/init/);
});

test("the scripted user's server passes the preflight only for a run that uses it", () => {
  const withApprover = init(["Bash", "mcp__tallymock__plan_workout_day", "mcp__evalapprover__approve"], ["tallymock", "evalapprover"]);
  assert.match(String(preflight(withApprover)), /foreign/);
  assert.equal(preflight(withApprover, ["tallymock", "evalapprover"]), null);
  assert.match(String(preflight(init(["mcp__claude_ai_Tally_Workout__plan_workout_day"], ["tallymock", "evalapprover"]), ["tallymock", "evalapprover"])), /foreign/);
});

// ---------- V7: main-thread API calls per turn ----------


const asst = (id: string, content: unknown[], parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent, message: { id, content } });
const tu = (id: string) => ({ type: "tool_use", id, name: "Bash", input: {} });

test("V7: one message sent as several assistant events counts once; a subagent's messages are not main-thread calls", () => {
  const events = [
    { type: "system", subtype: "init" },
    asst("msg_1", [{ type: "text", text: "Reading." }]),
    asst("msg_1", [tu("t1")]),
    asst("msg_1", [tu("t2")]),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
    asst("msg_sub", [tu("t3")], "t2"),
    asst("msg_sub", [{ type: "text", text: "sub" }], "t2"),
    asst("msg_2", [{ type: "text", text: "Done." }]),
  ];
  const msgs = apiMessagesFromEvents(events);
  assert.deepEqual(msgs.map((m) => [m.id, m.parent, m.tools]), [["msg_1", null, ["t1", "t2"]], ["msg_sub", "t2", ["t3"]], ["msg_2", null, []]]);
  assert.equal(mainCalls(msgs), 2);
});

test("V7: a resumed turn counts only its own messages, even when the stream replays an earlier one", () => {
  const seen = new Set<string>();
  const first = apiMessagesFromEvents([asst("a1", [tu("x")]), asst("a2", [{ type: "text", text: "ok" }])], seen);
  const resumed = apiMessagesFromEvents([asst("a2", [{ type: "text", text: "ok" }]), asst("b1", [tu("y")]), asst("b1", [tu("z")]), asst("b2", [])], seen);
  assert.equal(mainCalls(first), 2);
  assert.deepEqual(resumed.map((m) => m.id), ["b1", "b2"]);
  assert.deepEqual(resumed[0].tools, ["y", "z"]);
});
