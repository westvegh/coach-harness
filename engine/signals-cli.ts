// CLI subcommands for signals (contracts §15 "signals", "checkin"). Wired into engine/cli.ts.
//
//   node engine/cli.ts signals --from <date> --to <date> [--now <instant>] [--root <dir>]
//   node engine/cli.ts checkin --date <date> [--overall 1-5 | --sleep-quality 1-5 --energy 1-5 --soreness 1-5 --stress 1-5]
//                              [--want-to-train 1-5|none] [--pain region:score,...|none] [--urgent <term>,...] [--now <instant>] [--root <dir>]
//   At least one of the rating (--overall, or the four scales together), --want-to-train,
//   --pain or --urgent. `none` clears that answer for today. The answer merges into today's
//   check-in by group (adapters/signals/checkin/write.ts).
//   --urgent names urgent warning signs the athlete chose in the check-in; it writes,
//   commits and pushes the urgent stop (engine/urgent.ts, source checkin). --urgent alone
//   changes no signal file.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hasAnswer, writeCheckin, type CheckinAnswers } from "../adapters/signals/checkin/write.ts";
import { FOUR_SCALES } from "./checkin-shape.ts";
import { CoachError } from "./errors.ts";
import { unattendedMarker } from "./mode.ts";
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

/** "none" clears a group (--want-to-train none, --pain none). */
const isNone = (v: string) => v.trim().toLowerCase() === "none";

/** "left-knee:3,low-back:2" → [{region, score}]. */
export function parsePain(v: string | undefined): PainEntry[] | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  return v.split(",").map((part) => {
    const m = /^\s*([a-z][a-z0-9-]*)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
    if (!m || Number(m[2]) > 10) throw new CoachError("USAGE", `--pain entries are region:score with a score from 0 to 10 (got ${JSON.stringify(part)})`);
    return { region: m[1], score: Number(m[2]) };
  });
}

export async function cmdCheckin(argv: string[]): Promise<number> {
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
      overall: { type: "string" },
      "sleep-quality": { type: "string" },
      energy: { type: "string" },
      soreness: { type: "string" },
      stress: { type: "string" },
      "want-to-train": { type: "string" },
      pain: { type: "string" },
      urgent: { type: "string" },
    },
  });
  if (!values.date) throw new CoachError("USAGE", "checkin needs --date <YYYY-MM-DD>");
  const answers: CheckinAnswers = {};
  const flags = values as Record<string, string | undefined>;
  const scaleFlags = FOUR_SCALES.map((k) => [k, k.replace("_", "-")] as const);
  const given = scaleFlags.filter(([, flag]) => flags[flag] !== undefined);
  if (values.overall !== undefined && given.length > 0) throw new CoachError("USAGE", "checkin takes --overall or the four scales, not both");
  if (given.length > 0 && given.length < scaleFlags.length) {
    throw new CoachError("USAGE", `checkin needs the four scales together (--sleep-quality, --energy, --soreness, --stress); missing ${scaleFlags.filter(([, f]) => flags[f] === undefined).map(([, f]) => `--${f}`).join(", ")}`);
  }
  if (values.overall !== undefined) answers.overall = scale(values.overall, "overall");
  for (const [k, flag] of given) answers[k] = scale(flags[flag], flag);
  if (values["want-to-train"] !== undefined) answers.want_to_train = isNone(values["want-to-train"]) ? null : scale(values["want-to-train"], "want-to-train");
  if (values.pain !== undefined) {
    if (isNone(values.pain)) answers.pain = null;
    else {
      const pain = parsePain(values.pain);
      if (pain) answers.pain = pain;
    }
  }
  if (!hasAnswer(answers) && !values.urgent) {
    throw new CoachError("USAGE", "checkin needs at least one of --overall, the four scales, --want-to-train, --pain or --urgent");
  }
  const root = resolve(values.root ?? ".");
  const urgentTerms = values.urgent ? values.urgent.split(",") : [];
  let r: ReturnType<typeof writeCheckin>;
  try {
    r = writeCheckin({ root, date: values.date, answers, now: values.now, urgent: urgentTerms });
  } catch (e) {
    // The stop was written first; it still goes to the remote when the check-in fails.
    if (urgentTerms.length > 0 && existsSync(join(root, "athlete/.urgent-stop"))) {
      const { pushNow, unpushed, URGENT_RELATIVE } = await import("./urgent.ts");
      if (unpushed(root, [URGENT_RELATIVE])) await pushNow(root);
    }
    throw e;
  }
  // The stop goes to the remote at once (or on a retry), so a cloud run sees it.
  let push = null;
  if (r.urgent_stop) {
    const { pushNow, unpushed, URGENT_RELATIVE } = await import("./urgent.ts");
    push = r.urgent_stop.commit.committed || unpushed(root, [URGENT_RELATIVE]) ? await pushNow(root) : null;
  }
  out({ path: r.path, action: r.action, replaced: r.replaced, file: r.file, ...(r.note ? { note: r.note } : {}), ...(r.urgent_stop ? { urgent_stop: { ...r.urgent_stop, push } } : {}) });
  return 0;
}
