---
name: audit
description: Audits a plan against the method pack's rules and the athlete's limits, and reports each finding with its rule ID or limit ID and source. Use it when the user says "check my plan", "audit my plan", "audit this week", "audit the block", "is my program OK?", "does this follow the method?", "review my training", or when the setup, block or week skill needs an audit before an approval. It runs the engine's volume, targets and limits check commands and reads the method's rules (the method-expert agent only for a long read). It changes nothing.
---

# Audit

An audit compares a plan with `methods/<method>/rules.yaml` and with `athlete/limits.yaml`. Every finding cites a rule ID (or a limit ID) and its source. The audit changes nothing: it reports, and the coach fixes.

## Where plans live

Read `coach.yaml logger` and follow CLAUDE.md "Where plans live". With `logger: files`, read a week with `node engine/cli.ts plans read --week <date>` (its `days` are the week's DayPlans for `volume` and `limits check`), and skip the history read: `weeks` reads the logged weeks in `plans/` by itself. With `logger: other`, read the days through that tool.

## Steps

1. **Scope.** Ask, if the user did not say: "What should I audit? A) next week, B) this week, C) the current block, D) a draft from this session".
2. **Read the plan.**
   - A block: `athlete/block.yaml` (or the draft).
   - A week: `get_planned_workout` for each date of that week (with `logger: files`: `node engine/cli.ts plans read --week <date>`), or the draft days.
   - The reference: `get_workout_history` from 8 weeks before today to yesterday (follow `nextCursor` to the last page). With `logger: files`, skip it.
3. **Engine numbers.**
   - Sets per muscle: write `{week: <WeekPlan>}` to `.tmp/coach/audit-week.json` and run `node engine/cli.ts volume --input .tmp/coach/audit-week.json`.
   - Targets and the reference week: `node engine/cli.ts weeks --from <block start> --to <today>`, then `node engine/cli.ts targets --input .tmp/coach/targets.json` (`{block, logs, today, target_week}`, with `logs` from `weeks`).
   - **Limits review** (advisory): write the week's days to `.tmp/coach/audit-week.json` (`{week}`) and run `node engine/cli.ts limits check --input .tmp/coach/audit-week.json`. Each finding names the limit, the day and the exercise: a banned exercise, a weekly set count over a cap, or a set over a load cap. An `unclassified` finding is an exercise the taxonomy does not know: judge it against the limits yourself.
   - Method lint, when the pack itself is in question: `node engine/cli.ts lint-methods --pack <method> --volume`.
4. **Check the rules.** Read `methods/<method>/rules.yaml` and the principle files the plan touches, and compare the plan and the step 3 numbers with each rule that applies. Cite `[ID]` and the source for each finding. Optional, for a long read (a whole block, or a new pack): run the `method-expert` agent in the foreground (`run_in_background: false`; never as a background agent) with the pack name, the plan, the step 3 outputs and the athlete's template and emphasis.
5. **Report.** One table: severity (hard / soft), rule `[ID]` or limit `L-NNN`, the finding, the numbers (with the command that made them), the source (`sources.md` key and timestamp, or "athlete/limits.yaml"), and the fix. A limits conflict is hard. Hard findings first. Say "No findings" when there are none.
6. **Next step** (interactive): "Fix the hard findings now? A) yes, B) show me the details, C) no". A fix goes through the skill that owns the plan (`week` or `block`).

## Writes

None. The audit reads only. Scratch inputs go to `.tmp/coach/` (gitignored).
