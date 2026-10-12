---
name: block
description: Plans a new training block (usually 5 build weeks and a deload week) from the method's assessments, the template and the athlete's goals, audits it against the method rules, gets the athlete's yes, writes athlete/block.yaml and then week 1 to Tally. Use it when the user says "new block", "plan my next block", "start a new phase", "the block is over", "change my program", "switch to 3/4/5 days", "change my emphasis", or when the session context says a new block is due. A new block is always a big change, so it needs the athlete's yes.
---

# Block

A block is the plan for the next 4 to 8 weeks: the weekly frame, the week kinds and the sets per muscle. It follows `engine/types.ts Block` (contracts §16.5).

Today is `TZ=<coach.yaml athlete.timezone> date +%F`, or in an unattended run `local.date` in the `window-check --kind weekly` output. Put engine input files in `.tmp/coach/`.

## Steps

1. **Mode and safety.** Run `node engine/cli.ts mode`. Unattended: follow the Unattended section instead of these steps. Run `node engine/cli.ts hold status`. A pending file or an active hold: run the `safety` agent first, in the foreground (`run_in_background: false`; never as a background agent). In the same turn, ask its questions with the AskUserQuestion tool (CLAUDE.md hard rule 1); without that tool, paste its "Questions for the athlete (copy exactly):" block to the user word for word, as a quoted block: do not reword it, and add nothing that changes its meaning. An AskUserQuestion call that returns no answers (denied, failed or not available) means the athlete was not asked; paste the copy-exactly block in the same reply. Under a hold, plan no new block until it is cleared.
2. **Assessments.** Read `methods/<method>/assessments.md`. Ask "Run the assessment week first? A) yes, B) use my recent results, C) skip this time".
   - A: plan the test week from `assessments.md` (fresh tests first, fatiguing tests last). Write it as `test` week days, in the same way as step 8.
   - B: ask for the recent results, one test at a time, with the units.
   - Record the results in `athlete/brief.md` under "Best recent lifts or tests". Compare with the athlete's own earlier results, not with norms.
3. **Goals and frame.** Read `athlete/brief.md` and `coach.yaml template`. Ask "Keep <days> days a week and the <emphasis> emphasis? A) yes, B) change days, C) change emphasis". A change of days or emphasis is a `method_change`: it needs this yes, and it updates `coach.yaml template` after the yes.
4. **Exercises.** Read `methods/<method>/templates/<days>-day.yaml`. For each slot (`"<day>.<slot>"`), choose an exercise for its pattern: keep the athlete's current exercise when there is one, else find one with `search_exercises`. Never choose one that a limit in `athlete/limits.yaml` bans.
5. **Draft.** Get the block id with `node engine/cli.ts ids next --kind block`. Write `.tmp/coach/draft.json`: `{id, start (the next Monday), emphasis, exercises, loads?}`; add `targets` only when the athlete chose other week-1 sets. Run `node engine/cli.ts block draft --weeks <n> --input .tmp/coach/draft.json`, with `n` from `deload_every_weeks` in `methods/<method>/rules.yaml` ([NA-PROG-005]; 6 gives 5 build weeks and a deload). Add a test week first when step 2 chose A.
   - The engine does the arithmetic: slot sets (emphasis, rounding, minimums), the weekly step capped by [NA-PROG-001], and the deload sets and loads ([NA-PROG-006]). Use its numbers only.
   - With `ready: false`, choose an exercise for each `unresolved` slot and run it again.
   - Read its `warnings` (for example a muscle that a 1-set minimum puts above its target) and show them.
6. **Targets.** Each entry in `weeks` holds `targets`, `sets_by_muscle` and `days`. The `block` object is the `athlete/block.yaml` content. Do not add up sets yourself.
7. **Audit.** Run the `audit` skill on the draft block and week 1 (give it each week's `sets_by_muscle`). Fix every hard finding. List the soft findings.
8. **Approval.** Show the block: the frame (days and focus), the week kinds, the targets per muscle, the audit result, and week 1 in a table. Ask "A) yes, write the block and week 1, B) change something, C) not now".
9. **Write the block.** `athlete/block.yaml` is protected: the guard asks the athlete for each write. After a yes, move the old `athlete/block.yaml` (if it has an id) to `athlete/blocks/<old id>.yaml`. Write the `block` object from `block draft` to `athlete/block.yaml`, as printed. Commit "block <id>: <days>-day <emphasis>, start <date> (<rule IDs>)".
10. **Write week 1** (or the test week): every day in the `days` of that `block draft` week. For each day:
    - Read `get_training_context`, `get_planned_workout` for every date of that week (empty dates too), and `get_workout_history` from 8 weeks before today to today (follow `nextCursor` to the last page). All reads must be under 15 minutes old at each write.
    - Loads: write `.tmp/coach/loads.json` (`{exercises}` of the drafted day) and run `node engine/cli.ts loads --input .tmp/coach/loads.json`. Use its `suggestedWeight` values.
    - Each drafted exercise becomes one Tally exercise: `exerciseId` and `name` as drafted, `suggestedSets` = the number of entries in its `sets`, `suggestedReps` and `suggestedWeight` from its first set.
    - Empty date: `plan_workout_day` with `ifAbsent: true`. A day exists: ask "Replace it? A) yes, B) no"; after a yes, `plan_workout_day` with `expectedVersion` and `replace: true`.
    - Add `opId` from `node engine/cli.ts opid --date <date> --kind new_block --input .tmp/coach/call.json` when `adapters/loggers/tally/adapter.yaml` says `capabilities.opId: true`.
    - The guard asks for the exact call (a new block is big). Read the day back.
    - After the last day, read every date of the week back and compare the count of written days with the drafted days. Write a missing day once more; if it is still missing, tell the user the date and the reason.
11. **Log, commit and push.** Append a log entry `## <today> <HH:MM> · block <id>` with the frame, the targets and the rule IDs. Commit and push to `main`.

## Writes

- `athlete/block.yaml` and `athlete/blocks/<old id>.yaml` (the previous block) (interactive yes only).
- `athlete/proposals/<id>.yaml` (unattended, through `proposals create`), `athlete/brief.md` (test results), `athlete/log/<YYYY-MM>.md`, `.tmp/coach/*.json`.
- `coach.yaml` `template` key, only after a yes to a frame change.
- Tally: the first week with `plan_workout_day` (`ifAbsent: true`, or `expectedVersion` after a yes).
- Git: commits on `main`. Unattended: the proposal on `main`, and the new block (written by `node engine/cli.ts block write`) with the approved copy on `proposal/<id>`.

## Unattended

A new block is big and needs the athlete's yes. An unattended run (a `week` run at the block end) asks nothing. Every push is `node engine/cli.ts push` (it installs the git hooks and checks the destination; a nonzero exit means nothing was pushed: log it). Never run `git push` yourself. No Tally write, and no change to `athlete/block.yaml` on `main`. It makes a `new_block` proposal pull request; merging it is the yes.

1. **Safety.** Run `node engine/cli.ts hold status`. A pending file or an active hold: log "a new block is due: held for safety", commit, `git pull --rebase`, run `node engine/cli.ts push`, and stop.
2. **Draft.** Keep `coach.yaml`'s days and emphasis, and skip the assessments. For each slot, use the exercise of the same slot in the current `athlete/block.yaml`, else last week's exercise for that slot from the history, else one you find with `search_exercises`. Never choose one that a limit bans. Get the id with `node engine/cli.ts ids next --kind block`. Write `.tmp/coach/draft.json`: `{id, start (the next Monday), emphasis, exercises}`. Run `node engine/cli.ts block draft --weeks <n> --input .tmp/coach/draft.json` (`n` as in step 5). It caps week 1 against the reference week [NA-PROG-001]; note its `capped` list for the summary. With `ready: false`, resolve each `unresolved` slot and run it again. A slot that stays unresolved: log it, commit, run `node engine/cli.ts push` and stop.
3. **Audit.** Run the `audit` skill on the draft block and week 1 (scope D, ask nothing). A hard finding: fix the draft and run it again. If it still fails, log the finding, commit, run `node engine/cli.ts push` and stop.
4. **Evidence and base.** Read `get_training_context`, and `get_planned_workout` for every date of week 1 (empty dates too). Note each date's `version`, or `null` for an empty date.
5. **Week-1 calls.** For each day in week 1's `days`, build the Tally call as in step 10: an empty date takes `plan_workout_day` with `ifAbsent: true`; a date with a day takes `plan_workout_day` with `expectedVersion` and `replace: true`. Do not make the calls.
6. **Proposal.** Write `.tmp/coach/proposal.json`: `{"kind": "new_block", summary (the frame, the week-1 targets, the capped muscles), writes: [{tool, input}] (the week-1 calls in date order), base: {<date>: <version or null>}, rule_ids}`. `base` holds the version you read for each date, and `null` for an empty date. Run `node engine/cli.ts proposals create --input .tmp/coach/proposal.json`. Commit it on `main` and run `node engine/cli.ts push`.
7. **Branch.** Run `git switch -c proposal/<id>`. Write the draft's `block` object, as printed, to `.tmp/coach/block.json`. Run `node engine/cli.ts block write --input .tmp/coach/block.json --proposal <id>`. `athlete/block.yaml` is protected: this command writes it only on `proposal/<id>`. It moves the old block (an id other than the draft's) to `athlete/blocks/<old id>.yaml`; a revision of the same block (an early deload from the `week` run) replaces the file in place. It commits both files on the branch itself ("proposal <id>: block <block id>"); when it fails, it puts the previous files back. Run `node engine/cli.ts proposals approve-copy <id>`. Commit "proposal <id>: approved copy (<rule IDs>)" and run `node engine/cli.ts push`.
8. **Pull request.** Run `node engine/cli.ts proposals open-pr <id>`. Still on the branch: `git add athlete/proposals/<id>.yaml`, commit "proposal <id>: PR link", and run `node engine/cli.ts push`. Run `git switch main` as a command of its own (not joined with `&&` or `;`).
9. **Log and stop.** On `main`, append a log entry: "a new block is due: proposal <id> (<PR URL>)". Commit, `git pull --rebase`, run `node engine/cli.ts push`, and stop. The athlete approves by merging the PR (a merge commit, not a squash). The merge brings in the new `athlete/block.yaml`, and the next scheduled run applies week 1.
