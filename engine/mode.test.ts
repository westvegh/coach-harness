import { test } from "node:test";
import assert from "node:assert/strict";
import { mode } from "./mode.ts";

test("mode: the env matrix", () => {
  const cases: [NodeJS.ProcessEnv, string][] = [
    [{}, "interactive"],
    [{ CLAUDE_CODE_REMOTE: "true" }, "unattended"],
    [{ CLAUDE_CODE_REMOTE: "1" }, "unattended"],
    [{ CLAUDE_CODE_REMOTE: "" }, "interactive"],
    [{ COACH_UNATTENDED: "1" }, "unattended"],
    [{ COACH_UNATTENDED: "true" }, "unattended"],
    [{ COACH_UNATTENDED: "0" }, "interactive"],
    [{ COACH_UNATTENDED: "" }, "interactive"],
    [{ CLAUDE_CODE_REMOTE: "true", COACH_UNATTENDED: "0" }, "unattended"],
    [{ CLAUDE_CODE_REMOTE: "", COACH_UNATTENDED: "1" }, "unattended"],
  ];
  for (const [env, want] of cases) assert.equal(mode(env), want, JSON.stringify(env));
});

test("mode: reads process.env by default", () => {
  const saved = { r: process.env.CLAUDE_CODE_REMOTE, c: process.env.COACH_UNATTENDED };
  try {
    delete process.env.CLAUDE_CODE_REMOTE;
    process.env.COACH_UNATTENDED = "1";
    assert.equal(mode(), "unattended");
    delete process.env.COACH_UNATTENDED;
    assert.equal(mode(), "interactive");
  } finally {
    if (saved.r === undefined) delete process.env.CLAUDE_CODE_REMOTE;
    else process.env.CLAUDE_CODE_REMOTE = saved.r;
    if (saved.c === undefined) delete process.env.COACH_UNATTENDED;
    else process.env.COACH_UNATTENDED = saved.c;
  }
});
