---
name: audit
description: Audits a plan against the method pack's rules and reports each finding with its rule ID and source. Use it when the user says "check my plan", "audit my plan", "audit this week", "audit the block", "is my program OK?", "does this follow the method?", "review my training", or when the setup, block or week skill needs an audit before an approval. It runs the method-expert agent (read-only) plus the engine's volume and validate commands. It changes nothing.
---

# Audit

An audit compares a plan with `methods/<method>/rules.yaml`. Every finding cites a rule ID and its source. The audit changes nothing.

## Steps

1. **Scope.** Ask, if the user did not say: "What should I audit? A) next week, B) this week, C) the current block, D) a draft from this session".
2. **Read the plan.**
   - A block: `athlete/block.yaml` (or the draft).
   - A week: `get_planned_workout` for each date of that week, or the draft days.
   - The reference: `get_workout_history` from 8 weeks before today to yesterday (follow `nextCursor` to the last page).
3. **Engine numbers.**
   - Sets per muscle: write `{week: <WeekPlan>}` to `.tmp/coach/audit-week.json` and run `node engine/cli.ts volume --input .tmp/coach/audit-week.json`.
   - Targets and the reference week: `node engine/cli.ts weeks --from <block start> --to <today>`, then `node engine/cli.ts targets --input .tmp/coach/targets.json` (`{block, logs, today, target_week}`, with `logs` from `weeks`).
   - For each planned day write that is not yet in Tally: `node engine/cli.ts validate --tool plan_workout_day --args .tmp/coach/call.json`. It runs the guard's limits and hard rules and prints `rule_ids` and `warnings`.
   - Method lint, when the pack itself is in question: `node engine/cli.ts lint-methods --pack <method> --volume`.
4. **Method expert.** Run the `method-expert` agent in the foreground (`run_in_background: false`; never as a background agent): a background report comes back as a notification that the safety detector could misread. Give it: the pack name, the plan (as JSON or a table), the engine outputs from step 3, and the athlete's template and emphasis. It returns findings with `[ID]` and the source.
5. **Report.** One table: severity (hard / soft), rule `[ID]`, the finding, the numbers (with the command that made them), the source (`sources.md` key and timestamp), and the fix. Hard findings first. Say "No findings" when there are none.
6. **Next step** (interactive): "Fix the hard findings now? A) yes, B) show me the details, C) no". A fix goes through the skill that owns the plan (`week` or `block`).

## Writes

None. The audit reads only. Scratch inputs go to `.tmp/coach/` (gitignored).
