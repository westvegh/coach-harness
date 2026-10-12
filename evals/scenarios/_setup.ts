// The setup-basics scenarios (23 with mock Tally, 24 with `logger: files`): a fresh copy of
// the template, "Set me up", and the scripted athlete clicks through. Pass: week 1 written
// (Tally, or plans/<week>.csv) in at most 6 screens with 0 typed answers, and valid athlete
// files. The hook bootstrap checks of scenario 01 apply too.
import { parse } from "yaml";
import { validateBlock } from "../../engine/block.ts";
import { validateConfig } from "../../engine/config.ts";
import { addDays, weekdayOf } from "../../engine/dates.ts";
import { askCalls, check, parseCsvRows, screens, successfulWrites, tallyToolUses } from "../lib/checks.ts";
import { tallyState } from "../lib/instance.ts";
import type { AnswerRule, Check, RunArtifacts, Scenario } from "../lib/types.ts";
import { bootstrapChecks } from "./01-setup-scripted.ts";

/** An athlete with no current pain who says yes: 4 days, 60 min, full gym, strength. */
export const SETUP_ANSWERS: AnswerRule[] = [
  // The week-1 question can quote the whole table ("near max heart rate"), so it goes first
  // and the health rules are anchored to the start of their question.
  { question: "^week 1 is ready|write it\\?\\s*$", answer: ["^write it", "write", "^yes"] },
  { question: "^which units", answer: ["^lbs$"] },
  { question: "days a week", answer: ["^4$"] },
  { question: "^how long", answer: ["60"] },
  { question: "equipment", answer: ["full gym"] },
  { question: "main goal", answer: ["^strength$"] },
  { question: "^heart", answer: ["^none"] },
  { question: "^dizziness|^fainting", answer: ["^none"] },
  { question: "^other health", answer: ["^none"] },
  { question: "limiting your training", answer: ["^none"] },
  { question: "where should your plans go", answer: ["files in this repo"] },
  { question: "^your data goes", answer: ["^yes$"] },
  { question: "record of your recent training", answer: ["^skip$"] },
  { question: "replace the day", answer: ["^yes"] },
  { question: "which tally account", answer: [".*"] },
];

export const MAX_SCREENS = 6;

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

export function setupScenario(name: string, logger: "tally" | "files"): Scenario {
  return {
    name,
    title: `Setup basics with scripted clicks: week 1 in at most ${MAX_SCREENS} screens (${logger === "tally" ? "mock Tally" : "logger: files"})`,
    mode: "interactive",
    fresh: true,
    tally: logger === "tally",
    skills: ["setup", "audit"],
    approver: [],
    answers: SETUP_ANSWERS,
    prompt: "Set me up as a new athlete.",
    setup(ctx) {
      // Tally: 9 weeks of history and no planned day. Files: no Tally server at all.
      if (logger === "tally") Object.assign(ctx.mock, { ...tallyState(ctx.today), days: {} });
    },
    check(a: RunArtifacts): Check[] {
      const out: Check[] = [];
      const s = screens(a);
      const clicks = s.reduce((n, x) => n + x.clicks, 0);
      const typed = s.reduce((n, x) => n + x.typed, 0);
      out.push({ ...check(`week 1 in at most ${MAX_SCREENS} screens`, s.length > 0 && s.length <= MAX_SCREENS, `${s.length} screens: ${s.map((x) => x.questions.map((q) => q.header ?? q.question.slice(0, 30)).join("+")).join(" | ")}`), data: { screens: s.length, clicks, typed } });
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
      // V3b fix 4: the closing message is plain (no file paths of athlete files, no block or limit ids).
      const last = finalMessage(a);
      const leak = PLAIN_LEAKS.filter((r) => r.test(last)).map((r) => (r.exec(last) ?? [""])[0]);
      out.push(check("the final message has no athlete/ path, .yaml file, block id or limit id", last.trim() !== "" && leak.length === 0, leak.length ? `found ${leak.join(", ")}: ${last.slice(0, 300)}` : last.slice(0, 160)));
      out.push(...bootstrapChecks(a));
      return out;
    },
  };
}
