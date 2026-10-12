---
name: today
description: The daily run. It decides whether today's session stays, gets a note, is trimmed, or becomes a recovery day, from the recovery signals and the method's rules, and suggests today's top-set loads. Use it when the user asks "how should I train today?", "what's my workout today?", "should I train today?", "adjust today", "am I recovered?", "today's session", or "apply the approved proposal", and for the scheduled daily run ("Read .claude/skills/today/SKILL.md and follow it exactly"). It checks safety first, applies merged proposals, exits when today is already adjusted, runs signals, readiness, adjust and loads in the engine, writes through the guard, logs, commits and pushes.
---

# Today

The daily run. One adjustment kind a day at most. Precedence: hold, then recovery, then trim, then progression. An applied proposal for today is today's adjustment. Readiness acts on patterns against the athlete's own baseline, not on single days: one off day is a note [NA-REC-008].

Today is the date in the athlete's timezone: `local.date` in the step 1 `window-check` output (interactive, `TZ=<coach.yaml athlete.timezone> date +%F` also works). Now is `date -u +%Y-%m-%dT%H:%M:%SZ`. Put engine input files in `.tmp/coach/`.

## Notes to the logger

Tally is outside the athlete's private repo. Every note you write to a Tally day is generic by default:

| Situation | Note |
|---|---|
| `note` | `[coach] Readiness note (<rule_ids>)` |
| `trim` or `propose_deload` | `[coach] Adjusted for recovery (<rule_ids>)` |
| `recovery` | `[coach] Recovery day (<rule_ids>)` |
| a hold, a pending safety check, or an urgent event | `[coach] Rest day: see your coach repo` |
| `load_progression` | `[coach] Load progression (<rule_ids>)` |
| an applied proposal | `[coach] Approved change <proposal id>` |

- Never put symptoms, body regions, pain scores, readiness values, sleep or heart data, or the hold reason in a Tally note. They stay in `athlete/log/` in the private repo.
- Only when `coach.yaml` has `consent.logger_health_notes: true` (the athlete's separate yes in setup) may the note be detailed: `[coach] <decision_reasons> (<rule_ids>)`.

## Steps

1. **Window and mode.**
   - Run `node engine/cli.ts window-check --kind daily`. A nonzero exit means: stop, write nothing, end the run.
   - Run `node engine/cli.ts mode`. Note `interactive` or `unattended`.
   - Read `adapters/loggers/tally/adapter.yaml` with the Read tool. Note `capabilities.opId`.
   - Unattended, with `opId: false`: run `printenv CLAUDE_CODE_REMOTE`. A value means a cloud run: it reports only (no Tally write) in steps 3, 7 and 8.
2. **Safety.** This step runs before proposals, planning and every early exit.
   - Run `node engine/cli.ts hold status`.
   - Read the history with `get_workout_history`, `since` 8 weeks before today and `until` today (today's logged notes count). Follow `nextCursor` to the last page.
   - Run `node engine/cli.ts safety scan-notes --since <today minus 3 days>`. It scans the logged session notes, today's included, and writes the pending file on a match.
   - A pending safety file, interactive: run the `safety` agent first, in the foreground (`run_in_background: false`; never as a background agent). In the same turn, ask its questions with the AskUserQuestion tool (CLAUDE.md hard rule 1); without that tool, paste its "Questions for the athlete (copy exactly):" block to the user word for word, as a quoted block: do not reword it, and add nothing that changes its meaning. An AskUserQuestion call that returns no answers (denied, failed or not available) means the athlete was not asked; paste the copy-exactly block in the same reply, and wait for the answers. Then only `annotate`, rest or recovery are allowed today.
   - A pending safety file, unattended: ask nothing and do not start the question round. Set the hold: `node engine/cli.ts hold set --reason "pending safety check <today>: <terms>" --regions <the region: terms, if any>`. Leave the pending file. Then only `annotate`, rest or recovery are allowed today.
   - An active hold with no regions: allowed are only an `annotate` (the generic note "Rest day: see your coach repo", see "Notes to the logger") or a recovery day. Skip step 3 and steps 6 to 8 for training changes. Go to step 4, then write the note, then step 9.
   - An active hold with regions (and no pending file): run `node engine/cli.ts classify` on today's exercises. Remove each exercise that loads a held region or is unclassified (a removal is a trim), and leave the generic note "Adjusted for recovery". The rest of the day follows the normal steps. The guard denies any exercise that loads a held region.
   - `hold status` prints `urgent: true` (an urgent warning sign): no exercise at all, not even a recovery workout. Skip today's planned session with `skip_planned_workout` and leave the generic note "Rest day: see your coach repo". Interactive: run the `safety` agent in the foreground (`run_in_background: false`; never as a background agent) and give its urgent-care text word for word.
3. **Apply merged proposals.** Run `node engine/cli.ts proposals list --status approved`. For each proposal with `approved_on_main: true` and no `applied_at`:
   1. **Read the evidence first** (contracts §20). For each week that a write in `writes` touches: `get_training_context`, then `get_planned_workout` for every date of that week (Monday to Sunday, empty dates too). Use the history from step 2. All reads must be under 15 minutes old at each write; read again if more time passed.
   2. **Check the base.** If a date's version differs from `base`, or a `null` base date is no longer empty, do not apply the proposal. Log "proposal <id> not applied: the day changed after the proposal". Interactive: say so and offer a new proposal.
   3. **Write.** Make each write in `writes` exactly as stored. The guard accepts it through the approval record. Keep each tool result.
   4. **Read back.** Read each date the writes touch with `get_planned_workout`, so the snapshot holds the read-back.
   5. **Check.** Write the tool results, one per write in order (`null` when a write has no result), to `.tmp/coach/results.json`. Run `node engine/cli.ts proposals check-applied --id <id> --input .tmp/coach/results.json`. It checks each result and each read-back, and writes nothing.
   6. **Mark applied only when `check-applied` prints `status: applied`.** Then run `node engine/cli.ts proposals mark-applied <id> --input .tmp/coach/results.json`.
   7. **Otherwise do not mark it applied** (`partial` or `not-applied`). Log the partial state from the `check-applied` output: each write's `result`, `readback` and `applied`, and the `missing` list. Leave the proposal open, so the next run sees it again. Interactive: say so.
   - A proposal with `approved_on_main: false` and a `not_approved_because`: do not apply it. Log the reason.
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
   - Read today again within 15 minutes of each write. The guard denies a stale read.
   - Unattended cloud run with `opId: false`: make no write. Log the decision and the exact change it would make.
8. **Loads.** Run this step only when `hold_progression` in step 6's readiness output is false (the decision is `none` or `note`), no hold is active, and step 3 applied no proposal for today. One adjustment kind a day.
   - Skip it when `hold_progression` is true (`trim`, `recovery` or `propose_deload`): the pattern holds progression, and trim and recovery beat progression. The planned loads stay.
   - Skip it when step 3 applied a proposal with a write for today. The proposal is today's adjustment.
   - One off day is not a pattern: with `hold_progression: false`, run this step as usual. `loads` progresses only exercises whose rep targets were hit.
   - Run `node engine/cli.ts loads --from-snapshot <today>`. The history comes from the snapshot, so step 2's history read must be complete.
   - When its `update.operations` list is not empty, write them with `update_planned_workout`: `date`, `weightUnit` and `operations` from `update`, plus `expectedVersion`, `timezone` and the generic note `[coach] Load progression (<rule_ids>)` in `notes`. This is `load_progression`; the guard checks the top-set cap. Exercises in `not_targeted` stay as they are.
   - Read the day back after the write.
9. **Log, commit and push.**
   - The `log-writes` hook logs every Tally write. For a day with no write (`none`, a rest day, a report-only run, or a skipped proposal), append one entry to `athlete/log/<YYYY-MM>.md`:
     ```
     ## <today> <HH:MM> · no-change
     - trigger: daily run (cloud | mac) | user
     - readiness: wearable <state> (<reason>), subjective <state> (<reason>), performance <state> → <decision>
     - rules: <rule IDs>
     - change: none (<one-line reason>)
     ```
   - `git add athlete` and commit "today <date>: <decision> (<rule IDs>)".
   - `git pull --rebase`, then push with `node engine/cli.ts push`. It installs the git hooks (a fresh clone has none), checks that the repository is private, and only then pushes the branch to `origin`. A nonzero exit means nothing was pushed: append "push skipped: <reason>" to the log entry and commit it locally. Never run `git push` yourself in an unattended run: the guard denies it.
10. **Tell the athlete** (interactive): today's session in one short table, the decision, the reason in one sentence, and the rule IDs. On a pattern (`trim`, `recovery` or `propose_deload`), say how many off-mornings in a row (`pattern.days_of_decline`) and ask "Sleep, eating or drinking different this week? A) sleep, B) eating, C) drinking, D) no change". Record the answer in the log. Give no targets and no advice on food or supplements. End with the `openInTally` link when a tool result has one.

## Writes

- Tally, today only: `update_planned_workout` (preferred) or `plan_workout_day` with `expectedVersion`; kinds `annotate`, `trim_session`, `swap_to_recovery`, `load_progression`. Applied proposals: their stored writes.
- `athlete/log/<YYYY-MM>.md` (no-change entries), `athlete/proposals/<id>.yaml` (through `proposals mark-applied`, only after full success), `.tmp/coach/*.json`.
- Git: one commit, pushed to `main`.

## Unattended

- `window-check` runs first; outside the window, stop.
- Ask no questions. A change that needs the user (a protected day, a big change) becomes an `annotate` with the reason; the next `week` run can propose it.
- With `capabilities.opId: true`: every write carries `opId` and `expectedVersion`, then a read-back.
- With `capabilities.opId: false`: a cloud run writes nothing to Tally and logs what it would do; a Mac run writes and reads back.
- Never clear a hold or a pending file. Never change limits.
- Always commit, `git pull --rebase`, and push with `node engine/cli.ts push`. A failed check means no push and a log entry.
