// The setup-basics scenarios (23 with mock Tally, 24 with `logger: files`, and the V4 variants
// 26 to 28): a fresh copy of the template, "Set me up", and the scripted athlete clicks through.
// Pass: week 1 written (Tally, or plans/<week>.csv) in at most 5 screens on the basic path with
// 0 typed answers, valid athlete files, and no engine source read (V4). Reported: wall time, the
// count of Bash calls and the longest wait from an answer to the next screen. The hook bootstrap
// checks of scenario 01 apply too.
import { parse } from "yaml";
import { validateBlock } from "../../engine/block.ts";
import { validateConfig } from "../../engine/config.ts";
import { addDays, weekdayOf } from "../../engine/dates.ts";
import { askCalls, check, parseCsvRows, pathTokens, screens, successfulWrites, tallyToolUses } from "../lib/checks.ts";
import { tallyState } from "../lib/instance.ts";
import type { AnswerRule, Check, RunArtifacts, Scenario, SetupContext } from "../lib/types.ts";
import { bootstrapChecks } from "./01-setup-scripted.ts";

/** An athlete with no current pain who says yes: 4 days, 60 min, full gym, strength. */
export const SETUP_ANSWERS: AnswerRule[] = [
  // The week-1 question can quote the whole table ("near max heart rate"), so it goes first
  // and the health rules are anchored to the start of their question.
  { question: "^week 1 is ready|write it\\?\\s*$", answer: ["^write it", "write", "^yes"] },
  { question: "^which units", answer: ["^lbs$"] },
  { question: "days a week can you train", answer: ["^4$"] },
  { question: "^how long is a session", answer: ["60"] },
  { question: "equipment", answer: ["full gym"] },
  { question: "main goal", answer: ["^strength$"] },
  { question: "^heart", answer: ["^none"] },
  { question: "^dizziness|^fainting", answer: ["^none"] },
  { question: "^other health", answer: ["^none"] },
  { question: "limiting your training", answer: ["^none"] },
  { question: "where should your plans go", answer: ["files in this repo"] },
  { question: "^your data goes", answer: ["^yes$"] },
  { question: "record of your recent training", answer: ["^skip$"] },
  // V4: the optional history paths, when a scenario takes them.
  { question: "how long have you trained", answer: ["^1 to 3"] },
  { question: "trained lately", answer: ["^2 to 3"] },
  { question: "which app has your training", answer: ["^strong$"] },
  { question: "downloads or on the desktop", answer: ["^yes"] },
  { question: "which file is your training", answer: ["strong"] },
  { question: "replace the day", answer: ["^yes"] },
  { question: "which tally account", answer: [".*"] },
];

export const MAX_SCREENS = 5;

/**
 * Engine source reads (V4, V4b): a Read of engine/*.ts or docs/contracts.md, a Grep or Glob under
 * engine/, or a Bash command with a reader (cat, sed, head, tail, grep, rg, awk, less, more, bat, a
 * node or python script) that names a file, a glob or the folder itself under engine/, or
 * docs/contracts.md. Running `node engine/cli.ts …` and listing names (`ls`, `find`) do not count.
 */
export function sourceReads(a: RunArtifacts): string[] {
  const inEngine = (t: string) => {
    const p = t.replace(/^\.\//, "").replace(/^.*?(?=(^|\/)engine(\/|$))\/?/, "");
    return p === "engine" || p === "engine/" || (/^engine\//.test(p) && (/\.ts$/.test(p) || p.includes("*") || p.endsWith("/")));
  };
  return a.tools.flatMap((t) => {
    const i = t.input ?? {};
    if (t.name === "Read" && typeof i.file_path === "string" && /(^|\/)(engine\/[^/]+\.ts|docs\/contracts\.md)$/.test(i.file_path)) return [`Read ${i.file_path}`];
    if ((t.name === "Grep" || t.name === "Glob") && (/(^|\/)engine(\/|$)|contracts\.md/.test(String(i.path ?? "")) || /(^|\/)engine\/|contracts\.md/.test(String(i.glob ?? "")))) return [`${t.name} ${JSON.stringify(i).slice(0, 120)}`];
    if (t.name !== "Bash" || typeof i.command !== "string") return [];
    const cmd = i.command.replace(/node\s+\S*engine\/cli\.ts\b/g, "");
    if (!/(^|[\s;|&(])(cat|sed|head|tail|grep|rg|awk|less|more|node|python3?|bat)\b/.test(cmd)) return [];
    const hits = pathTokens(cmd, ["engine"]).filter((p) => inEngine(p) || /(^|\/)docs\/contracts\.md$/.test(p));
    return hits.length ? [`Bash ${i.command.slice(0, 160)}`] : [];
  });
}

/** The longest wait from an answer (an AskUserQuestion result) to the next screen, in seconds; null without two screens. */
export function longestWait(a: RunArtifacts): { seconds: number | null; after: string | null } {
  const asks = a.tools.filter((t) => t.name === "AskUserQuestion");
  let best: { seconds: number | null; after: string | null } = { seconds: null, after: null };
  for (let k = 1; k < asks.length; k++) {
    const prev = asks[k - 1];
    const next = asks[k];
    if (typeof prev.resultAt !== "number" || typeof next.at !== "number") continue;
    const sec = Math.round((next.at - prev.resultAt) / 100) / 10;
    if (best.seconds === null || sec > best.seconds) best = { seconds: sec, after: String(prev.input?.questions?.[0]?.question ?? "").slice(0, 60) };
  }
  return best;
}

/** The friction numbers a setup run reports (V4): wall time, Bash calls, the longest wait. */
export function setupMeasures(a: RunArtifacts): Check {
  const w = longestWait(a);
  const bash = a.tools.filter((t) => t.name === "Bash").length;
  const wallSec = Math.round((a.result.durationMs ?? 0) / 1000);
  return { name: "measures (reported, not a pass condition)", ok: true, detail: `wall ${wallSec} s, ${bash} Bash calls, longest wait ${w.seconds ?? "?"} s (after "${w.after ?? ""}")`, data: { wall_s: wallSec, bash_calls: bash, longest_wait_s: w.seconds, wait_after: w.after, model: a.model ?? null } };
}

/** Options for the V4 variants of the setup scenario. */
export type SetupVariant = {
  /** The scenario's title. */
  title?: string;
  prompt?: string;
  /** Mock Tally connected even though plans go to files (the "no Tally on request" scenario). */
  tallyConnected?: boolean;
  /** Answer rules put before the shared ones. */
  answers?: AnswerRule[];
  /** Screens the path is allowed (an optional path adds screens). */
  maxScreens?: number;
  setup?: (ctx: SetupContext) => void;
  checks?: (a: RunArtifacts) => Check[];
};

/** What the brief forbids in the final message (V3b fix 4). */
export const PLAIN_LEAKS = [/athlete\//, /\.yaml\b/, /\bB-0/, /\bL-0/];

/** The text the athlete reads last: the assistant text after the last tool call. */
export function finalMessage(a: RunArtifacts): string {
  const msgs = a.messages ?? [];
  const n = a.tools.length;
  const tail = msgs.filter((m) => m.afterTool >= n).map((m) => m.text);
  return tail.length ? tail.join("\n") : a.result.text;
}

const parseOr = (t: string | null | undefined) => {
  try {
    return t ? parse(t) : null;
  } catch {
    return null;
  }
};

/** West's model (V4): the setup runs pin it. */
export const SETUP_MODEL = "claude-opus-5-5";

export function setupScenario(name: string, logger: "tally" | "files", v: SetupVariant = {}): Scenario {
  const max = v.maxScreens ?? MAX_SCREENS;
  const tally = v.tallyConnected ?? logger === "tally";
  return {
    name,
    title: v.title ?? `Setup basics with scripted clicks: week 1 in at most ${max} screens (${logger === "tally" ? "mock Tally" : "logger: files"})`,
    mode: "interactive",
    fresh: true,
    tally,
    model: SETUP_MODEL,
    skills: ["setup", "audit"],
    approver: [],
    answers: [...(v.answers ?? []), ...SETUP_ANSWERS],
    prompt: v.prompt ?? "Set me up as a new athlete.",
    setup(ctx) {
      // Tally: completed sessions before today in this week and the previous 9 weeks; no planned day. Files: no Tally server at all.
      if (tally) Object.assign(ctx.mock, { ...tallyState(ctx.today), days: {} });
      v.setup?.(ctx);
    },
    check(a: RunArtifacts): Check[] {
      const out: Check[] = [];
      const s = screens(a);
      const clicks = s.reduce((n, x) => n + x.clicks, 0);
      const typed = s.reduce((n, x) => n + x.typed, 0);
      out.push({ ...check(`week 1 in at most ${max} screens`, s.length > 0 && s.length <= max, `${s.length} screens: ${s.map((x) => x.questions.map((q) => q.header ?? q.question.slice(0, 30)).join("+")).join(" | ")}`), data: { screens: s.length, clicks, typed } });
      const reads = sourceReads(a);
      out.push({ ...check("engine source reads: 0", reads.length === 0, reads.slice(0, 5).join(" | ")), data: { source_reads: reads.length } });
      out.push(setupMeasures(a));
      out.push(check("0 typed answers", typed === 0, `${typed} typed`));
      const cfg = parseOr(a.after["coach.yaml"]);
      let cfgOk = false;
      try {
        validateConfig(cfg);
        cfgOk = true;
      } catch (e) {
        out.push(check("coach.yaml is valid", false, (e as Error).message.slice(0, 300)));
      }
      if (cfgOk) out.push(check(`coach.yaml is valid, logger ${logger}`, cfg.logger === logger || (logger === "tally" && cfg.logger === undefined), `logger: ${cfg.logger}`));
      let block: ReturnType<typeof validateBlock> | null = null;
      try {
        block = validateBlock(parseOr(a.after["athlete/block.yaml"]));
        out.push(check("block.yaml is valid", true));
      } catch (e) {
        out.push(check("block.yaml is valid", false, (e as Error).message.slice(0, 300)));
      }
      const sessions = block?.weeks.find((w) => w.week === 1)?.sessions ?? 0;
      // V3c: the health, data and approval questions were asked and answered.
      const asks = askCalls(a);
      const answered = (re: RegExp, want?: RegExp) =>
        s.some((x) => x.questions.some((q) => re.test(q.question) && x.answers[q.question] !== undefined && (!want || want.test(x.answers[q.question]))));
      const health = [/^heart/i, /^dizziness|^fainting/i, /^other health/i, /limiting your training/i].filter((re) => !answered(re));
      out.push(check("the health questions were answered (heart, dizziness or fainting, other health, limiting now)", health.length === 0, `not answered: ${health.map(String).join(", ")}`));
      out.push(check("the data question was answered (Yes)", answered(/^your data goes/i, /^yes/i)));
      const approvalAt = s.findIndex((x) => x.questions.some((q) => /^week 1 is ready|write it\?\s*$/i.test(q.question) && /write/i.test(x.answers[q.question] ?? "")));
      const approvalTool = approvalAt === -1 ? -1 : asks[approvalAt]?.i ?? -1;
      const firstPlanWrite = a.tools.findIndex((t) => tallyToolUses(a).includes(t) || (t.name === "Bash" && /node engine\/cli\.ts plans write\b/.test(String(t.input?.command ?? ""))) || (/^(Write|Edit)$/.test(t.name) && /(^|\/)plans\//.test(String(t.input?.file_path ?? ""))));
      out.push(check("the week-1 approval was answered before the first plan write", approvalTool !== -1 && firstPlanWrite !== -1 && approvalTool < firstPlanWrite, `approval at tool ${approvalTool}, first plan write at tool ${firstPlanWrite}`));
      // V3c: exactly week 1's session dates, each with valid workout rows.
      const start = block?.start ?? "";
      const week1 = start ? Array.from({ length: 7 }, (_, i) => addDays(start, i)) : [];
      const expected = block ? week1.filter((d) => block!.days.some((bd) => bd.day === weekdayOf(d))) : [];
      if (logger === "tally") {
        const days = a.mock.days as Record<string, any>;
        const dates = Object.keys(days).sort();
        const badRows = dates.flatMap((d) => {
          const ex = days[d]?.exercises ?? [];
          if (ex.length === 0) return [`${d}: no exercises`];
          return ex.filter((e: any) => !String(e.name ?? "").trim() || !Number.isInteger(e.suggestedSets) || e.suggestedSets < 1 || (e.suggestedReps === undefined && e.suggestedDuration === undefined)).map((e: any) => `${d}: ${JSON.stringify(e).slice(0, 120)}`);
        });
        out.push(check("week 1 is written to Tally on exactly its session dates", successfulWrites(a).length > 0 && sessions > 0 && JSON.stringify(dates) === JSON.stringify(expected), `written ${dates.join(", ")}; expected ${expected.join(", ")}`));
        out.push(check("every written exercise is a valid workout row (name, whole sets of at least 1, reps or a duration)", dates.length > 0 && badRows.length === 0, badRows.slice(0, 5).join(" | ")));
      } else {
        const csv = Object.entries(a.after).filter(([p, t]) => /^plans\/\d{4}-W\d{2}\.csv$/.test(p) && t);
        const rows = csv.flatMap(([, t]) => parseCsvRows(t ?? "")).filter((r) => week1.includes(r.date));
        const dates = [...new Set(rows.map((r) => r.date))].sort();
        const badRows = rows.filter((r) => !r.exercise?.trim() || !/^[1-9]\d*$/.test(r.sets ?? "") || !(r.reps ?? "").trim() || ((r.load ?? "") !== "" && !/^(lbs|kg)$/.test(r.unit ?? ""))).map((r) => `${r.date} ${r.exercise}: sets ${r.sets}, reps ${r.reps}, load ${r.load} ${r.unit}`);
        out.push(check("week 1 lands in plans/ on exactly its session dates", csv.length > 0 && sessions > 0 && JSON.stringify(dates) === JSON.stringify(expected), `${csv.map(([p]) => p).join(", ")}: ${dates.join(", ")}; expected ${expected.join(", ")}`));
        out.push(check("every week-1 row is a valid workout row (exercise, whole sets of at least 1, reps, a unit with a load)", rows.length > 0 && badRows.length === 0, badRows.slice(0, 5).join(" | ")));
        out.push(check("no Tally write", successfulWrites(a).length === 0));
      }
      out.push(...(v.checks?.(a) ?? []));
      // V3b fix 4: the closing message is plain (no file paths of athlete files, no block or limit ids).
      const last = finalMessage(a);
      const leak = PLAIN_LEAKS.filter((r) => r.test(last)).map((r) => (r.exec(last) ?? [""])[0]);
      out.push(check("the final message has no athlete/ path, .yaml file, block id or limit id", last.trim() !== "" && leak.length === 0, leak.length ? `found ${leak.join(", ")}: ${last.slice(0, 300)}` : last.slice(0, 160)));
      out.push(...bootstrapChecks(a));
      return out;
    },
  };
}
