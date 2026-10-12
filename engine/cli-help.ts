// The CLI's help text and command lists. engine/cli.ts reads only this file
// to answer --help and to choose a dispatcher, so neither loads any engine module.

/** The automation helper commands (engine/cli-helpers.ts; contracts §15). */
export const HELPER_COMMANDS = ["mode", "opid", "adjust", "loads", "targets", "routine-body", "launchd-plist", "install-launchd", "window-check"] as const;

/** True for an engine helper command (engine/cli-helpers2.ts): `readiness` only with --date, `signals` only with `refresh`. */
export function isHelpers2Command(cmd: string, argv: string[]): boolean {
  if (cmd === "readiness") return argv.includes("--date");
  if (cmd === "signals") return argv[0] === "refresh";
  return ["weeks", "block", "ids", "lint-methods"].includes(cmd);
}

/** One usage line per E3 command (every command has a --help line; contracts §22). */
export const HELP: Record<string, string> = {
  adjust: "adjust --from-snapshot <date> --decision trim|recovery [--planned-minutes n] | adjust --decision trim|recovery < tally-day.json | adjust --input <{day, decision}.json>  (§15, §22.2)",
  loads: "loads --from-snapshot <date> | loads < tally-day.json | loads --input <{exercises, history?}.json>  (§15, §22.2)",
  readiness: "readiness --date <YYYY-MM-DD> [--now <instant>]  — builds the input from signals, the snapshot and coach.yaml | readiness --input <file.json>  (§5, §22.4)",
  weeks: "weeks --from <YYYY-MM-DD> --to <YYYY-MM-DD>  — the snapshot history as Monday-to-Sunday WeekLogs for targets (§22.5)",
  block: "block draft [--template <id>] --weeks <n> [--input <file.json>] [--now <instant>]  — template × targets → block.yaml and week-by-week DayPlans (§22.6)",
  ids: "ids next --kind block|limit  — the next free ID (§22.7)",
  urgent: "urgent set --term <name> --source chat|checkin|note|answer | urgent clear --reason clinician|false-alarm | urgent status  — the urgent stop (§10)",
  limits: "limits schema | limits regions | limits check --input <{week}|{days}.json>  — the limits.yaml shape, the regions each pattern loads, and a planned week against the limits (report only; §2)",
  signals: "signals refresh  — Oura fetch for the last 3 days on a Mac, else a one-line note (§22.8) | signals --from <date> --to <date>  (§11)",
  "lint-methods": "lint-methods [--pack <name>] [--volume]  — lint a method pack; exit 1 on errors (§22.9)",
  plans: "plans write --input <{days}|{week}|{day}|{tally_day}.json> | plans read --week <YYYY-MM-DD|YYYY-Www> | plans done --date <YYYY-MM-DD> (--as-planned | --exercise <name>) [--sets n] [--reps r] [--load x] [--felt <text>]  — the week files under plans/ (logger: files; §12a)",
  "setup-check": "setup-check  — setup's silent checks: mode, Node and Claude Code versions, npm ci, timezone, name, worktree, setup progress (§22a)",
  "init-athlete": "init-athlete  — copy the starting athlete files from templates/athlete/; never overwrites (§22a)",
  "allow-server": "allow-server --server <name>  — add mcp__<name> to .claude/settings.local.json permissions.allow, keeping the rest (§22a)",
  worktree: "worktree status | worktree ff-main | worktree ff-branch | worktree main-checkout | worktree remove-temp  — a copy in a git worktree: fast-forward main to this branch or this branch to main; the folder where main is checked out (a temporary one when none is) (§24)",
  commit: "commit --message <text>  — commit athlete/, plans/ and coach.yaml only, never other staged work (§22a)",
  "history-files": "history-files  — the two newest .csv files in ~/Downloads and ~/Desktop, for setup's history question (§22a)",
  logger: "logger set tally|files|other  — set coach.yaml logger (comments kept): a switch, or the fallback to files when another tool stops answering (§12a)",
  "tally-mention": "tally-mention [--sessions <n>]  — logger files|other: the one Tally line after the third session logged by hand; records tally_mentioned (§12a)",
};

/** `<cmd> --help` → {command, usage}. Null for other commands. */
export function helpCommand(cmd: string, argv: string[]): number | null {
  if (!argv.includes("--help") && !argv.includes("-h")) return null;
  const key = cmd;
  const usage = HELP[key];
  if (!usage) return null;
  process.stdout.write(JSON.stringify({ command: key, usage }, null, 2) + "\n");
  return 0;
}

