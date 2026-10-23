// SessionStart (docs/contracts.md §13): today's state for the coach. A record, not a gate.
//   - the urgent stop, first;
//   - v0.1 safety files: an urgent hold or urgent pending terms become the urgent stop, then
//     the coach asks whether to remove the old files;
//   - the athlete's limits as written in athlete/limits.md (cut at 2,000 characters), the pain
//     threshold, and until the 0.3.0 migration runs the old limits.yaml's limits as text;
//   - setup progress, what is due and the block week;
//   - privacy: the pre-push hook is installed when it is missing; tracked-file findings.
// Files only: a hook has no MCP access.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBlock } from "../../engine/block.ts";
import { loadConfig } from "../../engine/config.ts";
import { localDate, weekdayOf, weekStart } from "../../engine/dates.ts";
import { classifyLegacy } from "../../engine/legacy.ts";
import { limitsCarry, LIMITS_TEXT_MAX, painThreshold } from "../../engine/limits-text.ts";
import { scanRepo } from "../../engine/privacy.ts";
import { blockWeekAt } from "../../engine/progression.ts";
import { URGENT_CARE_TEXT } from "../../engine/safety-text.ts";
import { commitPaths, readStop, URGENT_RELATIVE, writeStop } from "../../engine/urgent.ts";
import { context, hookNow, projectRoot } from "./lib.ts";

/** An error as one line, with its code when it has one. */
function oneLine(e: unknown): string {
  const err = e as Error & { code?: string };
  const msg = err.message.replace(/\s*\n\s*/g, " ").trim();
  return err.code && !msg.startsWith(err.code) ? `${err.code}: ${msg}` : msg;
}

/** The last "setup: <part> done|stopped" line of athlete/log/setup.md (v0.1: "setup: step <n> done"), or null. */
function setupProgress(root: string): string | null {
  const p = join(root, "athlete/log/setup.md");
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf8").split("\n").filter((l) => /^setup: (step \S+|[a-z0-9]+) (done|stopped)\b/.test(l.trim()));
  return lines.length ? lines[lines.length - 1].trim() : null;
}

/**
 * Installs the pre-push hook when it is missing or differs (a fresh clone has none).
 * Returns a line for the context, or null when the hook was already there.
 */
async function ensureGitHook(root: string): Promise<string | null> {
  let hook: string;
  try {
    hook = execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-push"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
  const src = join(import.meta.dirname, "..", "..", "git-hooks", "pre-push");
  // git prints an absolute path in a linked worktree or with an absolute core.hooksPath.
  const path = resolve(root, hook);
  try {
    // Installed means the same content and executable, as prepushCheck tests it.
    if (readFileSync(path, "utf8") === readFileSync(src, "utf8") && (statSync(path).mode & 0o111) !== 0) return null;
  } catch {
    /* missing: install it */
  }
  try {
    (await import("../../engine/cli-git.ts")).installGitHooks(root);
    return "Privacy: the pre-push hook was missing; it is installed now (it blocks a push of athlete data to a public repository).";
  } catch (e) {
    return `PRIVACY: the pre-push hook is missing and could not be installed (${oneLine(e)}). Run node engine/cli.ts install-git-hooks before any push.`;
  }
}

async function main(): Promise<void> {
  const root = projectRoot();
  const now = hookNow();
  const cfgPath = join(root, "coach.yaml");
  if (!existsSync(cfgPath)) {
    const progress = setupProgress(root);
    context("SessionStart", `coach-harness: no coach.yaml yet. Run the setup skill before any coaching.${progress ? ` Setup progress: ${progress}.` : ""}`);
    return;
  }
  const cfg = loadConfig(cfgPath);
  const today = localDate(now, cfg.athlete.timezone);
  const lines: string[] = [`coach-harness: today is ${today} (${weekdayOf(today)}) in ${cfg.athlete.timezone}.`];

  // v0.1 safety files: an urgent event in them becomes the urgent stop first.
  const legacy = classifyLegacy(root, cfg.athlete.timezone);
  if (legacy.urgent.length > 0) {
    writeStop(root, { terms: legacy.urgent, source: "legacy", now });
    commitPaths(root, [URGENT_RELATIVE], "urgent stop (legacy)");
  }

  // The urgent stop, first.
  const stop = readStop(root);
  if (stop) {
    lines.push(
      `URGENT STOP since ${stop.at} (terms: ${stop.terms.join(", ")}; sources: ${stop.sources.join(", ") || "unknown"}). Make no training change: the urgent gate denies every plan write.`,
      "Before anything else, give the urgent-care text, keeping every instruction:",
      URGENT_CARE_TEXT,
      "Then ask the clear question of the `safety` skill (one clickable question). Only the athlete's answer in a live session clears it: run `node engine/cli.ts urgent clear --reason clinician` or `--reason false-alarm`. Never clear it on your own reading.",
      "If `git status` shows athlete/.urgent-stop as not pushed, push it now: `node engine/cli.ts push`.",
    );
  }
  if (legacy.files.length > 0) {
    lines.push(
      `Old safety files: ${legacy.summary.join("; ")} (${legacy.files.join(", ")}). v0.2 uses limits instead; these files gate nothing.${legacy.urgent.length > 0 ? " The urgent event in them is now the urgent stop above." : ""}`,
      'Before the first training write, ask one question: "Your copy has an old hold or safety check. The v0.2 coach uses limits instead. Remove them? A) Yes, B) Show them first". On A, delete the old files and commit. Removing them never clears the urgent stop.',
    );
  }

  // Limits: the athlete's words, carried as written. Code never reads their meaning.
  try {
    const l = await limitsCarry(root);
    if (l.legacy) {
      lines.push(
        l.legacy.ok
          ? "This copy still has the old limits file (athlete/limits.yaml). In a live session, run `node engine/cli.ts migrate-limits` before any plan (the update skill's last step). A scheduled run does not convert it: it follows the limits below and logs one line."
          : `Your old limits file (athlete/limits.yaml) cannot be converted (${l.legacy.error}). Follow it as written below, and ask the athlete to fix it. Run \`node engine/cli.ts migrate-limits\` after the fix.`,
      );
    }
    if (!l.exists && !l.legacy) lines.push("Limits: athlete/limits.md is missing. Read it before any plan; when it does not exist, no limits are written yet (the setup and limits skills create it).");
    else lines.push(`Limits (athlete/limits.md; follow every line in every plan):\n${l.text || "(empty)"}`);
    // W3b: name every file the text came from, the old athlete/limits.yaml too before the migration.
    if (l.truncated) lines.push(`Limits cut at ${LIMITS_TEXT_MAX.toLocaleString("en-US")} characters: Read ${l.sources.join(" and ")} in full before any plan.`);
  } catch (e) {
    lines.push(`WARNING: the limits cannot be read here (${oneLine(e)}). Read athlete/limits.md in full before any plan.`);
  }
  const pain = painThreshold(root, cfg);
  lines.push(`Pain threshold: ${pain.value} (${pain.source === "default" ? "the default" : `from ${pain.source}`}): pain the athlete reports at or above it goes to the safety skill.`);

  const progress = setupProgress(root);
  if (progress) lines.push(`Setup progress: ${progress}.`);

  // What is due. A check-in is never due (V6 D): the athlete brings it up, and the daily run
  // asks its one question only on a day when the answer can change the workout.
  const due: string[] = [];
  const signal = join(root, "athlete/signals", `${today}.json`);
  if (existsSync(signal)) {
    try {
      JSON.parse(readFileSync(signal, "utf8"));
    } catch {
      lines.push(`WARNING: athlete/signals/${today}.json is not valid JSON.`);
    }
  }
  const logFile = join(root, "athlete/log", `${today.slice(0, 7)}.md`);
  if (!existsSync(logFile) || !readFileSync(logFile, "utf8").includes(`## ${today} `)) due.push("the daily run (no log entry today)");
  if (weekdayOf(today) === cfg.automation.weekly.day) due.push("the weekly review");
  try {
    const block = readBlock(root);
    if (!block) due.push("a training block (athlete/block.yaml is empty)");
    else {
      const bw = blockWeekAt(block, weekStart(today));
      if (!bw) due.push("a new block (this week is outside the current block)");
      else lines.push(`Block ${block.id}: week ${bw.week} (${bw.kind}).`);
    }
  } catch (e) {
    lines.push(`WARNING: athlete/block.yaml does not load (${oneLine(e)}).`);
  }
  lines.push(due.length ? `Due: ${due.join("; ")}.` : "Nothing is due.");
  if (!cfg.automation.verified && cfg.automation.mode !== "manual") lines.push("Automation is not verified yet: run the setup test run.");

  // Privacy (rule 2).
  const hookLine = await ensureGitHook(root);
  if (hookLine) lines.push(hookLine);
  try {
    const findings = scanRepo(root).filter((f) => f.kind !== "athlete-file");
    if (findings.length) lines.push(`PRIVACY: ${findings.length} tracked file finding(s): ${findings.slice(0, 5).map((f) => `${f.file}${f.line ? `:${f.line}` : ""} (${f.detail})`).join("; ")}.`);
    execFileSync("git", ["check-ignore", "-q", "athlete/.cache/snapshot.json"], { cwd: root, stdio: "ignore" });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 1) lines.push("PRIVACY: athlete/.cache/ is not in .gitignore; the snapshot could be committed.");
  }
  context("SessionStart", lines.join("\n"));
}

try {
  await main();
} catch (e) {
  // A malformed file: the reason on stderr, exit 2 (as lib.ts runHook).
  process.stderr.write(`session-context: ${oneLine(e)}\n`);
  process.exitCode = 2;
}
