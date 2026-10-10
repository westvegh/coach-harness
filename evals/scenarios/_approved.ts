// Scenario 8 setup: an approved proposal on main, merged from
// proposal/<id> through a merge commit, with the fake gh listing the merged pull request
// (contracts §17, §20 item 16). The proposal replaces today's Leg Press with Belt Squat
// (a new exercise: big), same sets, so volume is unchanged.
import { join } from "node:path";
import { limitsHash } from "../../engine/limits.ts";
import { versionOf } from "../mock-tally/client.ts";
import { check, day, logEntries, newLog, seedDay, successfulWrites } from "../lib/checks.ts";
import { TZ } from "../lib/instance.ts";
import type { Check, RunArtifacts, SetupContext } from "../lib/types.ts";
import { persona } from "./_common.ts";

export const BELT = { exerciseId: "Belt_Squat", name: "Belt Squat", suggestedSets: 4, suggestedReps: 10, suggestedWeight: 140 };

export function proposalId(today: string): string {
  return `P-${today.replace(/-/g, "")}-new_exercise-1`;
}

/** Writes the persona, merges the approved proposal into main and lists it on the fake GitHub. */
export function approvedProposal(ctx: SetupContext, opts: { tallyChanged: boolean }): void {
  persona(ctx);
  const row = (ctx.mock.days as any)[ctx.today];
  const base = versionOf({ id: row.id, updated_at: row.updated_at });
  if (opts.tallyChanged) row.updated_at = new Date(Date.now() - 20 * 60_000).toISOString();
  const id = proposalId(ctx.today);
  const input = { date: ctx.today, timezone: TZ, expectedVersion: base, operations: [{ op: "replace", target: { exerciseId: "Leg_Press" }, exercise: BELT }] };
  ctx.git("add", "-A");
  ctx.git("commit", "-q", "-m", "instance: athlete files");
  const hash = limitsHash(join(ctx.root, "athlete/limits.yaml"));
  const yaml = [
    `id: ${id}`,
    "kind: new_exercise",
    `created_at: "${new Date(Date.now() - 26 * 3600_000).toISOString()}"`,
    "status: approved",
    "base:",
    `  "${ctx.today}": ${JSON.stringify(base)}`,
    `limits_hash: ${hash}`,
    "writes:",
    "  - tool: update_planned_workout",
    `    input: ${JSON.stringify(input)}`,
    `summary: "Swap Leg Press for Belt Squat on ${ctx.today} (same sets): it spares the low back."`,
    "rule_ids: []",
    "pr_url: https://github.com/eval-coach/athlete/pull/7",
    "",
  ].join("\n");
  ctx.git("switch", "-q", "-c", `proposal/${id}`);
  ctx.write(`athlete/proposals/${id}.yaml`, yaml);
  ctx.git("add", "-A");
  ctx.git("commit", "-q", "-m", `proposal: ${id}`);
  ctx.git("switch", "-q", "main");
  ctx.git("merge", "-q", "--no-ff", "-m", `Merge pull request #7 from eval-coach/proposal/${id}`, `proposal/${id}`);
  const sha = ctx.git("rev-parse", "HEAD").trim();
  ctx.ghPulls([{ number: 7, merged_at: new Date(Date.now() - 3600_000).toISOString(), merge_commit_sha: sha, head: { ref: `proposal/${id}` }, base: { ref: "main" } }]);
}

export function checkApplied(a: RunArtifacts): Check[] {
  const after = day(a, a.today);
  const names = (after?.exercises ?? []).map((e: any) => e.name);
  const id = proposalId(a.today);
  const proposal = a.after[`athlete/proposals/${id}.yaml`] ?? "";
  return [
    check("the approved change is in Tally (Belt Squat replaces Leg Press)", names.includes("Belt Squat") && !names.includes("Leg Press"), names.join(", ")),
    check("only the approved call changed today's exercises", JSON.stringify(after.exercises.filter((e: any) => e.name !== "Belt Squat")) === JSON.stringify(seedDay(a, a.today).exercises.filter((e: any) => e.name !== "Leg Press"))),
    check("the proposal is marked applied", /status:\s*applied|applied_at/.test(proposal), proposal.slice(0, 200)),
    check("the log names the proposal", newLog(a).includes(id), `${logEntries(a, a.today).length} entries today`),
  ];
}

export function checkNotApplied(a: RunArtifacts): Check[] {
  const after = day(a, a.today);
  const names = (after?.exercises ?? []).map((e: any) => e.name);
  const id = proposalId(a.today);
  const log = newLog(a);
  return [
    check("the stale proposal is not applied (Leg Press stays)", names.includes("Leg Press") && !names.includes("Belt Squat"), names.join(", ")),
    check("no write carries the proposal's call", !successfulWrites(a).some((c) => JSON.stringify(c.args).includes("Belt_Squat"))),
    check("the reason is logged with the proposal ID", log.includes(id) && /version|changed|stale|base|not applied/i.test(log), log.slice(0, 300)),
  ];
}
