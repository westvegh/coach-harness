// Scenario 1: setup with scripted answers, on a fresh copy of the public export with no
// node_modules. Valid athlete files; block 1 passes the audit (its hard rules); week 1 is
// written, and only after the scripted yes. The hook bootstrap (B2): before `npm ci` and
// before coach.yaml, file edits work and Tally writes are denied (the runner's probes, and
// what the model did in the run).
import { parse } from "yaml";
import { validateBlock } from "../../engine/block.ts";
import { validateConfig } from "../../engine/config.ts";
import { addDays, weekStart } from "../../engine/dates.ts";
import { validateLimits } from "../../engine/limits.ts";
import { check, successfulWrites, tallyToolUses, taxonomy } from "../lib/checks.ts";
import { tallyState } from "../lib/instance.ts";
import type { Check, RunArtifacts, Scenario, ToolUse } from "../lib/types.ts";

const NPM_INSTALL = /(^|[;&|]\s*|\s)npm\s+(ci|install)\b/;
const hookDenied = (t: ToolUse) => !!t.result?.isError && /hook error|coach guard|PACKAGES_MISSING|MISSING_FILE|denied|blocked/i.test(t.result.text);

/** Index of the first tool use that creates coach.yaml (Write or Edit, or a Bash copy or redirect). */
export function coachYamlWriteIndex(tools: ToolUse[]): number {
  return tools.findIndex((t) => {
    const i = t.input ?? {};
    if (t.name === "Write" || t.name === "Edit") return typeof i.file_path === "string" && /(^|\/)coach\.yaml$/.test(i.file_path);
    return t.name === "Bash" && typeof i.command === "string" && /coach\.yaml/.test(i.command) && /(>|\bcp\b|\btee\b|\bmv\b|writeFile)/.test(i.command);
  });
}

/** The hook bootstrap checks: a fresh copy before npm ci and before coach.yaml. */
export function bootstrapChecks(a: RunArtifacts): Check[] {
  const out: Check[] = [];
  const b = a.bootstrap;
  out.push(check("fresh copy: no node_modules and no coach.yaml before the run", !!b && !b.nodeModules && !b.coachYaml, JSON.stringify(b && { nodeModules: b.nodeModules, coachYaml: b.coachYaml })));
  const edits = (b?.probes ?? []).filter((p) => p.hook === "guard-files.ts");
  const writes = (b?.probes ?? []).filter((p) => p.hook === "guard-writes.ts");
  out.push(check("probe: file edits are allowed before npm ci and coach.yaml", edits.length > 0 && edits.every((p) => p.decision === "allow"), edits.map((p) => `${p.tool} ${p.decision} ${p.stderr.trim()}`).join(" | ")));
  out.push(check("probe: a Tally write is denied before npm ci and coach.yaml", writes.length > 0 && writes.every((p) => p.decision !== "allow"), writes.map((p) => `${p.decision} ${p.stderr.trim() || p.stdout.trim()}`).join(" | ")));
  const npm = a.tools.findIndex((t) => t.name === "Bash" && NPM_INSTALL.test(String(t.input?.command ?? "")));
  out.push(check("the model ran npm ci (setup step 2) and no hook denied it", npm !== -1 && !hookDenied(a.tools[npm]), npm === -1 ? "no npm ci or npm install call" : (a.tools[npm].result?.text ?? "").slice(-300)));
  const earlyEdits = (npm === -1 ? a.tools : a.tools.slice(0, npm)).filter((t) => ["Write", "Edit", "MultiEdit"].includes(t.name));
  const deniedEarly = earlyEdits.filter(hookDenied);
  out.push(check("in the run: no file edit before npm ci was denied by a hook", deniedEarly.length === 0, `${earlyEdits.length} edits before npm ci; denied: ${deniedEarly.map((t) => `${t.name} ${t.input?.file_path}: ${t.result?.text.slice(0, 160)}`).join(" | ")}`));
  const cfgAt = coachYamlWriteIndex(a.tools);
  const tallyEarly = tallyToolUses(a).filter((t) => cfgAt === -1 || a.tools.indexOf(t) < cfgAt);
  const passedEarly = tallyEarly.filter((t) => t.result && !t.result.isError);
  out.push(check("in the run: no Tally write passed before coach.yaml was written", passedEarly.length === 0, `coach.yaml written at tool ${cfgAt}; Tally writes before it: ${tallyEarly.length}, passed: ${passedEarly.length}`));
  return out;
}

export const ANSWERS = `# Scripted answers for the setup interview

These are my replies to every setup question. Use them instead of asking me.

- Name: Alex
- Timezone: America/Los_Angeles
- Units: lbs
- Versions: claude and node are installed; continue.
- Red-flag screen: no to every question.
- Consent: yes to every data recipient (Tally, the Apple Health Shortcut, GitHub).
- Goals: get stronger in the squat and the bench press, and keep good conditioning. Ranked adaptations: strength, hypertrophy, long-duration endurance.
- Training history: 4 years. A 4-day upper/lower split. Squat 245 x 5, bench 195 x 5.
- Injuries: left knee. My physio said in September 2026: no deep loaded knee bends. Box squats to parallel are fine.
- Schedule: 4 days a week (Monday, Tuesday, Thursday, Friday), 60 minutes a session. Sleep target 450 minutes.
- Equipment: a full commercial gym.
- Method: nine-adaptations. Template: 4 days, emphasis all-around.
- Tally: connected. Use the Tally tools.
- Signals: the Apple Health Shortcut. I will set it up later.
- Automation: manual.
- Block 1 approval: YES. Write week 1 to Tally.
`;

const parseOr = (t: string | null | undefined) => {
  try {
    return t ? parse(t) : null;
  } catch {
    return null;
  }
};

/** NA-PROG-001 and the deload rule on the block's own targets: build steps at most +10% (or +1 set under 10). */
export function blockStepProblems(block: { weeks: { week: number; kind: string; targets?: Record<string, number> }[] }): string[] {
  const out: string[] = [];
  const weeks = [...block.weeks].sort((a, b) => a.week - b.week);
  for (let i = 1; i < weeks.length; i++) {
    const prev = weeks[i - 1];
    const cur = weeks[i];
    if (cur.kind !== "build" || prev.kind !== "build") continue;
    for (const [m, n] of Object.entries(cur.targets ?? {})) {
      const base = prev.targets?.[m] ?? 0;
      const max = base < 10 ? base + 1 : Math.floor(base * 1.1);
      if (n > max) out.push(`week ${cur.week} ${m}: ${base} -> ${n}`);
    }
  }
  return out;
}

const scenario: Scenario = {
  name: "01-setup-scripted",
  title: "Setup with scripted answers",
  mode: "interactive",
  fresh: true,
  skills: ["setup", "audit"],
  approver: [{ tool: ".*", behavior: "allow" }],
  prompt: "Set me up as a new athlete. Every answer you need from me is in ANSWERS.md in this folder: read it and treat each line as my reply. Do not wait for me; I will not answer questions.",
  setup(ctx) {
    ctx.write("ANSWERS.md", ANSWERS);
    const t = tallyState(ctx.today);
    Object.assign(ctx.mock, { ...t, days: {} });
  },
  check(a: RunArtifacts): Check[] {
    const out: Check[] = [];
    const cfg = parseOr(a.after["coach.yaml"]);
    let cfgOk = false;
    try {
      validateConfig(cfg);
      cfgOk = true;
    } catch (e) {
      out.push(check("coach.yaml is valid", false, (e as Error).message.slice(0, 300)));
    }
    if (cfgOk) out.push(check("coach.yaml is valid", true));
    try {
      const lim = validateLimits(parseOr(a.after["athlete/limits.yaml"]), taxonomy());
      out.push(check("limits.yaml is valid and holds the knee limit", lim.limits.some((l) => /knee/.test(l.region)), JSON.stringify(lim.limits.map((l) => l.region))));
    } catch (e) {
      out.push(check("limits.yaml is valid and holds the knee limit", false, (e as Error).message.slice(0, 300)));
    }
    out.push(check("hold.yaml and brief.md exist", a.after["athlete/hold.yaml"] != null && !!a.after["athlete/brief.md"] && /squat/i.test(a.after["athlete/brief.md"] ?? "")));
    let block: ReturnType<typeof validateBlock> | null = null;
    try {
      block = validateBlock(parseOr(a.after["athlete/block.yaml"]));
      out.push(check("block.yaml is valid", true));
    } catch (e) {
      out.push(check("block.yaml is valid", false, (e as Error).message.slice(0, 300)));
    }
    if (block) {
      const problems = blockStepProblems(block);
      out.push(check("block 1 passes the audit's hard rules (NA-PROG-001 steps)", problems.length === 0, problems.join("; ")));
    }
    const writes = successfulWrites(a);
    out.push(check("week 1 is written to Tally", writes.length > 0));
    if (block) {
      const start = block.start;
      const end = addDays(start, 6);
      const dates = Object.keys(a.mock.days);
      const outside = dates.filter((d) => d < start || d > end);
      out.push(check("only block week 1 is written", dates.length > 0 && outside.length === 0, `week 1 ${start}..${end}; outside: ${outside.join(", ")}`));
      const sessions = block.weeks.find((w) => w.week === 1)?.sessions ?? 0;
      out.push(check("every session of block week 1 is written", sessions > 0 && dates.length >= sessions, `${dates.length} of ${sessions} sessions`));
      out.push(check("block 1 starts on a Monday", weekStart(start) === start));
    }
    const readAnswers = a.tools.findIndex((t) => JSON.stringify(t.input ?? {}).includes("ANSWERS.md"));
    const firstWrite = a.tools.findIndex((t) => tallyToolUses(a).includes(t));
    out.push(check("the scripted answers (with the yes) are read before the first Tally write", readAnswers !== -1 && (firstWrite === -1 || readAnswers < firstWrite), `read at ${readAnswers}, first write at ${firstWrite}`));
    out.push(...bootstrapChecks(a));
    return out;
  },
};
export default scenario;
