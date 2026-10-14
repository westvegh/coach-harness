// V7: the today commands (contracts §22b). engine/cli.ts dispatches here.
//
//   today-brief --stage pre|post [--input <evidence.json>] [--now <instant>] [--session <id>] [--root <dir>]
//   today-write-prep --input <{after, tool, kind}.json> [--now <instant>] [--session <id>] [--root <dir>]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CoachError } from "./errors.ts";

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CoachError("INPUT_ERROR", `cannot read ${path}: ${(e as Error).message}`);
  }
}

const opts = (argv: string[]) =>
  parseArgs({ args: argv, strict: true, options: { root: { type: "string" }, stage: { type: "string" }, input: { type: "string" }, now: { type: "string" }, session: { type: "string" } } });

export async function cmdTodayBrief(argv: string[]): Promise<number> {
  const { values } = opts(argv);
  const root = resolve(values.root ?? ".");
  const base = { root, ...(values.now ? { now: values.now } : {}), ...(values.session ? { session_id: values.session } : {}) };
  const tb = await import("./today-brief.ts");
  if (values.stage === "pre") {
    if (values.input) throw new CoachError("USAGE", "today-brief --stage pre takes no --input");
    const r = await tb.briefPre(base);
    out(r.compact);
    return r.exit;
  }
  if (values.stage === "post") {
    const evidence = values.input ? tb.parseEvidence(readJson(values.input)) : undefined;
    out((await tb.briefPost({ ...base, ...(evidence ? { evidence } : {}) })).compact);
    return 0;
  }
  throw new CoachError("USAGE", "usage: today-brief --stage pre|post [--input <evidence.json>]");
}

export async function cmdTodayWritePrep(argv: string[]): Promise<number> {
  const { values } = opts(argv);
  if (!values.input) throw new CoachError("USAGE", "usage: today-write-prep --input <{after, tool, kind}.json>");
  const root = resolve(values.root ?? ".");
  const { writePrep } = await import("./today-write-prep.ts");
  out(await writePrep({ root, input: readJson(values.input), ...(values.now ? { now: values.now } : {}), ...(values.session ? { session_id: values.session } : {}) }));
  return 0;
}
