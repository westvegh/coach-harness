---
name: week
description: The weekly review and plan. It checks last week's adherence, progressions and readiness trend, gets next week's targets from the engine, drafts each day from the block template with history-based loads, follows the limits (and builds back a capped region), classifies every change in code, writes the small changes and asks about the big ones. Use it when the user says "plan next week", "weekly review", "how did my week go?", "set up next week", "what's next week?", "Sunday planning", or for the scheduled weekly run ("Read .claude/skills/week/SKILL.md and follow it exactly"). In an unattended run, a big change becomes a log line for the next live session.
---

# Week

Plan next week (Monday to Sunday in the athlete's timezone) inside the current block.

Today is `local.date` in the step 1 `window-check` output (interactive, `TZ=<coach.yaml athlete.timezone> date +%F` also works). Put engine input files in `.tmp/coach/`.

## Where plans live

Read `coach.yaml logger` in step 1 and follow CLAUDE.md "Where plans live". The steps name the Tally tools. With `logger: files`:

- Step 2: no history read. `safety scan-notes` reads the notes and felt columns of `plans/` by itself.
- Step 5: read this week with `node engine/cli.ts plans read --week <today>` and next week with `node engine/cli.ts plans read --week <next Monday>`. No `get_training_context`.
- Step 6: adherence is the planned days in `plans read` against the logged days in `weeks` (which reads `plans/` by itself). A planned row with empty done columns is not logged: report it as not logged, not as missed.
- Step 8: use plain exercise names that fit the equipment (no `search_exercises`). The drafted days, with the loads, are next week's plan as they are.
- Step 9: classify each day with `tool: "plan_workout_day"`, `before` from `plans read` and `after` from the draft.
- Step 10: write next week's small changes with one `node engine/cli.ts plans write --input <the week file>` (or `{days}` with only the changed days). No `expectedVersion` and no `opId`. A row the athlete already logged keeps its done columns. Read the week back with `plans read`.

With `logger: other`: read and write next week through that tool, by its own instructions, and read each day back. When it does not answer, say so in one line, run `node engine/cli.ts logger set files`, and use files from then on. The engine cannot read that tool's history, so targets use the logged weeks you report from it. Under the urgent stop, write nothing to it.

## Steps

1. **Window and mode.**
   - Run `node engine/cli.ts window-check --kind weekly`. A nonzero exit means: stop, write nothing, end the run.
   - Run `node engine/cli.ts mode`. Read `coach.yaml logger` (see "Where plans live"). With Tally, read `adapters/loggers/tally/adapter.yaml` with the Read tool and note `capabilities.opId`.
2. **Safety and limits.** This step runs before proposals, planning and every early exit.
   - Run `node engine/cli.ts urgent status`. Read `athlete/limits.yaml` with the Read tool, and the "Preferences" lines in `athlete/brief.md`.
   - Read the history with `get_workout_history`, `since` 8 weeks before today, `until` today (today's logged notes count) and `limit: 10`. Follow `nextCursor` to the last page.
   - Run `node engine/cli.ts safety scan-notes --since <today minus 7 days>`. An urgent term newer than its last clearance writes, commits and pushes the urgent stop; pain notes are reported in `matches`.
   - **Urgent stop** (`stopped: true`, or the scan wrote it): write no plan change (the urgent gate denies every plan write). Leave next week as it is and log why. Interactive: give the urgent-care text and ask the `safety` skill's clear question (its step 6).
   - **Pain notes** from the past week, not already handled in the log: interactive, ask the `safety` skill's old-notes question (its step 8) before planning. Unattended: plan no exercise that loads the named region, and write one log line "- proposal for the next live session: ask about <region>".
   - **Build back** (interactive): for each limit with `build_back: true`, ask once "<Region>: how did it feel this week? A) Fine: build back one step, B) The same: keep the cap, C) Worse: avoid loading it for now". A raises the cap by one set a week (or about 10% load); B keeps it; C makes it a ban. Write the change to `athlete/limits.yaml` and say it in one line. Unattended: keep the caps as they are.
3. **Proposals for the live session** (interactive only). Follow `today` step 3: offer each "proposal for the next live session" line from the log, and log the answer.
4. **Block.** Read `athlete/block.yaml`. Find next week's block week (`start` plus whole weeks).
   - No block, or next week is past the block's last week: interactive, run the `block` skill. Unattended, follow the `block` skill's Unattended section: it writes one log line "- proposal for the next live session: a new block is due", with no Tally write. Then stop. A new block needs the athlete's yes.
5. **Read the evidence,** under 15 minutes old at each write:
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
     - **Interactive:** show the pattern and the reasons. Ask "A) make next week a deload week, B) plan a new block, C) keep the plan". A: draft next week as a deload (step 8, with `deload_weeks: [<next week's block week>]` in the draft input; the block's own deload week moves there). Write the revised `block` object to `athlete/block.yaml` first, then next week's days. B: run the `block` skill. C: plan as usual, and log the choice. When next week is block week 1, offer only B and C.
     - **Unattended:** never write it. Plan the week as usual and write one log line: "- proposal for the next live session: early deload: <days_of_decline> off-mornings with a low check-in and a performance drop (NA-REC-011)".
7. **Targets.** Write `.tmp/coach/targets.json`: `{block, logs, today, target_week}`, with `logs` copied from the `weeks` output. Run `node engine/cli.ts targets --input .tmp/coach/targets.json`. It gives the sets per muscle after the cap, the week kind and the `load_factor`. Use these numbers only.
8. **Draft the days.**
   - Write `.tmp/coach/draft.json`: `{id, start, emphasis, targets, exercises}` from `athlete/block.yaml` (`targets`: block week 1's targets) and `exercises`: for each slot (`"<day>.<slot>"`), last week's exercise for that slot, else one you find with `search_exercises`. A new exercise outside the block's slots and the last 8 weeks of history is `new_exercise` (big).
   - Run `node engine/cli.ts block draft --weeks <the block's number of weeks> --input .tmp/coach/draft.json --out .tmp/coach/wk`. It prints a short summary and writes one week file per block week. Next week is `.tmp/coach/wk/week-<next week's block week>.json` (`{week: {week_start, kind, load_factor, days}}`); call it the week file. With `ready: false`, resolve each `unresolved` slot and run it again.
   - **Preferences:** apply each "Preferences" line of `athlete/brief.md` to the drafted days (for example a recorded rep range on the exercises it names, an exercise the athlete likes in its slot), before the loads and the limits check. The audit lists a preference as "athlete chose" and does not undo it. A limit and the urgent stop still come first.
   - Compare that week's `sets_by_muscle` with the `targets` output of step 7. Where a muscle is above the capped target, remove sets from its slots in the week file (Edit tool) and run `node engine/cli.ts volume --input <the week file>` until no muscle is above. Never add sets above the targets.
   - Loads: first refresh the logged history (with Tally, read `get_workout_history` again with `limit: 10`, every page, when the step 5 read is more than 10 minutes old; with files, nothing to do). Then run `node engine/cli.ts loads --input <the week file> --fill`. It fills each hard set from the logged history and applies the week's `load_factor` once (a deload week stays light). No `--history` here: an export from setup is old by now.
   - Follow `athlete/limits.yaml`: never place an exercise that a limit bans, and keep each capped pattern at or under its `max_sets_per_week` and `max_load`. Check the drafted week with `node engine/cli.ts limits check --input <the week file>` and fix every finding in the week file; run `volume` and `limits check` again after a fix.
   - With Tally, `node engine/cli.ts tally-days --input <the week file>` prints each day as a `plan_workout_day` input: write it as it is, adding only the read-dependent fields (step 10). Run `tally-days` (or `plans write`) only after the last change to the week file; after any later change, run it again.
9. **Classify each day.** Write `{tool, before, after}` to `.tmp/coach/call.json` and run `node engine/cli.ts classify --input .tmp/coach/call.json`. It prints `kinds` and `big`. Your own label does not count.
   - A new day on an empty date built only from the block week's template slots is `block_session` (small).
   - `big: false`: a small change. Go to step 10.
   - `big: true`: a big change. Go to step 11.
   - A day the athlete built or edited (`source` is not `mcp`, or `userModified: true`): leave it as it is. Interactive: ask before you change it.
10. **Write the small changes.**
    - Empty date: `plan_workout_day` with `ifAbsent: true`.
    - A day exists: `update_planned_workout` with `expectedVersion` (preferred), or `plan_workout_day` with `expectedVersion` and `replace: true`.
    - Add `opId` from `node engine/cli.ts opid --date <date> --kind <kind> --input .tmp/coach/call.json` when `capabilities.opId` is true.
    - Read each day back with `get_planned_workout`.
11. **Big changes.**
    - **Interactive:** show each big change (day, what changes, kinds, rule IDs). Ask "A) yes, write it, B) change it, C) skip it". After a yes, write it as in step 10.
    - **Unattended:** never write it. Write one log line per change: "- proposal for the next live session: <day>: <the change> (<kinds>, <rule IDs>)". The next live session offers it (`today` step 3).
12. **Log, commit and push.** The `log-writes` hook logs each Tally write. Append one weekly entry to `athlete/log/<YYYY-MM>.md`:
    ```
    ## <today> <HH:MM> · week <block week>
    - trigger: weekly run (cloud | mac) | user
    - adherence: <logged>/<planned> sessions
    - targets: <muscle sets from targets>
    - written: <dates and kinds>
    - proposed: <changes for the next live session, or none>
    ```
    With `logger: files` or `other`, in a live session: run `node engine/cli.ts tally-mention` first (with `other`, add `--sessions <n>`), so its `coach.yaml` change goes into the commit; when it prints `mention: true`, say its `text` once in step 13. Run `node engine/cli.ts commit --message "week <week_start>: plan (<rule IDs>)"`. A nonzero exit: stop, and say in one line that the commit failed and why. Run `git pull --rebase`, then `node engine/cli.ts push`. A nonzero push exit means nothing was pushed: append "push skipped: <reason>" to the log entry and commit it locally.
13. **Tell the athlete** (interactive): next week in one table, last week's adherence, the targets, and what needs their yes, in plain words (no rule IDs or file paths: CLAUDE.md "Style").

## Writes

- Tally: next week's days with `plan_workout_day` (`ifAbsent: true` or `expectedVersion`) or `update_planned_workout` (`expectedVersion`); small kinds only without a yes.
- With `logger: files`: next week's days in `plans/<YYYY>-W<ww>.csv`, only through `node engine/cli.ts plans write`. With `logger: other`: next week's days in that tool.
- `athlete/limits.yaml`: a build-back step the athlete chose (a live answer only).
- `athlete/log/<YYYY-MM>.md` (the weekly entry, proposal lines), `.tmp/coach/*.json`, `.tmp/coach/wk/*.json`.
- Git: commits on `main`.

## Unattended

- `window-check` runs first; outside the window, stop.
- Ask no questions. Small changes are written; a big change becomes one log line for the next live session (step 11).
- Under the urgent stop, write no plan change. Keep build-back caps as they are.
- Commit, `git pull --rebase`, and push with `node engine/cli.ts push`. It installs the git hooks and checks the destination first. A failed check means no push and a log entry.
