---
name: today
description: The daily run. It decides whether today's session stays, gets a note, is trimmed, or becomes a recovery day, from the recovery signals and the method's rules, and suggests today's top-set loads. Use it when the user asks "how should I train today?", "what's my workout today?", "should I train today?", "check in", "morning check-in", "how am I doing?", "how do I look for today?", "am I ready to train?", "adjust today", "am I recovered?", "today's session", or "what did you propose?", and for the scheduled daily run ("Read .claude/skills/today/SKILL.md and follow it exactly"). It checks the urgent stop, pain and the limits first, gives a report-only answer when today is already adjusted, offers changes proposed for the live session, runs signals, readiness, adjust and loads in the engine, asks one "How do you feel today?" question only on a day when the answer can change the workout, recommends today's session with the reasons, writes, logs, commits and pushes.
---

# Today

The daily run. The coach reads the data, decides, and recommends; the athlete changes it if they want. One adjustment kind a day at most. Precedence: the urgent stop, then recovery, then trim, then progression. A proposal the athlete accepts for today is today's adjustment. Readiness acts on patterns against the athlete's own baseline, not on single days: one off day is a note [NA-REC-008].

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
- Step 3: read today with `node engine/cli.ts plans read --week <today>` and take today's day from `days`. No day: a rest day. A date in `unplanned_logged` (logged rows with no sets, reps or load planned) has no planned session either: it is a rest day with logged work. Plan nothing on it and write no plan; its logged rows still count for readiness, which judges them against the athlete's own history. Today is already adjusted when the day's notes already hold a `[coach]` line from today's run: interactive, give the report only (step 3, "Already adjusted, interactive"); unattended, end the run.
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
   - Read `coach.yaml logger` (see "Where plans live"). With Tally, read `adapters/loggers/tally/adapter.yaml` with the Read tool and note `capabilities.opId`. Note `coach.yaml signals.wearable`.
2. **Safety.** This step runs before the already-adjusted check, proposals, planning and every early exit.
   - Run `node engine/cli.ts urgent status`. Read `athlete/limits.yaml` with the Read tool.
   - Read the history with `get_workout_history`, `since` 8 weeks before today, `until` today (today's logged notes count) and `limit: 10`. Follow `nextCursor` to the last page.
   - Run `node engine/cli.ts safety scan-notes --since <today minus 3 days>`. It scans the logged session notes, today's included. An urgent term newer than its last clearance writes, commits and pushes the urgent stop; pain notes are reported in `matches`.
   - **Urgent stop** (`urgent status` prints `stopped: true`, or the scan wrote it): make no Tally write at all (the urgent gate denies every plan write, a skip and a note included). Log "rest day: urgent stop" and go to step 9. Interactive: give the urgent-care text first and ask the `safety` skill's clear question (its step 6), exactly as the `safety` skill says. Under the urgent stop there is no report format: no verdict first, no line limit, no closing invitation, and no "How do you feel today?" question.
   - **Pain from today's check-in.** A check-in can carry pain (from the Shortcut, or from an earlier chat). Run `node engine/cli.ts signals --from <today> --to <today>`. Read `pain_threshold` in `athlete/limits.yaml` (default 4). Take each `pain` entry in a record's `subjective` with a score at or above the threshold. It is handled when the log has "- pain handled: <region> <checkin_at>" with that record's `checkin_at` (a record without one: its `observed_at`; the engine fills it in); a later check-in with worse pain has a new `checkin_at`, so it is handled again. For each entry that is not handled:
     - Interactive: run the `safety` skill for that region now, before anything else. When the `safety` skill finishes, append "- pain handled: <region> <checkin_at>" to the log.
     - Unattended: avoid loading the region today (remove the exercises that load it; that is a trim with the note "Adjusted for recovery"), and write one log line "- proposal for the next live session: ask about <region>". Write no "pain handled" line.
   - **Pain notes** in `matches`, not already handled in the log: interactive, ask the `safety` skill's old-notes question (its step 8) before planning. Unattended: avoid loading the named region today (remove the exercises that load it; that is a trim with the note "Adjusted for recovery"), and write one log line "- proposal for the next live session: ask about <region>".
   - **Limits:** today's session must follow every limit. After step 3 reads today, write `{days: [<today as a DayPlan>]}` to `.tmp/coach/today.json` and run `node engine/cli.ts limits check --input .tmp/coach/today.json`. Remove or swap each exercise it reports (a trim, note "Adjusted for recovery") before any other change.
   - **Preferences:** read the "Preferences" lines in `athlete/brief.md`. Every change today keeps them: a swap uses an exercise the athlete likes, never one they dislike, and a recorded rep range stays. A cluster (`coach.yaml clusters`) stays a cluster: a trim drops mini-sets, and its load repeats unless every mini-set hit (`loads` does both). A limit and the urgent stop still come first.
3. **Read today.** Call `get_planned_workout` for today.
   - No day planned: a rest day. Log "rest day: no session planned". Interactive: run step 6 for the report (no question on a rest day), then go to step 9; step 10 gives the verdict "Rest day". Unattended: go to step 9.
   - Already adjusted? For each kind `trim_session`, `swap_to_recovery`, `load_progression` and `annotate`, run `node engine/cli.ts oplog done --date <today> --kind <kind>`.
     - Any `status: done`: today is already adjusted (see below).
     - `status: uncertain`: read each date in `reread` with `get_planned_workout` and compare it with the logged change, as the `reason` says. If the day shows the change, treat it as done. If not, go on; never retry blindly.
     - `not_done` for every kind: go on.
   - **Already adjusted, interactive: a report only** (with any logger: the `oplog` check above, or the files-logger `[coach]` line check). Fresh reads are allowed: `signals refresh` (its cache update), the logger reads and the snapshot the hooks write. Run step 6's reads and `readiness`, then give the step 10 report with what the earlier run changed, from the `oplog` kinds that are done or the day's `[coach]` note (for example "This morning's run made today a little lighter."). Skip the "How do you feel today?" question, the proposals, every plan write, the no-change log entry, `tally-mention`, the commit and the push. The report changes no tracked file. End the run. (Step 2's urgent and pain handling came first and may write and commit, as usual.)
   - **Already adjusted, unattended:** say "Today is already adjusted." Log nothing new. End the run.
   - The day is protected (`source` is not `mcp`, or `userModified: true`): any change needs the athlete's yes. Interactive: the one consent question (step 7, "Consent"). Unattended: no write at all on a protected day (no override and no note); write one log line "- proposal for the next live session: <the change>".
4. **Proposals for the live session** (interactive only). They run after the already-adjusted check: on the already-adjusted branch they wait for the next live session. Read the last 10 log entries for lines "- proposal for the next live session: …" with no later "proposal handled" line. Ask no question here. Sort each one:
   - **A change to today's session:** it joins the step 7 list. The step 7 consent question covers it with the rest of today's changes ("Apply these? A) Yes, B) Change something, C) Not now", after `classify`). An accepted proposal is today's adjustment.
   - **"Ask about <region>":** run the `safety` skill for that region now, as for pain in step 2.
   - **Anything else** (for example the week run's program change): keep it for step 10. All of them are offered once, in one list, after the report.
   - Never one question per proposal. Log "- proposal handled: <yes|no>: <the change>" for each one after its answer. Unattended: skip this step.
5. **Read the context.** Call `get_training_context` with `historyWeeks: 2`. The hooks write the reads to the snapshot; you do not.
6. **Signals and readiness.**
   - Run `node engine/cli.ts signals refresh`. On a Mac with Oura it fetches the last 3 days; otherwise it prints a one-line note. Go on either way.
   - Read `get_planned_workout` for each date in the last 4 days that has a logged session (readiness judges each session against its own plan, and a date with no plan against the athlete's own history), unless step 2 or 3 already read it in the last 15 minutes. Read the history again (through today, every page) if step 2's read is more than 15 minutes old.
   - Run `node engine/cli.ts readiness --date <today>`. It builds its input from the signals, the snapshot history and `coach.yaml`. Report what it reports as `unknown`; never estimate a missing value.
   - **The one question** (interactive only). Ask it only when `decision` is `trim` and there is no rating for today (`subjective.state` is `unknown`). Then the answer can change the workout: a red rating makes a recovery day, and on the long pattern a flagged rating with flagged performance proposes a program change. Never on another day: not when the decision is already `recovery`, not on `none` or `note` days, not when the wearable is missing or calibrating, not on a rest day, not on the already-adjusted branch, and not under the urgent stop. Never twice a day: a rating recorded today means no question.
     - One AskUserQuestion call with one question, "How do you feel today?", and four options: "Good", "Okay", "Run down", "Wrecked". Without AskUserQuestion, ask the same question as text: "How do you feel today? A) Good, B) Okay, C) Run down, D) Wrecked".
     - Map the answer: Good 4, Okay 3, Run down 2, Wrecked 1. Run `node engine/cli.ts checkin --date <today> --overall <n>`, then `node engine/cli.ts commit --message "check-in <today>"` (a nonzero exit: stop, and say in one line that the commit failed and why), then `node engine/cli.ts readiness --date <today>` again. Use the new decision. Do not ask again after the rerun.
7. **Decision.** Use `decision` from the readiness output. Never pick it yourself. The reason line is the generic note for the decision (see "Notes to the logger"). The full `[coach] <decision_reasons> (<rule_ids>)` goes into the log entry, and into the Tally note only with `consent.logger_health_notes: true`.
   - `none`: no write. Log the readiness line.
   - `note` (one day is not a pattern [NA-REC-008]): one `annotate` write: `update_planned_workout` with `notes` only (keep the existing notes; add the reason line) and `expectedVersion`. Loads may still progress in step 8.
   - `trim` (the short pattern: 3 or more off-mornings in a row [NA-REC-009]): trim with `adjust` (below). Progression is held: step 8 does not run.
   - `recovery` with `aversion: true` (the check-in's want-to-train is 1 [NA-REC-012]): swap to recovery with `adjust`. Not wanting to train is a reason to rest, and a recovery day is the safer change, so the coach makes it without a question. Interactive: step 10 says "Recovery day", with the reason, and the closing line invites a change. If the athlete then asks to keep the session as planned, write today back as step 3 read it (with `expectedVersion`), with the reason line in `notes`, and keep the planned loads (step 8 does not run).
   - `recovery` without aversion (the short pattern, and the check-in or performance is red today [NA-REC-010]): swap to recovery with `adjust`.
   - `propose_deload` (the long pattern with all three kinds of evidence [NA-REC-011]): trim today with `adjust`, as for `trim`. Add "the week run proposes a program change" to the reason line. Do not change the program here: the `week` run proposes it.
   - **The `adjust` write** (`trim` for `trim` and `propose_deload`, `recovery` for `recovery`):
     1. Run `node engine/cli.ts adjust --from-snapshot <today> --decision <trim|recovery>`. It reads today's day from the snapshot (step 3's read, under 15 minutes old) and prints `tally_day`, `changes` and `warnings`. With `SNAPSHOT_STALE`, read today again and rerun it. Resolve each `warnings` exercise with `search_exercises`.
     2. Make the write from `tally_day`, copying its values: `update_planned_workout` (preferred: `modify` operations for set counts, `replace` for swapped exercises) or `plan_workout_day` with `tally_day`'s fields, `expectedVersion` and `replace: true`. Add the reason line to `notes`. Pass `expectedVersion`.
     3. Add `opId` when `capabilities.opId` is true: write `{tool, args}` to `.tmp/coach/call.json` and run `node engine/cli.ts opid --date <today> --kind <trim_session|swap_to_recovery> --input .tmp/coach/call.json`.
   - Read today again within 15 minutes of each write.
   - **The coach recommends.** Every choice for today's session (a load, the sets, a swap, which exercise, a trim) is the coach's: make it, say the pick and one reason, apply it when it may, and end with the step 10 invitation to change it. Never ask the athlete to choose between the coach's own options (no "Which weight today? 40 / 45 / 50"), and never ask one question per exercise or per change.
   - **Consent** (interactive). A protected day (step 3), a big change, or a step 4 proposal for today: before any write, read the day and run `classify` on the final change (write `{before, after, tool, today}` to `.tmp/coach/classify.json` and run `node engine/cli.ts classify --input .tmp/coach/classify.json`). Then list every change the coach recommends for today (this step's write, step 8's loads, and the step 4 proposals for today together), each with its reason, and ask one question: "Apply these? A) Yes, B) Change something, C) Not now".
     - A: write the whole list. For a protected day, pass `overrideUserModified: true` with `expectedVersion`, for this approved write only. Read the day back. If a reread before the write shows a different day, show the new list and ask again.
     - B: the athlete says what to change in their own words. Apply nothing yet. Show the revised list and ask the same question again.
     - C: write nothing. Log "- proposal for the next live session: <the list>".
     - Never one question per exercise or per change. A small change on a day the coach wrote needs no question.
   - Unattended: a protected day gets no write at all (no override, no note): log "- proposal for the next live session: <the change>". A big change on another day: make no big change; log the proposal line (CLAUDE.md rule 7).
8. **Loads.** Run this step only when `hold_progression` in step 6's readiness output is false (the decision is `none` or `note`) and no step 4 proposal for today is in the step 7 list. One adjustment kind a day.
   - Skip it when `hold_progression` is true (`trim`, `recovery` or `propose_deload`): the pattern holds progression, and trim and recovery beat progression. The planned loads stay.
   - Skip it when the step 7 list holds a step 4 proposal for today. The proposal is today's adjustment.
   - One off day is not a pattern: with `hold_progression: false`, run this step as usual. `loads` progresses only exercises whose rep targets were hit.
   - Run `node engine/cli.ts loads --from-snapshot <today>`. The history comes from the snapshot, so step 2's history read must be complete.
   - **The coach's own load.** When the engine's load reason does not fit the logs, the coach may choose another load for an exercise. The bounds:
     - It is a weight the athlete logged for that exercise in the last 4 weeks, or today's planned weight, in the day's unit (the engine converts; no mental math).
     - It is not above the higher of the engine's suggestion and the last logged top-set weight, so the top-set cap holds [NA-PROG-003].
     - It is not above a limit's `max_load`, and it is never a raise on a day with `hold_progression: true` or in a deload week.
     - Say why, with the logged numbers ("45 lb: you got 12, 12, 9 at 45 last time"). The log keeps both the engine's number and the coach's choice.
   - When its `update.operations` list is not empty (with the coach's own loads in place of the engine's where it chose them), write them with `update_planned_workout`: `date`, `weightUnit` and `operations` from `update`, plus `expectedVersion`, `timezone` and the generic note `[coach] Load progression (<rule_ids>)` in `notes`. This is `load_progression`; `loads` keeps the top-set cap [NA-PROG-003]. Never raise a load past a limit's `max_load`. Exercises in `not_targeted` stay as they are. A protected day or a big change: the step 7 consent question first.
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
10. **The report** (interactive). Plain words: no rule IDs, file paths or command names (CLAUDE.md "Style"). At most about 6 short lines, in this order:
    - **The verdict, first:** "Train as planned" (`none` or `note`), "Train, a little lighter" (`trim` or `propose_deload`), "Recovery day" (`recovery`), or "Rest day" (no session planned).
    - **Why**, with the athlete's own numbers from the readiness reasons: last night's sleep against the target, HRV and resting HR against the athlete's usual range, and the last sessions (every rep hit, or what fell short). Name a missing value plainly ("no Oura data for last night"; "still learning your normal: 12 of 28 days"). Never estimate a missing value. On a pattern, say how many off-mornings in a row (`pattern.days_of_decline`). When `coach.yaml signals.wearable` is `none`, say in one line: "No recovery data is connected. Say 'connect my Oura' or 'connect my Apple Watch' to add it."
    - **Today's session** in one line (the day name and the main exercises), and what changed today, each with its reason (fewer sets, a recovery day, a load that goes up or stays).
    - **The closing line**, an invitation, not a question: "Tell me if anything hurts or feels off, or if you want to change something." On a pattern day (`trim`, `recovery` or `propose_deload`): "Tell me if anything hurts, or if your sleep, food or drinks were different this week." Record an answer in the log. Give no targets and no advice on food or supplements.
    - The `openInTally` link when a tool result has one.
    - **Other proposals** (step 4, not about today's session): after the report, list them all, each with its reason, and ask one question: "Apply these? A) Yes, B) Change something, C) Not now". A: make each change through the skill that owns it (a program change through `week` or `block`, with that skill's own approval). B: show the revised list and ask again. C: change nothing; they wait for the next live session. Never one question per proposal.
    - Under the urgent stop, step 2's urgent handling replaces this report.

## Writes

- Tally, today only: `update_planned_workout` (preferred) or `plan_workout_day` with `expectedVersion`; kinds `annotate`, `trim_session`, `swap_to_recovery`, `load_progression`. An accepted proposal: its change. `overrideUserModified: true` only for the write the athlete approved with "A) Yes" (step 7, "Consent").
- `athlete/signals/<today>.json`, only through `node engine/cli.ts checkin --overall` (the one question, step 6).
- Nothing on the already-adjusted branch of an interactive run (step 3): the report changes no tracked file.
- With `logger: files`: today's day in `plans/<YYYY>-W<ww>.csv`, only through `node engine/cli.ts plans write`. With `logger: other`: today's day in that tool.
- `athlete/log/<YYYY-MM>.md` (no-change entries, proposal lines, "pain handled" lines), `.tmp/coach/*.json`.
- Git: one commit, pushed to `main`.

## Unattended

- `window-check` runs first; outside the window, stop.
- Ask no questions. A protected day gets no write at all (no override and no note: the Tally server rejects a note on a protected day). A big change on another day is not made. Each becomes one log line "- proposal for the next live session: <the change>".
- With `capabilities.opId: true`: every write carries `opId` and `expectedVersion`, then a read-back.
- Under the urgent stop, write no plan change (Tally, `plans/` or another tool). Never clear the stop. Never change limits.
- Never run `tally-mention`: no one is there to see the line.
- Always commit, `git pull --rebase`, and push with `node engine/cli.ts push`. A failed check means no push and a log entry.
