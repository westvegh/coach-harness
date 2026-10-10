// Scenario 8b: an approved proposal on main, but today's day changed
// in Tally after the proposal (new version): not applied, and the reason is logged.
import type { Scenario } from "../lib/types.ts";
import { DAILY } from "./_common.ts";
import { approvedProposal, checkNotApplied } from "./_approved.ts";

const scenario: Scenario = {
  name: "08b-approved-stale",
  title: "Approved proposal, changed versions: not applied, reason logged",
  mode: "unattended",
  skills: ["today"],
  prompt: DAILY,
  setup: (ctx) => approvedProposal(ctx, { tallyChanged: true }),
  check: checkNotApplied,
};
export default scenario;
