// Scenario 8a: an approved proposal on main whose base versions still
// match Tally: the daily run applies it.
import type { Scenario } from "../lib/types.ts";
import { DAILY } from "./_common.ts";
import { approvedProposal, checkApplied } from "./_approved.ts";

const scenario: Scenario = {
  name: "08a-approved-applied",
  title: "Approved proposal, matching versions: applied",
  mode: "unattended",
  skills: ["today"],
  prompt: DAILY,
  setup: (ctx) => approvedProposal(ctx, { tallyChanged: false }),
  check: checkApplied,
};
export default scenario;
