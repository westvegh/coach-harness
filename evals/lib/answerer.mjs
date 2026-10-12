#!/usr/bin/env node
// The scripted athlete for AskUserQuestion (v0.2 friction evals). A PreToolUse hook that
// the runner adds with `--settings` (matcher AskUserQuestion). It answers each question
// from the scenario's scripted answers and returns `permissionDecision: "allow"` with
// `updatedInput` = the original `questions` plus `answers` (code.claude.com hooks, "allow
// with updatedInput"), so the tool runs without a prompt.
//
// EVAL_ANSWERS: path to a JSON list of {question: regex on the question text, answer:
// regex on an option label, or a list of them (single choice: the first that matches an
// option; multiSelect: every one that does), typed?: free text}. The
// first rule whose `question` matches wins. A question with no rule, or with no option
// that matches, is unanswered: the hook denies the call, and the run fails its check.
// EVAL_ANSWER_LOG: one JSON line per call (a screen): the questions, the answers, the
// clicks (option labels chosen) and the typed answers.
import { appendFileSync, readFileSync } from "node:fs";

/** Answers one AskUserQuestion input. Pure: the hook entry below and the tests use it. */
export function answer(input, rules) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const answers = {};
  const unanswered = [];
  let clicks = 0;
  let typed = 0;
  for (const q of questions) {
    const text = String(q?.question ?? "");
    const labels = (Array.isArray(q?.options) ? q.options : []).map((o) => String(o?.label ?? ""));
    const rule = rules.find((r) => new RegExp(r.question, "i").test(text));
    if (!rule) {
      unanswered.push(text);
      continue;
    }
    if (typeof rule.typed === "string") {
      answers[text] = rule.typed;
      typed++;
      continue;
    }
    const wants = Array.isArray(rule.answer) ? rule.answer : [rule.answer];
    const chosen = [];
    // Single choice: the first pattern that matches an option. Multi-select: every pattern that does.
    for (const w of wants) {
      const hit = labels.find((l) => new RegExp(w, "i").test(l) && !chosen.includes(l));
      if (!hit) continue;
      chosen.push(hit);
      if (!q?.multiSelect) break;
    }
    if (chosen.length === 0) {
      unanswered.push(text);
      continue;
    }
    answers[text] = chosen.join(", ");
    clicks += chosen.length;
  }
  return { answers, unanswered, clicks, typed };
}

function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let event = {};
    try {
      event = JSON.parse(raw);
    } catch {
      /* no input: deny below */
    }
    const input = event.tool_input ?? {};
    let rules = [];
    try {
      rules = JSON.parse(readFileSync(process.env.EVAL_ANSWERS ?? "", "utf8"));
    } catch {
      rules = [];
    }
    const r = answer(input, rules);
    const questions = (input.questions ?? []).map((q) => ({ question: q.question, header: q.header, multiSelect: !!q.multiSelect, options: (q.options ?? []).map((o) => o.label) }));
    if (process.env.EVAL_ANSWER_LOG) appendFileSync(process.env.EVAL_ANSWER_LOG, JSON.stringify({ at: new Date().toISOString(), questions, ...r }) + "\n");
    const out =
      r.unanswered.length === 0 && questions.length > 0
        ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input, answers: r.answers } } }
        : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `The athlete did not answer this screen (eval: no scripted answer for: ${r.unanswered.join(" | ") || "an empty screen"}).` } };
    process.stdout.write(JSON.stringify(out) + "\n");
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
