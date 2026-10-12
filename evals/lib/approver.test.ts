// The scripted user (approver.mjs), driven over stdio: a denied AskUserQuestion gets the
// print-mode text of a bare `claude -p`, never "The user said no.", so a run cannot read the
// denial as the athlete declining to answer. Other tools keep the rules and the old denial.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APPROVER = fileURLToPath(new URL("./approver.mjs", import.meta.url));

/** Sends one tools/call per prompt and returns each decision the approver gives. */
function ask(prompts: { tool_name: string; input?: unknown }[], rules: unknown[] = []) {
  const lines = [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    ...prompts.map((p, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "approve", arguments: { input: {}, ...p } } })),
  ];
  const r = spawnSync(process.execPath, [APPROVER], { input: lines.map((l) => JSON.stringify(l)).join("\n") + "\n", env: { ...process.env, APPROVER_RULES: JSON.stringify(rules), APPROVER_LOG: "" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  return out.filter((m) => m.id > 0).map((m) => JSON.parse(m.result.content[0].text));
}

const QUESTIONS = { questions: [{ question: "How bad is the left knee now, from 0 to 10?", header: "Pain score", options: [{ label: "0 to 3" }, { label: "4 to 6" }], multiSelect: false }] };

test("approver: a denied AskUserQuestion says the tool is not available, not that the user said no", () => {
  const [d] = ask([{ tool_name: "AskUserQuestion", input: QUESTIONS }]);
  assert.equal(d.behavior, "deny");
  assert.equal(d.message, "Error: No such tool available: AskUserQuestion. AskUserQuestion is disabled for this session, in subagents as well as here.");
  assert.doesNotMatch(d.message, /said no|declin/i);
});

test("approver: other tools keep the rules and the old denial", () => {
  const rules = [{ tool: "^Bash$", input: "git commit", behavior: "allow" }];
  const [allowed, denied, other] = ask(
    [
      { tool_name: "Bash", input: { command: "git commit -m x" } },
      { tool_name: "Bash", input: { command: "rm -rf athlete" } },
      { tool_name: "mcp__tallymock__plan_workout_day", input: {} },
    ],
    rules,
  );
  assert.deepEqual(allowed, { behavior: "allow", updatedInput: { command: "git commit -m x" } });
  assert.deepEqual(denied, { behavior: "deny", message: "The user said no." });
  assert.deepEqual(other, { behavior: "deny", message: "The user said no." });
});

test("approver: a rule can still allow AskUserQuestion", () => {
  const [d] = ask([{ tool_name: "AskUserQuestion", input: QUESTIONS }], [{ tool: "^AskUserQuestion$", behavior: "allow" }]);
  assert.deepEqual(d, { behavior: "allow", updatedInput: QUESTIONS });
});
