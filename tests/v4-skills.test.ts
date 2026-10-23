// V4 (setup polish): static checks on the skills and CLAUDE.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(REPO, p), "utf8");
const skill = (name: string) => read(`.claude/skills/${name}/SKILL.md`);
const claudeMd = read("CLAUDE.md");

/** The text of "## <name>" up to the next "## ". */
function section(text: string, name: string): string {
  const i = text.indexOf(`\n## ${name}\n`);
  assert.ok(i >= 0, `section ${name}`);
  const rest = text.slice(i + name.length + 5);
  const j = rest.indexOf("\n## ");
  return j < 0 ? rest : rest.slice(0, j);
}

/** Numbered steps of the Steps section: n → text. */
function steps(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const st = section(text, "Steps");
  const parts = st.split(/\n(?=\d+\. \*\*)/);
  for (const p of parts) {
    const m = /^(\d+)\. /.exec(p.trim());
    if (m) out.set(Number(m[1]), p);
  }
  return out;
}

type Q = { question: string; options: string[]; dynamic: boolean; line: string };

/** Every `"<question>?" with <options>` in a text, with its written options (quoted, before the sentence ends). */
function questions(text: string): Q[] {
  const out: Q[] = [];
  for (const line of text.split("\n")) {
    const ms = [...line.matchAll(/"([^"\n]+\?)" with /g)];
    ms.forEach((m, k) => {
      const rest = line.slice(m.index! + m[0].length, k + 1 < ms.length ? ms[k + 1].index : line.length);
      const options: string[] = [];
      let i = 0;
      let depth = 0;
      while (i < rest.length) {
        const c = rest[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === '"' && depth === 0) {
          const end = rest.indexOf('"', i + 1);
          options.push(rest.slice(i + 1, end));
          i = end + 1;
          continue;
        } else if (c === "." && depth === 0 && (rest[i + 1] === " " || i === rest.length - 1)) break;
        i++;
      }
      out.push({ question: m[1], options, dynamic: /one option per|one per server|by name and folder/.test(rest.slice(0, 120)), line });
    });
  }
  return out;
}

test("D: every question in setup has two to four written options and no written \"Other\" option", () => {
  const qs = questions(section(skill("setup"), "Steps"));
  assert.ok(qs.length >= 15, `${qs.length} questions found`);
  for (const q of qs) {
    assert.ok(!q.options.includes("Other"), `${q.question}: a written "Other" option`);
    if (q.dynamic) {
      assert.match(q.line, /at most four|by name and folder|one option per file/, `${q.question}: a bounded dynamic list`);
      continue;
    }
    assert.ok(q.options.length >= 2 && q.options.length <= 4, `${q.question}: ${q.options.length} options (${q.options.join(" | ")})`);
  }
  // The history question: the newest export (dynamic) plus three written options, so four at most.
  const h = qs.find((q) => q.question === "Do you have a record of your recent training?")!;
  assert.deepEqual(h.options, ["Export from another app", "Answer two quick questions", "Skip"]);
});

test("D: each setup screen has one to four questions", () => {
  const st = steps(skill("setup"));
  const count = (t: string) => questions(t).length;
  assert.equal(count(st.get(2)!), 4, "Basics");
  assert.equal(count(st.get(3)!), 1, "Goal");
  assert.equal(count(st.get(4)!), 4, "Health check");
  const plans = st.get(5)!;
  const main = plans.slice(0, plans.indexOf("- The answers:"));
  assert.ok(count(main) >= 1 && count(main) <= 4, `Plans and data: ${count(main)}`);
  const quick = plans.split("\n").find((l) => l.includes("screen: Quick questions"))!;
  assert.equal(count(quick), 2, "both quick questions on one screen");
  const w1 = st.get(7)!.split("\n").find((l) => l.includes("Week 1 is ready"))!;
  assert.equal(count(w1), 1, "Week 1 approval");
});

test("D: setup without Tally on request: no Tally call, no allow-server for Tally, files with no question when files are the only place", () => {
  const s = skill("setup");
  const rule = section(s, "Tally, or no Tally");
  assert.match(rule, /The athlete says they do not use Tally[^\n]*treat it as "no Tally server answered"\. Call no Tally tool, run no `allow-server` for Tally, read no Tally history/);
  assert.match(rule, /when files are the only place \(no other connected tool\), choose files with no question; with a connected tool, ask it with only real options[^\n]*no Tally option/);
  assert.match(steps(s).get(1)!, /\*\*Find Tally\*\* \(skip it when the athlete does not use Tally/);
  assert.match(steps(s).get(5)!, /When the athlete does not use Tally: no question when files are the only place; with a connected tool, the same question without the Tally option\./);
});

test("C: the history paths: export steps (Strong, Hevy, Fitbod), the rescan of new or changed exports, the quick questions, JEFIT and Apple Health not offered", () => {
  const p = steps(skill("setup")).get(5)!;
  const app = questions(p).find((q) => q.question === "Which app has your training?")!;
  assert.deepEqual(app.options, ["Strong", "Hevy", "Fitbod"]);
  assert.match(p, /JEFIT, or Apple Health, which exports XML[^\n]*"I can't read that app's export yet\." and go to the quick questions/);
  assert.match(p, /Strong: "In Strong, open Settings, then Export Strong Data/);
  assert.match(p, /Hevy: "In Hevy, open Profile, then Settings, then Export & Import Data/);
  assert.match(p, /Fitbod or another app: "Open the app's settings, find Export, choose CSV, and save the file to Downloads\."/);
  assert.deepEqual(questions(p).find((q) => q.question === "Is the file in Downloads or on the Desktop?")!.options, ["Yes, read it", "Skip for now"]);
  assert.match(p, /run `node engine\/cli\.ts history-files` again and keep only the exports that are new or changed since the step 1 list/);
  assert.match(p, /One: read it\. Two or more: ask "Which file is your training\?"[^\n]*None: ask "I don't see a new export yet\. Look again\?" with "Look again", "Skip"/);
  const quick = questions(p).filter((q) => /How long have you trained|How many days a week have you trained/.test(q.question));
  assert.deepEqual(quick.map((q) => q.options), [["Under 1 year", "1 to 3 years", "3+ years", "Skip"], ["0 to 1", "2 to 3", "4+", "Skip"]]);
  assert.match(p, /Write the answers in `athlete\/brief\.md` under "Training history"[^\n]*say so in "Why this week"/);
  assert.match(p, /\*\*Read an export:\*\* read only the file the athlete chose[^\n]*only its last 8 weeks\. Write `\.tmp\/coach\/history\.json`/);
  assert.match(read("templates/athlete/brief.md"), /- Days a week lately:/);
});

test("A7: setup and block use the fixed folder .tmp/coach/b1/ and the exact commands, in order; no hand-built week input", () => {
  for (const name of ["setup", "block"]) {
    const s = skill(name);
    const at = (t: string) => {
      const i = s.indexOf(t);
      assert.ok(i >= 0, `${name}: ${t}`);
      return i;
    };
    const order = [
      "node engine/cli.ts ids next --kind block",
      "--input .tmp/coach/b1/draft.json --out .tmp/coach/b1",
      "node engine/cli.ts loads --input .tmp/coach/b1/week-1.json --fill",
      "node engine/cli.ts volume --input .tmp/coach/b1/week-1.json",
      "node engine/cli.ts block write --input .tmp/coach/b1/block.json",
      "node engine/cli.ts plans write --input .tmp/coach/b1/week-1.json",
    ];
    const idx = order.map(at);
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, `${name}: commands in order`);
    assert.ok(at("node engine/cli.ts tally-days --input .tmp/coach/b1/week-1.json") > idx[4], `${name}: tally-days after block write`);
    for (const gone of ["loads.json", "week1.json", "Move the old `athlete/block.yaml`"]) assert.ok(!s.includes(gone), `${name}: ${gone}`);
  }
  assert.match(skill("block"), /write it as it is|printed input as it is/);
  assert.match(skill("setup"), /Write each printed input as it is, adding only/);
  assert.match(skill("audit"), /A draft's week file goes in as it is/);
});

test("A9: CLAUDE.md: no source reading in normal use; the Read tool, and grep or find in Bash for search", () => {
  assert.ok(claudeMd.includes("In normal use, do not read engine source or `docs/contracts.md`. `node engine/cli.ts help <command>` gives each input shape. Read source only when a command fails in a way its help does not explain."));
  assert.match(claudeMd, /This Claude Code version has no Glob or Grep tool\./);
  assert.doesNotMatch(claudeMd, /Read, Grep and Glob tools/);
  assert.match(skill("setup"), /\*\*No source reading\.\*\* Never read engine source or `docs\/contracts\.md`/);
});

test("B4: setup and block show \"Why this week\" (3 to 5 plain bullets) before the week table", () => {
  for (const name of ["setup", "block"]) {
    const s = skill(name);
    const why = s.indexOf("**Why this week");
    const table = name === "setup" ? s.indexOf("**The table.**") : s.indexOf("Week 1 in one table");
    assert.ok(why > 0 && table > why, `${name}: why before the table`);
    assert.match(s.slice(why, why + 600), /3 to 5 short bullets in plain words[^\n]*`why\.week`[^\n]*`progression`[^\n]*limits[^\n]*loads note[^\n]*preference/);
  }
});

test("E: preferences persist: CLAUDE.md rule, the brief template, and week, block, today and audit apply them", () => {
  assert.match(claudeMd, /When the athlete states a lasting preference \(a rep range, an exercise they like or dislike, a schedule, equipment\), write it in `athlete\/brief\.md` under "Preferences" and commit it\./);
  assert.match(claudeMd, /say so once when it is set, record "athlete chose", and then follow it without repeating the caution/);
  assert.match(read("templates/athlete/brief.md"), /## Preferences\n\n- Exercises the athlete likes:\n- Exercises the athlete dislikes:\n- Rep ranges and other choices:/);
  for (const name of ["week", "block", "today", "audit"]) assert.match(skill(name), /"Preferences" lines/, name);
  assert.match(skill("week"), /apply each "Preferences" line[^\n]*before the loads and the limits/);
  assert.match(skill("block"), /\*\*Preferences\.\*\* Apply each "Preferences" line[^\n]*week-1\.json/);
  assert.match(skill("audit"), /listed as "athlete chose"[^\n]*not a finding to fix/);
});

test("F1: setup ends with the Tally line after the closing line, with files or another tool only, without setting tally_mentioned", () => {
  const fin = steps(skill("setup")).get(8)!;
  const later = fin.indexOf("Later you can add recovery data");
  const tally = fin.indexOf("To log sets on your iPhone at the gym, try Tally: https://apps.apple.com/us/app/tally-workout-app/id6758911546. I read your sets back. Say 'switch to Tally' when you have it.");
  assert.ok(later > 0 && tally > later);
  assert.match(fin, /With `logger: files` or `other`, add one more line after it[^\n]*This line does not set `tally_mentioned`\./);
});

test("F3: setup with two Tally servers: the account question, then snapshot reset, the chosen server's reads from the first page, then the note scan", () => {
  const s = skill("setup");
  assert.match(section(s, "Tally, or no Tally"), /a server name is a connection, not an account\. Never decide by the names that two servers are the same account\./);
  const p = steps(s).get(5)!;
  const i = (t: string) => p.indexOf(t);
  const order = ["**The chosen Tally account**", "node engine/cli.ts snapshot reset", "`get_training_context`", "from the first page", "node engine/cli.ts safety scan-notes"].map(i);
  assert.ok(order.every((x) => x > 0) && [...order].sort((a, b) => a - b).join() === order.join(), JSON.stringify(order));
  assert.match(p, /check that its `server` is the chosen server and `sessions` matches the history/);
  assert.match(p, /Take the units from that account when it knows them/);
});

test("F5: every skill that reads the Tally history pages with limit: 10 and follows nextCursor (a larger page reaches the hook as a saved-file note)", () => {
  for (const name of ["setup", "today", "week", "audit", "explain"]) {
    const s = skill(name);
    for (const line of s.split("\n").filter((l) => /`get_workout_history`/.test(l) && !/limit: 2/.test(l))) {
      assert.match(line, /`limit: 10`/, `${name}: ${line.slice(0, 100)}`);
    }
  }
  assert.match(claudeMd, /`get_workout_history` with `limit: 10`, following `nextCursor`/);
});

test("V4b fix 2: week, block and setup write the week file (tally-days or plans write) only after its last change", () => {
  const rule = "Run `tally-days` (or `plans write`) only after the last change to the week file; after any later change, run it again.";
  for (const name of ["week", "block", "setup"]) assert.ok(skill(name).includes(rule), name);
  const w8 = steps(skill("week")).get(8)!;
  const at = (t: string) => w8.indexOf(t);
  assert.ok(at("loads --input <the week file> --fill") > at("volume --input <the week file>"), "loads after volume");
  assert.ok(at("**Follow every line of `athlete/limits.md`**") > at("--fill"), "the limits after loads");
  assert.ok(at("tally-days --input <the week file>") > at("**Follow every line of `athlete/limits.md`**"), "tally-days after the limits");
  const b = skill("block");
  assert.ok(b.indexOf("tally-days --input .tmp/coach/b1/week-1.json") > b.indexOf("each line of `athlete/limits.md` against every day"));
});

test("V4b fix 7: --history only for an export chosen in this session; block and week refresh the logged history before loads --fill", () => {
  const b = steps(skill("block")).get(7)!;
  assert.match(b, /First refresh the logged history: with Tally, read `get_workout_history`[^\n]*`limit: 10`[^\n]*with files, nothing to do/);
  assert.match(b, /Add `--history \.tmp\/coach\/history\.json` only when the athlete chose a new training export in this session[^\n]*never for an export from an earlier session/);
  const w = steps(skill("week")).get(8)!;
  assert.match(w, /first refresh the logged history[^\n]*No `--history` here/);
  assert.ok(!/--history/.test(w.replace("No `--history` here", "")), "week never passes --history");
  assert.match(skill("setup"), /`--history \.tmp\/coach\/history\.json` when an export was read in this setup/);
});
