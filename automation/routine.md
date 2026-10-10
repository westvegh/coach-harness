# Cloud routines

A routine is a scheduled Claude Code run in the cloud. Coach-harness uses two routines:

| Routine | Skill | Default schedule (athlete's local time) |
|---|---|---|
| `coach-harness daily` | `today` | every hour from 05:07 to 10:07 |
| `coach-harness weekly` | `week` | Sunday 17:07 |

The times come from `automation` in `coach.yaml`. The facts on this page were tested against Claude Code routines.

## How `setup` creates a routine

`setup` creates each routine with the **RemoteTrigger** tool. It does not use `/schedule`. The engine writes the request body:

```sh
node engine/cli.ts routine-body --kind daily --repo-url https://github.com/<owner>/<repo> \
  (--discover | --connections <file.json>) [--environment-id env_…] [--model <model id>] [--disabled]
```

The command prints `{ "body": {…}, "cron": { "cron", "offsets_min", "note" } }`. Send `body` to RemoteTrigger. Show `cron.note` to the athlete.

The steps:

1. Create the routine **disabled**: `routine-body --kind daily --repo-url … --discover`. This body has no `mcp_connections` and `enabled: false`. The create response lists every connector on the account, each with `connector_uuid`, `name` and `url`.
2. Save the create response to a file. Run `routine-body --connections <that file>`. The engine picks the connector whose `url` is `https://mcp.tallyworkout.app/api/mcp`.
3. Update the routine with the new body (`enabled: true`).
4. If the account has no Tally connector, `routine-body` exits with `NO_TALLY_CONNECTOR`. Stop, and give the athlete the link to connect Tally in claude.ai.
5. Run the routine once (`RemoteTrigger run`). Read the log (`list_runs`, then `get_run_log`). Set `automation.verified: true` in `coach.yaml` only after a successful test run.

## Facts the body must respect

### Connectors are pinned to Tally

A new routine gets **every** connector on the account by default. The body therefore sets `mcp_connections` to exactly one entry, the Tally connector, with `permitted_tools` set to the 11 Tally tools. `routine-body` refuses any other connector URL.

`allowed_tools` is an exact, narrow list (`UNATTENDED_TOOLS` in `engine/automation.ts`). There is no open `Bash`, `Write` or `Edit`:

- `Read`, `Glob`, `Grep`.
- Bash only for `node engine/cli.ts <subcommand>` (pushes go through `node engine/cli.ts push`), `git status|diff|log|add|commit|pull|switch`, `gh api` on this repository, `date` and `printenv CLAUDE_CODE_REMOTE`, with plain words only.
- `Edit` and `Write` only under `athlete/log/**`, `athlete/proposals/**` and `.tmp/coach/**`.
- The 11 Tally tools as `mcp__<connector name>__<tool>`. The connector name comes from your account (setup reads it), so any name form works.

The file guard enforces the same allowlist again in every unattended run: a command outside it is denied, also with a looser runner setting. The guard hooks match every Tally write by regex, whatever the connector prefix.

### The prompt checks the window, then dispatches explicitly

The prompt never relies on skill descriptions. It says, for example:

> First run: node engine/cli.ts window-check --kind daily. If it exits with a nonzero code, stop and do nothing else. Otherwise read .claude/skills/today/SKILL.md and follow it exactly. Unattended run. This is a scheduled cloud routine. If node_modules is missing, run npm ci first. Push only with node engine/cli.ts push: it installs the git hooks, checks that the repository is private, and then pushes. If it exits nonzero, nothing was pushed; log the reason and stop. Commit to the main branch: run git pull --rebase before you push.

A cloud run starts from a fresh clone with no `node_modules` and no git hooks (git does not clone the hooks folder). `npm ci` is the one command the guard allows before the packages are installed, and the run cannot change `package.json` or `package-lock.json`. Every push goes through `node engine/cli.ts push`: it installs the pre-push hook, runs `prepush-check` (the hook is installed and `gh api` reports the repository as private), and pushes only after both pass. The guard denies a raw `git push` in a scheduled run.

The `today` and `week` skills also run `window-check` first, before any other step.

`window-check` reads the athlete's local time from `coach.yaml`:

- **Daily:** the run continues when the local time is from `daily_window.start` to `daily_window.end`, plus 30 minutes for a late start.
- **Weekly:** the run continues on `weekly.day`, from `weekly.time` to 30 minutes after it.
- In an unattended run, a time outside the window exits with code 4. In an interactive run, it always exits 0.

Cloud runs set `CLAUDE_CODE_REMOTE`, so `node engine/cli.ts mode` reports `unattended` and the guard denies big changes.

### Cron is UTC and covers both offsets

The routines API takes cron in UTC, and UTC does not follow daylight saving time. The engine therefore makes a cron that fires under **both** UTC offsets of the athlete's timezone. `window-check` then refuses each run that is outside the local window. The schedule needs no update at a DST change.

- **Daily:** for Los Angeles, 05:07 to 10:07 becomes `7 12-18 * * *`. That is 7 runs a day. In winter the 04:07 run is refused; in summer the 11:07 run is refused. The 6 runs from 05:07 to 10:07 local always go on. The interval is never under 1 hour, the routines minimum.
- **Weekly:** for Los Angeles, Sunday 17:07 becomes `7 0-1 * * 1` (Monday 00:07 and 01:07 UTC). Each week one of the 2 runs is at 17:07 local and goes on. The other run is at 16:07 or 18:07 local and is refused.

### Pull requests use REST

`gh pr create` fails in a routine: "GitHub GraphQL is not available from Claude Code sessions". Proposals open their pull request through the REST API:

```sh
gh api -X POST repos/{owner}/{repo}/pulls -f title=… -f head=proposal/<id> -f base=main -f body=…
```

`node engine/cli.ts proposals open-pr <id>` makes this call and records `pr_url` in the proposal file.

### Proposals: how a big change gets approved

An unattended run never makes a big change by itself. It writes a proposal and opens a pull request:

1. On `main`: `node engine/cli.ts proposals create --input <file.json>`. This writes `athlete/proposals/<id>.yaml` with `status: proposed`. Commit and push to `main`.
2. `git switch -c proposal/<id>`, then `node engine/cli.ts proposals approve-copy <id>`. This sets `status: approved`. It refuses on any branch other than `proposal/<id>`. Commit, then `git push -u origin proposal/<id>`.
3. `git switch main`, then `node engine/cli.ts proposals open-pr <id>`. Commit the recorded `pr_url` and push.
4. The athlete reads the PR and approves it by merging it.

**Merge with a merge commit.** Do not squash and do not rebase. The guard accepts an approved proposal only when the file reached `main` through a merge of `proposal/<id>`. To reject a proposal, close the PR.

### Merged proposals apply on the next run

A merge does not start a run. The next scheduled `today` or `week` run reads `athlete/proposals/` on `main` before anything else. It applies each approved, unapplied proposal under the guard's approval-record rule: every base version and the limits hash must still match. Then it runs `proposals mark-applied <id>`, which sets `status: applied`, `applied_at` and `results`. The athlete can also say "apply" in chat to apply it at once.

### The GitHub trigger is optional

A routine can also start on a GitHub event (for example, a merged PR). The routines API for this trigger is not documented, and the request shapes we tried were rejected. If the athlete wants it, they add the trigger in the claude.ai web UI. Coach-harness does not need it.

### Network: the Default environment

Routines run in the **Default** environment. Its network allowlist blocks hosts that are not on the list ("Host not in allowlist").

- **Tally** works: the run reaches it through the claude.ai connector, not through the network. No allowlist change is needed.
- **GitHub** works: `node engine/cli.ts push` (which runs `git push`) and `gh api` both work.
- **Oura** does not work directly. A direct Oura call from the cloud needs a Custom network environment and a token broker. In v1, Oura runs on the Mac (see `launchd/README.md`).
