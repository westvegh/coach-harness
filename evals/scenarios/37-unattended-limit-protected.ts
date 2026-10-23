// Scenario 37 (0.3.0; model-dependent): an unattended daily run with a limit and a protected day.
// Today's Lower A is the athlete's own day in Tally (user-modified) and has Leg Press 4 x 10; the
// line says no leg press. Pass: no write to today (a protected day gets none unattended), one log
// line "- proposal for the next live session: ..." that names the leg press, the limits file
// unchanged, no question, and the run committed and pushed.
import { askCalls, check, logEntries, successfulWrites, unchanged } from "../lib/checks.ts";
import type { Scenario } from "../lib/types.ts";
import { DAILY, persona } from "./_common.ts";

export const LEG_PRESS_LINE = "- Left knee: no leg press for now; squats to a box are fine. (since 2026-10-10)";

const scenario: Scenario = {
  name: "37-unattended-limit-protected",
  title: "Unattended, a limit and a protected day: no write, the conflict becomes a proposal line",
  mode: "unattended",
  skills: ["today"],
  prompt: DAILY,
  setup(ctx) {
    persona(ctx, {
      limits: [LEG_PRESS_LINE],
      tally: (m) => {
        const row = (m.days as Record<string, any>)[ctx.today];
        Object.assign(row, { source: "user", user_modified: true, client_id: `app-${ctx.today}`, mcp_batch_id: null });
      },
    });
  },
  check(a) {
    const writes = successfulWrites(a).filter((c) => c.args?.date === a.today);
    const entries = logEntries(a, a.today).join("\n");
    const proposal = entries.split("\n").find((l) => /^- proposal for the next live session: /.test(l) && /leg press/i.test(l)) ?? "";
    return [
      check("no write to today (a protected day, unattended)", writes.length === 0, JSON.stringify(writes.map((w) => w.tool))),
      check("the conflict is one proposal line that names the leg press", proposal !== "", entries.slice(0, 500)),
      check("the limits file is unchanged", unchanged(a, "athlete/limits.md")),
      check("no question (unattended)", askCalls(a).length === 0),
      check("the run committed and pushed", a.pushedMain.length > 0 && a.commits.some((c) => c.files.some((f) => f.startsWith("athlete/log/"))), `${a.pushedMain.length} pushed`),
    ];
  },
};
export default scenario;
