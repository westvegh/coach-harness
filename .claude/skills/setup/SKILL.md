---
name: setup
description: Sets up a new athlete from zero, or resumes a setup that stopped, in five clickable screens with no typed answers - basics, goal, a health check, where plans go with the data and history questions, then week 1. Use it when the user says "set me up", "get started", "start coaching me", "onboard me", "new athlete", "continue setup" or "finish setup", or when coach.yaml does not exist. It runs silent checks, uses Tally when a Tally server answers (otherwise plans go to files in this repo, or a connected tool the athlete names), writes the athlete files and coach.yaml, drafts and audits block 1, shows week 1 as a table, writes it after a yes, commits and pushes. Recovery data, automation and injury history are separate skills for later. Interactive only.
---

# Setup

Set up one athlete with as little friction as possible. Count every question, click, typed answer, wait and permission prompt, and keep them few.

- Each screen is one AskUserQuestion call (at most 4 questions, at most 4 options each). A step with no question prints nothing unless it fails.
- Never ask for typed text. Every question has options; AskUserQuestion always adds "Other" for an athlete who wants to type.
- Athlete-facing text never shows template syntax, step numbers, rule IDs or code paths. Say what happens in plain words.
- The target: week 1 after 5 screens and 0 typed answers, with Tally or with files, for an athlete with no current pain who says "Yes" to the data question. "Show details", "I'll type a short summary", "Change something" and a limiting region are optional paths the athlete chooses; each adds one screen or one typed answer.
- Without AskUserQuestion (print mode), or when a call returns no answers, ask the same questions as text with lettered options, and wait for the answer.
- **No permission prompts.** Write and append files with the Write or Edit tool (`athlete/**`, `plans/**`, `coach.yaml` and `.tmp/coach/**` need no prompt; the Write tool creates folders, so never run `mkdir`). Run one engine command per Bash call, exactly as written here, with no `;`, `&&`, pipes, redirects, `echo`, `cat`, `head`, `grep` or `node -e`. Read the engine's output from its printed result. Read files with the Read tool. For a command's usage, run `node engine/cli.ts help <command>`.

## Screens

Every AskUserQuestion call setup can make. The steps tag each one with `(screen: <name>)`.

| Screen | Asked when | Calls |
|---|---|---|
| Basics | always | 1 |
| Goal | always | 1 |
| Health check | always | 1 |
| Plans and data | always | 1 |
| Week 1 approval | always | 1 |
| Old notes | the Tally history has pain notes | 1 |
| Region | the athlete chooses a region in the health check | 1 |
| Data details | the athlete chooses "Show details" | 1 |
| What to change | the athlete chooses "Change something" | 1 |
| Replace a day | a Tally day already exists on a week-1 date | 1 |

## Resume

Setup keeps one state line per finished part in `athlete/log/setup.md`, with the answers of that part:

`setup: <part> done <YYYY-MM-DD HH:MM> (<answers>)`

Append each state line with the Edit tool (the Write tool when `athlete/log/setup.md` does not exist yet), never with `echo` or `>>`.

The parts, in order: `checks`, `basics`, `goal`, `health`, `plans`, `files`, `week1`, `finish`. `node engine/cli.ts setup-check` prints the last line as `setup_progress`. Read every state line, take the answers from them, and skip every part already done. Say in plain words where you pick up, for example "I have your basics and your goal. Next: a short health check."

## Steps

1. **Silent checks** (no question). Run `node engine/cli.ts setup-check`.
   - Each line in `problems` stops setup. Say it in plain words and stop. An unattended run writes nothing (see Unattended).
   - `claude.ok: null` means the version is unknown: go on.
   - `npm_ci_needed: true`: run `npm ci`.
   - Run `node engine/cli.ts init-athlete`. It copies the starting athlete files and never overwrites one.
   - **Find Tally.** Look in your own tool list for a tool whose name ends in `__get_training_context`. The part between `mcp__` and that ending is the Tally server, for example `tally`, `Tally_Workout` or `claude_ai_Tally_Workout`. For each server, run `node engine/cli.ts allow-server --server <server>` first (then its tools need no permission prompt), then call its `get_training_context` with the timezone from `setup-check`. A server answers when the call returns data. Note `weightUnit` and `weightUnitSource`.
   - **The Tally history.** With a Tally server, read `get_workout_history` from 8 weeks before today to today, and follow `nextCursor` to the last page. Note the number of sessions. Run `node engine/cli.ts safety scan-notes --since <today minus 8 weeks>`: an urgent term writes the urgent stop (give the urgent-care text and stop setup); pain notes in `matches` get the `safety` skill's old-notes question (screen: Old notes).
   - **Find other tools.** Look in your tool list for connected MCP servers that are not Tally and that can hold a plan: a sheet, a document or a notes tool (for example Google Sheets, Notion or Airtable). Keep at most two, by their plain names.
   - **Find training exports.** When no Tally server answered, or the Tally history has fewer than 2 sessions, run `node engine/cli.ts history-files`. It lists the two newest `.csv` files in Downloads and on the Desktop.
   - **Worktree.** When `worktree.worktree` is true and `worktree.branch` is not `main`, work on this branch. The last step fast-forwards `main` to it. Say nothing about it unless that fails.
   - Append `setup: checks done <time> (tally <server or none>, sessions <n>, tools <names or none>)` to `athlete/log/setup.md` (Edit tool).
2. **Basics** (one AskUserQuestion call; screen: Basics):
   - "Which units do you lift in?" with "lbs", "kg". Leave it out when Tally knows the unit (`weightUnitSource` is `settings` or `history`), and use Tally's.
   - "How many days a week can you train?" with "3", "4", "5".
   - "How long is a session?" with "45 min", "60 min", "75 min", "90 min".
   - "What equipment do you have?" with "Full gym", "Home gym with a barbell", "Dumbbells and bands", "Bodyweight only".
   - Append `setup: basics done <time> (units, days, minutes, equipment)` to `athlete/log/setup.md` (Edit tool).
3. **Goal** (one AskUserQuestion call; screen: Goal): "What is your main goal?" with "All-around", "Strength", "Size", "Endurance". "Other" takes general health or anything else.
   - The emphasis: All-around → `all-around`, Strength → `strength`, Size → `hypertrophy`, Endurance → `endurance`, Other → `general-health` (or one of the four when the text names it).
   - You pick the weekdays; ask nothing. Use the method template's default days for the day count (3: Mon, Wed, Fri; 4: Mon, Tue, Thu, Fri; 5: Mon, Tue, Wed, Fri, Sat). They show in the week 1 table, where the athlete can change them.
   - Append `setup: goal done <time> (emphasis)` to `athlete/log/setup.md` (Edit tool).
4. **Health check** (one AskUserQuestion call, four questions, each `multiSelect: true`; screen: Health check). The first three cover the seven PAR-Q+ items, each with "None of these":
   - "Heart: do any of these apply?" with "A clinician said I have a heart condition or high blood pressure", "Chest pain at rest, in daily life or when I exercise", "A clinician said I should only exercise with medical supervision", "None of these".
   - "Dizziness or fainting: do any of these apply?" with "Dizziness that makes me lose balance", "Fainting in the past year", "None of these".
   - "Other health: do any of these apply?" with "Another long-term condition", "Prescribed medicine for a long-term condition", "A bone, joint or soft-tissue problem that more activity could make worse", "None of these".
   - "Is anything limiting your training now?" with "Shoulder", "Low back", "Knee", "None". "Other" takes another region, for example hip, elbow or ankle.
   - **Chest pain or fainting** (only these two): give the urgent-care text from the safety text (`URGENT_CARE_TEXT`) first, keeping every instruction. Run `node engine/cli.ts urgent set --term "chest pain" --source answer`, or `--term fainting`, or one call for each when both apply. Append `setup: health stopped <time> (urgent stop)` to `athlete/log/setup.md` (Edit tool) and stop setup. Setup goes on after the stop is cleared in a live session (the `safety` skill's clear question).
   - **Any other yes** (dizziness included; not "None of these"): say once, "Get clearance from a clinician before you train hard. I record what you report." Write each item in `athlete/brief.md` under "Health" as a short fact. Setup goes on.
   - **A region** in the last question: run the `safety` skill for it now (screen: Region): its one question screen (two regions per screen), then the limit the athlete chose.
   - Never ask for medication names, and never comment on medication.
   - Append `setup: health done <time> (clearance yes|no, regions or none)` to `athlete/log/setup.md` (Edit tool).
5. **Plans and data** (one AskUserQuestion call, at most four questions; screen: Plans and data).
   - **Which Tally account**, only when two or more Tally servers answered with different data (a different last session or profile): "Which Tally account holds your training?" with at most four options, one per server, newest last session first, each named by that date.
   - **Where plans go**, only when no Tally server answered: "Where should your plans go?" with "Files in this repo (Recommended)" first (description: "A spreadsheet per week. Log in any spreadsheet app, or tell me in chat."), then "Tally" (description: "Log sets on your iPhone at the gym, and the coach reads them back."), then each connected tool found in step 1 by its plain name, for example "Google Sheets" (description: "Plans go in your Google Sheets."). Four options at most. "Other" takes another tool.
   - **The data question**, always. With a Tally server: "Your data goes to Anthropic (Claude), GitHub (this private repo) and Tally (plans, history and coach notes, which can include readiness and pain scores). OK?" Without one: "Your data goes to Anthropic (Claude) and GitHub (this private repo). If you choose Tally, Tally also gets your plans, history and coach notes, which can include readiness and pain scores. OK?" The options: "Yes", "Show details".
   - **The history question**, only when no Tally server answered or the Tally history has fewer than 2 sessions: "Do you have a record of your recent training?" with one option per file from `history-files` (at most two, named by the file name and its folder, for example "strong.csv in Downloads"), then "I'll type a short summary", then "Skip". "Other" takes a path to a file.
   - The answers:
     - "Show details" (an optional path; screen: Data details): say what each one gets (Anthropic: this conversation and the files the coach reads; GitHub: this private repository with your plans and athlete files; Tally: plans, workout history and short coach notes). Then ask once more: "Yes", "Yes, but keep Tally notes generic", "No". "No": stop setup, and say why in one line (the coach needs Claude and the private repository). "Keep Tally notes generic": write `consent.logger_health_notes: false`. A plain yes needs no key (the default is true).
     - Tally, and a server answered: `logger: tally`.
     - Tally, but no server answered: `logger: files` for now. Say: "Tally is not connected yet, so week 1 goes in a spreadsheet file for now. To connect Tally, open claude.ai, then Settings, then Connectors, and add Tally. Then say 'move my plans to Tally'."
     - Files: `logger: files`.
     - A connected tool: run `node engine/cli.ts allow-server --server <server>` for it, then `logger: other`; use that tool and follow its own instructions. A tool named under "Other" that is not in your tool list: say "I can't reach that tool from here, so your plans go in a spreadsheet file in this repo for now." and use `logger: files`.
     - A file: read it with the Read tool (the CSV files in Downloads and on the Desktop need no permission prompt). Take the last 8 weeks: the exercises, the sessions per week and the top set of each lift. Write a short summary in `athlete/brief.md` under "Training history". The top sets give the starting loads (the `history` in the loads input in step 7). Do not keep a copy of the file.
     - "I'll type a short summary" (an optional path, one typed answer the athlete chose): ask "Tell me in a line or two: what you train, how often, and your best recent lifts." Write it in `athlete/brief.md` under "Training history", in short facts.
     - "Skip": start light. The first weeks set the loads.
   - Append `setup: plans done <time> (logger, notes detailed|generic, history file|summary|skip|tally)` to `athlete/log/setup.md` (Edit tool).
6. **Write the athlete files** (no question).
   - Fill `athlete/brief.md` from the answers, with the Write tool: the goal, days, session length, equipment and the health facts. Short facts only: no medication names, no clinician narratives.
   - Write `coach.yaml` last, with the Write tool, from `coach.example.yaml`: `athlete.name` from `setup-check` `name` (else `Athlete`), `athlete.timezone` from `timezone`, `athlete.units`, `method: nine-adaptations` (or the only folder under `methods/`), `template: { days, emphasis }`, `signals: { wearable: none, checkin: chat }` (the `recovery-data` skill changes it later), `logger`, `consent` only for generic notes, `automation.mode: manual` and `verified: false`. With Tally, add `automation.tool_prefix: mcp__<server>__`. Keep `approval` and `thresholds` as in the example. Leave out `sleep_target_min` (the engine uses 480).
   - Run `node engine/cli.ts config-check`. Fix each problem it prints in `coach.yaml`.
   - Append `setup: files done <time>` to `athlete/log/setup.md` (Edit tool).
7. **Week 1** (one AskUserQuestion call; screen: Week 1 approval).
   - **The method, in one line:** "The coach plans from one method: fitness as nine qualities (strength, size, endurance and others), from Andy Galpin's public teaching. You chose strength, so that gets the most sets." Use the goal the athlete chose in place of "strength". For all-around, say "You chose all-around, so the sets are spread across the qualities." instead of the last sentence.
   - **Draft block 1** (no question). Follow the `block` skill steps 4 to 6, without their questions:
     - Exercises for each template slot. With Tally, find each one with `search_exercises`. With files or another tool, use plain exercise names that fit the equipment. Never one that a limit in `athlete/limits.yaml` bans.
     - `node engine/cli.ts ids next --kind block`, then write `.tmp/coach/draft.json` with the Write tool (`{id, start, emphasis, exercises}`, `start` the next Monday), then run `node engine/cli.ts block draft --weeks <n> --input .tmp/coach/draft.json` alone, with `n` from `deload_every_weeks` in the method's rules. Keep its printed output (no redirect): the week-1 entry of `weeks` is week 1.
     - Loads: write `.tmp/coach/loads.json` with the Write tool (`{exercises}` of each drafted day, plus `history` from a training export) and run `node engine/cli.ts loads --input .tmp/coach/loads.json`. Use its `suggestedWeight` values.
     - Audit week 1 yourself, without a question: run the `audit` skill's engine checks (`node engine/cli.ts volume` and `node engine/cli.ts limits check` on week 1) and read the method rules. Fix every hard finding and every limits conflict. When a soft finding is left, say it in one line.
   - **The table.** Show week 1 in one table: the day (weekday and date), the focus, and each exercise with sets × reps and load. Then one AskUserQuestion: "Week 1 is ready. Write it?" with "Write it to Tally" (with Tally), "Write it to a spreadsheet file" (with files) or "Write it to your tool" (with another tool), and "Change something".
   - "Change something" (an optional path; screen: What to change): ask "What should change?" with "The weekdays", "An exercise", "The session length", "Something else". Make the change, run the checks again, and show the table again.
   - **After the yes, write `athlete/block.yaml`** (the `block` object from `block draft`, as printed). It must exist before week 1.
   - **Write week 1.** Every planned day of week 1: the `days` of the `block draft` entry with `week: 1` (one date each). Their number is the planned count.
     - **Tally:** read every date of week 1 with `get_planned_workout` (empty dates too) and read `get_training_context`. All reads must be under 15 minutes old at each write; read again if more time passed. Each drafted exercise becomes one Tally exercise: `exerciseId` and `name` as drafted, `suggestedSets` = the number of entries in its `sets`, `suggestedReps` and `suggestedWeight` from its first set. An empty date: `plan_workout_day` with `ifAbsent: true`. A day that exists (screen: Replace a day): ask "Replace the day already there? A) Yes, B) No"; after a yes, `plan_workout_day` with `expectedVersion` and `replace: true`. Add `opId` from `node engine/cli.ts opid --date <date> --kind block_session --input .tmp/coach/call.json` (the call input written with the Write tool) when `adapters/loggers/tally/adapter.yaml` says `capabilities.opId: true`. On a refusal, read the reason.
     - **Check the count** (Tally): after the last write, read every week-1 date back with `get_planned_workout`. Count the dates that hold the drafted day, and compare the count with the planned count. **A missing day:** read that date again and write it once more, the same way. If it is still missing, do not try again: tell the athlete the date, the day's focus and Tally's reason. Week 1 is complete only when the counts match.
     - **Files:** write `.tmp/coach/week1.json` with the Write tool (`{days}`: the drafted days with the loads from `loads`) and run `node engine/cli.ts plans write --input .tmp/coach/week1.json`. Say where it is, with the real file name: "Week 1 is in plans/2026-W43.csv in this folder. Open it in Numbers, Excel or Google Sheets and fill the done columns, or tell me in chat after each session."
     - **Another tool:** write each day with that tool, following its own instructions, and read each day back. When the tool stops answering, say so in one line, run `node engine/cli.ts logger set files`, and write week 1 to files.
   - Append `setup: week1 done <time> (planned count, written count)` to `athlete/log/setup.md` (Edit tool).
8. **Finish** (no question unless something fails).
   - Run `node engine/cli.ts install-git-hooks`, then `node engine/cli.ts prepush-check`. It prints `ok: true` when the pre-push hook is installed and the repository is private: go on. With `ok: false`, push nothing and say why in one line: a public repository ("This repository is public. Make it private on GitHub, then say 'finish setup' to save your plan there."), no GitHub login, or no remote (a copy on this Mac only: say nothing).
   - Run `node engine/cli.ts commit --message "setup: athlete files, block 1 and week 1"`. A nonzero exit: stop, and say in one line that the commit failed and why (its `reason`). Push nothing.
   - **Worktree** (`worktree.worktree` is true and the branch is not `main`): run `node engine/cli.ts worktree ff-main`. It fast-forwards `main` in the main checkout when that checkout is clean. With `ok: false`, say in one line that main was not updated, and why. Then push main with `node engine/cli.ts push --branch main`. Otherwise run `node engine/cli.ts push`. A cloud run clones `main`, so the setup must be there before any automation.
   - Append `setup: finish done <time>` to `athlete/log/setup.md` (Edit tool).
   - **The final message is plain** (CLAUDE.md "Style"): no file paths, no block, limit or rule ids, no command names. For example, say "No limits yet." and never name the limits file; say "Block 1 starts Monday, October 19." and never the block id. The one exception: with files, name the week's plan file once, so the athlete can open it.
   - End with one line: "Later you can add recovery data (Oura or Apple Health), daily and weekly automation, injury history or assessments. Just ask."

## Writes

- `athlete/` starting files (through `node engine/cli.ts init-athlete`), `athlete/brief.md`, `athlete/log/setup.md`.
- `athlete/limits.yaml`, only through the `safety` skill (the athlete's choice for a region).
- `coach.yaml`, once, in step 6 (and `logger` through `node engine/cli.ts logger set files` when another tool stops answering).
- `athlete/block.yaml`, after the athlete's yes.
- Week 1: Tally with `plan_workout_day` (`ifAbsent: true`, or `expectedVersion` after a yes); or `plans/<YYYY>-W<ww>.csv` through `node engine/cli.ts plans write`; or the athlete's own tool.
- `.claude/settings.local.json`: the allow rules for the Tally server and a chosen tool (through `node engine/cli.ts allow-server`).
- Git: one commit of `athlete/`, `plans/` and `coach.yaml`, pushed to `main` (in a worktree, `main` is fast-forwarded first).

## Unattended

Setup never runs unattended. When `setup-check` lists "setup needs an interactive session", write nothing, log "setup needs an interactive session", and stop.
