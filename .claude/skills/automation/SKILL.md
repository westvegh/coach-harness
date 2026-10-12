---
name: automation
description: Sets up the daily and weekly runs after setup - cloud routines, this Mac (launchd), or by hand - with a test run before anything counts as on. Use it when the user says "automate it", "set up automation", "run it every morning", "schedule the daily run", "cloud routine" or "run on my Mac". It asks one question, creates the routines or launchd agents after a yes, runs one test inside its window, and sets automation.mode and verified in coach.yaml only after that run succeeds. Interactive only.
---

# Automation

The daily run (`today` skill) adjusts today's session; the weekly run (`week` skill) plans next week. Automation starts them on a schedule. Until a test run succeeds, `coach.yaml` keeps `automation.mode: manual` and `verified: false`.

## Steps

1. **Mode and logger.** Run `node engine/cli.ts mode`. Unattended: stop (see Unattended). Read `coach.yaml`.
   - The scheduled runs read and write Tally. With `logger: files` or `other`, say: "The scheduled runs need Tally for now. Say 'how should I train today?' each morning and 'plan next week' on Sunday." Keep `automation.mode: manual` and stop.
2. **Pushed first.** A cloud run clones `main`. Run `node engine/cli.ts prepush-check`; with `ok: true`, run `node engine/cli.ts commit --message "automation: before the first run"` (a nonzero exit: stop, and say in one line that the commit failed and why), `git pull --rebase` and `node engine/cli.ts push`. With `ok: false`, say why in one line and offer only the Mac or by hand.
3. **Ask once** (one AskUserQuestion call): "How should the daily and weekly runs start?" with "Cloud routines" (description: "They run even when this Mac is off."), "This Mac" (description: "It must be on and awake at the run times."), "By hand".
4. **Cloud.** Check that the repo has a GitHub `origin` and that step 2 pushed. For each kind (`daily`, `weekly`):
   1. Run `node engine/cli.ts routine-body --kind <kind> --repo-url <url> --discover --disabled`.
   2. Create the routine with RemoteTrigger using that body. It is created disabled.
   3. Save the returned `mcp_connections` to `.tmp/coach/connections.json`.
   4. Run `node engine/cli.ts routine-body --kind <kind> --repo-url <url> --connections .tmp/coach/connections.json`. With `NO_TALLY_CONNECTOR`, stop and give the Tally connect steps (claude.ai, then Settings, then Connectors).
   5. Update the routine with that body (the Tally connector only, enabled).
   6. Run it once, inside its window (daily: `daily_window`; weekly: the `weekly` day and time). Outside the window the run stops at `window-check` and writes no log. Then run `git pull --rebase` and read the new log entry that the run pushed.
   7. Only when that log entry shows success: set `automation.mode: cloud` and `automation.verified: true` in `coach.yaml`. Otherwise keep `manual` and `false`, and show the error.
5. **This Mac.** Run `node engine/cli.ts install-launchd --kind both` (a dry run). It puts the connected Tally server's exact tool names into the allowlist: `coach.yaml automation.tool_prefix`, else the servers that `claude mcp list` shows. Check `tool_prefixes` in its output against the prefix of the Tally tools you call in this session; when they differ, pass `--tool-prefix <prefix>`. Show the plists in short. Ask "Install the two Mac runs? A) Yes, B) No". After a yes, run `node engine/cli.ts install-launchd --kind both --yes --load`. It first makes a probe run in the scheduled environment and installs nothing when the probe cannot call Tally (`LOGGER_PROBE_FAILED`). After the first run, read its log entry. Only when it shows success: set `automation.mode: mac` and `verified: true`.
6. **By hand:** keep `automation.mode: manual`. Say "Say 'how should I train today?' each morning, and 'plan next week' on Sunday."
7. **Commit.** Run `node engine/cli.ts commit --message "automation: <mode>"` (a nonzero exit: stop, and say in one line that the commit failed and why), then `git pull --rebase` and `node engine/cli.ts push`.

## Writes

- `coach.yaml` `automation` keys only, after a confirmed run.
- Routines (RemoteTrigger) or launchd agents, after a yes.
- `.tmp/coach/connections.json`.
- Git: commits, pushed to `main`.

## Unattended

Never in an unattended run: routines and launchd agents need the athlete's yes. Write nothing and stop.
