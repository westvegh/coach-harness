// Lint for the coach's skills and agents (v0.2): front matter, CLI commands that exist,
// Tally tool names, none of the removed machinery, and an unattended branch for every writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { HELP, HELPER_COMMANDS } from "../engine/cli-help.ts";

const REPO = new URL("..", import.meta.url).pathname;
const SKILLS = ["setup", "today", "check-in", "safety", "week", "block", "audit", "limits", "explain", "method", "update", "log", "recovery-data", "automation", "injury-history"];
const AGENTS = ["analyst", "method-expert"];

type Doc = { name: string; path: string; front: Record<string, unknown>; body: string; text: string };

function load(path: string, name: string): Doc {
  const text = readFileSync(path, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, `${path}: needs YAML front matter`);
  return { name, path, front: parse(m[1]) as Record<string, unknown>, body: m[2], text };
}

const skills = SKILLS.map((s) => load(join(REPO, ".claude/skills", s, "SKILL.md"), s));
const agents = AGENTS.map((a) => load(join(REPO, ".claude/agents", `${a}.md`), a));

/** The text of a `## <title>` section, up to the next `## ` heading. */
function section(body: string, title: string): string | null {
  const m = new RegExp(`\\n## ${title}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(`\n${body}`);
  return m ? m[1] : null;
}

// ---------- the engine's command surface ----------

const cliSource = readFileSync(join(REPO, "engine/cli.ts"), "utf8");
const helpSource = readFileSync(join(REPO, "engine/cli-help.ts"), "utf8");
// Engine helper commands are dispatched by isHelpers2Command, not by a `case` in cli.ts.
const helpers2 = (/return \[([^\]]+)\]\.includes\(cmd\)/.exec(helpSource)?.[1] ?? "").match(/[a-z-]+/g) ?? [];
const COMMANDS = new Set<string>([
  ...HELPER_COMMANDS,
  ...[...cliSource.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]),
  ...[...cliSource.matchAll(/cmd === "([a-z-]+)"/g)].map((m) => m[1]),
  ...helpers2,
  ...Object.keys(HELP).map((k) => k.split(" ")[0]),
]);

const engineFiles = readdirSync(join(REPO, "engine")).filter((f) => /^cli.*\.ts$/.test(f) && !f.endsWith(".test.ts"));
const usageText = [...engineFiles.map((f) => `engine/${f}`), "engine/urgent.ts"]
  .map((f) => readFileSync(join(REPO, f), "utf8"))
  .join("\n")
  .split("\n")
  .filter((l) => /usage/i.test(l))
  .concat(Object.entries(HELP).map(([k, v]) => `${k}: usage: ${v}`))
  .join("\n");
const SUBCOMMANDS: Record<string, Set<string>> = {};
for (const cmd of ["urgent", "safety", "snapshot", "block", "ids", "oplog", "limits", "plans", "worktree"]) {
  SUBCOMMANDS[cmd] = new Set([...usageText.matchAll(new RegExp(`(?:usage: |\\| |cli\\.ts |^\\s*)${cmd} ([a-z][a-z-]*)`, "gm"))].map((m) => m[1]));
}
/** Commands whose subcommand is optional: the allowed ones. */
const OPTIONAL_SUB: Record<string, Set<string>> = { signals: new Set(["refresh"]) };

test("the engine command surface was found; the removed commands are gone", () => {
  for (const c of ["readiness", "volume", "urgent", "signals", "checkin", "classify", "mode", "opid", "adjust", "loads", "targets", "window-check", "weeks", "block", "ids", "lint-methods", "oplog", "limits", "push"]) {
    assert.ok(COMMANDS.has(c), `engine/cli.ts has ${c}`);
  }
  for (const c of ["hold", "validate", "proposals"]) assert.ok(!COMMANDS.has(c), `${c} is removed in v0.2`);
  assert.deepEqual([...SUBCOMMANDS.urgent].sort(), ["clear", "set", "status"]);
  for (const sub of ["schema", "regions", "check"]) assert.ok(SUBCOMMANDS.limits.has(sub), `limits ${sub}`);
  assert.ok(!SUBCOMMANDS.limits.has("sync-ops") && !SUBCOMMANDS.limits.has("server-rules"));
  assert.ok(SUBCOMMANDS.block.has("draft") && SUBCOMMANDS.ids.has("next") && SUBCOMMANDS.oplog.has("done"));
});

const CLI_CMD = /node engine\/cli\.ts ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g;

// ---------- Tally tool names ----------

const adapter = parse(readFileSync(join(REPO, "adapters/loggers/tally/adapter.yaml"), "utf8")) as { tools: { reads: Record<string, string>; mutations: Record<string, string> } };
const TALLY_WRITES = new Set(Object.values(adapter.tools.mutations));
const TALLY_TOOLS = new Set([
  ...Object.values(adapter.tools.reads),
  ...TALLY_WRITES,
  "get_exercise_progress",
  "search_exercises",
]);
const SERVER_FORMS = ["tally", "Tally_Workout", "claude_ai_Tally_Workout"];
const TOOL_WORD = /\b(?:get|plan|update|move|skip|delete|search)_[a-z_]+\b/g;

// ---------- skills ----------

test("all fifteen skills exist", () => {
  const dirs = readdirSync(join(REPO, ".claude/skills")).filter((d) => existsSync(join(REPO, ".claude/skills", d, "SKILL.md")));
  assert.deepEqual(dirs.sort(), [...SKILLS].sort());
});

for (const s of skills) {
  test(`${s.name}: front matter name and a description with trigger phrases`, () => {
    assert.equal(s.front.name, s.name);
    const d = String(s.front.description ?? "");
    assert.ok(d.length > 100 && d.length < 1000, `description length ${d.length}`);
    const phrases = d.match(/"[^"]+"/g) ?? [];
    assert.ok(phrases.length >= 3, `the description quotes at least 3 trigger phrases (found ${phrases.length})`);
  });

  test(`${s.name}: numbered steps and a Writes section`, () => {
    const steps = section(s.body, "Steps");
    assert.ok(steps, "a ## Steps section");
    assert.match(steps, /^1\. /m, "steps are numbered");
    assert.match(steps, /^2\. /m, "steps are numbered");
    assert.ok(section(s.body, "Writes"), "a ## Writes section");
  });

  test(`${s.name}: every engine command it names exists`, () => {
    for (const m of s.text.matchAll(CLI_CMD)) {
      const [, cmd, sub] = m;
      assert.ok(COMMANDS.has(cmd), `node engine/cli.ts ${cmd} is not an engine command`);
      if (SUBCOMMANDS[cmd]) assert.ok(sub && SUBCOMMANDS[cmd].has(sub), `node engine/cli.ts ${cmd} ${sub ?? ""}: unknown subcommand`);
      if (OPTIONAL_SUB[cmd] && sub) assert.ok(OPTIONAL_SUB[cmd].has(sub), `node engine/cli.ts ${cmd} ${sub}: unknown subcommand`);
    }
    for (const m of s.text.matchAll(/node ((?:engine|adapters)\/[\w/.-]+\.ts)/g)) {
      assert.ok(existsSync(join(REPO, m[1])), `${m[1]} does not exist`);
    }
  });

  test(`${s.name}: every Tally tool name is a known tool in a known form`, () => {
    for (const m of s.text.matchAll(TOOL_WORD)) assert.ok(TALLY_TOOLS.has(m[0]), `${m[0]} is not a Tally tool`);
    for (const m of s.text.matchAll(/\bmcp__([A-Za-z_]+?)__([a-z_]+)\b/g)) {
      assert.ok(SERVER_FORMS.includes(m[1]), `${m[0]}: unknown server form`);
      assert.ok(TALLY_TOOLS.has(m[2]), `${m[0]}: unknown tool`);
    }
  });

  test(`${s.name}: none of the removed machinery (guard, hold, pending file, safety agent, copy-exactly blocks, --approved, proposal PRs)`, () => {
    for (const re of [/\bguard\b/i, /hold\.yaml|hold (set|clear|status|init)|\bactive hold\b/i, /\.safety-pending|pending (file|safety)/i, /the `safety` agent/, /copy exactly/i, /--approved/, /proposals (create|list|open-pr|approve-copy|mark-applied|check-applied)|proposal\/<id>|athlete\/proposals/, /node engine\/cli\.ts validate/, /update_training_limits|sync-ops|server-rules/]) {
      assert.doesNotMatch(s.text, re, `${s.name}: ${re}`);
    }
    assert.doesNotMatch(section(s.body, "Writes")!, /\.cache\//, "the cache is never a write target");
  });

  test(`${s.name}: a skill that writes has an unattended branch`, () => {
    const writes = section(s.body, "Writes")!.trim();
    if (/^None\b/.test(writes)) return;
    const un = section(s.body, "Unattended");
    assert.ok(un && un.trim().length > 40, "a ## Unattended section");
  });

  test(`${s.name}: Tally writes carry a version or create-only-if-empty`, () => {
    const writesTally = [...TALLY_WRITES].some((t) => s.text.includes(t) && t !== "update_user_profile");
    if (!writesTally || s.name === "audit" || s.name === "explain") return;
    assert.ok(s.text.includes("expectedVersion"), "names expectedVersion");
  });
}

test("today and week run window-check first, then mode", () => {
  for (const name of ["today", "week"]) {
    const steps = section(skills.find((s) => s.name === name)!.body, "Steps")!;
    const w = steps.indexOf("node engine/cli.ts window-check");
    assert.ok(w >= 0 && w < steps.indexOf("node engine/cli.ts mode"), `${name}: window-check comes first`);
  }
});

test("today checks the urgent stop and the notes before the already-adjusted exit", () => {
  const steps = section(skills.find((s) => s.name === "today")!.body, "Steps")!;
  const exit = steps.indexOf("Today is already adjusted.");
  assert.ok(exit > 0, "the already-adjusted exit");
  assert.ok(steps.indexOf("urgent status") < exit);
  assert.ok(steps.indexOf("safety scan-notes") < exit);
});

test("setup writes the athlete files, coach.yaml and block.yaml before week 1", () => {
  const steps = section(skills.find((s) => s.name === "setup")!.body, "Steps")!;
  const files = steps.indexOf("Write the athlete files");
  const block = steps.indexOf("athlete/block.yaml");
  const week1 = steps.indexOf("**Write week 1.**");
  assert.ok(files > 0 && block > files && week1 > block);
  assert.ok(steps.indexOf("Write `coach.yaml` last") > files);
});

test("no skill syncs limits to Tally; limits says once that old Tally limits stay until the athlete removes them", () => {
  for (const s of skills) assert.doesNotMatch(s.text, /Server-side limits|update_training_limits/, s.name);
  assert.match(skill("limits").body, /v0\.2 never writes limits to Tally[^\n]*say once[^\n]*Settings → Training limits/);
});

test("unattended big changes become one log line for the next live session; no PR, no proposal file", () => {
  assert.match(steps("week").get(11)!, /\*\*Unattended:\*\* never write it\. Write one log line per change: "- proposal for the next live session: /);
  assert.match(claudeMd, /Unattended: make no big change; write one line in the athlete log, "- proposal for the next live session: <the change>"/);
  for (const s of skills) assert.doesNotMatch(s.text, /gh pr (create|merge)|git switch -c/, `${s.name}: no PR flow`);
  // The next live session offers them.
  // V6b fix 4: no question per proposal; today's proposals join the one consent question.
  assert.match(steps("today").get(4)!, /\*\*Proposals for the live session\*\* \(interactive only\)[^\n]*"- proposal for the next live session: …"[^\n]*Ask no question here\./);
  assert.match(steps("today").get(4)!, /Never one question per proposal\./);
});

// ---------- agents ----------

for (const a of agents) {
  test(`agent ${a.name}: front matter and no Tally write tools`, () => {
    assert.equal(a.front.name, a.name);
    const d = String(a.front.description ?? "");
    assert.ok(d.length > 100 && d.length < 1000, `description length ${d.length}`);
    const tools = String(a.front.tools ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    assert.ok(tools.length > 0, "an explicit tools list");
    for (const t of tools) {
      assert.ok(!t.includes("*"), `${t}: no wildcards`);
      assert.ok(!["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task"].includes(t), `${t} is not allowed`);
      const suffix = t.startsWith("mcp__") ? t.slice(t.lastIndexOf("__") + 2) : null;
      if (suffix) {
        assert.ok(!TALLY_WRITES.has(suffix), `${t} is a Tally write tool`);
        assert.ok(TALLY_TOOLS.has(suffix), `${t}: unknown tool`);
      }
    }
    assert.doesNotMatch(a.text, /\bguard\b|hold status|validate --tool|proposals (list|check-applied)/, `${a.name} names a removed command`);
  });
}

test("the safety agent is gone: the safety skill replaces it", () => {
  assert.equal(existsSync(join(REPO, ".claude/agents/safety.md")), false);
  assert.ok(existsSync(join(REPO, ".claude/skills/safety/SKILL.md")));
});

test("method-expert has read-only tools and checks the limits under NA-REC-007", () => {
  const tools = String(agents.find((a) => a.name === "method-expert")!.front.tools).split(",").map((t) => t.trim());
  assert.deepEqual(tools.sort(), ["Glob", "Grep", "Read"]);
  const body = agents.find((a) => a.name === "method-expert")!.body;
  for (const s of ["[ID]", "source", "Never estimate", "athlete/limits.yaml", "[NA-REC-007]", "limits check"]) assert.ok(body.includes(s), s);
});

test("analyst reports numbers with inputs and never estimates", () => {
  const body = agents.find((a) => a.name === "analyst")!.body;
  for (const s of ["node engine/cli.ts", "never estimate", "input", "ANALYST RESULT"]) assert.ok(body.toLowerCase().includes(s.toLowerCase()), s);
  for (const m of body.matchAll(/node engine\/cli\.ts ([a-z][a-z-]*)/g)) assert.ok(COMMANDS.has(m[1]), m[1]);
});

// ---------- skill wiring checks ----------

const skill = (name: string) => skills.find((s) => s.name === name)!;

/** Top-level numbered steps of a skill: step number → its text (with sub-items). */
function steps(name: string): Map<number, string> {
  const text = section(skill(name).body, "Steps")!;
  const map = new Map<number, string>();
  const heads = [...text.matchAll(/^(\d+)\. /gm)];
  heads.forEach((h, i) => map.set(Number(h[1]), text.slice(h.index!, i + 1 < heads.length ? heads[i + 1].index : text.length)));
  return map;
}

/** Index of each needle in the text, in order; fails when one is missing or out of order. */
function inOrder(text: string, needles: string[], what: string): void {
  let at = -1;
  for (const n of needles) {
    const i = text.indexOf(n, at + 1);
    assert.ok(i > at, `${what}: "${n}" must come after the previous item`);
    at = i;
  }
}

const claudeMd = readFileSync(join(REPO, "CLAUDE.md"), "utf8");

test("finding 1: today and week read history through today and scan notes before proposals, planning and every early exit", () => {
  for (const name of ["today", "week"]) {
    const st = steps(name);
    const safety = st.get(2)!;
    assert.match(safety, /\*\*Safety/, `${name}: step 2 is the safety step`);
    assert.match(safety, /get_workout_history[^\n]*`until` today/, `${name}: the history read runs through today`);
    assert.ok(safety.includes("node engine/cli.ts safety scan-notes"), `${name}: step 2 scans the session notes`);
    assert.ok(safety.includes("node engine/cli.ts urgent status"), `${name}: step 2 reads the urgent stop`);
    const step1 = st.get(1)!;
    for (const line of step1.split("\n").filter((l) => /\bstop\b|End the run|end the run/.test(l))) {
      assert.ok(line.includes("window-check"), `${name}: step 1 exits only at window-check: ${line.trim()}`);
    }
  }
  // V6 A.5: urgent and pain handling, then the already-adjusted check, then proposals.
  inOrder(section(skill("today").body, "Steps")!, ["safety scan-notes", "Today is already adjusted.", "Proposals for the live session", "node engine/cli.ts readiness"], "today");
  inOrder(section(skill("week").body, "Steps")!, ["safety scan-notes", "Proposals for the live session", "a new block is due", "node engine/cli.ts targets"], "week");
});

test("the urgent stop: today and week make no plan write under it, and clear it only through the safety skill's question", () => {
  for (const name of ["today", "week"]) {
    const safety = steps(name).get(2)!;
    assert.match(safety, /\*\*Urgent stop\*\*/);
    assert.match(safety, /urgent gate denies every plan write/);
    assert.match(safety, /the `safety` skill's clear question \(its step 6\)/);
  }
  for (const s of [...skills.map((x) => x.text), claudeMd]) {
    for (const line of s.split("\n").filter((l) => /urgent clear/.test(l))) assert.match(line, /--reason clinician|clinician`? or `?--reason false-alarm|false-alarm/, line.trim());
  }
  assert.match(claudeMd, /Never clear it on your own reading, and never in an unattended run\./);
});

test("finding 2: no load progression after trim or recovery", () => {
  const loads = steps("today").get(8)!;
  assert.match(loads, /\*\*Loads\.\*\*/);
  assert.match(loads, /only when `hold_progression` in step 6's readiness output is false \(the decision is `none` or `note`\)/);
  assert.match(loads, /Skip it when `hold_progression` is true \(`trim`, `recovery` or `propose_deload`\)/);
});

test("setup never runs hold init or the safety agent; pain goes to the safety skill and urgent signs to urgent set", () => {
  const text = section(skill("setup").body, "Steps")!;
  assert.doesNotMatch(text, /hold init|`safety` agent/);
  assert.match(steps("setup").get(4)!, /run the `safety` skill for it now \(screen: Region\): its one question screen \(two regions per screen\)/);
  assert.match(steps("setup").get(4)!, /node engine\/cli\.ts urgent set --term "chest pain" --source answer/);
});

test("week classifies each change in code and routes big changes to step 11", () => {
  const classify = steps("week").get(9)!;
  assert.match(classify, /node engine\/cli\.ts classify --input \.tmp\/coach\/call\.json/);
  assert.match(classify, /`big: false`: a small change\. Go to step 10\./);
  assert.match(classify, /`big: true`: a big change\. Go to step 11\./);
});

test("the plan follows the limits: week checks the drafted week with limits check; today checks today", () => {
  // V4: the week file from block draft --out.
  assert.match(steps("week").get(8)!, /node engine\/cli\.ts limits check --input <the week file>/);
  assert.match(steps("today").get(2)!, /node engine\/cli\.ts limits check --input \.tmp\/coach\/today\.json/);
  assert.match(steps("audit").get(3)!, /\*\*Limits review\*\* \(advisory\)[^\n]*node engine\/cli\.ts limits check/);
  assert.match(claudeMd, /4\. \*\*Follow the limits\.\*\*/);
});

test("week builds back a capped region once a week, interactive only", () => {
  const safety = steps("week").get(2)!;
  assert.match(safety, /\*\*Build back\*\* \(interactive\): for each limit with `build_back: true`, ask once "<Region>: how did it feel this week\? A\) Fine: build back one step, B\) The same: keep the cap, C\) Worse: avoid loading it for now"/);
  assert.match(safety, /Unattended: keep the caps as they are\./);
});

test("finding 10: setup commits and pushes at its end; automation pushes first and sets mode and verified only after a confirmed run", () => {
  inOrder(steps("setup").get(8)!, ["node engine/cli.ts install-git-hooks", "node engine/cli.ts prepush-check", "node engine/cli.ts commit --message", "node engine/cli.ts push"], "setup finish");
  const text = section(skill("automation").body, "Steps")!;
  inOrder(text, ["node engine/cli.ts push", "**Cloud.**", "RemoteTrigger", "shows success: set `automation.mode: cloud` and `automation.verified: true`"], "automation");
  for (const line of text.split("\n").filter((l) => /set `automation\.mode: (cloud|mac)`|Set `automation\.mode: (cloud|mac)`/.test(l))) {
    assert.match(line, /success/, `mode is set only after a confirmed run: ${line.trim()}`);
  }
});

test("finding 13: every pain follow-up in check-in offers options; a warning sign the athlete names passes --urgent", () => {
  const pain = steps("check-in").get(3)!;
  for (const q of ["Where?", "Which side?", "How bad"]) {
    const line = pain.split("\n").find((l) => l.includes(q));
    assert.ok(line && /A\) [^\n]*B\) /.test(line), `${q} has options`);
  }
  assert.match(pain, /not sure/);
  assert.match(pain, /\*\*A warning sign\*\* the athlete names: pass the term names with `--urgent`/);
  assert.match(steps("check-in").get(4)!, /\[--urgent <term>,\.\.\.\]/);
  assert.match(steps("check-in").get(5)!, /run the `safety` skill for that region/);
});

// ---------- the safety skill ----------

test("safety skill: one clickable screen (at most 4 questions), the three handling choices, side, warning signs, two regions per screen", () => {
  const ask = steps("safety").get(2)!;
  assert.match(ask, /at most 4 questions in one AskUserQuestion call/);
  assert.match(ask, /"<Region>: how should the coach handle it\?" with the options "It's fine now: train normally", "Go light and build back slowly", "Avoid loading it for now/);
  assert.match(ask, /Say the caution once, in the option text, never as a refusal/);
  assert.match(ask, /only for regions that have sides \(shoulder, elbow, wrist, hip, knee, ankle\)/);
  assert.match(ask, /"Any of these now\?" \(`multiSelect: true`\) with "New numbness or weakness", "Swelling with heat or redness", "Cannot bear weight", "None of these"/);
  assert.match(ask, /More than two regions: one screen per two regions/);
  assert.match(ask, /node engine\/cli\.ts urgent set/);
  assert.match(steps("safety").get(3)!, /By default, the limit covers the patterns that load the region: run `node engine\/cli\.ts limits regions`/);
});

test("safety skill: writes the limit the athlete chose (note, cap with build_back, ban), and the it's-better and old-notes flows", () => {
  const write = steps("safety").get(4)!;
  assert.match(write, /node engine\/cli\.ts limits schema/);
  assert.match(write, /"It's fine now": no limit/);
  assert.match(write, /"Go light and build back slowly": `rule: cap`[^\n]*`build_back: true`/);
  assert.match(write, /"Avoid loading it for now": `rule: ban`/);
  assert.match(steps("safety").get(6)!, /"A clinician has seen me about it", "It was a false alarm", "Not yet"[^\n]*--reason clinician[^\n]*--reason false-alarm[^\n]*Never clear it on your own reading/);
  assert.match(steps("safety").get(7)!, /"Remove the <region> limit\? A\) Yes, B\) Loosen it, C\) Keep it"/);
  assert.match(steps("safety").get(8)!, /one multi-select: "Which of these still bother you\?"/);
  assert.match(steps("safety").get(10)!, /See a clinician for new pain, pain that gets worse, or pain that does not settle\.[^\n]*once per conversation/);
  assert.match(skill("safety").body, /Without AskUserQuestion \(print mode\)[^\n]*ask the same questions as text with lettered options/);
  assert.doesNotMatch(skill("safety").text, /\bAgent\b|subagent|`safety` agent/, "no agent call");
});

test("CLAUDE.md hard rules 1 and 2: the urgent stop first, then the safety skill for ordinary pain", () => {
  assert.match(claudeMd, /1\. \*\*The urgent stop comes first\.\*\*/);
  assert.match(claudeMd, /2\. \*\*Pain and injuries: the `safety` skill\.\*\* Ask one clickable question screen\./);
});

// ---------- wiring round (contracts §21-§22, G evals) ----------

test("no E3 marker is left: every engine helper is wired", () => {
  for (const d of [...skills, ...agents]) assert.doesNotMatch(d.text, /E3:/, `${d.name} still has an E3 marker`);
  assert.doesNotMatch(claudeMd, /E3:/);
});

test("skills name no engine/ script path and leave no arithmetic to the model", () => {
  for (const s of skills) {
    assert.doesNotMatch(s.text, /node engine\/(?!cli\.ts)[\w-]+\.ts/, `${s.name}: use node engine/cli.ts`);
    assert.doesNotMatch(s.text, /divided by|times the emphasis multiplier|rounded to the nearest|minus 1 set|plus 1 set/, `${s.name}: arithmetic left to the model`);
  }
  assert.match(steps("today").get(6)!, /node engine\/cli\.ts readiness --date <today>/);
  assert.doesNotMatch(steps("today").get(6)!, /readiness\.json/, "today builds no readiness input by hand");
  assert.match(steps("today").get(7)!, /node engine\/cli\.ts adjust --from-snapshot <today>/);
  assert.match(steps("today").get(8)!, /node engine\/cli\.ts loads --from-snapshot <today>/);
  assert.match(steps("week").get(6)!, /node engine\/cli\.ts weeks --from/);
  assert.match(steps("week").get(8)!, /node engine\/cli\.ts block draft/);
  assert.match(steps("block").get(5)!, /node engine\/cli\.ts ids next --kind block[\s\S]*node engine\/cli\.ts block draft/);
  assert.match(steps("setup").get(7)!, /node engine\/cli\.ts ids next --kind block[\s\S]*node engine\/cli\.ts block draft/);
  assert.match(steps("today").get(6)!, /node engine\/cli\.ts signals refresh/);
});

test("today exits as already adjusted only when oplog done says so", () => {
  const read = steps("today").get(3)!;
  inOrder(read, ["node engine/cli.ts oplog done --date <today> --kind <kind>", "`status: done`", "`status: uncertain`", "`reread`", "Today is already adjusted."], "today step 3");
  assert.doesNotMatch(read, /log already has an entry/, "the log heading is not a record of success");
});

test("setup writes every planned week-1 day from block draft and checks the count", () => {
  const w1 = steps("setup").get(7)!;
  inOrder(w1, ["Every planned day of week 1", "`block draft`", "planned count", "**Check the count**", "write it once more", "do not try again"], "setup week 1");
  assert.match(steps("setup").get(6)!, /Leave out `sleep_target_min`/);
  assert.match(steps("block").get(10)!, /compare the count of written days with the drafted days/);
});

test("athlete/.urgent-stop is committed: not gitignored, and CLAUDE.md says so", () => {
  const r = spawnSync("git", ["check-ignore", "-q", "athlete/.urgent-stop"], { cwd: REPO });
  assert.equal(r.status, 1, ".gitignore must not cover athlete/.urgent-stop");
  assert.match(claudeMd, /`athlete\/\.urgent-stop` is committed and pushed at once/);
});

// ---------- one adjustment kind a day, red days and the unattended block end ----------

test("today step 8: no load progression on a day a proposal changed", () => {
  const loads = steps("today").get(8)!;
  assert.match(loads, /Skip it when the step 7 list holds a step 4 proposal for today/);
  assert.match(skill("today").body, /A proposal the athlete accepts for today is today's adjustment/);
});

test("today acts on the engine's patterns: a note for one day, a trim on the short pattern, recovery on aversion", () => {
  const decide = steps("today").get(7)!;
  assert.match(decide, /`note` \(one day is not a pattern \[NA-REC-008\]\)/);
  assert.match(decide, /`trim` \(the short pattern: 3 or more off-mornings in a row \[NA-REC-009\]\)[^\n]*Progression is held/);
  assert.match(decide, /`recovery` with `aversion: true`/);
  // V6 I.1: the coach recommends the recovery day; it no longer asks the athlete to pick between its own options.
  assert.match(decide, /`recovery` with `aversion: true`[^\n]*swap to recovery with `adjust`\. Not wanting to train is a reason to rest, and a recovery day is the safer change, so the coach makes it without a question\./);
  assert.doesNotMatch(decide, /A\) make today a recovery day, B\) keep the session as planned/);
  assert.match(decide, /`propose_deload`[^\n]*trim today with `adjust`[^\n]*the `week` run proposes it/);
  const loads = steps("today").get(8)!;
  assert.match(loads, /One off day is not a pattern: with `hold_progression: false`, run this step as usual/);
  assert.doesNotMatch(skill("today").body, /2 of the last 3 days|pattern\.hold_progression/, "R1's rule is gone");
  assert.match(steps("today").get(10)!, /Give no targets and no advice on food or supplements/);
});

test("check-in asks about not wanting to train only when the athlete says it, and passes it to the engine", () => {
  const ask = steps("check-in").get(3)!;
  assert.match(ask, /Ask: "Not wanting to train at all, or just tired\?" with the options "I do not want to train at all" and "Just tired"\. The first gives `--want-to-train 1` \[NA-REC-012\]/);
  assert.match(ask, /"Just tired" records nothing, except when today already has `want_to_train` at the aversion line \(1\): then it is a correction, so record `--want-to-train none`/);
  assert.match(steps("check-in").get(4)!, /\[--want-to-train <n>\|none\]/);
});

test("week proposes a program change only on the deload signal: interactive asks, unattended logs it for the live session", () => {
  const review = steps("week").get(6)!;
  assert.match(review, /node engine\/cli\.ts readiness --date <today>/);
  assert.match(review, /`deload_signal: true`/);
  assert.match(review, /\*\*Interactive:\*\*[^\n]*Ask "A\) make next week a deload week, B\) plan a new block, C\) keep the plan"/);
  assert.match(review, /\*\*Unattended:\*\* never write it\. Plan the week as usual and write one log line: "- proposal for the next live session: early deload/);
});

test("an unattended block end writes one log line for the live session, with no Tally write and no block change", () => {
  const week4 = steps("week").get(4)!;
  assert.match(week4, /interactive, run the `block` skill/);
  assert.match(week4, /Unattended, follow the `block` skill's Unattended section/);
  const un = section(skill("block").body, "Unattended")!;
  inOrder(un, ["writes no Tally day and does not change `athlete/block.yaml`", '"- proposal for the next live session: a new block is due', "node engine/cli.ts push"], "block Unattended");
  assert.match(steps("block").get(1)!, /Unattended: follow the Unattended section/);
});

// ---------- launch review finding 5: generic logger notes by default ----------

test("launch review finding 5: today's logger notes come from the generic table; detail only with consent.logger_health_notes true, never with false", () => {
  const today = skills.find((s) => s.name === "today")!;
  const notes = section(today.body, "Notes to the logger");
  assert.ok(notes, "today has a Notes to the logger section");
  for (const g of ["Readiness note", "Adjusted for recovery", "Recovery day", "Rest day: see your coach repo", "Load progression"]) assert.ok(notes.includes(g), g);
  assert.match(notes, /consent\.logger_health_notes: false`[^\n]*never put symptoms, body regions, pain scores, readiness values/);
  assert.match(notes, /consent\.logger_health_notes: true/);
  assert.doesNotMatch(today.body, /The reason line is `\[coach\] <decision_reasons>/);
  assert.doesNotMatch(today.body, /the reason with its rule IDs in `notes`/);
  assert.match(claudeMd, /generic note/);
  assert.match(claudeMd, /consent\.logger_health_notes: true/);
});

test("launch review finding 5 (v0.2): setup's one data question says Tally notes can hold readiness and pain scores; generic notes stay one click away", () => {
  const plans = steps("setup").get(5)!;
  assert.doesNotMatch(skill("setup").text, /no health data/i, "the old consent text said Tally gets no health data");
  assert.match(plans, /"Your data goes to Anthropic \(Claude\), GitHub \(this private repo\) and Tally \(plans, history and coach notes, which can include readiness and pain scores\)\. OK\?"/);
  assert.match(plans, /"Show details"[\s\S]*"Yes, but keep Tally notes generic"[\s\S]*`consent\.logger_health_notes: false`/);
  assert.match(readFileSync(join(REPO, "coach.example.yaml"), "utf8"), /logger_health_notes: true/);
});

test("launch review finding 8: the README claims a timestamp only where the source pins one", () => {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  assert.doesNotMatch(readme, /a link and a timestamp for each sourced rule/);
  assert.match(readme, /with a timestamp where the source pins one; rules marked approximate cite the episode only/);
  assert.match(readme, /Rules marked `policy` are the pack's own choices/);
  assert.match(readFileSync(join(REPO, "methods/nine-adaptations/rules.yaml"), "utf8"), /precision: approximate/);
});

// ---------- agents in the foreground; clickable questions ----------

test("B1: every agent call in the skills runs in the foreground with run_in_background: false", () => {
  const call = /\b(run|hand off to)\b[^\n]*the `(method-expert|analyst)` agent/i;
  let count = 0;
  for (const s of skills) {
    for (const line of s.text.split("\n").filter((l) => call.test(l))) {
      count++;
      assert.match(line, /`run_in_background: false`/, `${s.name}: ${line.trim()}`);
    }
  }
  assert.ok(count >= 1, `every agent call is checked (found ${count})`);
  assert.match(skills.find((s) => s.name === "audit")!.text, /run the `method-expert` agent in the foreground \(`run_in_background: false`/i);
  assert.match(claudeMd, /Run every agent in the foreground \(`run_in_background: false`\)/);
});

test("clickable questions: AskUserQuestion when it is there, lettered text options without it", () => {
  assert.match(claudeMd, /Use AskUserQuestion for clickable options when it is available; otherwise write the options as text\./);
  const health = steps("setup").get(4)!;
  inOrder(health, ["one AskUserQuestion call", "`multiSelect: true`", '"Is anything limiting your training now?"', '"Other" takes another region', "run the `safety` skill"], "setup health check");
  assert.match(skill("setup").body, /Without AskUserQuestion \(print mode\)[^\n]*ask the same questions as text with lettered options/);
});

// ---------- V1b fix round ----------

test("V1b fix 7: update restarts right after update --yes and runs nothing else; the rest runs in the new session", () => {
  const st = steps("update");
  assert.match(st.get(4)!, /node engine\/cli\.ts update --yes --to <to>/);
  const restart = st.get(5)!;
  assert.match(restart, /\*\*Restart first\*\* \(`restart_claude_code: true`\)\. Right after `update --yes`/);
  assert.match(restart, /Run nothing else in this session: no `npm ci`, no hook install, no `config-check`, no tests, no push\. Step 6 runs in the new session\./);
  for (const cmd of ["npm ci`.", "install-git-hooks", "config-check", "npm test", "node engine/cli.ts push"]) assert.ok(!restart.includes(`Run \`${cmd}`), `step 5 runs no ${cmd}`);
  inOrder(st.get(6)!, ["In the new session after a restart", "Run `npm ci`", "node engine/cli.ts install-git-hooks", "node engine/cli.ts config-check", "Run `npm test`", "node engine/cli.ts push", "old hold or safety-check files"], "update step 6");
  assert.match(st.get(1)!, /"Finish the update" after a restart: go straight to step 6/);
  assert.match(String(skill("update").front.description), /"finish the update"/);
});

test("V1b fix 10: the safety screen with two regions: two handling questions, one shared multi-select side question, one warning-sign question", () => {
  const ask = steps("safety").get(2)!;
  inOrder(ask, ["**One handling question per region**", "**One side question, shared,**", "**One warning-sign question:**"], "safety step 2");
  assert.match(ask, /Two regions: "Which side\?" \(`multiSelect: true`\) with "<Region A>: left", "<Region A>: right", "<Region B>: left", "<Region B>: right"; both sides of a region means both of its options are chosen\./);
  assert.match(ask, /One region: "<Region>: which side\?" with "Left", "Right", "Both"/);
  assert.match(ask, /Two regions are 4 questions at most: two handling questions, one side question, one warning-sign question\./);
  assert.doesNotMatch(ask, /"<Region>: which side\?" with "Left", "Right", "Both", only when/, "no side question per region");
});

test("V1b fix 11: method asks one approval for the whole reviewed pack and ordinary fixes; audit and explain use their agents only for a long read", () => {
  const method = skill("method");
  assert.match(steps("method").get(5)!, /Ask once: "Write the whole pack\? A\) yes, B\) change it, C\) no"\. This one yes covers every file of the reviewed pack\./);
  assert.match(steps("method").get(6)!, /Do not ask again per file\./);
  assert.match(steps("method").get(7)!, /Fix every error yourself \(an ordinary fix/);
  assert.doesNotMatch(method.text, /each after its own yes|write it after a yes|The guard asks/);
  const audit = steps("audit").get(4)!;
  assert.match(audit, /Read `methods\/<method>\/rules\.yaml`/);
  assert.match(audit, /Optional, for a long read \(a whole block, or a new pack\): run the `method-expert` agent/);
  assert.match(String(skill("audit").front.description), /the method-expert agent only for a long read/);
  assert.match(steps("explain").get(7)!, /The analyst agent is optional, for a long read/);
  assert.doesNotMatch(skill("explain").text, /Use the analyst agent for any number/);
});

// ---------- V2: setup v2 and Tally optional (docs/build/briefs/V2-setup-v2.md) ----------

// ---------- the setup screens: walk the scripted answer paths (V2b fix 5) ----------

type ScreenRow = { name: string; when: string; calls: number };

/** The rows of setup's "## Screens" table. */
function screenTable(): ScreenRow[] {
  const sec = section(skill("setup").body, "Screens")!;
  return sec
    .split("\n")
    .filter((l) => /^\| [A-Z]/.test(l) && !l.startsWith("| Screen |"))
    .map((l) => l.split("|").map((c) => c.trim()))
    .map((c) => ({ name: c[1], when: c[2], calls: Number(c[3]) }));
}

/** A scripted path: the facts and the athlete's answers that decide which screens appear. */
type Path = { tally: boolean; tallySessions: number; painNotes: boolean; region: boolean; details: boolean; change: boolean; dayExists: boolean; history: "tally" | "csv" | "skip" | "export" | "questions"; newExports?: number };

/** Which screens a path meets, from each row's "Asked when" text; an unknown condition fails the test. */
function screensFor(p: Path): string[] {
  return screenTable()
    .filter((r) => {
      switch (r.when) {
        case "always":
          return true;
        case "the Tally history has pain notes":
          return p.tally && p.painNotes;
        case "the athlete chooses a region in the health check":
          return p.region;
        case 'the athlete chooses "Show details"':
          return p.details;
        case 'the athlete chooses "Change something"':
          return p.change;
        case "a Tally day already exists on a week-1 date":
          return p.tally && p.dayExists;
        // V4: the optional history paths.
        case 'the athlete chooses "Export from another app"':
          return p.history === "export";
        case "the rescan finds two or more new exports":
          return p.history === "export" && (p.newExports ?? 1) !== 1;
        case 'the athlete chooses "Answer two quick questions"':
          return p.history === "questions";
        default:
          throw new Error(`setup screen ${r.name}: unknown condition "${r.when}"`);
      }
    })
    .flatMap((r) => Array(r.calls).fill(r.name));
}

const BASE_PATH: Path = { tally: false, tallySessions: 0, painNotes: false, region: false, details: false, change: false, dayExists: false, history: "skip" };

test("V2b fix 5: setup reaches week 1 in at most 5 AskUserQuestion calls on the scripted paths: Tally, files, files with a CSV", () => {
  const paths: Record<string, Path> = {
    tally: { ...BASE_PATH, tally: true, tallySessions: 12, history: "tally" },
    "tally with little history": { ...BASE_PATH, tally: true, tallySessions: 1, history: "skip" },
    files: { ...BASE_PATH },
    "files with a CSV": { ...BASE_PATH, history: "csv" },
  };
  for (const [name, p] of Object.entries(paths)) {
    const calls = screensFor(p);
    assert.deepEqual(calls, ["Basics", "Goal", "Health check", "Plans and data", "Week 1 approval"], name);
    assert.ok(calls.length <= 5, `${name}: ${calls.length} calls`);
  }
  // The optional paths the athlete chooses add one screen each, and the skill says so.
  assert.equal(screensFor({ ...BASE_PATH, details: true }).length, 6);
  assert.equal(screensFor({ ...BASE_PATH, change: true }).length, 6);
  assert.match(skill("setup").body, /"Show details", "Export from another app", "Answer two quick questions", "Change something" and a limiting region are optional paths the athlete chooses/);
  // V4: the export path adds two screens (three when the rescan finds several files); the quick questions add one.
  assert.equal(screensFor({ ...BASE_PATH, history: "export" }).length, 7);
  assert.equal(screensFor({ ...BASE_PATH, history: "export", newExports: 2 }).length, 8);
  assert.equal(screensFor({ ...BASE_PATH, history: "questions" }).length, 6);
  // Every screen in the table is tagged in the steps, every tag is in the table, and every question with options sits in a tagged step.
  const st = section(skill("setup").body, "Steps")!;
  const tags = [...st.matchAll(/screen: ([A-Z][A-Za-z0-9 ]+?)\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tags)].sort(), screenTable().map((r) => r.name).sort());
  for (const [n, text] of steps("setup")) {
    if (/"[^"]+\?" with "/.test(text)) assert.match(text, /screen: /, `setup step ${n} asks a question but names no screen`);
  }
  for (const n of [1, 6, 8]) assert.match(steps("setup").get(n)!.split("\n")[0], /\(no question/, `step ${n} asks nothing`);
  // The history question is part of the Plans and data screen, not a screen of its own.
  const plans = steps("setup").get(5)!;
  assert.match(plans.split("\n")[0], /one AskUserQuestion call, at most four questions; screen: Plans and data/);
  assert.match(plans, /\*\*The history question\*\*, only when no Tally server answered or the Tally history has fewer than 2 sessions/);
  assert.doesNotMatch(steps("setup").get(7)!, /"Do you have a record of your recent training\?"/);
  assert.match(steps("setup").get(1)!, /\*\*The Tally history\.\*\*[^\n]*`get_workout_history`/);
  assert.match(skill("setup").body, /Never ask for typed text\. Every question has options/);
  assert.match(steps("setup").get(6)!, /`athlete\.name` from `setup-check` `name`[^\n]*`athlete\.timezone` from `timezone`/);
});

test("V2 setup basics and goal: units (prefilled from Tally), days, session length, equipment; the goal; the coach picks the weekdays", () => {
  const basics = steps("setup").get(2)!;
  for (const q of ['"Which units do you lift in?" with "lbs", "kg"', '"How many days a week can you train?" with "3", "4", "5"', '"How long is a session?"', '"What equipment do you have?"']) assert.ok(basics.includes(q), q);
  assert.match(basics, /Leave it out when Tally knows the unit \(`weightUnitSource` is `settings` or `history`\)/);
  const goal = steps("setup").get(3)!;
  assert.match(goal, /"What is your main goal\?" with "All-around", "Strength", "Size", "Endurance"\. "Other" takes general health/);
  assert.match(goal, /You pick the weekdays; ask nothing\.[^\n]*They show in the week 1 table/);
});

test("V2b fix 7: the health screen: three PAR-Q+ questions with None of these plus the regions; dizziness is not fainting", () => {
  const h = steps("setup").get(4)!;
  assert.match(h.split("\n")[0], /one AskUserQuestion call, four questions, each `multiSelect: true`; screen: Health check/);
  const line = (q: string) => h.split("\n").find((l) => l.includes(q))!;
  const qs = ['"Heart: do any of these apply?"', '"Dizziness or fainting: do any of these apply?"', '"Other health: do any of these apply?"'].map(line);
  for (const q of qs) {
    assert.ok(q, "each PAR-Q+ question");
    assert.match(q, /"None of these"\.$/, "each ends with None of these");
    const n = (q.match(/"[^"]+"/g) ?? []).length - 1;
    assert.ok(n >= 2 && n <= 4, `2 to 4 options (AskUserQuestion allows 4): ${n}`);
  }
  const all = qs.join("\n");
  // The seven PAR-Q+ items, one option each.
  for (const item of [/"A clinician said I have a heart condition or high blood pressure"/, /"Chest pain at rest, in daily life or when I exercise"/, /"Dizziness that makes me lose balance"/, /"Fainting in the past year"/, /"Another long-term condition"/, /"Prescribed medicine for a long-term condition"/, /"A bone, joint or soft-tissue problem that more activity could make worse"/, /"A clinician said I should only exercise with medical supervision"/]) assert.match(all, item);
  assert.match(h, /"Is anything limiting your training now\?" with "Shoulder", "Low back", "Knee", "None"/);
  // Only chest pain or fainting stops; dizziness gets the clearance sentence.
  assert.match(h, /\*\*Chest pain or fainting\*\* \(only these two\)/);
  inOrder(h, ["**Chest pain or fainting**", "`URGENT_CARE_TEXT`", 'node engine/cli.ts urgent set --term "chest pain" --source answer', "stop setup"], "urgent");
  assert.doesNotMatch(h.split("\n").find((l) => l.includes("**Chest pain or fainting**"))!, /dizz/i);
  assert.match(h, /\*\*Any other yes\*\* \(dizziness included; not "None of these"\): say once, "Get clearance from a clinician before you train hard\. I record what you report\."[^\n]*Setup goes on\./);
  assert.match(h, /\*\*A region\*\*[^\n]*run the `safety` skill/);
  assert.match(h, /Never ask for medication names/);
});

test("V2 setup: no step numbers, template syntax, rule IDs or code paths in quoted athlete text", () => {
  const steps_ = section(skill("setup").body, "Steps")!;
  const quoted = [...steps_.matchAll(/"([^"\n]+)"/g)].map((m) => m[1]).filter((q) => q.includes(" ") || /^[A-Z]/.test(q));
  assert.ok(quoted.length > 30, `the quoted athlete text was found (${quoted.length})`);
  for (const q of quoted) {
    assert.doesNotMatch(q, /[<>{}]|\$\{|\bstep \d|\bscreen \d|\bpart \d/i, `template syntax or a step number: "${q}"`);
    assert.doesNotMatch(q, /\b[A-Z]{2}-[A-Z]{2,5}-\d{3}\b|\bL-\d{3}\b/, `a rule or limit ID: "${q}"`);
    assert.doesNotMatch(q, /\b(engine|adapters|\.claude|methods|templates|athlete)\/|\.(ts|yaml|json)\b|`/, `a code path: "${q}"`);
  }
  assert.match(skill("setup").body, /Athlete-facing text never shows template syntax, step numbers, rule IDs or code paths\./);
  assert.match(section(skill("setup").body, "Resume")!, /"I have your basics and your goal\. Next: a short health check\."/);
});

test("V2b fix 6: plans and data: Tally without a logger question; else the connected tools by name (Files first, 4 options at most); allow-server for the chosen tool; the Tally account question bounded", () => {
  const p = steps("setup").get(5)!;
  assert.match(steps("setup").get(1)!, /\*\*Find other tools\.\*\*[^\n]*connected MCP servers that are not Tally[^\n]*Keep at most two, by their plain names\./);
  assert.match(p, /\*\*Where plans go\*\*, only when no Tally server answered and the athlete did not say they do not use Tally: "Where should your plans go\?" with "Files in this repo \(Recommended\)" first[^\n]*then "Tally"[^\n]*then each connected tool found in step 1 by its plain name, for example "Google Sheets"[^\n]*Four options at most\./);
  assert.doesNotMatch(p, /"A tool you already use"/);
  assert.match(p, /A connected tool: run `node engine\/cli\.ts allow-server --server <server>` for it, then `logger: other`/);
  assert.match(p, /"Which Tally account holds your training\?" with at most four options, one per server, newest last session first/);
  assert.match(p, /\*\*The data question\*\*, always\./);
  assert.match(p, /"Yes", "Show details"/);
  assert.match(p, /Tally, but no server answered: `logger: files` for now\./);
  assert.match(p, /say "I can't reach that tool from here, so your plans go in a spreadsheet file in this repo for now\." and use `logger: files`\./);
  // The history question (V4): the newest export by name, the export path, the quick questions, skip.
  assert.match(p, /"Do you have a record of your recent training\?" with the newest export from `history-files` when there is one \(named by the file and its folder[^\n]*then "Export from another app", "Answer two quick questions", "Skip"\. "Other" takes a path/);
  assert.doesNotMatch(skill("setup").text, /I'll type a short summary/);
  assert.match(steps("setup").get(1)!, /node engine\/cli\.ts history-files/);
  assert.match(p, /\*\*Read an export:\*\* read only the file the athlete chose, with the Read tool[^\n]*only its last 8 weeks[^\n]*Do not keep a copy of the file/);
  assert.match(steps("setup").get(1)!, /node engine\/cli\.ts allow-server --server <server>` first \(then its tools need no permission prompt\), then call its `get_training_context`/);
});

test("V2 setup week 1: one method line; the week as a table; write it", () => {
  const w = steps("setup").get(7)!;
  assert.match(w, /"The coach plans from one method: fitness as nine qualities \(strength, size, endurance and others\), from Andy Galpin's public teaching\. You chose strength, so that gets the most sets\."/);
  assert.match(w, /\*\*The table\.\*\* Show week 1 in one table/);
  assert.match(w, /"Week 1 is ready\. Write it\?" with "Write it to Tally" \(with Tally\), "Write it to a spreadsheet file" \(with files\)[^\n]*"Change something"/);
  // V4: the week file from block draft --out goes to plans write as it is.
  assert.match(w, /\*\*Files:\*\*[^\n]*node engine\/cli\.ts plans write --input \.tmp\/coach\/b1\/week-1\.json[^\n]*"Week 1 is in plans\/2026-W43\.csv in this folder\./);
  assert.match(w, /\*\*Tally:\*\*[^\n]*`plan_workout_day` with `ifAbsent: true`[^\n]*`expectedVersion` and `replace: true`/);
  assert.match(w, /\*\*Another tool:\*\*[^\n]*following its own instructions[^\n]*node engine\/cli\.ts logger set files/);
  assert.match(steps("setup").get(8)!, /End with one line: "Later you can add recovery data \(Oura or Apple Health\), daily and weekly automation, injury history or assessments\. Just ask\."/);
});

test("V2 setup keeps Resume, and moved recovery data and automation out", () => {
  const resume = section(skill("setup").body, "Resume")!;
  assert.match(resume, /`athlete\/log\/setup\.md`/);
  assert.match(resume, /`setup: <part> done <YYYY-MM-DD HH:MM> \(<answers>\)`/);
  assert.match(resume, /skip every part already done/);
  for (const part of ["checks", "basics", "goal", "health", "plans", "files", "week1", "finish"]) {
    assert.match(section(skill("setup").body, "Steps")!, new RegExp(`setup: ${part} (done|stopped)`), part);
  }
  const setupText = skill("setup").text;
  for (const gone of [/RemoteTrigger/, /install-launchd/, /oura\/auth\.ts/, /oura\/fetch\.ts/, /routine-body/]) assert.doesNotMatch(setupText, gone, `${gone} moved to a deferred skill`);
});

test("V2 deferred skills: recovery-data, automation and injury-history are short and self-contained", () => {
  for (const name of ["recovery-data", "automation", "injury-history"]) {
    const s = skill(name);
    assert.ok(s.text.split("\n").length < 60, `${name} is short (${s.text.split("\n").length} lines)`);
    for (const sec of ["Steps", "Writes", "Unattended"]) assert.ok(section(s.body, sec), `${name}: ## ${sec}`);
    assert.match(section(s.body, "Unattended")!, /Never in an unattended run/);
    assert.match(String(s.front.description), /Interactive only\./);
  }
  const rd = section(skill("recovery-data").body, "Steps")!;
  assert.match(rd, /"Which recovery data do you have\?" with "Oura ring", "Apple Watch or another Apple Health device", "None: chat check-ins only"/);
  assert.match(rd, /`! node adapters\/signals\/oura\/auth\.ts`/, "the athlete runs the Oura sign-in in the prompt");
  assert.match(rd, /node adapters\/signals\/oura\/fetch\.ts --days 50/);
  assert.match(rd, /apple-health-shortcut\/SHORTCUT\.md/);
  const au = section(skill("automation").body, "Steps")!;
  assert.match(au, /"How should the daily and weekly runs start\?" with "Cloud routines"[^\n]*"This Mac"[^\n]*"By hand"/);
  assert.match(au, /With `logger: files` or `other`, say: "The scheduled runs need Tally for now\./);
  for (const line of au.split("\n").filter((l) => /set `automation\.mode: (cloud|mac)`/.test(l))) assert.match(line, /success/);
  const ih = section(skill("injury-history").body, "Steps")!;
  assert.match(ih, /"Which regions had an injury or pain in the past year\?"/);
  assert.match(ih, /\*\*Still bothers:\*\* run the `safety` skill/);
  assert.match(ih, /\*\*Healed:\*\*[^\n]*no limit/);
});

test("V2 logger sweep: every skill that reads or writes plans follows coach.yaml logger; CLAUDE.md maps each job", () => {
  for (const name of ["today", "week", "block", "audit", "explain", "check-in", "log"]) {
    assert.match(skill(name).text, /`coach\.yaml logger`/, `${name} reads the logger`);
  }
  for (const name of ["today", "week", "block", "audit", "explain", "check-in"]) {
    const where = section(skill(name).body, "Where plans live");
    assert.ok(where, `${name}: a Where plans live section`);
    assert.match(where, /CLAUDE\.md "Where plans live"/, `${name} points to the map`);
  }
  for (const name of ["today", "week", "block", "setup"]) assert.match(skill(name).text, /node engine\/cli\.ts plans write --input/, `${name} writes plans to files`);
  for (const name of ["today", "week", "audit", "explain", "log"]) assert.match(skill(name).text, /node engine\/cli\.ts plans read --week/, `${name} reads plans from files`);
  for (const name of ["today", "week", "block"]) assert.match(section(skill(name).body, "Writes")!, /`plans\/<YYYY>-W<ww>\.csv`, only through `node engine\/cli\.ts plans write`/, `${name}: Writes names the files`);
  for (const name of ["today", "week", "block"]) assert.match(section(skill(name).body, "Where plans live")!, /`logger: other`[^\n]*by its own instructions/, `${name}: logger other`);
  const where = section(`\n${claudeMd}`, "Where plans live")!;
  assert.match(where, /\| Job \| `tally` \| `files` \(`plans\/<YYYY>-W<ww>\.csv`\) \| `other` \(a tool the athlete connected\) \|/);
  for (const job of ["Read a planned day or week", "Read the logged history", "Write or change a day", "The athlete logs a session"]) assert.ok(where.includes(job), job);
  assert.match(where, /With `other`, the urgent gate cannot see that tool's writes: under the urgent stop, write nothing to it\./);
  assert.match(where, /With `other`, when the tool does not answer, say so in one line, run `node engine\/cli\.ts logger set files`, and use `files` from then on/);
});

test("V2 log skill: a chat report fills the done columns with one engine command; Tally users log in the app", () => {
  const st = section(skill("log").body, "Steps")!;
  assert.match(st, /`tally`: say "Log your sets in Tally at the gym; I read them from there\." Stop\./);
  assert.match(st, /"Did all sets"[^\n]*`node engine\/cli\.ts plans done --date <date> --as-planned`/);
  assert.match(st, /node engine\/cli\.ts plans done --date <date> --exercise "<name>" --sets <n> --reps <r> --load <x>/);
  assert.match(st, /add `--felt "<their words, short>"`/);
  assert.match(st, /\*\*Urgent and pain first\.\*\*/);
  assert.match(String(skill("check-in").text), /run the `log` skill/);
});

test("V2 Tally mention: today, week and log run tally-mention in a live session and say its text once; never unattended", () => {
  for (const name of ["today", "week", "log"]) {
    assert.match(skill(name).text, /node engine\/cli\.ts tally-mention/, name);
    assert.match(skill(name).text, /`mention: true`, say its `text` once/, name);
  }
  assert.match(section(skill("today").body, "Unattended")!, /Never run `tally-mention`/);
  assert.match(claudeMd, /run `node engine\/cli\.ts tally-mention` in a live session/);
});

test("V2 worktrees: setup fast-forwards main at the end; update runs on the main checkout, then fast-forwards the branch, then the restart", () => {
  const fin = steps("setup").get(8)!;
  inOrder(fin, ["**Worktree**", "node engine/cli.ts worktree ff-main", "node engine/cli.ts push --branch main"], "setup finish");
  assert.match(steps("setup").get(1)!, /\*\*Worktree\.\*\* When `worktree\.worktree` is true and `worktree\.branch` is not `main`, work on this branch\./);
  const up = steps("update");
  inOrder(up.get(1)!, ["node engine/cli.ts worktree status", "node engine/cli.ts commit --message", "node engine/cli.ts worktree ff-main", "node engine/cli.ts worktree main-checkout", "`main_checked_out_at`", ".tmp/coach/main-checkout", "--root <path>", "node engine/cli.ts update --check --root <path>"], "update check");
  assert.doesNotMatch(up.get(1)!, /<main_checkout>/, "V2b fix 8: not the main checkout's folder, which may hold another branch");
  inOrder(up.get(4)!, ["node engine/cli.ts update --yes --to <to>", "add `--root <path>`", "node engine/cli.ts worktree ff-branch", "node engine/cli.ts worktree remove-temp"], "update yes");
  assert.match(up.get(5)!, /Right after `update --yes` \(in a worktree, right after `worktree ff-branch`\)/);
  assert.match(up.get(6)!, /node engine\/cli\.ts push --branch main/);
});

/** True when one allow rule covers the command (a `*` matches any text, as in Claude Code's Bash rules). */
function allowed(cmd: string, rules: string[]): boolean {
  return rules.some((r) => {
    const m = /^Bash\((.*)\)$/.exec(r);
    if (!m) return false;
    const re = new RegExp(`^${m[1].split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(cmd) || re.test(`${cmd} x`);
  });
}

test("V2 allow rules: every engine and adapter command the everyday skills run is covered, so default mode does not prompt", () => {
  const rules: string[] = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf8")).permissions.allow;
  // Rare, one-time flows that may prompt once: automation's routine and launchd installs, the method lint, an explicit help call.
  const EXEMPT = /^node engine\/cli\.ts (routine-body|install-launchd|launchd-plist)\b/;
  const missing: string[] = [];
  for (const s of skills) {
    for (const m of s.text.matchAll(/`(node (?:engine\/cli\.ts|adapters\/[\w/.-]+\.ts)[^`]*)`/g)) {
      const cmd = m[1].replace(/<[^>]+>/g, "x").replace(/\|[a-z-]+/g, "").trim();
      if (EXEMPT.test(cmd) || cmd.startsWith("! ")) continue;
      if (/oura\/auth\.ts/.test(cmd)) continue; // the athlete runs the sign-in in the prompt
      if (!allowed(cmd, rules)) missing.push(`${s.name}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
  for (const r of ["Bash(node engine/cli.ts update --yes --to *)", "Bash(node engine/cli.ts update --check --root *)", "Bash(git pull --rebase)", "Edit(athlete/**)", "Write(plans/**)", "Write(coach.yaml)"]) assert.ok(rules.includes(r), r);
});

test("V2b fix 4: the fallback from another tool switches coach.yaml logger to files, in one line to the athlete", () => {
  const log = steps("log").get(5)!;
  inOrder(log, ["When it does not answer, fall back to files", '"I can\'t reach your tool, so I\'m keeping your plans in a spreadsheet file in this repo from now on."', "node engine/cli.ts logger set files", "plans done"], "log fallback");
  for (const name of ["today", "week", "block"]) assert.match(section(skill(name).body, "Where plans live")!, /When it does not answer, say so in one line, run `node engine\/cli\.ts logger set files`/, name);
  assert.match(steps("setup").get(7)!, /When the tool stops answering, say so in one line, run `node engine\/cli\.ts logger set files`/);
  assert.match(claudeMd, /With `other`, the engine reads no Tally cache/);
});

test("V2b fix 9: every skill that commits stops on a failed commit and says it in one line", () => {
  let count = 0;
  for (const s of skills) {
    for (const line of s.text.split("\n").filter((l) => /node engine\/cli\.ts commit --message/.test(l))) {
      count++;
      assert.match(line, /[Aa] nonzero exit: stop, and say in one line that the commit failed and why/, `${s.name}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.ok(count >= 12, `every commit line was checked (${count})`);
  assert.match(claudeMd, /a nonzero exit is a failed commit: stop and say so in one line/);
});

test("V2b fix 10: today, week and log run tally-mention before the commit, then pull and push", () => {
  for (const name of ["today", "week", "log"]) {
    inOrder(section(skill(name).body, "Steps")!, ["node engine/cli.ts tally-mention", "node engine/cli.ts commit --message", "git pull --rebase", "node engine/cli.ts push"], name);
  }
});

test("V3b fix 2: setup names the Write or Edit tool next to every file it writes, and forbids composed commands", () => {
  const t = skill("setup").text;
  assert.match(t, /\*\*No permission prompts\.\*\* Write and append files with the Write or Edit tool/);
  for (const w of ["`;`", "`&&`", "pipes", "redirects", "`echo`", "`head`", "`grep`", "`node -e`", "never run `mkdir`"]) assert.ok(t.includes(w), w);
  const appends = [...t.matchAll(/Append `setup: [^`]*`([^\n]*)/g)];
  assert.ok(appends.length >= 8);
  for (const m of appends) assert.match(m[1], /^ to `athlete\/log\/setup\.md` \(Edit tool\)/, m[0]);
  assert.match(t, /Fill `athlete\/brief\.md` from the answers, with the Write tool/);
  assert.match(t, /Write `coach\.yaml` last, with the Write tool/);
  // V4: the draft input and the normalized export are the only JSON setup writes by hand.
  for (const f of ["b1/draft.json", "history.json"]) assert.match(t, new RegExp(`write \`\\.tmp/coach/${f.replace(".", "\\.")}\` with the Write tool`, "i"), f);
  assert.match(t, /Keep its printed output \(no redirect\)/);
});

test("V3b fix 3: the safety skill changes the conflicting days without a second screen", () => {
  const t = skill("safety").text;
  const step5 = steps("safety").get(5)!;
  assert.doesNotMatch(t, /Change those days now\?/);
  assert.match(step5, /Plan around it, without asking/);
  assert.match(step5, /ask no second question/);
  assert.match(step5, /Under the urgent stop, change nothing/);
  assert.match(step5, /`source` is `mcp` and `userModified` is false/);
  assert.match(step5, /A day the athlete built or edited in the app: leave it, and say so in one line/);
  assert.match(step5, /Say what changed in one line/);
  assert.match(step5, /node engine\/cli\.ts limits check --input \.tmp\/coach\/week\.json/);
});

test("V3b fix 4: final messages are plain: no file paths, block, limit or rule ids", () => {
  const style = readFileSync(join(REPO, "CLAUDE.md"), "utf8");
  assert.match(style, /\*\*Final messages are plain\.\*\* What the athlete reads at the end of a skill has no file paths, no block, limit or rule ids, and no command names/);
  assert.match(style, /"No limits yet\." instead of "`athlete\/limits\.yaml` has no limits"/);
  assert.doesNotMatch(style, /Give the number, the reason and the rule ID\./);
  const setup = skill("setup").text;
  assert.match(setup, /\*\*The final message is plain\*\*[^\n]*no file paths, no block, limit or rule ids/);
  assert.doesNotMatch(steps("today").get(10)!, /and the rule IDs/);
  assert.match(steps("week").get(13)!, /plain words \(no rule IDs or file paths/);
  assert.doesNotMatch(skill("safety").text, /\(L-0\d\d\)/);
});
