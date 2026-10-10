# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

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
