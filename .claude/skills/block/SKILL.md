---
name: block
description: Plans a new training block (usually 5 build weeks and a deload week) from the method's assessments, the template and the athlete's goals, audits it against the method rules, gets the athlete's yes, writes athlete/block.yaml and then week 1 where the plans live (Tally, files in this repo, or the athlete's tool). Use it when the user says "new block", "plan my next block", "start a new phase", "the block is over", "change my program", "switch to 3/4/5 days", "change my emphasis", or when the session context says a new block is due. A new block is always a big change, so it needs the athlete's yes.
---

# Block

A block is the plan for the next 4 to 8 weeks: the weekly frame, the week kinds and the sets per muscle. It follows `engine/types.ts Block` (contracts §16.5).

Today is `TZ=<coach.yaml athlete.timezone> date +%F`, or in an unattended run `local.date` in the `window-check --kind weekly` output.

## Where plans live

Read `coach.yaml logger` in step 1 and follow CLAUDE.md "Where plans live". The steps give the command lines for each logger. With `logger: files`: in step 4, use plain exercise names that fit the equipment (no `search_exercises`); in step 10, `plans write` writes the week file as it is. `block draft` reads the logged weeks in `plans/` by itself. With `logger: other`: write each day through that tool, by its own instructions, and read it back. When it does not answer, say so in one line, run `node engine/cli.ts logger set files`, and write the week to files.

## The working folder

Every file of this skill is in `.tmp/coach/b1/`. `block draft --out .tmp/coach/b1` writes `block.json` (the block) and one `week-<n>.json` per block week: `{week: {week_start, kind, load_factor, days}}`. That one week file goes to every command: `loads --fill`, `volume`, `plans write` and `tally-days`. Never build a week input by hand, and never read engine source to learn a shape: `node engine/cli.ts help <command>` gives it.

## Steps

1. **Mode and safety.** Run `node engine/cli.ts mode`. Read `coach.yaml logger` (see "Where plans live"). Unattended: follow the Unattended section instead of these steps. Run `node engine/cli.ts urgent status`. Under the urgent stop, plan no block: give the urgent-care text and ask the `safety` skill's clear question (its step 6). Read `athlete/limits.md` in full: the block follows every line. When a line names a body part, run `node engine/cli.ts regions` once to see which movements load it, and count all of them for that line (isolation work too, such as leg curls for the knee). Unattended, never change it. Read the "Preferences" lines in `athlete/brief.md`.
2. **Assessments.** Read `methods/<method>/assessments.md`. Ask "Run the assessment week first? A) yes, B) use my recent results, C) skip this time".
   - A: plan the test week from `assessments.md` (fresh tests first, fatiguing tests last). Write it as `test` week days, in the same way as step 10.
   - B: ask for the recent results, one test at a time, with the units.
   - Record the results in `athlete/brief.md` under "Best recent lifts or tests". Compare with the athlete's own earlier results, not with norms.
3. **Goals and frame.** Read `athlete/brief.md` and `coach.yaml template`. Ask "Keep <days> days a week and the <emphasis> emphasis? A) yes, B) change days, C) change emphasis". A change of days or emphasis is a `method_change`: it needs this yes, and it updates `coach.yaml template` after the yes.
4. **Exercises.** Read `methods/<method>/templates/<days>-day.yaml`. For each slot (`"<day>.<slot>"`), choose an exercise for its pattern: keep the athlete's current exercise when there is one, follow the "Preferences" lines (an exercise the athlete likes or dislikes), else find one with `search_exercises`. Never choose one that a line in `athlete/limits.md` rules out.
5. **Draft.** Run these in order, one per Bash call:
   - `node engine/cli.ts ids next --kind block`.
   - Write `.tmp/coach/b1/draft.json` with the Write tool: `{"id", "start" (the next Monday), "emphasis", "exercises": {"<pattern or day.slot>": {"name", "exerciseId"?}}, "loads"?}`. Add `targets` only when the athlete chose other week-1 sets.
   - `node engine/cli.ts block draft --weeks <n> --input .tmp/coach/b1/draft.json --out .tmp/coach/b1`, with `n` from `deload_every_weeks` in `methods/<method>/rules.yaml` ([NA-PROG-005]; 6 gives 5 build weeks and a deload). Add a test week first when step 2 chose A.
   - It prints a summary: `ready`, `unresolved`, `warnings`, `rule_ids`, `capped`, `progression`, `why` and per week `{week, kind, week_start, load_factor, file, sets_by_muscle}`. The engine does the arithmetic: slot sets (emphasis, rounding, minimums), the weekly step capped by [NA-PROG-001], and the deload sets ([NA-PROG-006]). Use its numbers only. Do not add up sets yourself.
   - With `ready: false`, choose an exercise for each `unresolved` slot and run the draft again (a slot "same exercise twice" needs another exercise). Read its `warnings` and show the ones that matter. The summary's `short` lists the muscles planned below their target, because one exercise gets at most the pack's session maximum [NA-DES-009].
6. **Preferences.** Apply each "Preferences" line of `athlete/brief.md` to `.tmp/coach/b1/week-1.json` with the Edit tool (for example a rep range: the `reps` of each set of the exercises it names), and to the matching slots in `.tmp/coach/b1/block.json`. A preference never breaks a limit and never raises sets above the draft. Clusters come from `coach.yaml clusters` (CLAUDE.md "Preferences persist"): add an entry before step 5 when the athlete chooses them; the draft keeps their prescription.
7. **Loads.** First refresh the logged history: with Tally, read `get_workout_history` from 8 weeks before today to today with `limit: 10`, following `nextCursor` to the last page; with files, nothing to do. Then run `node engine/cli.ts loads --input .tmp/coach/b1/week-1.json --fill`. It fills each hard set from the logged history and applies the week's `load_factor` (a lighter week) once, in the file. Add `--history .tmp/coach/history.json` only when the athlete chose a new training export in this session (it replaces the logged weeks); never for an export from an earlier session. An exercise with no history keeps its load: say "the first sessions set the loads".
8. **Audit.** Run the `audit` skill on week 1 without its scope question: `node engine/cli.ts volume --input .tmp/coach/b1/week-1.json`, then the method rules, then each line of `athlete/limits.md` against every day (its limits review). Fix every hard finding and every conflict with a limit line in the week file, and check again. List the soft findings. A preference the athlete chose is listed as "athlete chose", not fixed.
9. **Approval.** Show:
   - The frame (days and focus), the week kinds and the targets per muscle, in plain words.
   - **Why this week**: 3 to 5 short bullets in plain words: the summary's `why.week` lines that apply, how weeks 2 to the end build (from `progression`: about <step × 100>% more sets each build week, then a lighter week), what the athlete's limits change (in the athlete's words), the loads note, any preference the plan follows, and the `why.short` line when there is one.
   - Week 1 in one table: the day, the focus, and each exercise with sets × reps and load.
   - Ask "A) yes, write the block and week 1, B) change something, C) not now".
10. **Write the block and week 1.** After the athlete's yes, one command per Bash call. Run `tally-days` (or `plans write`) only after the last change to the week file; after any later change, run it again.
    - `node engine/cli.ts block write --input .tmp/coach/b1/block.json`. It archives the old block (a block with another id goes to `athlete/blocks/`) and writes `athlete/block.yaml`. A nonzero exit: stop, and say in one line why.
    - `node engine/cli.ts commit --message "block <id>: <days>-day <emphasis>, start <date> (<rule IDs>)"`. A nonzero exit: stop, and say in one line that the commit failed and why.
    - **Files:** `node engine/cli.ts plans write --input .tmp/coach/b1/week-1.json`, then `node engine/cli.ts plans read --week <week 1 start>`.
    - **Tally:** `node engine/cli.ts tally-days --input .tmp/coach/b1/week-1.json`. It prints one `plan_workout_day` input per date. Read `get_training_context` and `get_planned_workout` for every date of the week (empty dates too); all reads must be under 15 minutes old at each write. For each printed day, call `plan_workout_day` with the printed input as it is, adding only: `ifAbsent: true` for an empty date; for a day that exists, ask "Replace it? A) yes, B) no", and after a yes `expectedVersion` and `replace: true`; and `opId` from `node engine/cli.ts opid --date <date> --kind new_block --input .tmp/coach/call.json` (`{tool, args}`, written with the Write tool) when `adapters/loggers/tally/adapter.yaml` says `capabilities.opId: true`. Read each day back. After the last day, read every date of the week back and compare the count of written days with the drafted days. Write a missing day once more; if it is still missing, tell the user the date and the reason.
11. **Log, commit and push.** Append a log entry `## <today> <HH:MM> · block <id>` with the frame, the targets and the rule IDs. Run `node engine/cli.ts commit --message "block <id>: week 1 written"` (a nonzero exit: stop, and say in one line that the commit failed and why), then `git pull --rebase` and `node engine/cli.ts push`.

## Writes

- `athlete/block.yaml` and `athlete/blocks/<old id>.yaml` (the previous block), only through `node engine/cli.ts block write` (interactive yes only).
- `athlete/brief.md` (test results), `athlete/log/<YYYY-MM>.md`, `.tmp/coach/b1/*.json`.
- `coach.yaml` `template` key, only after a yes to a frame change.
- Tally: the first week with `plan_workout_day` (`ifAbsent: true`, or `expectedVersion` after a yes).
- With `logger: files`: the first week in `plans/<YYYY>-W<ww>.csv`, only through `node engine/cli.ts plans write`. With `logger: other`: the first week in that tool.
- Git: commits on `main`.

## Unattended

A new block is big and needs the athlete's yes. An unattended run (a `week` run at the block end) asks nothing, writes no Tally day and does not change `athlete/block.yaml`.

1. Write one log line: "- proposal for the next live session: a new block is due (block <id> ended <date>)". Under the urgent stop, add "after the urgent stop is cleared".
2. Commit, `git pull --rebase`, run `node engine/cli.ts push` (a nonzero exit means nothing was pushed: log it), and stop. The next live session offers the block (`today` step 3) and runs this skill.
