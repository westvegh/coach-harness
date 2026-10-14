// The engine CLI (contracts §13). Output is JSON on stdout; a nonzero exit means an error.
//
//   node engine/cli.ts readiness --input <file.json>
//   node engine/cli.ts volume --input <file.json>
//   node engine/cli.ts limits-hash [--file <limits.yaml>]
//   node engine/cli.ts snapshot show | snapshot reset
//   node engine/cli.ts safety detect --text <text>
//   node engine/cli.ts safety scan-notes --since <YYYY-MM-DD> [--input <history.json>] [--dry-run] [--now <instant>]
//   node engine/cli.ts classify --exercise "<name>" | --input <file.json>
//
//   --- urgent stop (handlers in engine/urgent.ts; contracts §10) ---
//   node engine/cli.ts urgent set --term <name> --source chat|checkin|note|answer   (commits and pushes)
//   node engine/cli.ts urgent clear --reason clinician|false-alarm                  (refused unattended)
//   node engine/cli.ts urgent status
//   --- end urgent stop ---
//   --- signals (handlers in engine/signals-cli.ts) ---
//   node engine/cli.ts signals --from <date> --to <date> [--now <instant>]
//   node engine/cli.ts checkin --date <date> [--overall n | --sleep-quality n --energy n --soreness n --stress n] [--want-to-train n|none] [--pain region:score,...|none] [--urgent <term>,...]
//   --- end signals ---
//   --- privacy (handlers in engine/cli-git.ts; contracts §10a) ---
//   node engine/cli.ts install-git-hooks
//   node engine/cli.ts prepush-check [--remote origin]          (exit 1: do not push)
//   node engine/cli.ts push [--branch <name>]                   (hooks, check, git push origin; exit 1: nothing pushed)
//   --- end privacy ---
//   --- limits (handlers in engine/cli-limits.ts) ---
//   node engine/cli.ts limits schema | limits regions | limits check --input <file.json>   (report only)
//   node engine/cli.ts oplog done --date <YYYY-MM-DD> --kind <kind>
//   --- end limits ---
//
//   --- engine helpers (handlers in engine/cli-helpers2.ts; contracts §22) ---
//   node engine/cli.ts readiness --date <date> [--now <instant>]
//   node engine/cli.ts weeks --from <date> --to <date>
//   node engine/cli.ts block draft [--template <id>] --weeks <n> [--input <file.json>] [--out <dir>]
//   node engine/cli.ts block write --input <dir>/block.json
//   node engine/cli.ts ids next --kind block|limit|proposal [--change <kind>]
//   node engine/cli.ts signals refresh
//   node engine/cli.ts lint-methods [--pack <name>] [--volume]
//   node engine/cli.ts <command> --help        (one usage line for each E3 command)
//   node engine/cli.ts --help                  (the usage and every E3 usage line; also `help`)
//   node engine/cli.ts help <command> [<subcommand>]   (the usage and input shape; every command has one)
//   --- end engine helpers ---
//
//   --- files logger (handlers in engine/cli-plans.ts; contracts §12a) ---
//   node engine/cli.ts plans write --input <file.json> | plans read --week <date> | plans done --date <date> (--as-planned | --exercise <name>) [...]
//   --- end files logger ---
//   --- setup v2 (handlers in engine/cli-setup.ts; contracts §22a) ---
//   node engine/cli.ts setup-check | init-athlete | allow-server --server <name> | worktree status|ff-main|ff-branch
//   node engine/cli.ts commit --message <text> | tally-mention [--sessions <n>] | logger set tally|files|other | history-files
//   --- end setup v2 ---
//
//   --- V7: the fast today (contracts §22b) ---
//   node engine/cli.ts today-brief --stage pre|post [--input <evidence.json>]   (pre exit 4: outside the window)
//   node engine/cli.ts today-write-prep --input <{after, tool, kind}.json>
//   node engine/cli.ts save --run <run_id> --message <text> [--no-change <reason>] [--input <{lines}.json>] [--sessions <n>]
//   --- end V7 ---
//
//   --- update (handlers in engine/cli-update.ts; contracts §24) ---
//   node engine/cli.ts update --check [--ref <tag or branch>] [--root <main checkout>]
//   node engine/cli.ts update --yes --to <sha> [--keep-mine <path>]... [--take-template <path>]... [--root <main checkout>]
//   node engine/cli.ts config-check
//   --- end update ---
//
// Every command takes --root <dir> (default: the current directory).
import { fileURLToPath } from "node:url";
import { CoachError } from "./errors.ts";
// Each command imports its own modules when it runs: `--help` and the light
// commands never load the Oura adapter or the lint. The dispatchers below are
// light themselves; their commands import lazily too.
// The help text and the command lists of the E1 and E3 dispatchers (engine/cli-help.ts).
import { HELP, HELPER_COMMANDS, helpCommand, helpFor, isHelpers2Command } from "./cli-help.ts";
// The bodies of readiness --input, volume, limits-hash, snapshot, safety and classify (engine/cli-core.ts).
const core = () => import("./cli-core.ts");

const USAGE = "usage: cli.ts <readiness|volume|limits-hash|limits|oplog|urgent|snapshot|safety|classify|signals|checkin|weeks|block|ids|lint-methods|plans|setup-check|worktree|commit|tally-mention|…> [options] [--root <dir>]";

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "--help" || cmd === "-h" || (cmd === "help" && rest.length === 0)) {
      out({ usage: USAGE, commands: HELP });
      return 0;
    }
    // `help <command>`: the same as `<command> --help` (V3b: the coach tried it; one allow rule covers it).
    // V4: every command and subcommand has help (`help safety scan-notes`).
    if (cmd === "help") {
      const words = rest.join(" ").trim().split(/\s+/);
      const h = helpFor(words);
      if (!h) throw new CoachError("USAGE", `no help for ${JSON.stringify(rest.join(" "))}; run: node engine/cli.ts help`);
      out(h);
      return 0;
    }
    // ---- Engine helpers the skills need (contracts §22), in engine/cli-helpers2.ts ----
    // readiness --date, weeks, block draft, ids next, signals refresh (async), lint-methods
    const help = helpCommand(cmd ?? "", rest);
    if (help !== null) return help;
    if (isHelpers2Command(cmd ?? "", rest)) return (await (await import("./cli-helpers2.ts")).helpers2Command(cmd ?? "", rest)) ?? 2;
    // ---- end engine helpers ----
    // ---- Helpers and automation (contracts §15), in engine/cli-helpers.ts ----
    // mode, opid, adjust, loads, targets, routine-body, launchd-plist, install-launchd, window-check
    if ((HELPER_COMMANDS as readonly string[]).includes(cmd ?? "")) return (await (await import("./cli-helpers.ts")).helpersCommand(cmd ?? "", rest)) ?? 2;
    // ---- end helpers and automation ----
    switch (cmd) {
      case "readiness":
        return await (await core()).cmdReadiness(rest);
      case "volume":
        return await (await core()).cmdVolume(rest);
      case "limits-hash":
        return await (await core()).cmdLimitsHash(rest);
      case "snapshot":
        return await (await core()).cmdSnapshot(rest);
      case "classify":
        return await (await core()).cmdClassify(rest);
      // --- urgent stop ---
      case "urgent":
        return await (await import("./urgent.ts")).urgentCommand(rest);
      // --- end urgent stop ---
      // --- privacy ---
      case "install-git-hooks":
      case "prepush-check":
      case "push": {
        const code = (await import("./cli-git.ts")).gitCommand(cmd, rest);
        if (code !== null) return code;
        throw new CoachError("USAGE", USAGE);
      }
      // --- end privacy ---
      // --- limits ---
      case "limits":
        return (await import("./cli-limits.ts")).limitsCommand(cmd, rest) as number;
      case "oplog":
        return (await import("./cli-oplog.ts")).oplogCommand(rest);
      // --- end limits ---
      // --- safety ---
      case "safety":
        return await (await core()).cmdSafety(rest);
      // --- end safety ---
      // --- files logger ---
      case "plans":
        return await (await import("./cli-plans.ts")).plansCommand(rest);
      // --- end files logger ---
      // --- setup v2 ---
      case "setup-check":
      case "init-athlete":
      case "allow-server":
      case "worktree":
      case "commit":
      case "tally-mention":
      case "logger":
      case "history-files":
        return await (await import("./cli-setup.ts")).setupCommand(cmd, rest);
      // --- end setup v2 ---
      // --- update ---
      case "update":
        return await (await import("./cli-update.ts")).cmdUpdate(rest);
      case "config-check":
        return await (await import("./cli-update.ts")).cmdConfigCheck(rest);
      // --- end update ---
      // --- V7: the fast today (contracts §22b) ---
      case "save":
        return await (await import("./save.ts")).cmdSave(rest);
      case "today-brief":
        return await (await import("./cli-today.ts")).cmdTodayBrief(rest);
      case "today-write-prep":
        return await (await import("./cli-today.ts")).cmdTodayWritePrep(rest);
      // --- end V7 ---
      // --- signals ---
      case "signals":
        return (await import("./signals-cli.ts")).cmdSignals(rest);
      case "checkin":
        return await (await import("./signals-cli.ts")).cmdCheckin(rest);
      // --- end signals ---
      default:
        throw new CoachError("USAGE", USAGE);
    }
  } catch (e) {
    const err = e instanceof CoachError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
    out({ error: err });
    process.stderr.write(`${err.code}: ${err.message}\n`);
    return err.code === "USAGE" ? 2 : 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
