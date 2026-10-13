// Scenario 27 (V4 C, G3): setup with a training export. A Strong export and a finance CSV sit in
// the fixture Downloads folder (COACH_HISTORY_HOME). Pass: the export is offered by name, chosen,
// read with a successful result, and the history reaches the week (a training-history line in the
// brief); any read outside the instance or the fixture folder fails it.
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { addDays } from "../../engine/dates.ts";
import { check, pathTokens, screens } from "../lib/checks.ts";
import type { RunArtifacts } from "../lib/types.ts";
import { setupScenario } from "./_setup.ts";

const FILE = "strong_workouts.csv";
/** The Strong export header (cited in docs/build/reports/V4-setup-polish.md). */
const HEADER = "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE";

/** Four weeks of two sessions, ending last week. */
export function strongExport(today: string): string {
  const rows = [HEADER];
  for (let w = 4; w >= 1; w--) {
    const a = addDays(today, -7 * w);
    const b = addDays(today, -7 * w + 2);
    const add = (d: string, name: string, ex: string, weight: number, reps: number) => {
      for (let s = 1; s <= 3; s++) rows.push(`${d} 17:30:00,${name},1h,${ex},${s},${weight},${reps},0,0,,,`);
    };
    add(a, "Lower", "Squat (Barbell)", 205 + 5 * (4 - w), 5);
    add(a, "Lower", "Romanian Deadlift (Barbell)", 155, 8);
    add(b, "Upper", "Bench Press (Barbell)", 165 + 5 * (4 - w), 5);
    add(b, "Upper", "Bent Over Row (Barbell)", 135, 8);
  }
  return rows.join("\n") + "\n";
}

/**
 * True when a path, resolved against the run's working folder (the instance root; `~` is the home
 * folder), stays inside the instance or the fixture home (V4b: relative paths are resolved, not trusted).
 */
export function insideRun(a: RunArtifacts, p: string): boolean {
  const root = a.paths?.root ?? "/nonexistent-root";
  const abs = resolve(root, p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
  if (abs === "/dev/null") return true;
  const roots = [a.paths?.root, a.paths?.historyHome].filter((x): x is string => !!x).flatMap((r) => [r, `/private${r}`, r.replace(/^\/private/, "")]);
  return roots.some((r) => abs === r || abs.startsWith(`${r}/`) || `/private${abs}`.startsWith(`${r}/`));
}

/** Reads of a path outside the run: Read, Grep and Glob paths, and every path word of a Bash command. */
export function outsideReads(a: RunArtifacts): string[] {
  return a.tools.flatMap((t) => {
    const i = t.input ?? {};
    if (["Read", "Grep", "Glob"].includes(t.name)) {
      const p = String(i.file_path ?? i.path ?? "");
      const g = t.name === "Glob" && typeof i.pattern === "string" && (i.pattern.startsWith("/") || i.pattern.startsWith("~") || i.pattern.startsWith("..")) ? [i.pattern] : [];
      return [p, ...g].filter((x) => x && !insideRun(a, x)).map((x) => `${t.name} ${x}`);
    }
    if (t.name === "Bash") return pathTokens(String(i.command ?? "")).filter((p) => !insideRun(a, p)).map((p) => `Bash ${p}`);
    return [];
  });
}

export default setupScenario("27-setup-history-export", "files", {
  title: "Setup with a training export: offered by name, chosen, read, and in the brief; no read outside the run",
  answers: [{ question: "record of your recent training", answer: ["strong_workouts"] }],
  setup(ctx) {
    writeFileSync(`${ctx.historyHome}/Downloads/${FILE}`, strongExport(ctx.today));
    writeFileSync(`${ctx.historyHome}/Downloads/statement.csv`, "Date,Description,Amount,Balance\n2026-10-01,Coffee,-4.50,1200.00\n");
  },
  checks(a) {
    const s = screens(a);
    const offered = s.some((x) => x.questions.some((q) => q.options.some((o) => o.includes(FILE))));
    const chosen = s.some((x) => Object.values(x.answers).some((v) => v.includes(FILE)));
    const read = a.tools.find((t) => t.name === "Read" && String(t.input?.file_path ?? "").endsWith(FILE));
    const brief = a.after["athlete/brief.md"] ?? "";
    const hist = brief.split(/\n## /).find((sec) => sec.startsWith("Training history")) ?? "";
    const outside = outsideReads(a);
    return [
      check("the export is offered by name", offered),
      check("the export is chosen", chosen),
      check("the export is read with a successful result", !!read && read.result?.isError === false, read ? read.result?.text.slice(0, 120) : "no Read of the export"),
      check("the history reaches the week (the brief's training history names a lift from the export)", /squat|bench|deadlift|row/i.test(hist), hist.slice(0, 200)),
      check("no read outside the instance or the fixture folder", outside.length === 0, outside.slice(0, 5).join(" | ")),
      check("the finance file is never offered", !s.some((x) => x.questions.some((q) => q.options.some((o) => /statement/i.test(o))))),
    ];
  },
});
