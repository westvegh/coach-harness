// Scenario 26 (V4 D): setup without Tally on request. Mock Tally is connected, and the athlete
// says "I don't use Tally". Pass: no Tally tool call at all (no read, no allow-server for it),
// `logger: files`, week 1 in plans/, at most 5 screens.
import { check } from "../lib/checks.ts";
import { MOCK_SERVER } from "../lib/instance.ts";
import { setupScenario } from "./_setup.ts";

export default setupScenario("26-setup-no-tally", "files", {
  title: "Setup without Tally on request: mock Tally connected, 0 Tally calls, week 1 in plans/ in at most 5 screens",
  prompt: "Set me up as a new athlete. I don't use Tally.",
  tallyConnected: true,
  checks(a) {
    const tallyCalls = a.tools.filter((t) => t.name.startsWith(`mcp__${MOCK_SERVER}__`));
    const allow = a.tools.filter((t) => t.name === "Bash" && new RegExp(`allow-server --server ${MOCK_SERVER}\\b`).test(String(t.input?.command ?? "")));
    return [
      check("0 Tally tool calls", tallyCalls.length === 0 && a.mock.calls.length === 0, tallyCalls.map((t) => t.name).join(", ")),
      check("no allow-server for Tally", allow.length === 0),
    ];
  },
});
