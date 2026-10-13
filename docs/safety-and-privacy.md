# Safety and privacy

## Not medical advice

coach-harness plans and adjusts training. It is not a medical device, and it is not medical advice. The coach does not diagnose and does not treat. It never gives advice about medication, supplements, hormones or peptides. It never sets under-fuelling or rapid weight-loss targets. For pain, an injury or a health question, talk to a clinician.

## Safety

Code enforces two rules: the urgent stop and privacy (see "The pre-push check"). Everything else in this section is the coach's judgment, guided by `CLAUDE.md`, the skills and the method pack. No hook checks a plan before it is written.

### The urgent stop

A Claude Code hook (`.claude/hooks/safety-detect.ts`) reads every message you send before Claude sees it. It looks for urgent warning signs only: chest pain, fainting, new numbness or weakness, severe shortness of breath, a sudden severe headache and the other urgent terms in `engine/safety-terms.yaml`. It also matches a term that you negate ("no chest pain"): a false alarm costs one question.

Four routes start the stop: a chat message (the hook), a check-in that names an urgent sign, a logged note with an urgent term (the daily and weekly runs scan your notes), and anything else the coach recognizes, for example an answer in setup's health check (`node engine/cli.ts urgent set`).

When the stop starts:

- The coach gives the urgent-care text first ([safety.md](safety.md)) and makes no training change.
- `athlete/.urgent-stop` is written and committed. It holds the term names, the sources and a time. It never holds your words. The message hook writes and commits it, and the coach pushes it next with `node engine/cli.ts push`; the other routes (`urgent set`, the check-in, the note scan) also push it themselves. A cloud run sees the stop only after that push.

**What code blocks while the stop exists:**

- every MCP tool, on any server, whose name ends in `plan_workout_day`, `plan_workout_range`, `update_planned_workout`, `move_planned_workout`, `skip_planned_workout`, `delete_planned_workout`, `update_user_profile` or `update_training_limits` (a PreToolUse hook, `.claude/hooks/urgent-gate.ts`; it blocks when it fails, so an error cannot let a write through);
- Edit, Write and MultiEdit of any file under `plans/` (the same hook);
- `node engine/cli.ts plans write` and `plans done` (they refuse);
- `node engine/cli.ts urgent clear` in a scheduled run, or without `--reason clinician` or `--reason false-alarm` (it refuses).

**What is the coach's instruction only:** the urgent-care text; no change in a tool you connected yourself (`logger: other`: the hook cannot know that tool's names); no plan change through the shell (a shell command that writes under `plans/` is not checked); and asking you before it runs `urgent clear`.

Only your answer in a live session should clear the stop. The coach asks one question: "A clinician has seen me about it", "It was a false alarm" or "Not yet". The first two run `node engine/cli.ts urgent clear --reason clinician` or `--reason false-alarm`, which append a record (date, terms, sources, reason; no symptom text) to `athlete/log/urgent-clearances.jsonl` and delete the stop. "Not yet" keeps it. The command cannot tell whether you answered: that is the coach's instruction. A scheduled run cannot clear it.

### Pain and injuries

When you mention pain or an injury, the coach (the `safety` skill) asks one screen of clickable questions:

- how to handle the region: "It's fine now: train normally", "Go light and build back slowly", or "Avoid loading it for now";
- which side, when the region has sides;
- "Any of these now?": new numbness or weakness, swelling with heat or redness, cannot bear weight, or none. A warning sign starts the urgent stop.

Then it writes the limit you chose: no limit (a log line), a cap on weekly sets that builds back each week when the region feels fine, or a ban on the movements that load the region. When you say the region is better, it asks one question: remove the limit, loosen it, or keep it.

The coach never diagnoses, never names a likely cause, and says once per conversation: "See a clinician for new pain, pain that gets worse, or pain that does not settle." In a scheduled run it asks nothing: it avoids loading the region that day, leaves a note, and asks at the next live session.

When you report what a clinician told you, the coach records it as `clinician-reported`. It never claims to verify it.

### Your limits

Your limits live in `athlete/limits.yaml`. A limit can ban a movement pattern or an exercise, or cap the weekly sets or the load for a body region. The coach reads the file before every plan and checks each planned week with `node engine/cli.ts limits check`, which reports a banned exercise, a weekly set count over a cap, a set over a load cap, and any exercise the engine cannot classify. The coach fixes each finding before it writes. The `audit` skill runs the same check on request.

This is guidance, not a gate. The coach can misread a limit, and no hook stops that write. Two things make a mistake visible: git records every plan change, and your logger shows the plan. The evals in `evals/` measure it: three limit shapes (a ban, a weekly set cap and a load cap), ten planned weeks each.

The coach changes a limit only when you ask (the `limits` skill, or the `safety` skill for a new or better region), and commits the change. A scheduled run never changes a limit.

## Where your data lives

| Data | Where it lives | Who can read it |
|---|---|---|
| Your brief, limits, block and log (`athlete/`) | Your private GitHub repository | You and GitHub |
| Your weekly plans and logged sets, with `logger: files` (`plans/`) | Your private GitHub repository | You and GitHub |
| Apple Health data (sleep, HRV, resting heart rate) and check-ins from the Shortcut | `athlete/signals/` in your private repo. Your own Shortcut sends it with your own GitHub token. | You and GitHub |
| Oura data | `athlete/.cache/` on your Mac (not committed) | You |
| Oura app credentials and tokens | The macOS Keychain on your Mac | You |
| Your plan, your workout log and a short coach note on each changed day, with `logger: tally` or `other` | Tally, or the tool you connected | You and that service |
| Your conversations with the coach | Anthropic, as for any Claude Code session | You and Anthropic |

The harness itself has no server. It sends nothing to the harness authors.

### Notes in your logger

The coach writes a short note on a day it changes in Tally. **By default the note can include health details:** readiness values (sleep, HRV, resting heart rate), body regions and pain scores. To keep them out, choose "Show details" on setup's data question, then "Yes, but keep Tally notes generic". Then the notes stay generic, for example "Adjusted for recovery" or "Rest day: see your coach repo", and the details stay in your private repo. Your choice is `consent.logger_health_notes` in `coach.yaml` (`false` keeps the notes generic); change it there at any time.

Setup asks one data question that names each recipient: Anthropic (Claude), GitHub (your private repo) and, with Tally, Tally ("plans, history and coach notes, which can include readiness and pain scores"). Oura and the Apple Health Shortcut are added later (the `recovery-data` skill), and that skill names them. Setup also checks that your repository is private before the first push.

### What git records

Git records every change to `athlete/`, `plans/` and `coach.yaml`: the coach commits after each change, and a Stop hook commits any changed file under those paths that is left. Each Tally write also gets a summary line in your athlete log (`athlete/log/`), which is committed; the Tally day itself is not in git. A change the coach makes in another tool you connected is not recorded.

### A training export at setup

Without Tally history, setup looks for a workout export in `~/Downloads` and `~/Desktop`. It reads only the first line (the column names) of each `.csv` file there, and lists only files whose columns look like a workout export. It never prints the column names, and never names a file that does not match. The coach reads the full contents of one file only: the one you choose, and only its last 8 weeks. It writes a short summary to `athlete/brief.md` and a normalized copy to `.tmp/coach/history.json` (scratch, not committed). That file content goes to Anthropic as part of the conversation.

### The Apple Health Shortcut

The Shortcut runs on your phone and uses a fine-grained GitHub token that can write to one repository only. The token stays in the Shortcut on your phone. Revoke it on GitHub at any time. The guide is `adapters/signals/apple-health-shortcut/SHORTCUT.md`.

### Oura

The Oura fetcher uses your own Oura API application. Its client ID, client secret and tokens are in the macOS Keychain (service `coach-harness.oura`). Nothing is written to the repository. Error messages never include a token or a server response.

## What each automation mode sends where

| Mode | Runs on | Sends |
|---|---|---|
| Manual | Your computer, when you talk to the coach | Your conversation to Anthropic; plan reads and writes to your logger; commits to your private repo when you push. |
| Mac | Your Mac, through launchd | The same as manual, plus Oura API calls from your Mac. The run uses your claude.ai login, not an API key. |
| Cloud | Claude Code cloud routines | Anthropic clones your private repo into a cloud session. The run reads and writes your logger through its claude.ai connector only, then pushes commits to your repo. |

A cloud routine gets only the logger connector, not the other connectors on your account. Oura does not run in the cloud.

### What a scheduled run may do

A scheduled run (Mac or cloud) has no one to answer a prompt, so it runs with `--permission-mode dontAsk` and a list of the tools it may use (`engine/automation.ts`, `UNATTENDED_TOOLS`):

- **Shell:** `node engine/cli.ts <command>`, `git status`, `diff`, `log`, `add`, `commit`, `pull` and `switch`, `gh api`, `date` and `printenv CLAUDE_CODE_REMOTE`. Pushes go through `node engine/cli.ts push`, which checks that your repository is private first.
- **Files:** Edit and Write under `athlete/log/` and `.tmp/coach/`. Plans are written through the engine (`plans write`) or the logger's tools.
- **Logger tools:** the 11 Tally tools, under the exact names of the Tally server you connected. Before Mac automation is installed, a probe run proves those names.

This list is what lets the run work. It is not a second gate: no hook checks it again. The scheduled runs need Tally for now.

### Permissions in a live session

`.claude/settings.json` allows the exact commands the coach runs in normal use (each engine command it needs, `npm ci`, the push and the update check), and file edits under `athlete/`, `plans/`, `coach.yaml` and `.tmp/coach/`. Claude Code asks you before any other shell command. No hook reads the commands you approve, so read each one before you approve it, and do not approve a command you do not understand. Text in a logger note or a web page could try to persuade the model to run something; the data sources are your own, and your git history is the record of every change.

## The pre-push check

Setup installs a git `pre-push` hook (`git-hooks/pre-push`). Git does not clone the hooks folder, so a scheduled run pushes only through `node engine/cli.ts push`. That command installs the hook again, runs `node engine/cli.ts prepush-check` (the hook is installed and GitHub reports the repository as private), and pushes only when the check passes. A failed or public check means no push and a log entry. A fresh clone has no git hook, so the session-start hook installs it when it is missing. Before each push, the hook looks up the visibility of the destination repository on GitHub.

- If the lookup fails, the push is blocked.
- If the destination is public and any commit in the push touches your athlete data, the push is blocked. Athlete data is `athlete/`, `plans/` (your weekly plans and logged sets) and `coach.yaml`.

The hook checks each push only. If you later make the repository public in GitHub's settings, the hook cannot stop that. Keep your copy private. The session-start hook also warns when a tracked file holds a token or athlete data in the wrong place.

## Delete your data

1. Delete your private repository on GitHub.
2. Revoke the Shortcut's GitHub token, and remove the logger connector from Claude.
3. Delete your Oura API application and run `security delete-generic-password -s coach-harness.oura -a tokens` (and the same for `client_id` and `client_secret`).
4. Delete your account in your logger app if you want your plan and log gone too.

## Report a problem

See [SECURITY.md](../SECURITY.md) to report a security problem privately.
