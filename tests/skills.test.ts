// Lint for the coach's skills and agents: front matter, CLI commands that exist,
// Tally tool names, no protected write targets, and an unattended branch for every writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { HELP, HELPER_COMMANDS } from "../engine/cli-help.ts";
import { PROTECTED_DIRS, PROTECTED_FILES } from "../engine/protect.ts";

const REPO = new URL("..", import.meta.url).pathname;
const SKILLS = ["setup", "today", "check-in", "week", "block", "audit", "limits", "explain", "method", "update"];
const AGENTS = ["analyst", "method-expert", "safety"];

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
  ...helpers2,
  ...Object.keys(HELP).map((k) => k.split(" ")[0]),
]);

const engineFiles = readdirSync(join(REPO, "engine")).filter((f) => /^cli.*\.ts$/.test(f) && !f.endsWith(".test.ts"));
const usageText = [...engineFiles.map((f) => `engine/${f}`), "engine/hold.ts"]
  .map((f) => readFileSync(join(REPO, f), "utf8"))
  .join("\n")
  .split("\n")
  .filter((l) => /usage/i.test(l))
  .concat(Object.entries(HELP).map(([k, v]) => `${k}: usage: ${v}`))
  .join("\n");
const SUBCOMMANDS: Record<string, Set<string>> = {};
for (const cmd of ["hold", "safety", "snapshot", "block", "ids", "oplog", "limits"]) {
  SUBCOMMANDS[cmd] = new Set([...usageText.matchAll(new RegExp(`(?:usage: |\\| |cli\\.ts |^\\s*)${cmd} ([a-z][a-z-]*)`, "gm"))].map((m) => m[1]));
}
SUBCOMMANDS.proposals = new Set(HELP.proposals.split("|").map((part) => part.trim().replace(/^proposals /, "").split(" ")[0]));
/** Commands whose subcommand is optional: the allowed ones. */
const OPTIONAL_SUB: Record<string, Set<string>> = { signals: new Set(["refresh"]) };

test("the engine command surface was found", () => {
  for (const c of ["readiness", "volume", "hold", "signals", "checkin", "classify", "validate", "mode", "opid", "adjust", "loads", "targets", "proposals", "window-check", "weeks", "block", "ids", "lint-methods", "oplog", "limits"]) {
    assert.ok(COMMANDS.has(c), `engine/cli.ts has ${c}`);
  }
  assert.deepEqual([...SUBCOMMANDS.hold].sort(), ["clear", "clear-pending", "init", "set", "status"]);
  for (const sub of ["create", "approve-copy", "open-pr", "list", "mark-applied", "check-applied"]) assert.ok(SUBCOMMANDS.proposals.has(sub), `proposals ${sub}`);
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
  "update_training_limits", // named only in the capability-gated server-side limits step
]);
const SERVER_FORMS = ["tally", "Tally_Workout", "claude_ai_Tally_Workout"];
const TOOL_WORD = /\b(?:get|plan|update|move|skip|delete|search)_[a-z_]+\b/g;

// ---------- skills ----------

test("all ten skills exist", () => {
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

  test(`${s.name}: no protected file is a write target`, () => {
    const writes = section(s.body, "Writes")!;
    for (const raw of writes.split("\n")) {
      // An engine command in backticks is how a file is written, not the target itself.
      const line = raw.replace(/`node [^`]*`/g, "");
      const hits = [...PROTECTED_FILES, ...PROTECTED_DIRS].filter((p) => line.includes(p));
      if (hits.length === 0) continue;
      // A file that only a trusted engine command writes (contracts §23: athlete/signals/ through `checkin`).
      if (/only through `node engine\/cli\.ts [^`]+`\.?$/.test(raw.trim())) continue;
      // The only exception: a reviewed entry the guard asks the user about, never unattended.
      assert.ok(line.includes("(interactive yes only)"), `${s.name} names ${hits.join(", ")} as a write target: ${line.trim()}`);
    }
    assert.doesNotMatch(writes, /hold\.yaml|\.safety-pending|\.cache\//, "hold, pending and cache files are never write targets");
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

test("today checks safety before the already-adjusted exit", () => {
  const steps = section(skills.find((s) => s.name === "today")!.body, "Steps")!;
  const exit = steps.indexOf("Today is already adjusted.");
  assert.ok(exit > 0, "the already-adjusted exit");
  assert.ok(steps.indexOf("hold status") < exit);
  assert.ok(steps.indexOf("safety scan-notes") < exit);
});

test("setup writes the athlete files, coach.yaml and block.yaml before week 1", () => {
  const steps = section(skills.find((s) => s.name === "setup")!.body, "Steps")!;
  const files = steps.indexOf("Write the athlete files");
  const block = steps.indexOf("athlete/block.yaml");
  const week1 = steps.indexOf("**Write week 1**");
  assert.ok(files > 0 && block > files && week1 > block);
  assert.ok(steps.indexOf("Write `coach.yaml` last") > files);
});

test("limits and setup gate the server-side limits step on the tool list, silently", () => {
  for (const name of ["limits", "setup"]) {
    const s = skills.find((x) => x.name === name)!;
    assert.ok(s.body.includes("Server-side limits (only when available)"), `${name}: the marked step`);
    assert.ok(s.body.includes("skip this step silently"), `${name}: skipped without a word`);
    assert.ok(s.body.includes("update_training_limits"), `${name}: gated on the tool list`);
  }
});

test("unattended proposals go through the engine and a PR, never approved on main", () => {
  const week = skills.find((s) => s.name === "week")!.body;
  for (const c of ["proposals create", "proposals approve-copy", "proposals open-pr", "git switch -c proposal/"]) assert.ok(week.includes(c), c);
  for (const s of skills) assert.doesNotMatch(s.text, /gh pr (create|merge)/, `${s.name}: no gh pr create or merge`);
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
  });
}

test("method-expert has read-only tools", () => {
  const tools = String(agents.find((a) => a.name === "method-expert")!.front.tools).split(",").map((t) => t.trim());
  assert.deepEqual(tools.sort(), ["Glob", "Grep", "Read"]);
  const body = agents.find((a) => a.name === "method-expert")!.body;
  for (const s of ["[ID]", "source", "Never estimate"]) assert.ok(body.includes(s), s);
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

test("finding 1: today and week read history through today and scan notes before proposals, planning and every early exit", () => {
  for (const name of ["today", "week"]) {
    const st = steps(name);
    const safety = st.get(2)!;
    assert.match(safety, /\*\*Safety\.\*\*/, `${name}: step 2 is the safety step`);
    assert.match(safety, /get_workout_history[^\n]*`until` today/, `${name}: the history read runs through today`);
    assert.ok(safety.includes("node engine/cli.ts safety scan-notes"), `${name}: step 2 scans the session notes`);
    // Step 1 may stop only at window-check (an out-of-window run is not this run).
    const step1 = st.get(1)!;
    for (const line of step1.split("\n").filter((l) => /\bstop\b|End the run|end the run/.test(l))) {
      assert.ok(line.includes("window-check"), `${name}: step 1 exits only at window-check: ${line.trim()}`);
    }
    assert.ok(!st.get(2)!.includes("proposals list"), `${name}: proposals come after the scan`);
  }
  inOrder(section(skill("today").body, "Steps")!, ["safety scan-notes", "proposals list", "Today is already adjusted.", "node engine/cli.ts readiness"], "today");
  inOrder(section(skill("week").body, "Steps")!, ["safety scan-notes", "Apply merged proposals", "a new block is due", "node engine/cli.ts targets"], "week");
});

test("finding 2: no load progression after trim or recovery", () => {
  const loads = steps("today").get(8)!;
  assert.match(loads, /\*\*Loads\.\*\*/);
  assert.match(loads, /only when `hold_progression` in step 6's readiness output is false \(the decision is `none` or `note`\)/);
  assert.match(loads, /Skip it when `hold_progression` is true \(`trim`, `recovery` or `propose_deload`\)/);
});

test("finding 3: setup initializes the hold file before the audit and any write", () => {
  const text = section(skill("setup").body, "Steps")!;
  inOrder(text, ["node engine/cli.ts hold init", "**Audit.**", "**Write week 1**"], "setup");
  assert.doesNotMatch(text, /no file means no hold/, "a missing hold file fails the guard");
});

test("finding 5: proposal replay reads the §20 evidence first, and week reads history before step 3", () => {
  const apply = steps("today").get(3)!;
  inOrder(apply, ["get_training_context", "every date of that week", "under 15 minutes", "Make each write"], "today step 3");
  assert.ok(steps("week").get(2)!.includes("get_workout_history"), "week reads the history in step 2, before proposals");
  assert.match(steps("week").get(3)!, /§20 evidence reads/);
});

test("finding 6: week routes approval denies to a proposal, and changes the plan only for hard failures", () => {
  const classify = steps("week").get(9)!;
  assert.match(classify, /`deny` with `big: true`[^\n]*needs an approved proposal[^\n]*Do not change the plan\. Go to step 11/);
  assert.match(classify, /Any other `deny`[^\n]*hard rule[^\n]*fix the draft/);
  assert.match(steps("week").get(11)!, /\*\*Unattended:\*\*[^\n]*Make a proposal/);
});

test("finding 8: after open-pr, the proposal branch is committed and pushed before switching to main", () => {
  inOrder(steps("week").get(11)!, ["proposals open-pr", "git add athlete/proposals/<id>.yaml", "commit", "node engine/cli.ts push", "git switch main"], "week step 11");
});

test("finding 9: mark-applied only after check-applied confirms every write and read-back", () => {
  const apply = steps("today").get(3)!;
  inOrder(apply, ["Make each write", "Read each date the writes touch", "node engine/cli.ts proposals check-applied --id <id>", "prints `status: applied`", "node engine/cli.ts proposals mark-applied <id>"], "today step 3");
  assert.match(apply, /Otherwise do not mark it applied\*\* \(`partial` or `not-applied`\)\. Log the partial state/);
  assert.match(steps("week").get(3)!, /mark-applied` only after full success/);
});

test("finding 10: setup commits and pushes before automation, and sets mode and verified only after a confirmed run", () => {
  const text = section(skill("setup").body, "Steps")!;
  inOrder(text, ["node engine/cli.ts install-git-hooks", "node engine/cli.ts push", "**Automation.**", "RemoteTrigger", "shows success: set `automation.mode: cloud` and `automation.verified: true`"], "setup");
  for (const line of text.split("\n").filter((l) => /set `automation\.mode: (cloud|mac)`|Set `automation\.mode: (cloud|mac)`/.test(l))) {
    assert.match(line, /success/, `mode is set only after a confirmed run: ${line.trim()}`);
  }
});

test("finding 13: every pain follow-up in check-in offers options", () => {
  const pain = steps("check-in").get(4)!;
  for (const q of ["Where?", "Which side?", "How bad"]) {
    const line = pain.split("\n").find((l) => l.includes(q));
    assert.ok(line && /A\) [^\n]*B\) /.test(line), `${q} has options`);
  }
  assert.match(pain, /not sure/);
});

// ---------- wiring round (contracts §21-§22, G evals) ----------

const claudeMd = readFileSync(join(REPO, "CLAUDE.md"), "utf8");

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
  assert.match(steps("setup").get(9)!, /node engine\/cli\.ts ids next --kind limit/);
  assert.match(steps("today").get(6)!, /node engine\/cli\.ts signals refresh/);
});

test("the safety agent always runs in the foreground, and its questions reach the user", () => {
  const handoff = /(run|hand off to|hand any current pain to)[^\n]*the `safety` agent/i;
  const docs = [...skills.map((s) => ({ name: s.name, text: s.text })), { name: "CLAUDE.md", text: claudeMd }];
  let count = 0;
  for (const d of docs) {
    for (const line of d.text.split("\n").filter((l) => handoff.test(l))) {
      count++;
      assert.match(line, /in the foreground/, `${d.name}: the safety agent runs in the foreground: ${line.trim()}`);
      assert.match(line, /never as a background agent/, `${d.name}: ${line.trim()}`);
      assert.match(line, /word for word/, `${d.name}: its questions are relayed word for word: ${line.trim()}`);
      assert.match(line, /`run_in_background: false`/, `${d.name}: the call sets run_in_background: false: ${line.trim()}`);
    }
    assert.doesNotMatch(d.text, /run_in_background: true|in the background\b(?! agent)/, `${d.name}: no background safety run`);
  }
  assert.ok(count >= 7, `every hand-off is checked (found ${count})`);
  for (const name of ["today", "week"]) {
    assert.match(steps(name).get(2)!, /unattended: ask nothing[^\n]*\n?[^\n]*node engine\/cli\.ts hold set/i, `${name}: unattended runs set the hold instead of asking`);
  }
  assert.match(claudeMd, /In an unattended run, ask nothing: set the hold with `node engine\/cli\.ts hold set`/);
});

test("today exits as already adjusted only when oplog done says so", () => {
  const read = steps("today").get(4)!;
  inOrder(read, ["node engine/cli.ts oplog done --date <today> --kind <kind>", "`status: done`", "Today is already adjusted.", "`status: uncertain`", "`reread`"], "today step 4");
  assert.doesNotMatch(read, /log already has an entry/, "the log heading is not a record of success");
});

test("setup writes every planned week-1 day from block draft and checks the count", () => {
  const w1 = steps("setup").get(14)!;
  inOrder(w1, ["every planned day of week 1", "`block draft`", "planned count", "**Check the count.**", "write it once more", "do not try again"], "setup step 14");
  assert.match(steps("setup").get(5)!, /sleep_target_min/);
  assert.match(steps("block").get(10)!, /compare the count of written days with the drafted days/);
});

test("athlete/.safety-pending is committed: not gitignored, and CLAUDE.md says so", () => {
  const r = spawnSync("git", ["check-ignore", "-q", "athlete/.safety-pending"], { cwd: REPO });
  assert.equal(r.status, 1, ".gitignore must not cover athlete/.safety-pending");
  assert.match(claudeMd, /`athlete\/\.safety-pending` is committed/);
  // The entry is a built-ins bootstrap; the commit check itself is in the body module.
  const hook = readFileSync(join(REPO, ".claude/hooks/commit-check.body.ts"), "utf8");
  assert.match(hook, /athlete\/\.safety-pending is committed like the other athlete files/);
});

// ---------- one adjustment kind a day, red days and the unattended block end ----------

test("today step 8: no load progression on a day a proposal changed", () => {
  const loads = steps("today").get(8)!;
  assert.match(loads, /Skip it when step 3 applied a proposal with a write for today/);
  assert.match(skill("today").body, /An applied proposal for today is today's adjustment/);
});

test("today acts on the engine's patterns: a note for one day, a trim on the short pattern, recovery on aversion", () => {
  const decide = steps("today").get(7)!;
  assert.match(decide, /`note` \(one day is not a pattern \[NA-REC-008\]\)/);
  assert.match(decide, /`trim` \(the short pattern: 3 or more off-mornings in a row \[NA-REC-009\]\)[^\n]*Progression is held/);
  assert.match(decide, /`recovery` with `aversion: true`/);
  assert.match(decide, /Interactive: ask "You do not want to train today\.[^"]*A\) make today a recovery day, B\) keep the session as planned"/);
  assert.match(decide, /Unattended: swap to recovery with `adjust`\. A recovery day is the safer change, so it is always allowed\./);
  assert.match(decide, /`propose_deload`[^\n]*trim today with `adjust`[^\n]*the `week` run proposes it/);
  const loads = steps("today").get(8)!;
  assert.match(loads, /One off day is not a pattern: with `hold_progression: false`, run this step as usual/);
  assert.doesNotMatch(skill("today").body, /2 of the last 3 days|pattern\.hold_progression/, "R1's rule is gone");
  assert.match(steps("today").get(10)!, /Give no targets and no advice on food or supplements/);
});

test("check-in asks the optional want-to-train item with options and passes it to the engine", () => {
  const ask = steps("check-in").get(3)!;
  assert.match(ask, /Want to train: "How much do you want to train today\? 1 I do not want to train at all … 5 I really want to train"/);
  assert.match(ask, /"F\) skip"/);
  assert.match(steps("check-in").get(5)!, /\[--want-to-train <n>\]/);
});

test("week proposes a program change only on the deload signal: interactive asks, unattended opens a proposal PR", () => {
  const review = steps("week").get(6)!;
  assert.match(review, /node engine\/cli\.ts readiness --date <today>/);
  assert.match(review, /`deload_signal: true`/);
  assert.match(review, /\*\*Interactive:\*\*[^\n]*Ask "A\) make next week a deload week, B\) plan a new block, C\) keep the plan"/);
  assert.match(review, /\*\*Unattended:\*\* never write it\. Make a `new_block` proposal for an early deload, with no Tally write[^\n]*`block` skill's Unattended steps 4 to 9/);
  assert.doesNotMatch(review, /3 or more days in the last 7 show all 3 categories/);
});

test("an unattended block end drafts the block and opens a new_block proposal PR, with no Tally write", () => {
  const week4 = steps("week").get(4)!;
  assert.match(week4, /interactive, run the `block` skill/);
  assert.match(week4, /Unattended, follow the `block` skill's Unattended section/);
  assert.doesNotMatch(week4, /commit, push and stop\. A new block needs/);
  const un = section(skill("block").body, "Unattended")!;
  inOrder(
    un,
    [
      "node engine/cli.ts hold status",
      "node engine/cli.ts ids next --kind block",
      "node engine/cli.ts block draft",
      "`audit` skill",
      "get_planned_workout",
      '"kind": "new_block"',
      "`base`",
      "node engine/cli.ts proposals create",
      "git switch -c proposal/<id>",
      "node engine/cli.ts block write",
      "athlete/block.yaml",
      "node engine/cli.ts proposals approve-copy <id>",
      "node engine/cli.ts push",
      "node engine/cli.ts proposals open-pr <id>",
      "git switch main",
      "a new block is due: proposal <id>",
    ],
    "block Unattended",
  );
  assert.match(un, /No Tally write/);
  assert.match(steps("block").get(1)!, /Unattended: follow the Unattended section/);
});

// ---------- launch review finding 5: generic logger notes by default ----------

test("launch review finding 5: today writes generic logger notes by default; detail only with consent.logger_health_notes", () => {
  const today = skills.find((s) => s.name === "today")!;
  const notes = section(today.body, "Notes to the logger");
  assert.ok(notes, "today has a Notes to the logger section");
  for (const g of ["Readiness note", "Adjusted for recovery", "Recovery day", "Rest day: see your coach repo", "Load progression"]) assert.ok(notes.includes(g), g);
  assert.match(notes, /Never put symptoms, body regions, pain scores, readiness values/);
  assert.match(notes, /consent\.logger_health_notes: true/);
  // The decision step no longer puts the detailed reasons into Tally without consent.
  assert.doesNotMatch(today.body, /The reason line is `\[coach\] <decision_reasons>/);
  assert.doesNotMatch(today.body, /`annotate` \(the hold reason\)/);
  assert.doesNotMatch(today.body, /the reason with its rule IDs in `notes`/);
  const md = readFileSync(join(REPO, "CLAUDE.md"), "utf8");
  assert.match(md, /generic note/);
  assert.match(md, /consent\.logger_health_notes: true/);
});

test("launch review finding 5: setup's consent text is accurate and asks separately for detailed logger notes", () => {
  const setup = skills.find((s) => s.name === "setup")!;
  assert.doesNotMatch(setup.text, /no health data/i, "the old consent text said Tally gets no health data");
  assert.match(setup.text, /Tally: your plans, your workout history, and a short coach note/);
  assert.match(setup.text, /Detailed notes in Tally:[^\n]*A\) no, keep the notes generic \(recommended\), B\) yes/);
  assert.match(setup.text, /consent\.logger_health_notes: false` \(A\) or `true` \(B\)/);
  assert.match(readFileSync(join(REPO, "coach.example.yaml"), "utf8"), /logger_health_notes: false/);
});

test("launch review finding 8: the README claims a timestamp only where the source pins one", () => {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  assert.doesNotMatch(readme, /a link and a timestamp for each sourced rule/);
  assert.match(readme, /with a timestamp where the source pins one; rules marked approximate cite the episode only/);
  assert.match(readme, /Rules marked `policy` are the pack's own choices/);
  // The premise: some sourced rules are approximate.
  assert.match(readFileSync(join(REPO, "methods/nine-adaptations/rules.yaml"), "utf8"), /precision: approximate/);
});

// ---------- eval re-run addendum B and C ----------

test("B1: every agent call in the skills runs in the foreground with run_in_background: false", () => {
  const call = /\b(run|hand off to|hand any current pain to)\b[^\n]*the `(safety|method-expert|analyst)` agent/i;
  let count = 0;
  for (const s of skills) {
    for (const line of s.text.split("\n").filter((l) => call.test(l))) {
      count++;
      assert.match(line, /`run_in_background: false`/, `${s.name}: ${line.trim()}`);
    }
  }
  assert.ok(count >= 10, `every agent call is checked (found ${count})`);
  assert.match(skills.find((s) => s.name === "audit")!.text, /Run the `method-expert` agent in the foreground \(`run_in_background: false`/);
  assert.match(claudeMd, /`run_in_background: false`/);
  assert.match(claudeMd, /Every other agent call runs in the foreground too/);
});

test("C: the safety agent ends with a copy-exactly question block, and every hand-off pastes it as a quoted block", () => {
  const agent = readFileSync(join(REPO, ".claude/agents/safety.md"), "utf8");
  const output = agent.slice(agent.indexOf("## Output"));
  assert.match(output, /end your output with this marked block/);
  assert.match(output, /Questions for the athlete \(copy exactly\):\n1\. <question> <options/);
  assert.match(output, /pastes the block word for word, as a quoted block, and does not reword it/);
  const handoff = /(run|hand off to|hand any current pain to)[^\n]*the `safety` agent/i;
  for (const d of [...skills.map((s) => ({ name: s.name, text: s.text })), { name: "CLAUDE.md", text: claudeMd }]) {
    for (const line of d.text.split("\n").filter((l) => handoff.test(l) && /questions|word for word/.test(l))) {
      if (/urgent-care text/.test(line)) continue;
      assert.match(line, /paste its "Questions for the athlete \(copy exactly\):" block to the user word for word, as a quoted block: do not reword it, and add nothing that changes its meaning/, `${d.name}: ${line.trim()}`);
    }
  }
  assert.match(claudeMd, /paste its "Questions for the athlete \(copy exactly\):" block/);
});
