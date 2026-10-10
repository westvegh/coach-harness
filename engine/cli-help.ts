// The CLI's help text and command lists. engine/cli.ts reads only this file
// to answer --help and to choose a dispatcher, so neither loads any engine module.

/** The automation helper commands (engine/cli-helpers.ts; contracts §15). */
export const HELPER_COMMANDS = ["mode", "opid", "adjust", "loads", "targets", "proposals", "routine-body", "launchd-plist", "install-launchd", "window-check"] as const;

/** True for an engine helper command (engine/cli-helpers2.ts): `readiness` only with --date, `signals` only with `refresh`. */
export function isHelpers2Command(cmd: string, argv: string[]): boolean {
  if (cmd === "readiness") return argv.includes("--date");
  if (cmd === "signals") return argv[0] === "refresh";
  return ["weeks", "block", "ids", "lint-methods"].includes(cmd);
}

/** One usage line per E3 command (every command has a --help line; contracts §22). */
export const HELP: Record<string, string> = {
  "hold init": "hold init  — write the inactive athlete/hold.yaml when none exists; exit 3 when an active hold exists (§22.1)",
  adjust: "adjust --from-snapshot <date> --decision trim|recovery [--planned-minutes n] | adjust --decision trim|recovery < tally-day.json | adjust --input <{day, decision}.json>  (§15, §22.2)",
  loads: "loads --from-snapshot <date> | loads < tally-day.json | loads --input <{exercises, history?}.json>  (§15, §22.2)",
  proposals: "proposals create --input <file.json>  (base: {date: version | null}; null = the date must still be empty) | approve-copy | open-pr | list | mark-applied | check-applied --id <id> [--input <results.json>]  (§15, §21 item 10, §22.3)",
  readiness: "readiness --date <YYYY-MM-DD> [--now <instant>]  — builds the input from signals, the snapshot and coach.yaml | readiness --input <file.json>  (§5, §22.4)",
  weeks: "weeks --from <YYYY-MM-DD> --to <YYYY-MM-DD>  — the snapshot history as Monday-to-Sunday WeekLogs for targets (§22.5)",
  block: "block draft [--template <id>] --weeks <n> [--input <file.json>] [--now <instant>]  — template × targets → block.yaml and week-by-week DayPlans (§22.6) | block write --input <block.json> --proposal <id>  — athlete/block.yaml on proposal/<id> only (contracts §23)",
  ids: "ids next --kind block|limit|proposal [--change <kind>] [--now <instant>]  — the next free ID (§22.7)",
  signals: "signals refresh  — Oura fetch for the last 3 days on a Mac, else a one-line note (§22.8) | signals --from <date> --to <date>  (§11)",
  "lint-methods": "lint-methods [--pack <name>] [--volume]  — lint a method pack; exit 1 on errors (§22.9)",
};

/** `<cmd> --help` (or `hold init --help`) → {command, usage}. Null for other commands. */
export function helpCommand(cmd: string, argv: string[]): number | null {
  if (!argv.includes("--help") && !argv.includes("-h")) return null;
  const key = cmd === "hold" && argv[0] === "init" ? "hold init" : cmd;
  const usage = HELP[key];
  if (!usage) return null;
  process.stdout.write(JSON.stringify({ command: key, usage }, null, 2) + "\n");
  return 0;
}

