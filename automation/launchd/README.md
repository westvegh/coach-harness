# Mac runs (launchd)

Use Mac mode when the cloud cannot do the job. The main case is Oura: v1 reads Oura on the Mac, because a cloud run cannot reach it (see `../routine.md`).

Set `automation.mode: mac` in `coach.yaml`.

## Install

```sh
node engine/cli.ts install-launchd --kind both            # shows the plists; writes nothing
node engine/cli.ts install-launchd --kind both --yes      # writes ~/Library/LaunchAgents/dev.coach-harness.{daily,weekly}.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.coach-harness.daily.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.coach-harness.weekly.plist
```

`--yes --load` writes the files and runs `launchctl bootstrap` for you. Without `--yes`, the command writes nothing.

**The claude path.** launchd starts the agent with a short PATH that does not hold `~/.local/bin`, where Claude Code installs. So `install-launchd` runs `command -v claude` in your shell, checks that the file exists and is executable, and writes that absolute path into `ProgramArguments`. If it finds no `claude`, it stops with `CLAUDE_NOT_FOUND` and writes nothing. To use another path, pass `--claude <absolute path>`. If you move or reinstall Claude Code, run `install-launchd` again.

To see one plist without installing it: `node engine/cli.ts launchd-plist --kind daily`.

## What the agent runs

```sh
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN COACH_UNATTENDED=1 \
  /absolute/path/to/claude -p "First run: node engine/cli.ts window-check --kind daily. … Otherwise read .claude/skills/today/SKILL.md and follow it exactly. Unattended run. …" \
  --permission-mode dontAsk --allowedTools Read Glob Grep "Bash(node engine/cli.ts:*)" "Bash(git status:*)" … "Write(athlete/log/**)" … mcp__claude_ai_Tally_Workout__…
```

- **`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are unset.** With an API key set, `claude -p` disables the claude.ai connectors (so Tally is gone) and bills usage to the API. Without them, the run uses your claude.ai login.
- **`COACH_UNATTENDED=1`** puts the hooks in unattended mode. The guard then denies big changes, as in a cloud run.
- **`--allowedTools`** is an exact, narrow list (`UNATTENDED_TOOLS` in `engine/automation.ts`): no open `Bash`, `Write` or `Edit`. Bash runs only the engine CLI (pushes go through `node engine/cli.ts push`), `git status|diff|log|add|commit|pull|switch`, `gh api` on this repository, `date` and `printenv CLAUDE_CODE_REMOTE`, with plain words only. `Edit` and `Write` reach only `athlete/log/**`, `athlete/proposals/**` and `.tmp/coach/**`. The file guard enforces the same list again.
- **The Tally tool names** use the prefix of the Tally server you connected (`mcp__tally__`, `mcp__Tally_Workout__` or `mcp__claude_ai_Tally_Workout__`). Setup records it in `coach.yaml` `automation.tool_prefix`; otherwise `install-launchd` finds it with `claude mcp list`. It writes it into the list and makes a probe run before it installs anything.

## Schedule

launchd uses the Mac's local time, so the plist needs no UTC conversion and follows daylight saving time. The daily agent runs every hour from `daily_window.start` to `daily_window.end`. The weekly agent runs at `weekly.day` and `weekly.time`. The Mac must be awake. launchd runs a missed job once when the Mac wakes; if that is outside the window, `window-check` stops it.

The log is `athlete/.cache/launchd-<kind>.log` (ignored by git).

## Remove

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.coach-harness.daily.plist
rm ~/Library/LaunchAgents/dev.coach-harness.daily.plist
```

Do the same for `weekly`.
