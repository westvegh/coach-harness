---
name: setup
description: Sets up a new athlete from zero, or resumes a setup that stopped. Use it when the user says "set me up", "get started", "start coaching me", "onboard me", "new athlete", "continue setup" or "finish setup", or when coach.yaml does not exist. It checks the tools, runs the red-flag screen, asks for consent for each data recipient, interviews the athlete with options, chooses a method and template, connects Tally and the recovery signals, builds baselines, writes the athlete files and coach.yaml, proposes and audits block 1, writes week 1 after a yes, installs the git hooks, offers automation and commits. Interactive only.
---

# Setup

Set up one athlete. Ask one topic at a time. Every question has options. Keep each answer short in the files.

## Resume

Setup keeps a state line in `athlete/log/setup.md`, one line per finished step:

```
setup: step <n> done <YYYY-MM-DD HH:MM>
```

At the start, read `athlete/log/setup.md` if it exists. Skip every step it lists as done. Say which step you resume from.

## Steps

1. **Mode.** Run `node engine/cli.ts mode`. If it prints `unattended`, stop: setup is interactive only. Log "setup needs an interactive session" and end.
2. **Versions.** Run `claude --version` and `node --version`.
   - Claude Code must be 2.1.295 or later. The guard hooks fail closed only from that version.
   - Node must be 22.18 or later.
   - If one is too old, say which, and how to update it. Stop until it is fixed.
   - Run `npm ci` if `node_modules/` does not exist. The guard hooks need it.
3. **Red-flag screen** (PAR-Q+ style). Ask each question with "A) yes, B) no":
   1. Has a clinician said you have a heart condition, or high blood pressure?
   2. Do you get chest pain at rest, in daily life, or during exercise?
   3. Do you lose balance from dizziness, or have you fainted in the last 12 months?
   4. Do you have another chronic medical condition (other than heart disease or high blood pressure)?
   5. Do you take prescribed medication for a chronic medical condition?
   6. Do you have a bone, joint or soft-tissue problem now, or in the last 12 months, that more activity could make worse?
   7. Has a clinician said that you should only do medically supervised activity?
   - A "yes" to 2 or 3 now: give the urgent-care text from `engine/safety-text.ts` (`URGENT_CARE_TEXT`) and stop setup.
   - Any other "yes": say "Get clearance from a clinician before you train hard. I record what you report. I do not verify it." Record each constraint the athlete reports as a limit entry with `source: clinician-reported` (step 10).
   - A "yes" to 6: ask the region, the side, and the movements that hurt. Make a limit entry with `source: athlete` (or `clinician-reported` when a clinician set it).
   - Never ask about medication names, and never comment on medication.
4. **Consent** (`docs/safety-and-privacy.md`). Name each data recipient. Ask "A) yes, B) no" for each:
   - Anthropic: cloud routines and transcripts.
   - GitHub: this private repo holds the athlete files.
   - Tally: your plans, your workout history, and a short coach note on a changed day. By default the note is generic ("Adjusted for recovery", "Rest day: see your coach repo"). Symptoms, body regions and pain scores stay in this private repo.
   - Oura: only if the athlete uses Oura.
   - Apple Health data that the athlete's own Shortcut sends to this private repo.
   - A "no" removes that feature. A "no" to GitHub or Tally stops setup: the harness needs both.
   - A separate question, after the Tally yes: "Detailed notes in Tally: may the coach write the reason for a change into the day's note in Tally? That can include readiness values (sleep, HRV), a body region or a pain score. A) no, keep the notes generic (recommended), B) yes". Store the answer in `coach.yaml` as `consent.logger_health_notes: false` (A) or `true` (B).
   - Check that the repo is private: `gh api repos/<owner>/<repo> --jq .private`. If it is public, stop until it is private.
5. **Interview.** Ask with options:
   - Goals: the main goal, and the nine adaptations ranked (strength, hypertrophy, power, muscular endurance, anaerobic capacity, maximal aerobic output, long-duration endurance, speed, skill). Offer "A) all-around, B) strength, C) hypertrophy, D) endurance, E) general health" first.
   - Training history: years, recent program, best recent lifts or tests.
   - Injuries and pain now or in the past year: region, side, movements that hurt. Hand any current pain to the `safety` agent first: run it in the foreground (`run_in_background: false`; never as a background agent). In the same turn, paste its "Questions for the athlete (copy exactly):" block to the user word for word, as a quoted block: do not reword it, and add nothing that changes its meaning.
   - Schedule: days a week ("A) 3, B) 4, C) 5"), which weekdays, session length in minutes ("A) 45, B) 60, C) 75, D) 90").
   - Equipment: "A) full gym, B) home gym with barbell, C) dumbbells and bands, D) bodyweight only".
   - Sleep target, optional: "A) 420 minutes (7 h), B) 450 (7.5 h), C) 480 (8 h), D) other, in minutes (240-720), E) skip". Store the minutes as given in `coach.yaml athlete.sleep_target_min`. With E, leave the key out: the engine uses 480.
   - Units: "A) lbs, B) kg". Timezone: confirm the IANA zone (for example `America/Los_Angeles`).
6. **Method and template.** List the folders under `methods/`. Read `methods/<method>/METHOD.md`. Choose `template: { days, emphasis }` from the interview. Show the choice and ask "A) yes, B) change it".
7. **Connect Tally.** Call `get_training_context` with the timezone. If the tool is missing or fails, give the connect steps ("claude.ai → Settings → Connectors → Tally", or the project `.mcp.json`) and stop until it responds. Note `weightUnit` and `weightUnitSource`, and the exact prefix of the tool name you called (for example `mcp__tally__`): automation needs it. If Tally does not know the unit, use the athlete's answer.
8. **Signals.** Ask "Which recovery data do you have? A) Apple Watch or another Apple Health device, B) Oura, C) none: chat check-ins only".
   - A: give the Shortcut guide `adapters/signals/apple-health-shortcut/SHORTCUT.md`. Set `signals.wearable: apple-health-shortcut`, `checkin: shortcut`.
   - B, on a Mac: ask the athlete to run the Oura sign-in in their own terminal: `node adapters/signals/oura/auth.ts` (it opens the browser). Then run `node adapters/signals/oura/fetch.ts --days 50` (the baseline needs 28 valid days within 6 weeks, plus a week for the patterns). Set `signals.wearable: oura`. Say: "Oura runs on this Mac only in v1. Cloud runs cannot reach Oura. Choose Mac automation in step 18, or use chat check-ins on the days you run in the cloud."
   - C: set `signals.wearable: none`, `checkin: chat`.
9. **Write the athlete files.** Do this before `coach.yaml`: the guard is not active until `coach.yaml` exists.
    - Copy the starting files: `cp -n templates/athlete/brief.md templates/athlete/limits.yaml templates/athlete/baselines.json templates/athlete/block.yaml athlete/`. Do not copy `hold.yaml` with `cp`.
    - Fill `athlete/brief.md` from the interview. Short facts only, no clinician narratives.
    - Add the limit entries from steps 3 and 5 to `athlete/limits.yaml` (contracts §2). Get each id with `node engine/cli.ts ids next --kind limit` (run it again after each entry you write). Each entry has `id`, `region` (from `engine/movements.yaml`), `rule`, `patterns` or `exercises`, `note`, `source`, `since`. Show each entry and ask "A) yes, B) change it" before you write it.
    - Write `coach.yaml` last, from `coach.example.yaml`, with the athlete's name, timezone, units, `sleep_target_min` (when given), method, template, signals, `consent.logger_health_notes` (step 4), `automation.mode: manual`, `verified: false`, and `automation.tool_prefix`: the prefix of the Tally tool you called in step 7 (the part before `get_training_context`, for example `mcp__tally__` or `mcp__claude_ai_Tally_Workout__`). Keep the `approval` and `thresholds` keys as in the example.
    - Then run `node engine/cli.ts hold init`. It writes the inactive hold file that the guard needs (the audit and every write fail without it). It never overwrites an active hold (exit 3 means a hold is active: run the `safety` agent first, in the foreground (`run_in_background: false`; never as a background agent). In the same turn, paste its "Questions for the athlete (copy exactly):" block to the user word for word, as a quoted block: do not reword it, and add nothing that changes its meaning).
10. **Baselines.** Run `node engine/cli.ts signals --from <today minus 50 days> --to <today>` and `node engine/cli.ts readiness --date <today>`. Report `wearable.calibrating`, the wearable `reasons` and `known` as the engine prints them. Do not count days yourself.
11. **Propose block 1.** Use the `block` skill steps 3 to 6: the template, `block draft`, the start Monday. Keep the `block draft` output: step 14 writes week 1 from it. Write `athlete/block.yaml` (contracts §16.5). It must exist before week 1: without it the guard denies any rise in weekly sets.
12. **Audit.** Run the `audit` skill on block 1. Fix every hard finding. Show the soft findings.
13. **Approval.** Show block 1 and week 1 in a short table (day, focus, exercises, sets x reps, load). Ask "A) yes, write week 1 to Tally, B) change something, C) not now".
14. **Write week 1** after a yes. Write every planned day of week 1: the `days` of the `block draft` entry with `week: 1` (one date each). Note their number: that is the planned count.
    - Read every date of week 1 with `get_planned_workout` (empty dates too). Read `get_training_context`. Read `get_workout_history` from 8 weeks before today to today, and follow `nextCursor` to the last page. All reads must be under 15 minutes old at each write; read again if more time passed.
    - Loads: write `.tmp/coach/loads.json` (`{exercises}` of the drafted day) and run `node engine/cli.ts loads --input .tmp/coach/loads.json`. Use its `suggestedWeight` values.
    - Each drafted exercise becomes one Tally exercise: `exerciseId` and `name` as drafted, `suggestedSets` = the number of entries in its `sets`, `suggestedReps` and `suggestedWeight` from its first set.
    - Empty date: `plan_workout_day` with `ifAbsent: true`. A day exists: `plan_workout_day` with `expectedVersion` and `replace: true`, only after the user says yes to replacing it.
    - Add `opId` from `node engine/cli.ts opid --date <date> --kind block_session --input .tmp/coach/call.json` when `adapters/loggers/tally/adapter.yaml` says `capabilities.opId: true`.
    - The guard checks each write. On a deny, read the reason. Do not work around it.
    - **Check the count.** After the last write, read every week-1 date back with `get_planned_workout`. Count the dates that hold the drafted day, and compare the count with the planned count.
    - **A missing day:** read that date again and write it once more, the same way. If it is still missing, do not try again: tell the user the date, the day's focus and the guard's or Tally's reason, and log it. Week 1 is complete only when the counts match.
15. **Server-side limits (only when available).** Run this step only when the Tally tool list includes `update_training_limits` and `athlete/limits.yaml` has a limit. Otherwise skip this step silently: do not mention it to the athlete.
    1. Resolve every name under `exercises` and `allow` in `athlete/limits.yaml` with one `search_exercises` call. Write `.tmp/coach/resolved.json` as `{"<name as written>": {"exerciseId": "...", "name": "..."}}`.
    2. Call `get_training_context` and save its result to `.tmp/coach/context.json`.
    3. Run `node engine/cli.ts limits sync-ops --server .tmp/coach/context.json --resolved .tmp/coach/resolved.json`.
    4. Say each `skipped` and `localOnly` reason in plain words. Ask about each `unresolved` name and run step 3 again.
    5. If `ops` is not empty, list them and ask "Add these limits to Tally? A) yes, B) no". After a yes, call `update_training_limits` with `{"ops": <ops>, "expectedVersion": <expectedVersion>}`. The guard asks again.
    6. Show each `appOnly` sentence: only the athlete can remove or relax it, in the Tally app (Settings → Training limits).
16. **Git hooks.** Run `node engine/cli.ts install-git-hooks`. It installs the pre-push check that blocks athlete data on a public remote. Then run `node engine/cli.ts prepush-check`: it must print `ok: true` (the hook is installed and the repo is private). Otherwise stop and fix it before any push: make the repo private, or log in to `gh`.
17. **Commit and push.** `git add athlete coach.yaml` and commit "setup: athlete files, block 1, week 1". Run `node engine/cli.ts push`: it pushes only after the step 16 checks pass again. A cloud run clones the repo, so every setup file must be on `main` before step 18.
18. **Automation.** Ask "How should the daily and weekly runs start? A) cloud routines, B) this Mac (launchd), C) by hand". Keep `automation.mode: manual` and `verified: false` until a test run succeeds.
    - **Cloud:** check that the repo has a GitHub `origin` and that step 17 pushed. For each kind (`daily`, `weekly`):
      1. Run `node engine/cli.ts routine-body --kind <kind> --repo-url <url> --discover --disabled`.
      2. Create the routine with RemoteTrigger using that body. It is created disabled.
      3. Save the returned `mcp_connections` to `.tmp/coach/connections.json`.
      4. Run `node engine/cli.ts routine-body --kind <kind> --repo-url <url> --connections .tmp/coach/connections.json`. With `NO_TALLY_CONNECTOR`, stop and link the Tally connect page.
      5. Update the routine with that body (Tally connector only, enabled).
      6. Run it once, inside its window (daily: `daily_window`; weekly: the `weekly` day and time). Outside the window the run stops at `window-check` and writes no log. Then run `git pull --rebase` and read the new log entry that the run pushed.
      7. Only when that log entry shows success: set `automation.mode: cloud` and `automation.verified: true` in `coach.yaml`. Otherwise keep `manual` and `false`, and show the error.
    - **Mac:** run `node engine/cli.ts install-launchd --kind both` (a dry run). It puts the connected Tally server's exact tool names into the allowlist: `coach.yaml automation.tool_prefix`, else the servers that `claude mcp list` shows. Check `tool_prefixes` in its output against the prefix of the Tally tools you called in this session (for example `mcp__tally__`); when they differ, pass `--tool-prefix <prefix>`. Show the plists. After a yes, run `node engine/cli.ts install-launchd --kind both --yes --load`. It first makes a probe run in the scheduled environment (no API key, `dontAsk`, only `get_training_context` allowed) and installs nothing when the probe cannot call Tally (`LOGGER_PROBE_FAILED`). After the first run, read its log entry. Only when it shows success: set `automation.mode: mac` and `verified: true`.
    - **By hand:** keep `automation.mode: manual`. Say "Say 'how should I train today?' each morning, and 'plan next week' on Sunday."
19. **Commit the automation state.** `git add coach.yaml athlete/log` and commit "setup: automation <mode>". `git pull --rebase`, then `node engine/cli.ts push`.

After each step, append its state line to `athlete/log/setup.md`.

## Writes

- `athlete/brief.md`, `athlete/baselines.json`, `athlete/log/setup.md`.
- `athlete/block.yaml` (interactive yes only).
- `athlete/limits.yaml`: the first limits, before `coach.yaml` exists (interactive yes only).
- `coach.yaml` (once, at the end of step 10; later only `automation` keys).
- Tally: week 1 with `plan_workout_day` (`ifAbsent: true`, or `expectedVersion` after a yes).
- Tally: `update_training_limits` with tightening ops only, after a yes, when the tool list has it.
- Routines (RemoteTrigger) or launchd agents, after a yes.
- Git: one commit, pushed to `main`.

## Unattended

Setup never runs unattended. If `node engine/cli.ts mode` prints `unattended`, write nothing, log "setup needs an interactive session", and stop.
