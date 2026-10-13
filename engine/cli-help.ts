// The CLI's help text and command lists. engine/cli.ts reads only this file
// to answer --help and to choose a dispatcher, so neither loads any engine module.
//
// Every command and subcommand has help: `node engine/cli.ts help <command> [<subcommand>]`
// prints its usage and input shape in one to three lines (a test walks the dispatch list).

/** The automation helper commands (engine/cli-helpers.ts; contracts §15). */
export const HELPER_COMMANDS = ["mode", "opid", "adjust", "loads", "targets", "routine-body", "launchd-plist", "install-launchd", "window-check", "tally-days"] as const;

/** True for an engine helper command (engine/cli-helpers2.ts): `readiness` only with --date, `signals` only with `refresh`. */
export function isHelpers2Command(cmd: string, argv: string[]): boolean {
  if (cmd === "readiness") return argv.includes("--date");
  if (cmd === "signals") return argv[0] === "refresh";
  return ["weeks", "block", "ids", "lint-methods"].includes(cmd);
}

/** One usage line per command (one to three lines; contracts §13, §22). */
export const HELP: Record<string, string> = {
  adjust: "adjust --from-snapshot <date> --decision trim|recovery [--planned-minutes n] | adjust --decision trim|recovery < tally-day.json | adjust --input <{day, decision}.json>  (§15, §22.2)",
  loads:
    "loads --input <week file> --fill [--history <file>]  — fills the week's loads in place (hard sets; × the week's load_factor once); --history: {units, sessions: [{date, exercises: [{name, sets: [{weight, reps}]}]}]}\n" +
    "loads --from-snapshot <date> | loads < tally-day.json | loads --input <{exercises, history?}.json>  — suggestions only (§15, §22.2)",
  "tally-days": "tally-days --input <week file>  — one plan_workout_day input per date {date, dayType, dayName, notes, exercises, weightUnit, timezone}; add only ifAbsent, expectedVersion, replace and opId (§22.6a)",
  readiness: "readiness --date <YYYY-MM-DD> [--now <instant>]  — builds the input from signals, the snapshot and coach.yaml | readiness --input <file.json>  (§5, §22.4)",
  weeks: "weeks --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--input <{clusters}.json>]  — the snapshot history as Monday-to-Sunday WeekLogs for targets, each with counted sets_by_muscle; clusters from --input, else coach.yaml (§22.5, §8a)",
  block:
    "block draft [--template <id>] --weeks <n> [--input <file.json>] [--out <dir>]  — template × targets → the block and week-by-week days; --out writes <dir>/block.json and <dir>/week-<n>.json and prints a summary\n" +
    "block write --input <dir>/block.json  — writes athlete/block.yaml (archives a block with another id; refused under the urgent stop)  (§22.6)",
  ids: "ids next --kind block|limit  — the next free ID (§22.7)",
  urgent: "urgent set --term <name> --source chat|checkin|note|answer | urgent clear --reason clinician|false-alarm | urgent status  — the urgent stop (§10)",
  limits: "limits schema | limits regions | limits check --input <week file>|<{days}.json>  — the limits.yaml shape, the regions each pattern loads, and a planned week against the limits (report only; §2)",
  signals: "signals refresh  — Oura fetch for the last 3 days on a Mac, else a one-line note (§22.8) | signals --from <date> --to <date>  (§11)",
  "lint-methods": "lint-methods [--pack <name>] [--volume]  — lint a method pack; exit 1 on errors (§22.9)",
  plans: "plans write --input <week file>|<{days}|{day}|{tally_day}.json> | plans read --week <YYYY-MM-DD|YYYY-Www> | plans done --date <YYYY-MM-DD> (--as-planned | --exercise <name>) [--sets n] [--reps r] [--load x] [--felt <text>]  — the week files under plans/ (logger: files; §12a)",
  "setup-check": "setup-check  — setup's silent checks: mode, Node and Claude Code versions, npm ci, timezone, name, worktree, setup progress (§22a)",
  "init-athlete": "init-athlete  — copy the starting athlete files from templates/athlete/; never overwrites (§22a)",
  "allow-server": "allow-server --server <name>  — add mcp__<name> to .claude/settings.local.json permissions.allow, keeping the rest (§22a)",
  worktree: "worktree status | worktree ff-main | worktree ff-branch | worktree main-checkout | worktree remove-temp  — a copy in a git worktree: fast-forward main to this branch or this branch to main; the folder where main is checked out (a temporary one when none is) (§24)",
  commit: "commit --message <text>  — commit athlete/, plans/ and coach.yaml only, never other staged work (§22a)",
  "history-files": "history-files  — the two newest workout CSV exports (by their header line) directly in ~/Downloads and ~/Desktop, for setup's history question (§22a)",
  logger: "logger set tally|files|other  — set coach.yaml logger (comments kept): a switch, or the fallback to files when another tool stops answering (§12a)",
  "tally-mention": "tally-mention [--sessions <n>]  — logger files|other: the one Tally line after the third session logged by hand; records tally_mentioned (§12a)",
  volume: "volume --input <week file>  — counted sets per muscle of the week (a cluster counts total reps ÷ its rep max), each cluster's count (`clusters`) and straight exercises above the pack's session maximum (`session_max`, advisory) | volume --input <{block, logs, today, target_week}.json>  — next week's targets (§7, §8a, §22.3)",
  "limits-hash": "limits-hash [--file <limits.yaml>]  — the limits file's hash (§2)",
  snapshot: "snapshot show | snapshot reset  — print the Tally snapshot cache; empty it (it is a cache; setup resets it after the account question) (§9)",
  safety: "safety detect --text <text> | safety scan-notes --since <YYYY-MM-DD> [--input <history.json>] [--dry-run]  — urgent and pain terms in text; in logged notes (an urgent term writes the urgent stop) (§10)",
  classify: "classify --exercise \"<name>\" [--id <exerciseId>] [--muscle <m>] | classify --input <{before, after, tool, today?}.json>  — an exercise's patterns, or a change's kind (small or big) (§6)",
  checkin: "checkin --date <YYYY-MM-DD> --sleep-quality 1-5 --energy 1-5 --soreness 1-5 --stress 1-5 [--want-to-train 1-5] [--pain region:score,...] [--urgent <term>,...]  — write today's check-in (live only; §11)",
  oplog: "oplog done --date <YYYY-MM-DD> --kind <kind>  — whether a Tally write of that kind is done on that date, from the write log (§15)",
  mode: "mode  — interactive or unattended (§15)",
  opid: "opid --date <YYYY-MM-DD> --kind <kind> --input <{tool, args}.json>  — the operation id for a Tally write (§15)",
  targets: "targets --input <{block, logs, today, target_week}.json>  — next week's sets per muscle from the block and the logged weeks; `straight` is what the straight exercises get after the clusters' counted sets (§15, §8a)",
  "routine-body": "routine-body --kind daily|weekly --repo-url <https://github.com/o/r> (--discover | --connections <file.json> | --connector-uuid <uuid>)  — the cloud routine body (automation skill; §15)",
  "launchd-plist": "launchd-plist --kind daily|weekly [--repo-path <abs path>] [--claude <abs path>]  — print a launchd agent for this Mac (§15)",
  "install-launchd": "install-launchd --kind daily|weekly|both [--yes] [--load]  — install the launchd agents after a probe run (live only; §15)",
  "window-check": "window-check --kind daily|weekly [--now <instant>]  — exit 4 when an unattended run is outside its window (§15)",
  "install-git-hooks": "install-git-hooks  — install the pre-push privacy hook (§10a)",
  "prepush-check": "prepush-check [--remote origin]  — ok: true when the pre-push hook is installed and the repository is private; exit 1: do not push (§10a)",
  push: "push [--branch <name>]  — the hooks, the privacy check, then git push origin; exit 1: nothing pushed (§10a)",
  update: "update --check [--ref <tag or branch>] [--root <main checkout>] | update --yes --to <sha> [--keep-mine <path>]... [--take-template <path>]... [--root <main checkout>]  — bring in the template's fixes (update skill; §24)",
  "config-check": "config-check  — the problems in coach.yaml; exit 1 when it has any (§24)",
  help: "help [<command> [<subcommand>]]  — the usage and input shape of a command",
};

/** Subcommand help (one to three lines each). `help <command> <subcommand>` prints it. */
export const SUBHELP: Record<string, Record<string, string>> = {
  block: {
    draft:
      "block draft --weeks <n> --input <draft.json> [--out <dir>] [--template <id>]  — with --out: <dir>/block.json, <dir>/week-<n>.json and a summary (why, progression, sets per week)\n" +
      'input: {"id":"B-001","start":"2026-10-19","emphasis":"strength","exercises":{"squat":{"name":"Back Squat"},"1.3":{"name":"Bench Press","exerciseId":"Barbell_Bench_Press"}},"loads":{"Back Squat":185}}  (exercises by pattern or "day.slot"; §22.6)\n' +
      'before coach.yaml exists, add: "method":"nine-adaptations","days":4,"units":"lbs","timezone":"America/Los_Angeles","logger":"files" (tally | files | none); optional: targets, step, deload_weeks, weekdays, clusters ([{name, mini_sets, reps, rm, rest_s?}], as in coach.yaml; then copied into each week file)',
    write: "block write --input <dir>/block.json  — validate the block, archive a block with another id to athlete/blocks/<id>.yaml, write athlete/block.yaml atomically; refused under the urgent stop  (§22.6a)",
  },
  ids: { next: "ids next --kind block|limit  — the next free ID (§22.7)" },
  urgent: {
    set: "urgent set --term <name> --source chat|checkin|note|answer  — write, commit and push the urgent stop",
    clear: "urgent clear --reason clinician|false-alarm  — only on the athlete's answer in a live session (refused unattended)",
    status: "urgent status  — whether the urgent stop is on, with its terms",
  },
  limits: {
    schema: "limits schema  — the limits.yaml shape (ban, cap with max_sets_per_week or max_load, build_back)",
    regions: "limits regions  — the regions each movement pattern loads",
    check: "limits check --input <week file>  — the week's days against athlete/limits.yaml (report only); also {days} or {week: {days}}",
  },
  plans: {
    write: "plans write --input <week file>  — write whole days to plans/<YYYY>-W<ww>.csv; also {days}, {day}, {tally_day} or one {date, exercises}; a logged row is never lost",
    read: "plans read --week <YYYY-MM-DD | YYYY-Www>  — the week's planned and logged days",
    done: "plans done --date <YYYY-MM-DD> (--as-planned | --exercise <name>) [--sets n] [--reps r] [--load x] [--felt <text>]  — fill the done columns",
  },
  worktree: {
    status: "worktree status  — whether this copy is a git worktree, its branch, and where main is checked out",
    "ff-main": "worktree ff-main  — fast-forward main to this branch (main's checkout must be clean)",
    "ff-branch": "worktree ff-branch  — fast-forward this branch to main (this checkout must be clean)",
    "main-checkout": "worktree main-checkout  — the folder where main is checked out (a temporary worktree when none is)",
    "remove-temp": "worktree remove-temp  — remove that temporary worktree (never --force)",
  },
  logger: { set: "logger set tally|files|other  — set coach.yaml logger, comments kept" },
  oplog: { done: "oplog done --date <YYYY-MM-DD> --kind <kind>  — done, not_done or uncertain, with the entries" },
  safety: {
    detect: "safety detect --text <text>  — the urgent and pain terms in the text (negations ignored)",
    "scan-notes": "safety scan-notes --since <YYYY-MM-DD> [--input <history.json>] [--dry-run]  — urgent and pain terms in logged session and exercise notes; prints server, sessions and matches; an urgent term writes the urgent stop",
  },
  snapshot: {
    show: "snapshot show  — the Tally snapshot cache (days, history, server)",
    reset: "snapshot reset  — empty the snapshot cache (setup runs it after the Tally account question)",
  },
  signals: { refresh: "signals refresh  — Oura fetch for the last 3 days on a Mac, else a one-line note (§22.8)" },
};

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** The help for `help <words…>`: {command, usage[, subcommands]}, or null. */
export function helpFor(words: string[]): { command: string; usage: string; subcommands?: string[] } | null {
  const [cmd, sub] = words;
  if (sub && SUBHELP[cmd]?.[sub]) return { command: `${cmd} ${sub}`, usage: SUBHELP[cmd][sub] };
  const usage = HELP[cmd];
  if (!usage) return null;
  return { command: cmd, usage, ...(SUBHELP[cmd] ? { subcommands: Object.keys(SUBHELP[cmd]) } : {}) };
}

/** `<cmd> --help` (or `<cmd> <sub> --help`) → the help. Null for other commands. */
export function helpCommand(cmd: string, argv: string[]): number | null {
  if (!argv.includes("--help") && !argv.includes("-h")) return null;
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
  const h = helpFor(sub ? [cmd, sub] : [cmd]);
  if (!h) return null;
  print(h);
  return 0;
}
