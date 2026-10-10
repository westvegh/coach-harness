// SessionStart (docs/contracts.md §13): what is due, the hold, a pending safety check,
// approved proposals not yet applied, snapshot freshness and privacy warnings. Files only:
// a hook has no MCP access. A malformed safety file: stderr, exit 2.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadApprovals } from "../../engine/approvals.ts";
import { loadConfig } from "../../engine/config.ts";
import { localDate, weekdayOf, weekStart } from "../../engine/dates.ts";
import { readBlock, readPending } from "../../engine/guard-context.ts";
import { readHold } from "../../engine/hold.ts";
import { scanRepo } from "../../engine/privacy.ts";
import { blockWeekAt } from "../../engine/progression.ts";
import { loadSnapshot, snapshotAgeMinutes } from "../../engine/snapshot.ts";
import { context, hookNow, projectRoot, readInput, runHook } from "./lib.ts";

runHook("session-context", () => {
  const sessionId = String(readInput().session_id ?? "");
  const root = projectRoot();
  const now = hookNow();
  const cfgPath = join(root, "coach.yaml");
  if (!existsSync(cfgPath)) {
    context("SessionStart", "coach-harness: no coach.yaml yet. Run the setup skill before any coaching.");
    return;
  }
  const cfg = loadConfig(cfgPath);
  const today = localDate(now, cfg.athlete.timezone);
  const lines: string[] = [`coach-harness: today is ${today} (${weekdayOf(today)}) in ${cfg.athlete.timezone}.`];

  // Safety first.
  const hold = readHold(root);
  const pending = readPending(root);
  if (pending) lines.push(`SAFETY FIRST: a safety check is pending since ${pending.at} (terms: ${pending.terms.join(", ") || "none"}). Only recovery or rest writes are allowed. Ask about the symptom before anything else.`);
  if (hold?.active) lines.push(`HOLD ACTIVE since ${hold.set_at}: ${hold.reason}${hold.regions.length ? ` (regions: ${hold.regions.join(", ")})` : ""}. Only recovery or rest writes are allowed; clearing needs the user's interactive yes.`);

  // What is due.
  const due: string[] = [];
  const signal = join(root, "athlete/signals", `${today}.json`);
  let checkedIn = false;
  if (existsSync(signal)) {
    try {
      checkedIn = !!(JSON.parse(readFileSync(signal, "utf8")) as { checkin?: unknown }).checkin;
    } catch {
      lines.push(`WARNING: athlete/signals/${today}.json is not valid JSON.`);
    }
  }
  if (!checkedIn) due.push("today's check-in");
  const logFile = join(root, "athlete/log", `${today.slice(0, 7)}.md`);
  if (!existsSync(logFile) || !readFileSync(logFile, "utf8").includes(`## ${today} `)) due.push("the daily run (no log entry today)");
  if (weekdayOf(today) === cfg.automation.weekly.day) due.push("the weekly review");
  const block = readBlock(root);
  if (!block) due.push("a training block (athlete/block.yaml is empty)");
  else {
    const bw = blockWeekAt(block, weekStart(today));
    if (!bw) due.push("a new block (this week is outside the current block)");
    else lines.push(`Block ${block.id}: week ${bw.week} (${bw.kind}).`);
  }
  lines.push(due.length ? `Due: ${due.join("; ")}.` : "Nothing is due.");

  // Approved proposals on main, not yet applied.
  const scan = loadApprovals(root);
  if (scan.records.length) lines.push(`Approved, not yet applied: ${scan.records.map((r) => r.proposal_id).join(", ")}. Apply them first, under the guard's approval-record rule.`);
  for (const r of scan.rejected) lines.push(`Proposal not accepted as approved: ${r.path} (${r.reason}).`);
  for (const w of scan.warnings) lines.push(`WARNING: ${w}`);

  // Freshness.
  try {
    const snap = loadSnapshot(root);
    if (snap) lines.push(`Snapshot: ${Math.round(snapshotAgeMinutes(snap, now))} minutes old, from ${snap.session_id === sessionId ? "this" : "another"} session; read the affected days again before any write.`);
  } catch (e) {
    lines.push(`WARNING: the snapshot is malformed (${(e as Error).message.split("\n")[0]}); the next logger read replaces it.`);
  }
  if (!cfg.automation.verified && cfg.automation.mode !== "manual") lines.push("Automation is not verified yet: run the setup test run.");

  // Privacy.
  try {
    const findings = scanRepo(root).filter((f) => f.kind !== "athlete-file");
    if (findings.length) lines.push(`PRIVACY: ${findings.length} tracked file finding(s): ${findings.slice(0, 5).map((f) => `${f.file}${f.line ? `:${f.line}` : ""} (${f.detail})`).join("; ")}.`);
    execFileSync("git", ["check-ignore", "-q", "athlete/.cache/snapshot.json"], { cwd: root, stdio: "ignore" });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 1) lines.push("PRIVACY: athlete/.cache/ is not in .gitignore; the snapshot could be committed.");
  }
  context("SessionStart", lines.join("\n"));
});
