---
name: update
description: Brings the latest coach-harness fixes from the template into this coaching repo, without touching the athlete's files. Use it when the user says "update the coach", "get the latest version", "update coach-harness", "are there updates?", "pull the template fixes", "upgrade the coach" or "finish the update". It shows what changes first, settles conflicts with the user, updates only after a yes, asks for a restart when the hooks changed, then (in the new session) checks the config and runs the tests. Interactive only.
---

# Update

This repo was made with GitHub's "Use this template", so it has no link to the template. `update` compares three things for each template file: the last release this copy has (`template-manifest.json`), the new release, and the file in this repo now. It never writes `coach.yaml` or anything under `athlete/`. The one athlete-data change is the 0.3.0 limits migration in step 6, which the new version runs after the restart.

## Steps

1. **Check.** "Finish the update" after a restart: go straight to step 6.
   - **A copy in a worktree.** Run `node engine/cli.ts worktree status`. When `worktree` is true and `branch` is not `main`, the update runs where `main` is checked out. First run `node engine/cli.ts commit --message "coach: before the update"` (a nonzero exit: stop, and say in one line that the commit failed and why), then `node engine/cli.ts worktree ff-main`, so main has this branch's commits. With `ok: false`, say why in plain words and stop. Then run `node engine/cli.ts worktree main-checkout`: its `path` is `main_checked_out_at` when main is checked out somewhere, else a temporary checkout of main in `.tmp/coach/main-checkout` (`temporary: true`). It never switches another checkout's branch. Add `--root <path>` to every `update` command below.
   - Run `node engine/cli.ts update --check` (in a worktree: `node engine/cli.ts update --check --root <path>`). The update refuses when that checkout has uncommitted changes or is behind `origin`. Read `source`, `to`, `release_from`, `release_to`, `changelog`, `plan` and `conflicts`.
   - `up_to_date: true`: say "The coach is up to date (release <release_from>)." Stop.
   - An error (`UPDATE_REFUSED`, `NO_MANIFEST`, `MANIFEST_INVALID`): say the reason in plain words and stop. For uncommitted changes, commit them first. For `NO_MANIFEST`, read its message to the user: this copy cannot be updated safely.
2. **Tell the user** in plain words: the release (`release_from` to `release_to`), each new changelog heading with one line of its text, and the counts (files replaced, added, deleted, and files you changed that stay yours).
3. **Conflicts.** For each conflict, say what happened (`why`) and ask "A) keep my version, B) take the template's version (mine is saved in .tmp/coach/update-backup/)". A is `--keep-mine <path>`; B is `--take-template <path>`.
4. **Approval.** Ask "Update now? A) yes, B) no". After a yes, run `node engine/cli.ts update --yes --to <to>` with one `--keep-mine <path>` or `--take-template <path>` for each conflict (in a worktree, add `--root <path>`). In a worktree, run `node engine/cli.ts worktree ff-branch` at once: this branch moves to the updated main. With `ok: false`, say why in plain words; the update is on main, and this branch can catch up later. Then run `node engine/cli.ts worktree remove-temp`: it removes the temporary checkout only, never with force, and keeps one that has changes. Also run it when the update stops early (an error, a "no", or up to date).
5. **Restart first** (`restart_claude_code: true`). Right after `update --yes` (in a worktree, right after `worktree ff-branch`), say: "Quit Claude Code and start it again now, then say 'finish the update'. The hooks changed, and this session still runs the old ones." Run nothing else in this session: no `npm ci`, no hook install, no `config-check`, no tests, no push. Step 6 runs in the new session. When `settings_merged: true`, add: "Your own settings file was kept; the urgent-gate hook was added to it." When `local_guard_hooks` lists hooks, say they still point at old v0.1 hook files that now allow everything, so they are harmless and can be removed from `.claude/settings.local.json`.
6. **Finish the update.** In the new session after a restart (the athlete says "finish the update"), or at once when `restart_claude_code: false`, in this order:
   - Run `npm ci`. (After a restart the `npm_ci_needed` flag is gone, so run it every time.)
   - Run `node engine/cli.ts install-git-hooks`.
   - Run `node engine/cli.ts config-check`. With `ok: false`, show each problem and stop before any coaching. A problem about the urgent-gate hook means the urgent stop cannot block plan writes: fix `.claude/settings.json` first.
   - **The limits, in plain words (0.3.0).** Run `node engine/cli.ts migrate-limits`. It converts an old `athlete/limits.yaml` to `athlete/limits.md`, line by line, with every rule, number and exception kept, moves the pain threshold to `coach.yaml`, and makes one commit. It is safe to run again.
     - `status: nothing_to_do`: go on.
     - `status: migrated`: show the new file's lines (its `text`) as they are. Say "Your limits are in your own words now. I converted the old file line by line and kept every rule and number." When a line holds a term the athlete would not say ("sets a week of … counted together", "exercise id", "These exact exercises do not count", a movement list), offer a plainer wording of those lines in one question: "Apply these? A) Yes, B) Change something, C) Keep as is". Only a yes changes the file (commit it with `node engine/cli.ts commit --message "limits: plainer words"`; a nonzero exit: stop, and say in one line that the commit failed and why). A rewording never drops or weakens a limit: keep every exercise, number and unit.
     - `MIGRATE_REFUSED` (uncommitted changes): say which files, ask "Commit them now? A) Yes, B) Not now". A: `node engine/cli.ts commit --message "coach: before the limits migration"` (a nonzero exit: stop, and say in one line that the commit failed and why), then run `migrate-limits` again. B: stop before any coaching.
     - `LIMITS_INVALID` (the old file cannot be converted): show its problems in plain words and stop before any coaching. The old file stays as it is, and the coach follows it as written until it is fixed.
     - `MIGRATE_FAILED`: say the reason in one line. The old file is back as it was; stop before any coaching.
   - Run `npm test`. A failure: show the failing test names and tell the user; do not coach until it is fixed.
   - Push: `git pull --rebase`, then `node engine/cli.ts push` (in a worktree: `node engine/cli.ts push --branch main`).
   - When the session context reports old hold or safety-check files, ask its one question about them.

## Writes

- Template files only, through `node engine/cli.ts update --yes --to <to>`, and one commit on `main` with the trailer `Coach-Template-Commit: <sha>`.
- In a worktree: `main` and this branch move by fast-forward only (`node engine/cli.ts worktree ff-main` and `worktree ff-branch`).
- `.tmp/coach/update-backup/<path>` for each `--take-template`.
- Step 6, once: `athlete/limits.md`, `coach.yaml` `thresholds.pain_threshold` and the removal of `athlete/limits.yaml`, only through `node engine/cli.ts migrate-limits` (one commit; a copy of the old file stays in `.tmp/coach/migrate-limits/`).

## Unattended

Never in an unattended run: an update replaces the coach's own code and needs the athlete's yes. The command refuses itself when `COACH_UNATTENDED` or `CLAUDE_CODE_REMOTE` is set. Log nothing and stop.
