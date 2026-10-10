// CLI subcommand for the operation log (oplog done). Wired into engine/cli.ts in one block.
//
//   node engine/cli.ts oplog done --date <YYYY-MM-DD> --kind <kind> [--root <dir>]
//
// Prints {date, kind, done, status: done|not_done|uncertain, reason, reread, entries}.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isCalendarDate } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { OP_KINDS } from "./opid.ts";
import { opDone } from "./oplog.ts";

const USAGE = "usage: oplog done --date <YYYY-MM-DD> --kind <kind>";

export function oplogCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: { root: { type: "string" }, date: { type: "string" }, kind: { type: "string" } },
  });
  if (positionals[0] !== "done") throw new CoachError("USAGE", USAGE);
  if (!isCalendarDate(values.date)) throw new CoachError("USAGE", `oplog done needs --date <YYYY-MM-DD>; ${USAGE}`);
  if (!values.kind || !(OP_KINDS as readonly string[]).includes(values.kind)) throw new CoachError("USAGE", `oplog done needs --kind, one of ${OP_KINDS.join(", ")}`);
  process.stdout.write(JSON.stringify(opDone(resolve(values.root ?? "."), values.date, values.kind), null, 2) + "\n");
  return 0;
}
