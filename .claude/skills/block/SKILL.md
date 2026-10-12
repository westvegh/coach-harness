---
name: block
description: Plans a new training block (usually 5 build weeks and a deload week) from the method's assessments, the template and the athlete's goals, audits it against the method rules, gets the athlete's yes, writes athlete/block.yaml and then week 1 where the plans live (Tally, files in this repo, or the athlete's tool). Use it when the user says "new block", "plan my next block", "start a new phase", "the block is over", "change my program", "switch to 3/4/5 days", "change my emphasis", or when the session context says a new block is due. A new block is always a big change, so it needs the athlete's yes.
---

# Block

A block is the plan for the next 4 to 8 weeks: the weekly frame, the week kinds and the sets per muscle. It follows `engine/types.ts Block` (contracts §16.5).

Today is `TZ=<coach.yaml athlete.timezone> date +%F`, or in an unattended run `local.date` in the `window-check --kind weekly` output. Put engine input files in `.tmp/coach/`.

## Where plans live

Read `coach.yaml logger` in step 1 and follow CLAUDE.md "Where plans live". The steps name the Tally tools. With `logger: files`: in step 4, use plain exercise names that fit the equipment (no `search_exercises`); in step 10, write the week's days (with the loads) with one `node engine/cli.ts plans write --input .tmp/coach/week1.json` (`{days}`), with no reads, `expectedVersion` or `opId` first, then read the week back with `plans read`. `block draft` reads the logged weeks in `plans/` by itself. With `logger: other`: write each day through that tool, by its own instructions, and read it back. When it does not answer, say so in one line, run `node engine/cli.ts logger set files`, and write the week to files.

## Steps

1. **Mode and safety.** Run `node engine/cli.ts mode`. Read `coach.yaml logger` (see "Where plans live"). Unattended: follow the Unattended section instead of these steps. Run `node engine/cli.ts urgent status`. Under the urgent stop, plan no block: give the urgent-care text and ask the `safety` skill's clear question (its step 6). Read `athlete/limits.yaml`: the block follows every limit.
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
7. **Audit.** Run the `audit` skill on the draft block and week 1 (give it each week's `sets_by_muscle`). It checks the limits too. Fix every hard finding and every limits conflict. List the soft findings.
8. **Approval.** Show the block: the frame (days and focus), the week kinds, the targets per muscle, the audit result, and week 1 in a table. Ask "A) yes, write the block and week 1, B) change something, C) not now".
9. **Write the block.** After the athlete's yes, move the old `athlete/block.yaml` (if it has an id) to `athlete/blocks/<old id>.yaml`. Write the `block` object from `block draft` to `athlete/block.yaml`, as printed. Run `node engine/cli.ts commit --message "block <id>: <days>-day <emphasis>, start <date> (<rule IDs>)"`. A nonzero exit: stop, and say in one line that the commit failed and why.
10. **Write week 1** (or the test week): every day in the `days` of that `block draft` week. For each day:
    - Read `get_training_context`, `get_planned_workout` for every date of that week (empty dates too), and `get_workout_history` from 8 weeks before today to today (follow `nextCursor` to the last page). All reads must be under 15 minutes old at each write.
    - Loads: write `.tmp/coach/loads.json` (`{exercises}` of the drafted day) and run `node engine/cli.ts loads --input .tmp/coach/loads.json`. Use its `suggestedWeight` values.
    - Each drafted exercise becomes one Tally exercise: `exerciseId` and `name` as drafted, `suggestedSets` = the number of entries in its `sets`, `suggestedReps` and `suggestedWeight` from its first set.
    - Empty date: `plan_workout_day` with `ifAbsent: true`. A day exists: ask "Replace it? A) yes, B) no"; after a yes, `plan_workout_day` with `expectedVersion` and `replace: true`.
    - Add `opId` from `node engine/cli.ts opid --date <date> --kind new_block --input .tmp/coach/call.json` when `adapters/loggers/tally/adapter.yaml` says `capabilities.opId: true`.
    - Read the day back.
    - After the last day, read every date of the week back and compare the count of written days with the drafted days. Write a missing day once more; if it is still missing, tell the user the date and the reason.
11. **Log, commit and push.** Append a log entry `## <today> <HH:MM> · block <id>` with the frame, the targets and the rule IDs. Run `node engine/cli.ts commit --message "block <id>: week 1 written"` (a nonzero exit: stop, and say in one line that the commit failed and why), then `git pull --rebase` and `node engine/cli.ts push`.

## Writes

- `athlete/block.yaml` and `athlete/blocks/<old id>.yaml` (the previous block) (interactive yes only).
- `athlete/brief.md` (test results), `athlete/log/<YYYY-MM>.md`, `.tmp/coach/*.json`.
- `coach.yaml` `template` key, only after a yes to a frame change.
- Tally: the first week with `plan_workout_day` (`ifAbsent: true`, or `expectedVersion` after a yes).
- With `logger: files`: the first week in `plans/<YYYY>-W<ww>.csv`, only through `node engine/cli.ts plans write`. With `logger: other`: the first week in that tool.
- Git: commits on `main`.

## Unattended

A new block is big and needs the athlete's yes. An unattended run (a `week` run at the block end) asks nothing, writes no Tally day and does not change `athlete/block.yaml`.

1. Write one log line: "- proposal for the next live session: a new block is due (block <id> ended <date>)". Under the urgent stop, add "after the urgent stop is cleared".
2. Commit, `git pull --rebase`, run `node engine/cli.ts push` (a nonzero exit means nothing was pushed: log it), and stop. The next live session offers the block (`today` step 3) and runs this skill.
