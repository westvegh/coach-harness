// The week's build-back question (0.3.0; scenarios 39a, 39c, 39u): a left knee the athlete chose to
// build back slowly, then "plan next week". Interactive: the week skill asks once how it felt; A adds
// "a little more from <today>" to the line, C rewrites it to "avoid for now" and next week then
// loads no knee. Unattended: no question and no change to the line.
import { askCalls, check } from "../lib/checks.ts";
import { judge } from "../lib/limit-rules.ts";
import type { Check, RunArtifacts, Scenario } from "../lib/types.ts";
import { ACCEPT_PLAN, persona, WEEKLY } from "./_common.ts";
import { expectedDates, nextWeekDays } from "./_limits.ts";

/** The weekly slot that opened a minute ago, in the athlete's timezone. */
export function weeklyNow(tz: string, now = Date.now()): { day: string; time: string } {
  const t = new Date(now - 60_000);
  const day = t.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" }).toLowerCase().slice(0, 3);
  const time = t.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  return { day, time };
}

/** The plan's consent question ("Write this?", "Apply these?"): yes, before ACCEPT_PLAN's narrower rules (its "keep the plan" rule would match a summary). */
export const WRITE_RULE = { question: "write (this|it|these)\\?|apply these\\?", answer: ["^a\\)? ?yes", "^yes", "write", "apply"] };

export const BUILD_BACK_LINE = "- Left knee: light only, building back slowly: about half the usual work for the knee, nothing heavy. (since 2026-10-15)";

/** The knee line's current rule is "avoid for now": outside brackets, it says avoid and no longer says building back (history in brackets is allowed). */
export function kneeAvoidsNow(line: string): boolean {
  const current = line.replace(/\([^)]*\)/g, "");
  return /knee/i.test(current) && /avoid/i.test(current) && !/building back/i.test(current);
}

const kneeLine = (a: RunArtifacts) => (a.after["athlete/limits.md"] ?? "").split("\n").find((l) => /^\s*-\s.*knee/i.test(l)) ?? "";
const feltScreens = (a: RunArtifacts) => askCalls(a).filter(({ t }) => /how did it feel/i.test(JSON.stringify(t.input ?? {})));
const written = (a: RunArtifacts) => {
  const days = nextWeekDays(a);
  return expectedDates(a.today).every((d) => days.some((x) => x.date === d && x.exercises.length > 0));
};

export function buildBackScenario(variant: "fine" | "worse" | "unattended"): Scenario {
  const name = { fine: "39a-build-back-fine", worse: "39c-build-back-worse", unattended: "39u-build-back-unattended" }[variant];
  const answer = variant === "fine" ? ["^a\\b", "fine"] : ["^c\\b", "worse"];
  return {
    name,
    title: { fine: "Build back: \"fine\" adds a little more to the line", worse: "Build back: \"worse\" makes the line avoid for now, and next week loads no knee", unattended: "Build back, unattended: no question, the line unchanged" }[variant],
    mode: variant === "unattended" ? "unattended" : "interactive",
    skills: ["week"],
    ...(variant === "unattended" ? { prompt: WEEKLY } : { approver: [], answers: [{ question: "how did it feel", answer }, WRITE_RULE, ...ACCEPT_PLAN, { question: ".", answer: ["^yes", "recommended", "."] }], prompt: "Plan next week and write it to Tally." }),
    setup(ctx) {
      // Unattended: the weekly window opens a minute ago (window-check admits weekly.day from weekly.time to 30 minutes later).
      persona(ctx, { limits: [BUILD_BACK_LINE], ...(variant === "unattended" ? { weekly: weeklyNow(ctx.tz) } : {}) });
    },
    check(a): Check[] {
      const line = kneeLine(a);
      if (variant === "unattended") {
        return [
          check("the limits file is unchanged", a.before["athlete/limits.md"] === a.after["athlete/limits.md"]),
          check("no question (unattended)", askCalls(a).length === 0),
          check("next week is written", written(a)),
        ];
      }
      const out: Check[] = [check("one build-back question for the knee", feltScreens(a).length === 1, `${feltScreens(a).length} screen(s)`)];
      if (variant === "fine") {
        out.push(check("the line gains \"a little more from <date>\" and keeps the athlete's words", /a little more from \d{4}-\d{2}-\d{2}/i.test(line) && /light only, building back slowly/i.test(line), line));
      } else {
        const broken = judge(nextWeekDays(a), { says: "left knee: avoid for now", region: "left-knee", kind: "avoid" });
        out.push(
          check("the line's current rule is \"avoid for now\" (earlier wording in brackets allowed)", kneeAvoidsNow(line), line),
          check("next week loads no knee (it follows the new line)", nextWeekDays(a).length > 0 && broken.length === 0, broken.map((f) => f.detail).slice(0, 5).join(" | ")),
        );
      }
      out.push(check("next week is written", written(a)), check("the limits change is committed", a.commits.some((c) => c.files.includes("athlete/limits.md"))));
      return out;
    },
  };
}
