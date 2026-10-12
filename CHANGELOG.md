# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

## [0.2.1]

### Fixed

- Tests: the hook tests give their test repositories a git identity, so they pass on machines with no git user set (the template's CI).

## [0.2.0]

v0.2 trusts the coach. Code enforces two rules only, the urgent stop and privacy, and the rest is the coach's judgment, guided by the method pack and the skills. Setup and pain reports take a few clicks.

### Changed for the athlete

- **Setup in five screens of clicks, with no typed answers,** on the basic path: basics, goal, a health check, where your plans and data go, and week 1 as a table. Optional paths add a screen or a typed answer only when you choose them: "Show details" on the data question, a typed summary of your training history, a region that limits your training now, and "Change something" on week 1. Recovery data, automation, injury history and assessments are separate skills for later ("add recovery data", "automate it").
- **Pain in one screen.** Say what hurts, and the coach asks one screen of clickable questions: train normally, go light and build back, or avoid loading the region for now. It writes the limit you chose. "It's better" is one question that removes or loosens the limit. No safety agent runs, and there is no hold to clear.
- **Tally is optional.** Without Tally, your plans go in a spreadsheet file per week in your repo (`plans/<YYYY>-W<ww>.csv`). Log in any spreadsheet app, or tell the coach in chat ("did all sets, last set of squats felt heavy"). You can also use a tool you already connected to Claude Code. After the third session you log by hand, the coach mentions Tally once.
- **No typed commands.** Normal flows need no `!` command and no permission prompt for the coach's own engine commands: `.claude/settings.json` allows each one exactly.
- **Proposals are log lines.** A scheduled run writes a big change as one line in your athlete log, and the coach offers it the next time you talk to it. No proposal files, branches or pull requests.

### What code enforces now

- **The urgent stop.** An urgent warning sign (chest pain, fainting, new numbness or weakness, and the other urgent terms) writes `athlete/.urgent-stop`. The message hook commits it and the coach pushes it next; `urgent set`, the check-in and the note scan push it themselves. While the stop exists, code blocks: every MCP tool, on any server, whose name ends in `plan_workout_day`, `plan_workout_range`, `update_planned_workout`, `move_planned_workout`, `skip_planned_workout`, `delete_planned_workout`, `update_user_profile` or `update_training_limits`; Edit, Write and MultiEdit under `plans/`; and `plans write` and `plans done`. Code also refuses `urgent clear` in a scheduled run and without a reason. The rest is the coach's instruction only: no change in a tool you connected yourself, no plan change through the shell, and asking you before `urgent clear`. Only your answer in a live session should clear it ("A clinician has seen me about it" or "It was a false alarm"), and the clearance is recorded.
- **Privacy.** The pre-push hook and `node engine/cli.ts push` refuse a public or unknown destination.
- **Removed:** the plan-write guard and its rebuild, the file guard (protected files, the Bash rules for scheduled runs), holds and pending safety checks, the safety agent, pain words in the message hook, approval records, and limit sync to the Tally server. The coach follows your limits by its own judgment; `node engine/cli.ts limits check` and the `audit` skill report any conflict, and the evals measure it.

### Migration from 0.1.x

The first upgrade runs the 0.1.x update skill that your session already has. From 0.1.2:

1. Open Claude Code in your main checkout (on `main`, not a git worktree: the 0.1.x update refuses another branch), and say "update the coach".
2. When it finishes, quit Claude Code and start it again. Run nothing else first: the running session keeps the v0.1 hooks until it restarts. v0.2 keeps the two old guard files as stubs that allow everything, so the old session does not lock up.
3. Say "finish the update". The v0.2 coach runs `npm ci`, installs the git hook, checks your config and runs the tests.
4. The old-files question: if your copy has `athlete/hold.yaml` or `athlete/.safety-pending`, the coach asks once: "Your copy has an old hold or safety check. The v0.2 coach uses limits instead. Remove them? A) Yes, B) Show them first". An urgent hold or an urgent term in the pending file becomes the urgent stop first, and removing the old files never clears it.

- `coach.yaml` needs no change: a v0.1 copy has `logger: tally` and stays on Tally.
- Limits already synced to Tally stay there until you remove them in the Tally app.
- Later updates from v0.2 on also work from a git worktree: the update runs where `main` is checked out, then moves your branch forward.

## [0.1.2]

### Fixed

- **Holds:** a trimmed exercise that is renamed to another movement goes through the hold checks; a cardio part of a combined exercise (for example "bike and bench press") is checked on its own; a ruck counts as knee and ankle loading, so a knee hold covers it.
- **Session start:** the safety reminder still shows when the movement list fails to load, and loads faster for urgent and pending checks.

## [0.1.1]

### Changed

- **Holds on a body part are regional.** A hold with regions blocks only exercises that load a held region (and exercises the coach cannot classify). Leg days go ahead under a shoulder hold. A hold with no region (for example dizziness) still pauses all training, and an urgent hold still allows no exercise.
- **Accepted limits can end a regional hold.** When the limits you accept cover every held region, the coach offers to end the hold in the same question.
- **Clickable safety answers.** The safety questions use Claude Code's question picker, with the same wording. Injury regions are multi-select.
- **A faster safety agent.** It knows the limits format and the hold rules, and no longer reads the engine code.

## [0.1.0]

The first public release.

### Added

- **Engine** (`engine/`): readiness from three categories (wearable, subjective, performance) judged by pattern against the athlete's own 28-day baseline (one off morning is a note; 3 or more consecutive off mornings hold progression and trim; 7 or more days with all three signals propose a deload; not wanting to train offers a recovery day), weekly volume and progression, change classification, trims and recovery days, load suggestions, block drafts, proposals and operation IDs. One CLI: `node engine/cli.ts`.
- **Guard** (`.claude/hooks/`): fail-closed checks on every logger write (fresh reads, versions, rebuild of the day and the week, safety holds, limits, the method's hard rules, consent), and protection of key files. Scheduled runs get a narrow allowlist: the engine CLI, a few git commands, `gh api` on the athlete's own repository, and writes only to the log, proposals and a scratch folder.
- **Safety:** a detector for pain words and urgent warning signs on every message, holds that only a live yes can clear, and fixed urgent-care and pain-referral text.
- **Method pack** `nine-adaptations`: rules with sources, prose, 3-, 4- and 5-day templates with five emphases, assessments, and a lint.
- **Skills** for setup, today, check-in, week, block, audit, limits, explain, method and update, and the `analyst`, `method-expert` and `safety` agents.
- **Signals:** Apple Health through an iOS Shortcut, Oura on the Mac, and chat check-ins.
- **Logger:** Tally, with golden parity tests for each write tool.
- **Automation:** manual, Mac (launchd) and cloud (Claude Code routines) modes; proposals as pull requests for big changes.
- **Privacy:** a pre-push hook that blocks athlete files on a public remote, `node engine/cli.ts push` (scheduled runs push only after the hook is installed and the repository is private), and a scan of tracked files for tokens and athlete data.
- **Updates:** `node engine/cli.ts update --check` and `update --yes --to <sha>` bring later template releases into a copy made with "Use this template". Each release ships `template-manifest.json` (every template file with its git mode and blob id). The update never touches `coach.yaml` or `athlete/`, settles conflicts with `--keep-mine` or `--take-template`, and commits once. The `update` skill, and `node engine/cli.ts config-check`.
