---
name: week
description: The weekly review and plan. It checks last week's adherence, progressions and readiness trend, gets next week's targets from the engine, drafts each day from the block template with history-based loads, classifies every change in code, writes the small changes and asks about (or proposes) the big ones. Use it when the user says "plan next week", "weekly review", "how did my week go?", "set up next week", "what's next week?", "Sunday planning", or for the scheduled weekly run ("Read .claude/skills/week/SKILL.md and follow it exactly"). In an unattended run, big changes become a proposal PR.
---

# Week

Plan next week (Monday to Sunday in the athlete's timezone) inside the current block.

Today is `local.date` in the step 1 `window-check` output (interactive, `TZ=<coach.yaml athlete.timezone> date +%F` also works). Put engine input files in `.tmp/coach/`.

## Steps

1. **Window and mode.**
   - Run `node engine/cli.ts window-check --kind weekly`. A nonzero exit means: stop, write nothing, end the run.
   - Run `node engine/cli.ts mode`. Read `adapters/loggers/tally/adapter.yaml` with the Read tool and note `capabilities.opId`. Unattended with `opId: false`: run `printenv CLAUDE_CODE_REMOTE`; a value means a cloud run that reports only.
2. **Safety.** This step runs before proposals, planning and every early exit.
   - Run `node engine/cli.ts hold status`.
   - Read the history with `get_workout_history`, `since` 8 weeks before today and `until` today (today's logged notes count). Follow `nextCursor` to the last page.
   - Run `node engine/cli.ts safety scan-notes --since <today minus 7 days>`. It scans the logged session notes of the past week, today's included, and writes the pending file on a match.
   - A pending safety file, interactive: run the `safety` agent first, in the foreground (`run_in_background: false`; never as a background agent). In the same turn, paste its "Questions for the athlete (copy exactly):" block to the user word for word, as a quoted block: do not reword it, and add nothing that changes its meaning, and wait for the answers.
   - A pending safety file, unattended: ask nothing. Set the hold: `node engine/cli.ts hold set --reason "pending safety check <today>: <terms>" --regions <the region: terms, if any>`. Leave the pending file.
   - A pending file or an active hold: plan no training increase. Write only rest or recovery days, or leave next week empty and say why.
   - `hold status` prints `urgent: true`: write no exercise at all, not even recovery. Leave next week empty and log why.
3. **Apply merged proposals.** Follow `today` step 3: all §20 evidence reads first (the week listing, every date of each touched week, the history from step 2, all under 15 minutes old), the `base` check, the writes, the result check and read-back, and `proposals mark-applied` only after full success.
4. **Block.** Read `athlete/block.yaml`. Find next week's block week (`start` plus whole weeks).
   - No block, or next week is past the block's last week: interactive, run the `block` skill. Unattended, follow the `block` skill's Unattended section: it drafts the next block, audits it and opens a `new_block` proposal PR, with no Tally write. It logs "a new block is due: proposal <id>". Then stop. A new block needs the athlete's yes: merging the PR.
5. **Read the evidence.** The guard needs all of it, under 15 minutes old, at each write:
   - `get_training_context` (the listing from today on).
   - `get_planned_workout` for every date of next week, empty dates too.
   - The history from step 2. Read it again (through today, every page) if it is more than 10 minutes old.
   - If more than 10 minutes pass before a write, read again.
6. **Review last week.**
   - Adherence: the planned sessions and the logged sessions, as counts from the history.
   - Progressions: the top set per main lift, from the history.
   - Readiness trend: the readiness lines in the last 7 log entries.
   - Program-change signal: run `node engine/cli.ts readiness --date <today>`. Report `pattern.days_of_decline` and `decision_reasons`. A change of program needs all three kinds of evidence over a long pattern: `deload_signal: true` (the `decision` is then `propose_deload`, or `recovery` on an aversion day) [NA-REC-011, NA-REC-003]. Without it, plan the week as usual.
   - Run `node engine/cli.ts weeks --from <the block's start> --to <today>`. Its `logs` are the logged weeks, Monday to Sunday. Report each `warnings` line: those sessions are unknown, not missed.
   - **Propose a program change** when `deload_signal` is true. A program change is big: it goes through approval.
     - **Interactive:** show the pattern and the reasons. Ask "A) make next week a deload week, B) plan a new block, C) keep the plan". A: draft next week as a deload (step 8, with `deload_weeks: [<next week's block week>]` in the draft input; the block's own deload week moves there). Write the revised `block` object to `athlete/block.yaml` first, then next week's days; the guard asks for each write. B: run the `block` skill. C: plan as usual, and log the choice. When next week is block week 1, offer only B and C.
     - **Unattended:** never write it. Make a `new_block` proposal for an early deload, with no Tally write: draft next week as a deload (step 8, with `deload_weeks: [<next week's block week>]` and the block's own `id`), then follow the `block` skill's Unattended steps 4 to 9 with that week's days and the revised `block` object. Use the summary "early deload: <days_of_decline> off-mornings with a low check-in and a performance drop (NA-REC-011)". Then stop. When next week is block week 1, follow the `block` skill's Unattended section instead.
7. **Targets.** Write `.tmp/coach/targets.json`: `{block, logs, today, target_week}`, with `logs` copied from the `weeks` output. Run `node engine/cli.ts targets --input .tmp/coach/targets.json`. It gives the sets per muscle after the cap, the week kind and the `load_factor`. Use these numbers only.
8. **Draft the days.**
   - Write `.tmp/coach/draft.json`: `{id, start, emphasis, targets, exercises}` from `athlete/block.yaml` (`targets`: block week 1's targets) and `exercises`: for each slot (`"<day>.<slot>"`), last week's exercise for that slot, else one you find with `search_exercises`. A new exercise outside the block's slots and the last 8 weeks of history is `new_exercise` (big).
   - Run `node engine/cli.ts block draft --weeks <the block's number of weeks> --input .tmp/coach/draft.json`. Take the entry in `weeks` whose `week` is next week's block week: its `days` are next week's plan. With `ready: false`, resolve each `unresolved` slot and run it again.
   - Compare that week's `sets_by_muscle` with the `targets` output of step 7. Where a muscle is above the capped target, remove sets from its slots and run `node engine/cli.ts volume --input .tmp/coach/week.json` (`{week}`) until no muscle is above. Never add sets above the targets.
   - Loads: write `.tmp/coach/loads.json` (`{exercises}` of each drafted day) and run `node engine/cli.ts loads --input .tmp/coach/loads.json`. Use its `suggestedWeight` values. For a deload week, `block draft` already scaled the loads.
   - Each drafted exercise becomes one Tally exercise: `exerciseId` and `name` as drafted, `suggestedSets` = the number of entries in its `sets`, `suggestedReps` and `suggestedWeight` from its first set.
   - Respect `athlete/limits.yaml` and any hold region: never place an exercise that a limit bans.
9. **Classify each day.** Write the tool call to `.tmp/coach/call.json` and run `node engine/cli.ts validate --tool <tool> --args .tmp/coach/call.json`. It prints `decision`, `reasons`, `kinds` and `big`. Your own label does not count.
   - A new day on an empty date built only from the block week's template slots is `block_session` (small).
   - `allow`: a small change. Go to step 10.
   - `ask` (interactive): a big change. Go to step 11.
   - `deny` with `big: true` and a reason that says the change "needs an approved proposal": the plan is valid but needs approval. Do not change the plan. Go to step 11 (a proposal).
   - `deny` with a reason "never allowed in an unattended run" (a day the user built or edited): leave that day as it is. Log it for the athlete.
   - Any other `deny` (no `kinds` in the output): a hard rule, a limit, safety or missing evidence failed. Read the missing data again, or fix the draft (fewer sets, another exercise), and validate again. Never work around it.
10. **Write the small changes.**
    - Empty date: `plan_workout_day` with `ifAbsent: true`.
    - A day exists: `update_planned_workout` with `expectedVersion` (preferred), or `plan_workout_day` with `expectedVersion` and `replace: true`.
    - Add `opId` from `node engine/cli.ts opid --date <date> --kind <kind> --input .tmp/coach/call.json` when `capabilities.opId` is true.
    - Read each day back with `get_planned_workout`.
    - Unattended cloud run with `opId: false`: write nothing; log the plan.
11. **Big changes.**
    - **Interactive:** show each big change (day, what changes, kinds, rule IDs). Ask "A) yes, write it, B) change it, C) skip it". After a yes, write it; the guard asks again for the exact call.
    - **Unattended:** never write it. Make a proposal:
      1. Write `.tmp/coach/proposal.json`: `{kind, summary, writes: [{tool, input}], base: {<date>: <version or null>}, rule_ids}`. `base` holds the version you read for each date, and `null` for a date that `get_planned_workout` found empty (the guard then requires it to be still empty).
      2. Run `node engine/cli.ts proposals create --input .tmp/coach/proposal.json`. It writes `athlete/proposals/<id>.yaml` with `status: proposed`. Commit it on `main` and run `node engine/cli.ts push`.
      3. Run `git switch -c proposal/<id>`. Run `node engine/cli.ts proposals approve-copy <id>`. Commit "proposal <id>: approved copy" and run `node engine/cli.ts push` (it sets the upstream of the new branch).
      4. Run `node engine/cli.ts proposals open-pr <id>`. It opens the PR with the REST API and writes `pr_url` into the proposal file.
      5. Still on `proposal/<id>`: `git add athlete/proposals/<id>.yaml`, commit "proposal <id>: PR link", and run `node engine/cli.ts push`. The branch must be clean before you switch.
      6. Run `git switch main`, alone (not joined to another command). The user approves by merging the PR (a merge commit, not a squash). The next scheduled run applies it.
12. **Log, commit and push.** The `log-writes` hook logs each Tally write. Append one weekly entry to `athlete/log/<YYYY-MM>.md`:
    ```
    ## <today> <HH:MM> · week <block week>
    - trigger: weekly run (cloud | mac) | user
    - adherence: <logged>/<planned> sessions
    - targets: <muscle sets from targets>
    - written: <dates and kinds>
    - proposed: <proposal ids and PR URLs, or none>
    ```
    Commit "week <week_start>: plan (<rule IDs>)". Run `git pull --rebase`, then `node engine/cli.ts push`. A nonzero exit means nothing was pushed: append "push skipped: <reason>" to the log entry and commit it locally.
13. **Tell the athlete** (interactive): next week in one table, last week's adherence, the targets, and what needs their yes.

## Writes

- Tally: next week's days with `plan_workout_day` (`ifAbsent: true` or `expectedVersion`) or `update_planned_workout` (`expectedVersion`); small kinds only without a yes.
- `athlete/proposals/<id>.yaml` (only through `proposals create` and `proposals approve-copy` on `proposal/<id>`), `athlete/log/<YYYY-MM>.md`, `.tmp/coach/*.json`.
- Git: commits on `main`, and the branch `proposal/<id>` with its PR.

## Unattended

- `window-check` runs first; outside the window, stop.
- Ask no questions. Small changes are written; big changes become a proposal PR (step 11).
- With `capabilities.opId: false`, a cloud run writes nothing to Tally; it logs the plan and still opens proposal PRs for big changes.
- Never merge a PR. Never write `status: approved` on `main`.
- Commit, `git pull --rebase`, and push with `node engine/cli.ts push`; also on `proposal/<id>`. It installs the git hooks and checks the destination first. A failed check means no push and a log entry; never run `git push` yourself.
