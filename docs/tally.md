# Tally, the reference logger

[Tally](https://tallyworkout.app) is an iPhone app for strength training. coach-harness uses it as its reference logger: the coach writes your plan to Tally, you log your sets in Tally at the gym, and the coach reads your log back the next day.

## What Tally does for the coach

Tally has an MCP server. Through it, the coach can:

- read your training context, your planned days, your workout history and your exercise progress;
- search Tally's exercise library;
- plan a day or a range of days, update part of a day, move a day, skip a day, or delete a day.

Every write carries the version of the day that the coach read, so a write never replaces a change that you made in the app since then. Tally also protects the days that you built or edited yourself: the coach can change them only after you say yes.

Tally stores your plan and your workout log. It does not receive your health data from coach-harness: sleep, HRV and resting heart rate stay in your private repository.

## Is Tally required?

You need a logger: the app that holds the plan and your log. Tally is the only logger adapter that ships today, and it needs an iPhone. You can add an adapter for another app; see [adding-a-logger-or-signal.md](adding-a-logger-or-signal.md).

## Connect Tally

Install Tally on your iPhone and sign in. Then connect its MCP server in one of these ways. The `setup` skill checks the connection and stops until it works.

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

Both ways work with the guard. It matches every Tally write tool by name, whatever the connector prefix (`mcp__tally__…`, `mcp__claude_ai_Tally_Workout__…`, `mcp__Tally_Workout__…`).

## How the coach writes to Tally

- The coach reads each day with `get_planned_workout` before it writes, and passes the version it read.
- The coach prefers `update_planned_workout` for partial changes. It never deletes a day and then writes it again.
- Each write carries an operation ID, so a repeated run cannot make the same change twice.
- After each write, the coach reads the day back and records the result in `athlete/log/`.
- The guard checks every write first. See [how-it-works.md](how-it-works.md).

## Disconnect

Remove the Tally connector in claude.ai (**Settings → Connectors**), or run `claude mcp remove --scope project tally` for the project server. To delete your plan and log, delete your account in the Tally app.
