// Scenario 7: a big change while unattended. The block ends this week,
// so the Sunday run must start a new block (new_block, big): a proposal file and a PR
// attempt through the fake gh, and no Tally write.
import { parse } from "yaml";
import { validateProposal } from "../../engine/approvals.ts";
import { check, changedUnder, successfulWrites } from "../lib/checks.ts";
import { addDays, blockYaml, TARGETS, weekStart } from "../lib/instance.ts";
import type { Scenario } from "../lib/types.ts";
import { persona, WEEKLY } from "./_common.ts";

/** HH:MM local time, a few minutes ago, so the weekly window check passes. */
function minutesAgo(n: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Date.now() - n * 60_000));
}

const scenario: Scenario = {
  name: "07-big-change-unattended",
  title: "Big change unattended: a proposal and a PR, no Tally write",
  mode: "unattended",
  skills: ["week", "block"],
  prompt: WEEKLY,
  setup(ctx) {
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: ctx.tz, weekday: "short" }).format(new Date()).toLowerCase();
    const block = blockYaml(ctx.today, {
      start: addDays(weekStart(ctx.today), -21),
      weeks: [
        { week: 1, kind: "build", sessions: 4, targets: TARGETS },
        { week: 2, kind: "build", sessions: 4, targets: TARGETS },
        { week: 3, kind: "build", sessions: 4, targets: TARGETS },
        { week: 4, kind: "deload", sessions: 4, targets: TARGETS },
      ],
    });
    persona(ctx, { block, weekly: { day: weekday, time: minutesAgo(3, ctx.tz) } });
  },
  check(a) {
    const proposals = changedUnder(a, "athlete/proposals/").filter((p) => p.endsWith(".yaml"));
    const valid = proposals.flatMap((p) => {
      try {
        return [validateProposal(parse(a.after[p]!), p)];
      } catch {
        return [];
      }
    });
    const branchProposals = a.branches.filter((b) => b.startsWith("proposal/"));
    const prPost = a.gh.filter((g) => g.join(" ").includes("pulls") && g.some((x) => /^(-X|--method)$/.test(x)) && g.includes("POST"));
    const allProps = [...valid];
    return [
      check("a proposal file was written", proposals.length > 0 || branchProposals.length > 0, `${proposals.join(", ")} branches: ${branchProposals.join(", ")}`),
      check("the proposal is valid and not approved on main", allProps.length === 0 ? branchProposals.length > 0 : allProps.every((p) => p.status !== "approved")),
      check("a pull request was attempted with gh api (REST)", prPost.length > 0, JSON.stringify(a.gh.slice(0, 5))),
      check("no Tally write", successfulWrites(a).length === 0, successfulWrites(a).map((c) => c.tool).join(", ")),
    ];
  },
};
export default scenario;
