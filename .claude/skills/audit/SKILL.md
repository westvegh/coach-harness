---
name: audit
description: Audits a plan against the method pack's rules and the athlete's limits (athlete/limits.md, in plain words), and reports each finding with its rule ID or the limit line it quotes, and its source. Use it when the user says "check my plan", "audit my plan", "audit this week", "audit the block", "is my program OK?", "does this follow the method?", "review my training", or when the setup, block or week skill needs an audit before an approval. It runs the engine's volume and targets commands, reads the method's rules and judges the plan against each limit line (the method-expert agent only for a long read). It changes nothing.
---

# Audit

An audit compares a plan with `methods/<method>/rules.yaml` and with the athlete's limits in `athlete/limits.md`. Every finding cites a rule ID and its source, or quotes the limit line it is about. The audit changes nothing: it reports, and the coach fixes.

## Where plans live

Read `coach.yaml logger` and follow CLAUDE.md "Where plans live". With `logger: files`, read a week with `node engine/cli.ts plans read --week <date>` (its `days` are the week's DayPlans for `volume`), and skip the history read: `weeks` reads the logged weeks in `plans/` by itself. With `logger: other`, read the days through that tool.

## Steps

1. **Scope.** Ask, if the user did not say: "What should I audit? A) next week, B) this week, C) the current block, D) a draft from this session".
2. **Read the plan.**
   - A draft from this session: its week files (`.tmp/coach/b1/week-<n>.json` from `block draft --out`) go to the step 3 commands directly, as they are.
   - A block: `athlete/block.yaml` (or the draft's `.tmp/coach/b1/block.json`).
   - A week: `get_planned_workout` for each date of that week (with `logger: files`: `node engine/cli.ts plans read --week <date>`), or the draft days.
   - The reference: `get_workout_history` from 8 weeks before today to yesterday, with `limit: 10` (follow `nextCursor` to the last page). With `logger: files`, skip it.
3. **Engine numbers.**
   - Sets per muscle: `node engine/cli.ts volume --input <week file>`. A draft's week file goes in as it is. For a week read from Tally or `plans read`, write `{week: {week_start, days}}` to `.tmp/coach/audit-week.json` with the Write tool and pass that. List each entry of its `clusters` with its `text` (for example "6 × 6 cluster, counts as 3 sets") [NA-DES-010]. Each `session_max` entry is a soft finding [NA-DES-009], or "athlete chose" when a preference covers it.
   - Targets and the reference week: `node engine/cli.ts weeks --from <block start> --to <today>`, then `node engine/cli.ts targets --input .tmp/coach/targets.json` (`{block, logs, today, target_week}`, with `logs` from `weeks`).
   - **Limits review** (by judgment): Read `athlete/limits.md` in full. Check every day and exercise of the plan against each line: an exercise the line rules out, more sets a week than a number in the line (count the hard sets yourself from the plan, warm-ups left out, or use `volume` for a muscle), or a weight above a weight in the line (`node engine/cli.ts load-under` converts a unit). Use `node engine/cli.ts classify --exercise "<name>"` and `node engine/cli.ts regions` when you are not sure what an exercise loads. A line that is unclear: say so, and do not guess.
   - Method lint, when the pack itself is in question: `node engine/cli.ts lint-methods --pack <method> --volume`.
4. **Check the rules.** Read `methods/<method>/rules.yaml` and the principle files the plan touches, and compare the plan and the step 3 numbers with each rule that applies. Cite `[ID]` and the source for each finding. Optional, for a long read (a whole block, or a new pack): run the `method-expert` agent in the foreground (`run_in_background: false`; never as a background agent) with the pack name, the plan, the step 3 outputs and the athlete's template and emphasis.
   - **Preferences:** read the "Preferences" lines in `athlete/brief.md`. A plan that follows a recorded preference (a rep range, an exercise the athlete likes) is listed as "athlete chose", with the rule it departs from, and is not a finding to fix. A limit and the urgent stop still come first.
5. **Report.** One table: severity (hard / soft), rule `[ID]` or the limit line, quoted, the finding, the numbers (with the command that made them), the source (`sources.md` key and timestamp, or "your limits"), and the fix. A conflict with a limit line is hard. Hard findings first. A recorded preference shows as severity "athlete chose", after the findings. Say "No findings" when there are none.
6. **Next step** (interactive): "Fix the hard findings now? A) yes, B) show me the details, C) no". A fix goes through the skill that owns the plan (`week` or `block`).

## Writes

None. The audit reads only. Scratch inputs go to `.tmp/coach/` (gitignored).
