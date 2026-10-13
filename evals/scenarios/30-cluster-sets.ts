// Scenario 30 (V5, 0.2.4): cluster sets and the per-exercise maximum, with `logger: files`. A
// made-up athlete does EZ bar curls as clusters (6 mini-sets of 6 at a 12-rep weight, 10 s apart):
// coach.yaml lists it, the brief has a preference line about it, and the plan files hold two
// logged cluster sessions of 35 of 36 reps at 35 lbs. The athlete asks for next week's plan and
// an audit. Pass, on the saved plan file (not a scratch file; V5b fix 8): next week's dates only;
// every session day of the block; the curl on its planned day, 6 × 6 with the cluster note, at
// exactly 35 lbs (a short cluster repeats; never the −5% drop); at least one straight resistance
// exercise and none above 4 sets on a day; a `volume` call on next week's plan that gives the
// curl's counted sets; and a reply line that says the curl "counts as 3".
import { stringify } from "yaml";
import { draftBlock } from "../../engine/block-draft.ts";
import type { ClusterEntry } from "../../engine/clusters.ts";
import { addDays, weekdayOf, weekStart } from "../../engine/dates.ts";
import { loadTemplates } from "../../engine/methods.ts";
import { fillDone, isoWeekId, writePlan } from "../../engine/plans-files.ts";
import { classify, loadTaxonomy } from "../../engine/taxonomy.ts";
import { readYamlFile } from "../../engine/yaml-file.ts";
import type { Rules } from "../../engine/types.ts";
import { check, parseCsvRows, taxonomy, turnText, yamlOf } from "../lib/checks.ts";
import { BRIEF, writeAthlete } from "../lib/instance.ts";
import type { Scenario } from "../lib/types.ts";
import { ACCEPT_PLAN } from "./_common.ts";

export const CURL = "EZ Bar Curls (Cluster)";
export const CLUSTERS: ClusterEntry[] = [{ name: CURL, mini_sets: 6, reps: 6, rm: 12, rest_s: 10 }];

/** One plain name per 4-day template slot pattern; the curl is the cluster. */
const EXERCISES: Record<string, { name: string }> = {
  plyometric: { name: "Box Jump" },
  squat: { name: "Barbell Back Squat" },
  horizontal_push: { name: "Bench Press" },
  hinge: { name: "Romanian Deadlift" },
  vertical_pull: { name: "Lat Pulldown" },
  overhead_press: { name: "Overhead Press" },
  horizontal_pull: { name: "Seated Cable Row" },
  zone2_cardio: { name: "Zone 2 Bike" },
  mobility: { name: "Mobility Flow" },
  lunge: { name: "Walking Lunge" },
  knee_flexion: { name: "Lying Leg Curl" },
  knee_extension: { name: "Leg Extension" },
  lateral_raise: { name: "Lateral Raise" },
  elbow_flexion: { name: CURL },
  rear_delt: { name: "Reverse Fly" },
  intervals: { name: "Bike Intervals" },
  breathing: { name: "Box Breathing" },
};
const LOADS: Record<string, number> = { "Barbell Back Squat": 225, "Bench Press": 185, "Romanian Deadlift": 185, "Lat Pulldown": 130, "Overhead Press": 95, "Seated Cable Row": 120, "Walking Lunge": 40, "Lying Leg Curl": 80, "Leg Extension": 90, "Lateral Raise": 20, [CURL]: 35, "Reverse Fly": 15 };

/** The block started two Mondays ago: weeks 1 and 2 are logged, this week is week 3, next week week 4. */
export const blockStart = (today: string) => addDays(weekStart(today), -14);

const scenario: Scenario = {
  name: "30-cluster-sets",
  title: "Cluster sets: next week keeps the 6 × 6 cluster at 35 lbs with its note, no straight exercise above 4 sets, and the audit counts it as 3",
  mode: "interactive",
  model: "claude-opus-5-5",
  tally: false,
  skills: ["week", "audit"],
  approver: [],
  answers: [...ACCEPT_PLAN, { question: ".", answer: ["^yes", "recommended", "keep", "."] }],
  prompt: "Plan next week and write it to my plan file. Then audit next week.",
  setup(ctx) {
    const T4 = loadTemplates(`${ctx.root}/methods/nine-adaptations`)["4-day"];
    const rules = readYamlFile(`${ctx.root}/methods/nine-adaptations/rules.yaml`) as Rules;
    const start = blockStart(ctx.today);
    const d = draftBlock(T4, 6, { tax: loadTaxonomy({ root: ctx.root }), rules, units: "lbs", method: "nine-adaptations", today: addDays(start, -3), emphasis: "all-around", templateId: "4-day", clusters: CLUSTERS }, { id: "B-001", start, exercises: EXERCISES, loads: LOADS });
    writeAthlete(ctx.write, ctx.today, { logger: "files", checkin: "chat", block: `# The current training block (written by node engine/cli.ts block write).\n${stringify(d.block)}` });
    ctx.write("coach.yaml", `${ctx.read("coach.yaml")}clusters:\n  - { name: "${CURL}", mini_sets: 6, reps: 6, rm: 12, rest_s: 10 }\n`);
    ctx.write("athlete/brief.md", BRIEF.replace("- Exercises the athlete dislikes: burpees.", "- Exercises the athlete dislikes: burpees.\n- Cluster sets: EZ bar curls as clusters, 6 mini-sets of 6 reps at my 12-rep weight, 10 s between mini-sets (athlete chose)."));
    // Weeks 1 and 2 are planned and logged as planned; each curl session was 35 of 36 reps at 35 lbs.
    for (const w of d.weeks.slice(0, 3)) writePlan(ctx.root, w.days, "lbs", CLUSTERS);
    for (const w of d.weeks.slice(0, 2)) {
      for (const day of w.days) {
        fillDone(ctx.root, { date: day.date, asPlanned: true });
        if (day.exercises.some((e) => e.name === CURL)) fillDone(ctx.root, { date: day.date, exercise: CURL, sets: "6", reps: "6,6,6,6,6,5", load: "35" });
      }
    }
  },
  check(a) {
    const next = addDays(weekStart(a.today), 7);
    const week = Array.from({ length: 7 }, (_, i) => addDays(next, i));
    const file = `plans/${isoWeekId(next)}.csv`;
    const rows = parseCsvRows(a.after[file] ?? "");
    // The block's session days and the curl's day, as next week's dates.
    const block = yamlOf(a.after["athlete/block.yaml"] ?? a.before["athlete/block.yaml"]) as { days?: { day: string; slots?: { exercise?: string }[] }[] } | null;
    const dateOf = (wd: string) => week.find((d) => weekdayOf(d) === wd);
    const sessionDates = (block?.days ?? []).map((d) => dateOf(d.day)).filter((d): d is string => !!d);
    const curlDate = dateOf((block?.days ?? []).find((d) => (d.slots ?? []).some((s) => /ez bar curl/i.test(s.exercise ?? "")))?.day ?? "");
    const outside = rows.filter((r) => !week.includes(r.date)).map((r) => `${r.date} ${r.exercise}`);
    const missing = sessionDates.filter((d) => !rows.some((r) => r.date === d));
    const curl = rows.filter((r) => /ez bar curl/i.test(r.exercise));
    const c = curl[0];
    // Straight resistance rows: they train a muscle and are not the cluster; sets per exercise per day.
    const perDay = new Map<string, { name: string; sets: number }>();
    for (const r of rows) {
      if (/cluster/i.test(r.exercise) || classify({ name: r.exercise }, taxonomy()).muscles.length === 0) continue;
      const k = `${r.date}|${r.exercise.toLowerCase()}`;
      const cur = perDay.get(k) ?? { name: `${r.date} ${r.exercise}`, sets: 0 };
      cur.sets += Number(r.sets || 1);
      perDay.set(k, cur);
    }
    const over = [...perDay.values()].filter((x) => x.sets > 4);
    // The audit: a successful `volume` call whose result has the curl's cluster line on its date in next week.
    const audit = a.tools.filter(
      (t) =>
        t.name === "Bash" &&
        /node engine\/cli\.ts volume --input /.test(String(t.input?.command ?? "")) &&
        t.result?.isError !== true &&
        /counts as 3 sets/.test(t.result?.text ?? "") &&
        !!curlDate &&
        new RegExp(`"date":\\s*"${curlDate}"`).test(t.result?.text ?? ""),
    );
    const text = turnText(a, 0) || a.result.text;
    // The count belongs to the curl: the curl named first, "counts as 3" after it on the same line.
    const tied = text.split("\n").filter((l) => /curl.*counts as 3\b/i.test(l));
    return [
      check(`next week's plan file (${file}) holds next week's dates only`, rows.length > 0 && outside.length === 0, outside.slice(0, 4).join(", ") || `${rows.length} rows`),
      check("every planned session day of the block is in the plan file", sessionDates.length > 0 && missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : sessionDates.join(", ")),
      check("the curl is on its planned day as a 6 × 6 cluster with its note", curl.length === 1 && c.date === curlDate && c.sets === "6" && c.reps === "6" && /Cluster: 6 × 6 at 12RM/.test(c.notes ?? ""), c ? `${c.date} (planned ${curlDate}): ${c.sets} × ${c.reps}, notes "${c.notes}"` : `${rows.length} rows, no curl`),
      check("the curl's load is exactly 35 lbs", c?.load === "35" && /^lbs?$/i.test(c?.unit ?? ""), c ? `${c.load} ${c.unit}` : "no curl row"),
      check("at least one straight resistance exercise, and none with more than 4 sets on a day", perDay.size > 0 && over.length === 0, over.map((x) => `${x.name}: ${x.sets}`).join(", ") || `${perDay.size} exercise-days`),
      check("the audit ran: a volume call on next week's plan gives the curl's counted sets", audit.length > 0, `${a.tools.filter((t) => t.name === "Bash" && /cli\.ts volume/.test(String(t.input?.command ?? ""))).length} volume calls`),
      check("the audit says the curl \"counts as 3\"", tied.length > 0, tied[0] ?? text.slice(-300)),
    ];
  },
};
export default scenario;
