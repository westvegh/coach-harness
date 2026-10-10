---
name: update
description: Brings the latest coach-harness fixes from the template into this coaching repo, without touching the athlete's files. Use it when the user says "update the coach", "get the latest version", "update coach-harness", "are there updates?", "pull the template fixes" or "upgrade the coach". It shows what changes first, settles conflicts with the user, updates only after a yes, then checks the config and runs the tests. Interactive only.
---

# Update

This repo was made with GitHub's "Use this template", so it has no link to the template. `update` compares three things for each template file: the last release this copy has (`template-manifest.json`), the new release, and the file in this repo now. It never writes `coach.yaml` or anything under `athlete/`.

## Steps

1. **Check.** Run `node engine/cli.ts update --check`. Read `source`, `to`, `release_from`, `release_to`, `changelog`, `plan` and `conflicts`.
   - `up_to_date: true`: say "The coach is up to date (release <release_from>)." Stop.
   - An error (`UPDATE_REFUSED`, `NO_MANIFEST`, `MANIFEST_INVALID`): say the reason in plain words and stop. For uncommitted changes, commit them first. For `NO_MANIFEST`, read its message to the user: this copy cannot be updated safely.
2. **Tell the user** in plain words: the release (`release_from` to `release_to`), each new changelog heading with one line of its text, and the counts (files replaced, added, deleted, and files you changed that stay yours).
3. **Conflicts.** For each conflict, say what happened (`why`) and ask "A) keep my version, B) take the template's version (mine is saved in .tmp/coach/update-backup/)". A is `--keep-mine <path>`; B is `--take-template <path>`.
4. **Approval.** Ask "Update now? A) yes, B) no". After a yes, run `node engine/cli.ts update --yes --to <to>` with one `--keep-mine <path>` or `--take-template <path>` for each conflict. The guard asks once more for this command.
5. **After the update,** in this order:
   - `npm_ci_needed: true`: run `npm ci`.
   - `reinstall_git_hooks: true`: run `node engine/cli.ts install-git-hooks`.
   - Run `node engine/cli.ts config-check`. With `ok: false`, show each problem and stop before any coaching.
   - Run `npm test`. A failure: show the failing test names and tell the user; do not coach until it is fixed.
   - Push: `git pull --rebase`, then `node engine/cli.ts push`.
6. **Restart.** `restart_claude_code: true`: say "Quit Claude Code and start it again before anything else. The hooks changed, and this session still runs the old ones."

## Writes

- Template files only, through `node engine/cli.ts update --yes`, and one commit on `main` with the trailer `Coach-Template-Commit: <sha>`.
- `.tmp/coach/update-backup/<path>` for each `--take-template`.

## Unattended

Never in an unattended run: an update replaces the coach's own code and needs the athlete's yes. The command refuses itself when `COACH_UNATTENDED` or `CLAUDE_CODE_REMOTE` is set, and the guard denies it. Log nothing and stop.
