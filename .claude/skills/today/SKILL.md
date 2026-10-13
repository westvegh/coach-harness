---
name: today
description: The daily run. It decides whether today's session stays, gets a note, is trimmed, or becomes a recovery day, from the recovery signals and the method's rules, and suggests today's top-set loads. Use it when the user asks "how should I train today?", "what's my workout today?", "should I train today?", "adjust today", "am I recovered?", "today's session", or "what did you propose?", and for the scheduled daily run ("Read .claude/skills/today/SKILL.md and follow it exactly"). It checks the urgent stop and the limits first, offers changes proposed for the live session, exits when today is already adjusted, runs signals, readiness, adjust and loads in the engine, writes, logs, commits and pushes.
---

# Today

The daily run. One adjustment kind a day at most. Precedence: the urgent stop, then recovery, then trim, then progression. A proposal the athlete accepts for today is today's adjustment. Readiness acts on patterns against the athlete's own baseline, not on single days: one off day is a note [NA-REC-008].

Today is the date in the athlete's timezone: `local.date` in the step 1 `window-check` output (interactive, `TZ=<coach.yaml athlete.timezone> date +%F` also works). Now is `date -u +%Y-%m-%dT%H:%M:%SZ`. Put engine input files in `.tmp/coach/`.

## Notes to the logger

Tally is outside the athlete's private repo. Every note you write to a Tally day is generic by default:

| Situation | Note |
|---|---|
| `note` | `[coach] Readiness note (<rule_ids>)` |
| `trim` or `propose_deload` | `[coach] Adjusted for recovery (<rule_ids>)` |
| `recovery` | `[coach] Recovery day (<rule_ids>)` |
| a region the athlete chose to avoid | `[coach] Adjusted for recovery (NA-REC-007)` |
| a rest day the athlete chose | `[coach] Rest day: see your coach repo` |
| `load_progression` | `[coach] Load progression (<rule_ids>)` |
| a proposal the athlete accepted | `[coach] Change you approved` |

- Never put symptoms, body regions, pain scores, readiness values, sleep or heart data in a Tally note. They stay in `athlete/log/` in the private repo.
- Only when `coach.yaml` has `consent.logger_health_notes: true` (the default since v0.2; setup's data question can turn it off) may the note be detailed: `[coach] <decision_reasons> (<rule_ids>)`.
- With `logger: files`, the note goes in the `notes` column of the day's first row, in this private repo, so the detailed form is fine. With `logger: other`, treat the tool like Tally.

## Where plans live

Read `coach.yaml logger` in step 1 and follow CLAUDE.md "Where plans live". The steps name the Tally tools. With `logger: files`:

- Step 2: no history read. `safety scan-notes` reads the notes and felt columns of `plans/` by itself.
- Step 4: read today with `node engine/cli.ts plans read --week <today>` and take today's day. No day: a rest day. Today is already adjusted when the day's notes already hold a `[coach]` line from today's run: say "Today is already adjusted." and end the run.
- Step 5: skip it (the units are in `coach.yaml`).
- Step 6: `readiness` reads the planned and logged days in `plans/` by itself; no per-date reads.
- Step 7: run `adjust --from-snapshot <today>` as written. Put its `tally_day`, with the reason line in `notes`, in `.tmp/coach/today.json` as `{tally_day}`, and run `node engine/cli.ts plans write --input .tmp/coach/today.json`. No `expectedVersion` and no `opId`.
- Step 8: run `loads --from-snapshot <today>` as written. Write today's day with each new `suggestedWeight` through `plans write` (the whole day).
- Read the week back with `plans read` after each write.

With `logger: other`: read and write today through that tool, by its own instructions. When it does not answer, say so in one line, run `node engine/cli.ts logger set files`, and use files from then on. The engine cannot read that tool, so `readiness` reports performance as unknown. Under the urgent stop, write nothing to it.

## Steps

1. **Window and mode.**
   - Run `node engine/cli.ts window-check --kind daily`. A nonzero exit means: stop, write nothing, end the run.
   - Run `node engine/cli.ts mode`. Note `interactive` or `unattended`.
   - Read `coach.yaml logger` (see "Where plans live"). With Tally, read `adapters/loggers/tally/adapter.yaml` with the Read tool and note `capabilities.opId`.
2. **Safety.** This step runs before proposals, planning and every early exit.
   - Run `node engine/cli.ts urgent status`. Read `athlete/limits.yaml` with the Read tool.
   - Read the history with `get_workout_history`, `since` 8 weeks before today, `until` today (today's logged notes count) and `limit: 10`. Follow `nextCursor` to the last page.
   - Run `node engine/cli.ts safety scan-notes --since <today minus 3 days>`. It scans the logged session notes, today's included. An urgent term newer than its last clearance writes, commits and pushes the urgent stop; pain notes are reported in `matches`.
   - **Urgent stop** (`urgent status` prints `stopped: true`, or the scan wrote it): make no Tally write at all (the urgent gate denies every plan write, a skip and a note included). Log "rest day: urgent stop" and go to step 9. Interactive: give the urgent-care text first and ask the `safety` skill's clear question (its step 6).
   - **Pain notes** in `matches`, not already handled in the log: interactive, ask the `safety` skill's old-notes question (its step 8) before planning. Unattended: avoid loading the named region today (remove the exercises that load it; that is a trim with the note "Adjusted for recovery"), and write one log line "- proposal for the next live session: ask about <region>".
   - **Limits:** today's session must follow every limit. After step 4 reads today, write `{days: [<today as a DayPlan>]}` to `.tmp/coach/today.json` and run `node engine/cli.ts limits check --input .tmp/coach/today.json`. Remove or swap each exercise it reports (a trim, note "Adjusted for recovery") before any other change.
   - **Preferences:** read the "Preferences" lines in `athlete/brief.md`. Every change today keeps them: a swap uses an exercise the athlete likes, never one they dislike, and a recorded rep range stays. A limit and the urgent stop still come first.
3. **Proposals for the live session** (interactive only). Read the last 10 log entries for lines "- proposal for the next live session: …" with no later "proposal handled" line. Offer each: "<the change>. A) Yes, do it, B) Not now". A yes: make the change (it is today's adjustment when it changes today). Log "- proposal handled: <yes|no>: <the change>". Unattended: skip this step.
4. **Read today.** Call `get_planned_workout` for today.
   - No day planned: log "rest day: no session planned" and go to step 9.
   - Already adjusted? For each kind `trim_session`, `swap_to_recovery`, `load_progression` and `annotate`, run `node engine/cli.ts oplog done --date <today> --kind <kind>`.
     - Any `status: done`: say "Today is already adjusted." Log nothing new. End the run.
     - `status: uncertain`: read each date in `reread` with `get_planned_workout` and compare it with the logged change, as the `reason` says. If the day shows the change, treat it as done (say "Today is already adjusted." and end the run). If not, go on; never retry blindly.
     - `not_done` for every kind: go on.
   - The day is protected (`source` is not `mcp`, or `userModified: true`): any change needs the user. Interactive: ask. Unattended: annotate only.
5. **Read the context.** Call `get_training_context` with `historyWeeks: 2`. The hooks write the reads to the snapshot; you do not.
6. **Signals and readiness.**
   - Run `node engine/cli.ts signals refresh`. On a Mac with Oura it fetches the last 3 days; otherwise it prints a one-line note. Go on either way.
   - Read `get_planned_workout` for each date in the last 4 days that has a logged session (readiness judges each session against its own plan), unless step 2 or 4 already read it in the last 15 minutes. Read the history again (through today, every page) if step 2's read is more than 15 minutes old.
   - Run `node engine/cli.ts readiness --date <today>`. It builds its input from the signals, the snapshot history and `coach.yaml`. Report what it reports as `unknown`; never estimate a missing value.
7. **Decision.** Use `decision` from the readiness output. Never pick it yourself. The reason line is the generic note for the decision (see "Notes to the logger"). The full `[coach] <decision_reasons> (<rule_ids>)` goes into the log entry, and into the Tally note only with `consent.logger_health_notes: true`.
   - `none`: no write. Log the readiness line.
   - `note` (one day is not a pattern [NA-REC-008]): one `annotate` write: `update_planned_workout` with `notes` only (keep the existing notes; add the reason line) and `expectedVersion`. Loads may still progress in step 8.
   - `trim` (the short pattern: 3 or more off-mornings in a row [NA-REC-009]): trim with `adjust` (below). Progression is held: step 8 does not run.
   - `recovery` with `aversion: true` (the check-in's want-to-train is 1 [NA-REC-012]):
     - Interactive: ask "You do not want to train today. That is a reason to rest. A) make today a recovery day, B) keep the session as planned". A: swap to recovery with `adjust` (below). B: one `annotate` write with the reason line, and keep the planned loads (step 8 does not run).
     - Unattended: swap to recovery with `adjust`. A recovery day is the safer change, so it is always allowed.
   - `recovery` without aversion (the short pattern, and the check-in or performance is red today [NA-REC-010]): swap to recovery with `adjust`.
   - `propose_deload` (the long pattern with all three kinds of evidence [NA-REC-011]): trim today with `adjust`, as for `trim`. Add "the week run proposes a program change" to the reason line. Do not change the program here: the `week` run proposes it.
   - **The `adjust` write** (`trim` for `trim` and `propose_deload`, `recovery` for `recovery`):
     1. Run `node engine/cli.ts adjust --from-snapshot <today> --decision <trim|recovery>`. It reads today's day from the snapshot (step 4's read, under 15 minutes old) and prints `tally_day`, `changes` and `warnings`. With `SNAPSHOT_STALE`, read today again and rerun it. Resolve each `warnings` exercise with `search_exercises`.
     2. Make the write from `tally_day`, copying its values: `update_planned_workout` (preferred: `modify` operations for set counts, `replace` for swapped exercises) or `plan_workout_day` with `tally_day`'s fields, `expectedVersion` and `replace: true`. Add the reason line to `notes`. Pass `expectedVersion`.
     3. Add `opId` when `capabilities.opId` is true: write `{tool, args}` to `.tmp/coach/call.json` and run `node engine/cli.ts opid --date <today> --kind <trim_session|swap_to_recovery> --input .tmp/coach/call.json`.
   - Read today again within 15 minutes of each write.
8. **Loads.** Run this step only when `hold_progression` in step 6's readiness output is false (the decision is `none` or `note`) and step 3 made no change to today. One adjustment kind a day.
   - Skip it when `hold_progression` is true (`trim`, `recovery` or `propose_deload`): the pattern holds progression, and trim and recovery beat progression. The planned loads stay.
   - Skip it when step 3 changed today. The accepted proposal is today's adjustment.
   - One off day is not a pattern: with `hold_progression: false`, run this step as usual. `loads` progresses only exercises whose rep targets were hit.
   - Run `node engine/cli.ts loads --from-snapshot <today>`. The history comes from the snapshot, so step 2's history read must be complete.
   - When its `update.operations` list is not empty, write them with `update_planned_workout`: `date`, `weightUnit` and `operations` from `update`, plus `expectedVersion`, `timezone` and the generic note `[coach] Load progression (<rule_ids>)` in `notes`. This is `load_progression`; `loads` keeps the top-set cap [NA-PROG-003]. Never raise a load past a limit's `max_load`. Exercises in `not_targeted` stay as they are.
   - Read the day back after the write.
9. **Log, commit and push.**
   - The `log-writes` hook logs every Tally write. For a day with no write (`none`, a rest day, the urgent stop, or a declined proposal), append one entry to `athlete/log/<YYYY-MM>.md`:
     ```
     ## <today> <HH:MM> · no-change
     - trigger: daily run (cloud | mac) | user
     - readiness: wearable <state> (<reason>), subjective <state> (<reason>), performance <state> → <decision>
     - rules: <rule IDs>
     - change: none (<one-line reason>)
     ```
   - With `logger: files` or `other`, in a live session: run `node engine/cli.ts tally-mention` first (with `other`, add `--sessions <n>`), so its `coach.yaml` change goes into the commit. When it prints `mention: true`, say its `text` once in step 10.
   - Run `node engine/cli.ts commit --message "today <date>: <decision> (<rule IDs>)"`. A nonzero exit: stop, and say in one line that the commit failed and why.
   - `git pull --rebase`, then push with `node engine/cli.ts push`. It installs the git hooks (a fresh clone has none), checks that the repository is private, and only then pushes the branch to `origin`. A nonzero exit means nothing was pushed: append "push skipped: <reason>" to the log entry and commit it locally.
10. **Tell the athlete** (interactive): today's session in one short table, the decision and the reason in one sentence, in plain words (no rule IDs or file paths: CLAUDE.md "Style"). On a pattern (`trim`, `recovery` or `propose_deload`), say how many off-mornings in a row (`pattern.days_of_decline`) and ask "Sleep, eating or drinking different this week? A) sleep, B) eating, C) drinking, D) no change". Record the answer in the log. Give no targets and no advice on food or supplements. End with the `openInTally` link when a tool result has one.

## Writes

- Tally, today only: `update_planned_workout` (preferred) or `plan_workout_day` with `expectedVersion`; kinds `annotate`, `trim_session`, `swap_to_recovery`, `load_progression`. An accepted proposal: its change.
- With `logger: files`: today's day in `plans/<YYYY>-W<ww>.csv`, only through `node engine/cli.ts plans write`. With `logger: other`: today's day in that tool.
- `athlete/log/<YYYY-MM>.md` (no-change entries, proposal lines), `.tmp/coach/*.json`.
- Git: one commit, pushed to `main`.

## Unattended

- `window-check` runs first; outside the window, stop.
- Ask no questions. A change that needs the athlete (a protected day, a big change) becomes an `annotate` with the generic reason, plus one log line "- proposal for the next live session: <the change>".
- With `capabilities.opId: true`: every write carries `opId` and `expectedVersion`, then a read-back.
- Under the urgent stop, write no plan change (Tally, `plans/` or another tool). Never clear the stop. Never change limits.
- Never run `tally-mention`: no one is there to see the line.
- Always commit, `git pull --rebase`, and push with `node engine/cli.ts push`. A failed check means no push and a log entry.
