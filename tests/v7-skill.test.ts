// V7: the today skill follows the call schedule, and every engine command it names is on the
// project's allow list (so the athlete sees no permission prompt).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const skill = readFileSync(join(REPO, ".claude/skills/today/SKILL.md"), "utf8");
const steps = skill.slice(skill.indexOf("## Steps"));
const allow: string[] = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf8")).permissions.allow;

const inOrder = (text: string, parts: string[]) => {
  let at = -1;
  for (const p of parts) {
    const i = text.indexOf(p, at + 1);
    assert.ok(i > at, `"${p}" in order`);
    at = i;
  }
};

test("the schedule: pre with the ToolSearch, the reads in one message, post, the write step, save, the report", () => {
  inOrder(steps, ["node engine/cli.ts today-brief --stage pre", "`ToolSearch`", "Interactive: send it in the same message as pre", "Unattended: after pre returns in the window", "in **one message** (parallel tool calls)", "node engine/cli.ts today-brief --stage post", "**More reads**", "node engine/cli.ts today-write-prep --input .tmp/coach/write.json", "Read today again with `get_planned_workout` (the read-back)", "node engine/cli.ts save --run <run_id>", "**The report**"]);
  assert.match(steps, /Do not Read `coach\.yaml`, `athlete\/brief\.md`, the adapter file or the log for this skill: pre carries what the skill needs from them\. Read in full every file in pre's `limits_sources`[^\n]*only when `limits_text_truncated` is true[^\n]*post's `limits_freshness\.changed_since_pre` is true/);
  assert.match(skill, /Never skip a read, a read-back, consent or safety work to save a call\. Incomplete safety data is unknown, and unknown safety means no training write\./);
  assert.match(steps, /When a read that safety needs \(the history, today's day\) is in `gave_up`, safety is unknown/);
  assert.match(skill, /\(never run `date`\)/);
});

/** Whether a command line matches one of the Bash allow rules. */
function allowed(cmd: string): boolean {
  return allow.some((r) => {
    const m = /^Bash\((.*)\)$/.exec(r);
    if (!m) return false;
    const rule = m[1];
    return rule.endsWith(" *") ? cmd.startsWith(rule.slice(0, -1)) : cmd === rule;
  });
}

test("every engine command the today skill tells the model to run is allowlisted", () => {
  const cmds = [...skill.matchAll(/`(node engine\/cli\.ts [^`]+)`/g)].map((m) => m[1].trim());
  // Commands quoted only as the code each post field runs ("the result of …") are not run by the model.
  const run = cmds.filter((c) => /^node engine\/cli\.ts (today-brief|today-write-prep|save|checkin|plans write --|plans read --|logger set|urgent clear)/.test(c));
  assert.ok(run.length >= 6, run.join(" | "));
  for (const c of run) assert.ok(allowed(c.replace(/<[^>]+>/g, "x")), c);
});
