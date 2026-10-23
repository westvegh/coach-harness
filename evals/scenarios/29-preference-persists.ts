// Scenario 29 (V4 E, G4): a preference persists across sessions. A set-up athlete (mock Tally)
// states a rep range in one session; a second session plans next week and audits it.
// Pass: the brief records the range under "Preferences"; next week's main lifts use it; the
// audit lists it as the athlete's choice.
import { classify } from "../../engine/taxonomy.ts";
import { check, taxonomy, turnText } from "../lib/checks.ts";
import type { Scenario } from "../lib/types.ts";
import { ACCEPT_PLAN, persona } from "./_common.ts";
import { nextWeek } from "./_limits.ts";

/** The main lifts: the patterns a rep-range preference is about. */
const LIFTS = new Set(["squat", "hinge", "horizontal_push", "vertical_push", "overhead_press", "vertical_pull", "horizontal_pull", "lunge"]);

const RANGE = /\b8\s*(to|-|–)\s*12\b/;

const scenario: Scenario = {
  name: "29-preference-persists",
  title: "A preference persists: a rep range stated in one session is used, and audited as the athlete's choice, in the next",
  mode: "interactive",
  model: "claude-opus-5-5",
  skills: ["week", "audit"],
  approver: [],
  answers: [
    { question: "(remember|record|save|keep).{0,40}(prefer|range|choice)|8.{0,4}12", answer: ["^yes", "keep", "record", "save", "."] },
    ...ACCEPT_PLAN,
    { question: ".", answer: ["^yes", "recommended", "."] },
  ],
  prompt: "From now on I want 8 to 12 reps on my main lifts (squats, hinges, presses, pulls and rows). Please remember that for future plans.",
  turns: [{ prompt: "Plan next week and write it to Tally. Then audit next week." }],
  setup(ctx) {
    persona(ctx);
  },
  check(a) {
    const brief1 = a.turns?.[0]?.after["athlete/brief.md"] ?? "";
    const prefs = brief1.split(/\n## /).find((x) => x.startsWith("Preferences")) ?? "";
    // V4b: the preference is committed in turn 1 (the commits on HEAD at the end of turn 1).
    const t1 = a.turns?.[0]?.commits;
    const t1Commits = t1 ? a.commits.filter((c) => t1.includes(c.sha)) : [];
    const days = a.mock.days as Record<string, any>;
    // V4b: every main lift counts; a lift with no rep field fails.
    const lifts = nextWeek(a.today)
      .filter((d) => days[d])
      .flatMap((d) => (days[d].exercises ?? []).map((e: any) => ({ d, e })))
      .filter(({ e }) => {
        const c = classify({ name: String(e.name ?? ""), exerciseId: e.exerciseId ?? null }, taxonomy());
        return c.source !== "none" && c.patterns.some((p) => LIFTS.has(p));
      });
    const off = lifts.filter(({ e }) => {
      if (e.suggestedReps === undefined && e.repsMax === undefined) return true;
      const top = Number(e.repsMax ?? e.suggestedReps);
      const low = Number(e.suggestedReps ?? e.repsMax);
      return !(top >= 8 && top <= 12 && low >= 8);
    });
    // V4b: the audit's evidence: a volume call on a week in turn 2 (0.3.0: the limits check is gone), and an "athlete chose" line.
    const from = a.turns?.[1]?.firstTool ?? a.tools.length;
    const auditCalls = a.tools.slice(from).filter((t) => t.name === "Bash" && /node engine\/cli\.ts volume --input /.test(String(t.input?.command ?? "")) && t.result?.isError !== true);
    const t2 = turnText(a, 1);
    return [
      check("turn 1: the brief records the rep range under Preferences", RANGE.test(prefs), prefs.slice(0, 200)),
      check("turn 1: the preference is committed in turn 1", t1Commits.some((c) => c.files.includes("athlete/brief.md")), t1 ? `${t1.length} commits in turn 1` : "no turn-1 commit record"),
      { ...check("turn 2: every main lift next week uses 8 to 12 reps", lifts.length >= 3 && off.length === 0, `${lifts.length} lifts; off: ${off.map(({ d, e }) => `${d} ${e.name} ${e.suggestedReps ?? "no reps"}-${e.repsMax ?? ""}`).join(", ")}`), data: { lifts: lifts.map(({ d, e }) => `${d} ${e.name} ${e.suggestedReps}${e.repsMax ? `-${e.repsMax}` : ""}`) } },
      check("turn 2: the audit ran (volume on the week)", auditCalls.length > 0),
      check("turn 2: the audit lists the range with an \"athlete chose\" line", /athlete chose/i.test(t2), t2.slice(-300)),
    ];
  },
};
export default scenario;
