# Tally, the reference logger

[Tally](https://tallyworkout.app) is an iPhone app for strength training. coach-harness uses it as its reference logger: the coach writes your plan to Tally, you log your sets in Tally at the gym, and the coach reads your log back the next day.

## What Tally does for the coach

Tally has an MCP server. Through it, the coach can:

- read your training context, your planned days, your workout history and your exercise progress;
- search Tally's exercise library;
- plan a day or a range of days, update part of a day, move a day, skip a day, or delete a day.

Every write carries the version of the day that the coach read, so a write never replaces a change that you made in the app since then. Tally also protects the days that you built or edited yourself: the coach can change them only after you say yes.

Tally stores your plan, your workout log and a short coach note on each day the coach changes. **By default, that note can include health details:** readiness values (sleep, HRV, resting heart rate), body regions and pain scores. To keep them out of Tally, choose "Show details" on setup's data question, then "Yes, but keep Tally notes generic". You can also set `consent.logger_health_notes: false` in `coach.yaml` at any time. Then the notes stay generic, for example "Adjusted for recovery", and the details stay in your private repository. See [safety-and-privacy.md](safety-and-privacy.md).

## Is Tally required?

No. Setup offers three places for your plans:

- **Files in this repo** (the default without Tally): one spreadsheet file per week, `plans/<YYYY>-W<ww>.csv`. You fill in what you did in a spreadsheet app, or you tell the coach in chat.
- **Tally**, which needs an iPhone.
- **Another tool you connected** to Claude Code, such as a sheet or a notes tool.

You need Tally only for the scheduled daily and weekly runs. Without it, you ask the coach yourself ("how should I train today?", "plan next week"). You can switch at any time: say "move my plans to Tally". To add an adapter for another app, see [adding-a-logger-or-signal.md](adding-a-logger-or-signal.md).

## Connect Tally

Install Tally on your iPhone and sign in. Then connect its MCP server in one of these ways. If you choose Tally in setup and no Tally server answers, setup puts week 1 in a spreadsheet file for now. Connect Tally later, then say "move my plans to Tally".

### In claude.ai (also used by Claude Code and by cloud routines)

1. Open claude.ai, then **Settings → Connectors**.
2. Add the Tally connector and sign in with your Tally account.

Claude Code uses your claude.ai connectors when you sign in to Claude Code with your claude.ai account. Cloud routines also need this connector: setup pins each routine to the Tally connector only.

### In Claude Code only (a project MCP server)

Add the server to the project and sign in when Claude Code asks:

```sh
claude mcp add --transport http --scope project tally https://mcp.tallyworkout.app/api/mcp
```

Then run `/mcp` in Claude Code to check that `tally` is connected.

Both ways work with the urgent stop. While it is on, the urgent gate denies every plan-write tool by name, whatever the connector prefix (`mcp__tally__…`, `mcp__claude_ai_Tally_Workout__…`, `mcp__Tally_Workout__…`).

## How the coach writes to Tally

- The coach reads each day with `get_planned_workout` before it writes, and passes the version it read.
- The coach prefers `update_planned_workout` for partial changes. It never deletes a day and then writes it again.
- Each write carries an operation ID, so a repeated run cannot make the same change twice.
- After each write, the coach reads the day back and records the result in `athlete/log/`.
- While the urgent stop is on, code blocks every plan write. No other hook checks a write: the coach follows these steps itself. See [how-it-works.md](how-it-works.md).

## Disconnect

Remove the Tally connector in claude.ai (**Settings → Connectors**), or run `claude mcp remove --scope project tally` for the project server. To delete your plan and log, delete your account in the Tally app.
