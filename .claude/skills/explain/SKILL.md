---
name: explain
description: Explains why the plan is what it is, by tracing a change from its log entry to the signals, the readiness numbers, the rule IDs and their sources. Use it when the user asks "why is today shorter?", "why did you change my workout?", "why a recovery day?", "why this weight?", "why didn't my squat go up?", "what does NA-PROG-001 mean?", "explain my readiness", "why is next week lighter?", or "what happened on Tuesday?". It reads only and changes nothing.
---

# Explain

Trace every answer to data. Never guess a reason.

## Where plans live

Read `coach.yaml logger` and follow CLAUDE.md "Where plans live". With `logger: files`, read a day with `node engine/cli.ts plans read --week <date>` instead of `get_planned_workout`, and skip the history reads: `readiness`, `loads` and `weeks` read `plans/` by themselves. The week files are in git, so `git log -p plans/` shows each change.

## Steps

1. **Find the change.** Ask, if it is not clear: "Which change? A) today, B) a date, C) next week, D) a rule". Find the log entry in `athlete/log/<YYYY-MM>.md` (`## <date> <time> · <op id>`). Read its readiness, rules, change, approval and result lines.
2. **Read the day.** `get_planned_workout` for that date: the current exercises and the `[coach]` note line.
3. **The signals.** Run `node engine/cli.ts signals --from <date minus 30 days> --to <date>`. Show the records that day used: source, `observed_at`, complete or not.
4. **The readiness numbers.** Read that date and its logged sessions first (`get_workout_history`, and `get_planned_workout` for each session date in the 4 days before), then run `node engine/cli.ts readiness --date <date>`. Its `inputs` and `sessions_judged` show what it used. Show each category's state and its reasons (z-scores, sleep ratio, check-in mean, shortfall), `known`, and `decision`. If the result differs from the log, say so and give both.
5. **The rules.** For each rule ID, read its entry in `methods/<method>/rules.yaml` (text, kind, severity, check) and its source in `methods/<method>/sources.md` (title, link, timestamp). Name the principle file that cites it (`methods/<method>/principles/*.md`).
6. **Loads and volume**, when asked:
   - Loads: `node engine/cli.ts loads --from-snapshot <date>` after a `get_planned_workout` read of that date. Show the reason for each.
   - Volume: `node engine/cli.ts weeks --from <block start> --to <date>`, then `node engine/cli.ts targets --input .tmp/coach/targets.json` with those `logs`. Show the reference week, the planned sets and the capped sets.
   - A change's size (small or big): `node engine/cli.ts classify --input .tmp/coach/call.json`.
   - A plan against the limits: `node engine/cli.ts limits check --input .tmp/coach/week.json`.
7. **Answer.** Short sentences. First the change, then the cause, then the numbers with the command that made them, then the rule `[ID]` and its source. Run the engine command for any number you do not have yet. The analyst agent is optional, for a long read (many dates or weeks); run it in the foreground (`run_in_background: false`).

## Writes

None. Explain reads only. Scratch inputs go to `.tmp/coach/` (gitignored).
