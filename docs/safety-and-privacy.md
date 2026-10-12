# Safety and privacy

## Not medical advice

coach-harness plans and adjusts training. It is not a medical device, and it is not medical advice. The coach does not diagnose and does not treat. It never gives advice about medication, supplements, hormones or peptides. It never sets under-fuelling or rapid weight-loss targets. For pain, an injury or a health question, talk to a clinician.

## Safety

### The safety detector

A Claude Code hook (`.claude/hooks/safety-detect.ts`) reads every message you send before Claude sees it. It matches pain words, body regions and urgent warning signs from `engine/safety-terms.yaml`. The daily run also checks the notes you log with your sessions.

- **An urgent warning sign** (for example chest pain or fainting): the coach stops all training talk and shows urgent-care text. This is its own state: the guard then allows no exercise at all, not even a shorter session or a recovery workout. Only notes, rest days and skips pass.
- **A pain word:** the hook writes `athlete/.safety-pending`. While that file exists, the guard blocks every training write except rest and recovery. The `safety` agent asks you a few short questions first.

A false alarm costs one question. The matcher can miss a paraphrase, so the daily check-in also asks about pain directly. The exact texts the coach shows are in [safety.md](safety.md).

Only the matched terms (for example `hurt` and `region:left-knee`) are stored. Your message text is never stored.

### Holds

A hold pauses training changes. What it blocks depends on the hold:

- **A regional hold** (it names regions, for example `left-shoulder` and `right-shoulder`) blocks every exercise that loads a held region, and every exercise the coach cannot classify. Other exercises follow the normal rules: your limits, the method rules, the volume and progression checks. Conditioning that loads no named region (a bike, intervals) passes only as recovery work that adds nothing.
- **A hold with no regions** (for example dizziness or illness) allows only notes, rest or recovery work.
- **An unanswered safety check** (`athlete/.safety-pending`) works like a hold with no regions, because the regions are not known yet.

Under every hold, a shorter session (fewer sets, the same or less load) and a skip also pass.

When you accept new limits for the held regions in the same live session, the safety agent asks one question: add the limits and end the hold. After your yes, the limits are written first, and then `hold clear --released-by-limits` ends the hold. It refuses when a held region has no limit. The limits keep protecting the region. A hold with no regions, or an urgent hold, is never ended this way.

An **urgent hold** is stricter. The safety agent sets it (`hold set --urgent`) for an urgent warning sign, and a hold whose reason names an urgent sign counts too. Under an urgent hold, or while a pending safety check holds an urgent term, the guard denies every exercise prescription. Only a note on an unchanged day, a rest day or a skip passes. `hold status` prints `urgent: true`.

- **Setting a hold is always allowed,** in every mode, because it makes training safer.
- **Clearing a hold needs your yes, in a live session.** A scheduled run can never clear a hold.
- When you report what a clinician told you, the coach records it as `clinician-reported`. It never claims to verify it.

Run `node engine/cli.ts hold status` to see the hold and any pending safety check.

### Your limits

Your injury limits live in `athlete/limits.yaml`. A limit can ban a movement pattern or an exercise, or cap the load or the weekly sets. The guard checks every write against every limit. An exercise that the engine cannot classify is blocked while any limit is active, so a new exercise name cannot slip past a ban.

The model cannot edit `athlete/limits.yaml`. The same protection covers the other evidence that authorizes training: `athlete/block.yaml` (the approved block) and `athlete/signals/` (your check-ins and health data). The block changes only through setup or the block skill with your yes, or when you merge a proposal. On a proposal branch, the guard still reads the block on `main`. Signal files come only from your Shortcut and from trusted engine commands, and `checkin` never runs in a scheduled run. To change a limit, say so (the `limits` skill), and the coach shows the exact change and writes it only after your yes.

## Where your data lives

| Data | Where it lives | Who can read it |
|---|---|---|
| Your brief, limits, block, log and proposals (`athlete/`) | Your private GitHub repository | You and GitHub |
| Apple Health data (sleep, HRV, resting heart rate) and check-ins from the Shortcut | `athlete/signals/` in your private repo. Your own Shortcut sends it with your own GitHub token. | You and GitHub |
| Oura data | `athlete/.cache/` on your Mac (not committed) | You |
| Oura app credentials and tokens | The macOS Keychain on your Mac | You |
| Your plan, your workout log and a short coach note on each changed day | Your logger app (for example Tally) | You and the logger |
| Your conversations with the coach | Anthropic, as for any Claude Code session | You and Anthropic |

The harness itself has no server. It sends nothing to the harness authors.

### Notes in your logger

The coach writes a short note on a day it changes. By default the note is generic, for example "Adjusted for recovery" or "Rest day: see your coach repo". Symptoms, body regions, pain scores and readiness values (sleep, HRV, resting heart rate) stay in your private repo. Setup asks a separate question before the coach may write those details into logger notes; your answer is `consent.logger_health_notes` in `coach.yaml`.

The setup skill names each recipient and asks for your consent to each one: Anthropic, GitHub, the logger, Oura (if you use it), and the Apple Health data that your Shortcut sends to your repo. It also checks that your repository is private.

### The Apple Health Shortcut

The Shortcut runs on your phone and uses a fine-grained GitHub token that can write to one repository only. The token stays in the Shortcut on your phone. Revoke it on GitHub at any time. The guide is `adapters/signals/apple-health-shortcut/SHORTCUT.md`.

### Oura

The Oura fetcher uses your own Oura API application. Its client ID, client secret and tokens are in the macOS Keychain (service `coach-harness.oura`). Nothing is written to the repository. Error messages never include a token or a server response.

## What each automation mode sends where

| Mode | Runs on | Sends |
|---|---|---|
| Manual | Your computer, when you talk to the coach | Your conversation to Anthropic; plan reads and writes to your logger; commits to your private repo when you push. |
| Mac | Your Mac, through launchd | The same as manual, plus Oura API calls from your Mac. The run uses your claude.ai login, not an API key. |
| Cloud | Claude Code cloud routines | Anthropic clones your private repo into a cloud session. The run reads and writes your logger through its claude.ai connector only, then pushes commits and pull requests to your repo. |

A cloud routine gets only the logger connector, not the other connectors on your account. Oura does not run in the cloud.

### What a scheduled run may do

A scheduled run (Mac or cloud) has no one to ask, so it gets a narrow allowlist instead of open shell and file access:

- **Shell:** only `node engine/cli.ts <command>`, `git status`, `diff`, `log`, `add`, `commit`, `pull` and `switch` (each with a short list of options; `switch` as a command of its own), `gh api` on your own repository (read, or open a pull request), `date +FORMAT` and `printenv CLAUDE_CODE_REMOTE`. Every word must be plain text: no `$`, backslash, `*`, `{ }` or `~`, so the shell has nothing to expand. Nothing runs in the background. `node engine/cli.ts checkin` and `install-launchd` never run unattended.
- **Pushes:** only `node engine/cli.ts push`. It installs the pre-push hook, checks that your repository is private, and pushes only then. A raw `git push` is denied.
- **Files:** Edit and Write only under `athlete/log/`, `athlete/proposals/` and `.tmp/coach/`.
- **Logger tools:** the 11 Tally tools, under the exact names of the Tally server you connected. Before Mac automation is installed, a probe run proves those names.

The runner's tool list (`engine/automation.ts`) sets this, and the file guard enforces it again: a command outside the list is denied even if the runner setting is looser.

In every mode, a write to a file that node, npm, git or a hook could run needs your yes: `package.json`, `package-lock.json`, `.npmrc`, `*.js`, `*.cjs`, `*.mjs`, `*.ts`, `*.sh`, files under `node_modules/`, `.husky/`, `.git/` or `.github/workflows/`, and any file with an execute bit.

### The residual risk in a live session

In a live (interactive) session, Claude Code asks you before each shell command that you have not allowed. The guard checks file writes and the shell commands that name protected files, but it cannot see what an arbitrary program does once it runs. If text in a logger note or a web page persuades the model to run a script, and you approve that command, the script can change any file in the repository, the engine included. Read each command before you approve it, and do not approve a command you do not understand. The logger's server-side limits (where available) and your git history are the backstops.

## The pre-push check

Setup installs a git `pre-push` hook (`git-hooks/pre-push`). Git does not clone the hooks folder, so a scheduled run pushes only through `node engine/cli.ts push`. That command installs the hook again, runs `node engine/cli.ts prepush-check` (the hook is installed and GitHub reports the repository as private), and pushes only when the check passes. A failed or public check means no push and a log entry; the guard denies a raw `git push` in a scheduled run. Before each push, the hook looks up the visibility of the destination repository on GitHub.

- If the lookup fails, the push is blocked.
- If the destination is public and any commit in the push touches `athlete/`, the push is blocked.

The hook checks each push only. If you later make the repository public in GitHub's settings, the hook cannot stop that. Keep your copy private. The session-start hook also warns when a tracked file holds a token or athlete data in the wrong place.

## Delete your data

1. Delete your private repository on GitHub.
2. Revoke the Shortcut's GitHub token, and remove the logger connector from Claude.
3. Delete your Oura API application and run `security delete-generic-password -s coach-harness.oura -a tokens` (and the same for `client_id` and `client_secret`).
4. Delete your account in your logger app if you want your plan and log gone too.

## Report a problem

See [SECURITY.md](../SECURITY.md) to report a security problem privately.
