// CLI subcommands for signals (contracts §15 "signals", "checkin"). Wired into engine/cli.ts.
//
//   node engine/cli.ts signals --from <date> --to <date> [--now <instant>] [--root <dir>]
//   node engine/cli.ts checkin --date <date> --sleep-quality 1-5 --energy 1-5 --soreness 1-5 --stress 1-5
//                              [--want-to-train 1-5] [--pain region:score,...] [--now <instant>] [--root <dir>]
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { writeCheckin, type CheckinAnswers } from "../adapters/signals/checkin/write.ts";
import { CoachError } from "./errors.ts";
import { unattendedMarker } from "./hold.ts";
import { loadSignals } from "./signals.ts";
import type { PainEntry, Scale } from "./types.ts";

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function cmdSignals(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: { root: { type: "string" }, from: { type: "string" }, to: { type: "string" }, now: { type: "string" } },
  });
  if (!values.from || !values.to) throw new CoachError("USAGE", "usage: signals --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--now <instant>]");
  out(loadSignals({ root: resolve(values.root ?? "."), from: values.from, to: values.to, now: values.now }));
  return 0;
}

function scale(v: string | undefined, name: string): Scale {
  const n = Number(v);
  if (v === undefined || !Number.isInteger(n) || n < 1 || n > 5) throw new CoachError("USAGE", `checkin needs --${name} as a whole number from 1 to 5`);
  return n as Scale;
}

/** "left-knee:3,low-back:2" → [{region, score}]. */
export function parsePain(v: string | undefined): PainEntry[] | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  return v.split(",").map((part) => {
    const m = /^\s*([a-z][a-z0-9-]*)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
    if (!m || Number(m[2]) > 10) throw new CoachError("USAGE", `--pain entries are region:score with a score from 0 to 10 (got ${JSON.stringify(part)})`);
    return { region: m[1], score: Number(m[2]) };
  });
}

export function cmdCheckin(argv: string[]): number {
  // A check-in is the athlete's own answers; an unattended run has no athlete to ask, and
  // replacing a check-in could erase reported pain (launch review finding 2).
  const marker = unattendedMarker(process.env);
  if (marker) throw new CoachError("UNATTENDED", `checkin records the athlete's answers and never runs unattended (${marker} is set)`);
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      root: { type: "string" },
      date: { type: "string" },
      now: { type: "string" },
      "sleep-quality": { type: "string" },
      energy: { type: "string" },
      soreness: { type: "string" },
      stress: { type: "string" },
      "want-to-train": { type: "string" },
      pain: { type: "string" },
    },
  });
  if (!values.date) throw new CoachError("USAGE", "checkin needs --date <YYYY-MM-DD>");
  const answers: CheckinAnswers = {
    sleep_quality: scale(values["sleep-quality"], "sleep-quality"),
    energy: scale(values.energy, "energy"),
    soreness: scale(values.soreness, "soreness"),
    stress: scale(values.stress, "stress"),
  };
  if (values["want-to-train"] !== undefined) answers.want_to_train = scale(values["want-to-train"], "want-to-train");
  const pain = parsePain(values.pain);
  if (pain) answers.pain = pain;
  const r = writeCheckin({ root: resolve(values.root ?? "."), date: values.date, answers, now: values.now });
  out({ path: r.path, action: r.action, replaced: r.replaced, file: r.file });
  return 0;
}
