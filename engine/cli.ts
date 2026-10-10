// The engine CLI (contracts §13). Output is JSON on stdout; a nonzero exit means an error.
//
//   node engine/cli.ts readiness --input <file.json>
//   node engine/cli.ts volume --input <file.json>
//   node engine/cli.ts limits-hash [--file <limits.yaml>]
//   node engine/cli.ts hold init                                  (exit 3: an active hold exists)
//   node engine/cli.ts hold set --reason <text> [--regions a,b] [--by who] [--urgent]
//   node engine/cli.ts hold clear [--approved] [--by who]      (exit 3: needs an interactive yes)
//   node engine/cli.ts hold clear-pending [--approved]         (exit 3: needs an interactive yes)
//   node engine/cli.ts hold status                                (urgent: true under an urgent event, S1)
//   node engine/cli.ts snapshot show
//   node engine/cli.ts safety detect --text <text>
//   node engine/cli.ts safety scan-notes --since <YYYY-MM-DD> [--input <history.json>] [--dry-run] [--now <instant>]
//
//   --- signals (handlers in engine/signals-cli.ts) ---
//   node engine/cli.ts signals --from <date> --to <date> [--now <instant>]
//   node engine/cli.ts checkin --date <date> --sleep-quality n --energy n --soreness n --stress n [--want-to-train n] [--pain region:score,...]
//   --- end signals ---
//   --- guard (handlers in engine/cli-guard.ts) ---
//   node engine/cli.ts classify --exercise "<name>" | --input <file.json>
//   node engine/cli.ts validate --tool <name> --args <file.json> [--mode interactive|unattended]
//   (proposals list: in the proposals case, with approved_on_main from engine/approvals.ts)
//   node engine/cli.ts install-git-hooks
//   node engine/cli.ts prepush-check [--remote origin]          (exit 1: do not push)
//   node engine/cli.ts push [--branch <name>]                   (hooks, check, git push origin; exit 1: nothing pushed)
//   --- end guard ---
//   --- server limits (handlers in engine/cli-limits.ts) ---
//   node engine/cli.ts limits server-rules [--resolved <file|->]
//   node engine/cli.ts limits sync-ops --server <file|-> [--resolved <file|->]
//   node engine/cli.ts oplog done --date <YYYY-MM-DD> --kind <kind>
//   (proposals check-applied --id <id>: in the proposals case, engine/cli-helpers.ts)
//   --- end server limits ---
//
//   --- engine helpers (handlers in engine/cli-helpers2.ts; contracts §22) ---
//   node engine/cli.ts readiness --date <date> [--now <instant>]
//   node engine/cli.ts weeks --from <date> --to <date>
//   node engine/cli.ts block draft [--template <id>] --weeks <n> [--input <file.json>]
//   node engine/cli.ts ids next --kind block|limit|proposal [--change <kind>]
//   node engine/cli.ts signals refresh
//   node engine/cli.ts lint-methods [--pack <name>] [--volume]
//   node engine/cli.ts <command> --help        (one usage line for each E3 command)
//   node engine/cli.ts --help                  (the usage and every E3 usage line)
//   --- end engine helpers ---
//
//   --- update (handlers in engine/cli-update.ts; contracts §24) ---
//   node engine/cli.ts update --check [--ref <tag or branch>]
//   node engine/cli.ts update --yes --to <sha> [--keep-mine <path>]... [--take-template <path>]...
//   node engine/cli.ts config-check
//   --- end update ---
//
// Every command takes --root <dir> (default: the current directory).
import { fileURLToPath } from "node:url";
import { CoachError } from "./errors.ts";
// Each command imports its own modules when it runs: `--help` and the light
// commands never load the guard, the Oura adapter or the lint. The dispatchers below are
// light themselves; their commands import lazily too.
// The help text and the command lists of the E1 and E3 dispatchers (engine/cli-help.ts).
import { HELP, HELPER_COMMANDS, helpCommand, isHelpers2Command } from "./cli-help.ts";
// The bodies of readiness --input, volume, limits-hash, snapshot and safety (engine/cli-core.ts).
const core = () => import("./cli-core.ts");

const USAGE = "usage: cli.ts <readiness|volume|limits-hash|limits|oplog|hold|snapshot|safety|signals|checkin|weeks|block|ids|lint-methods|…> [options] [--root <dir>]";

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "--help" || cmd === "-h") {
      out({ usage: USAGE, commands: HELP });
      return 0;
    }
    // ---- Engine helpers the skills need (contracts §22), in engine/cli-helpers2.ts ----
    // readiness --date, weeks, block draft, ids next, signals refresh (async), lint-methods
    const help = helpCommand(cmd ?? "", rest);
    if (help !== null) return help;
    if (isHelpers2Command(cmd ?? "", rest)) return (await (await import("./cli-helpers2.ts")).helpers2Command(cmd ?? "", rest)) ?? 2;
    // ---- end engine helpers ----
    // ---- Helpers and automation (contracts §15), in engine/cli-helpers.ts ----
    // mode, opid, adjust, loads, targets, proposals …, routine-body, launchd-plist, install-launchd
    if ((HELPER_COMMANDS as readonly string[]).includes(cmd ?? "")) return (await (await import("./cli-helpers.ts")).helpersCommand(cmd ?? "", rest)) ?? 2;
    // ---- end helpers and automation ----
    switch (cmd) {
      case "readiness":
        return await (await core()).cmdReadiness(rest);
      case "volume":
        return await (await core()).cmdVolume(rest);
      case "limits-hash":
        return await (await core()).cmdLimitsHash(rest);
      case "hold": {
        const hold = await import("./hold.ts");
        if (rest[0] === "status" && !rest.includes("--help")) {
          // hold status also says whether an urgent event is active (launch review finding 3).
          const root = rest.includes("--root") ? rest[rest.indexOf("--root") + 1] ?? "." : process.cwd();
          const h = hold.readHold(root);
          const p = hold.readPending(root);
          const why = (await import("./validate.ts")).urgentEvent(h, p);
          out({ ok: true, hold: h, pending: p, urgent: why !== null, ...(why ? { urgent_reason: why } : {}) });
          return 0;
        }
        return hold.holdCommand(rest, process.cwd());
      }
      case "snapshot":
        return await (await core()).cmdSnapshot(rest);
      // --- guard ---
      case "classify":
      case "validate":
      case "install-git-hooks":
      case "prepush-check":
      case "push": {
        const code = (await import("./cli-guard.ts")).guardCommand(cmd, rest);
        if (code !== null) return code;
        throw new CoachError("USAGE", USAGE);
      }
      // --- end guard ---
      // --- server limits ---
      case "limits":
        return (await import("./cli-limits.ts")).limitsCommand(cmd, rest) as number;
      case "oplog":
        return (await import("./cli-oplog.ts")).oplogCommand(rest);
      // --- end server limits ---
      // --- safety ---
      case "safety":
        return await (await core()).cmdSafety(rest);
      // --- end safety ---
      // --- update ---
      case "update":
        return await (await import("./cli-update.ts")).cmdUpdate(rest);
      case "config-check":
        return await (await import("./cli-update.ts")).cmdConfigCheck(rest);
      // --- end update ---
      // --- signals ---
      case "signals":
        return (await import("./signals-cli.ts")).cmdSignals(rest);
      case "checkin":
        return (await import("./signals-cli.ts")).cmdCheckin(rest);
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
