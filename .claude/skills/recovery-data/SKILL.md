---
name: recovery-data
description: Connects recovery data after setup - Oura (on this Mac) or an Apple Watch or other Apple Health device through a Shortcut - or keeps chat check-ins, then builds the baselines. Use it when the user says "add recovery data", "connect Oura", "connect my Apple Watch", "use Apple Health", "add HRV", "set up my wearable" or "I got an Oura ring". It asks one question, runs the Oura sign-in in the athlete's own terminal when needed, fetches the history, updates coach.yaml signals and reports what the baselines know. Interactive only.
---

# Recovery data

Readiness reads three kinds of evidence: the wearable (sleep, HRV, resting heart rate), the check-in and performance. Setup starts with chat check-ins only. This skill adds a wearable.

Today is `TZ=<coach.yaml athlete.timezone> date +%F`.

## Steps

1. **Mode.** Run `node engine/cli.ts mode`. Unattended: stop (see Unattended).
2. **Ask once** (one AskUserQuestion call): "Which recovery data do you have?" with "Oura ring", "Apple Watch or another Apple Health device", "None: chat check-ins only".
3. **Oura** (on a Mac):
   - The sign-in opens a browser, so the athlete runs it. Say: "Type this in the prompt and press Enter. It opens Oura in your browser to sign in:" and show `! node adapters/signals/oura/auth.ts` on its own line. Wait until the athlete says it is done.
   - Run `node adapters/signals/oura/fetch.ts --days 50`. The baseline needs 28 valid days within 6 weeks, plus a week for the patterns.
   - Set `signals: { wearable: oura, checkin: chat }` in `coach.yaml`.
   - Say: "Oura works on this Mac only. A cloud run cannot reach Oura, so on cloud days the daily run uses your check-in."
4. **Apple Health:** give the Shortcut guide `adapters/signals/apple-health-shortcut/SHORTCUT.md` in short steps. Set `signals: { wearable: apple-health-shortcut, checkin: shortcut }`. The Shortcut writes `athlete/signals/<date>.json` in this private repo.
5. **None:** keep `signals: { wearable: none, checkin: chat }`. Say: "Say 'check in' in the morning, and the daily run uses it."
6. **Baselines.** Run `node engine/cli.ts signals --from <today minus 50 days> --to <today>`, then `node engine/cli.ts readiness --date <today>`. Report `wearable.calibrating`, the wearable `reasons` and `known` as the engine prints them. Do not count days yourself.
7. **Check and commit.** Run `node engine/cli.ts config-check` and fix each problem. Run `node engine/cli.ts commit --message "recovery data: <wearable>"` (a nonzero exit: stop, and say in one line that the commit failed and why), then `git pull --rebase` and `node engine/cli.ts push`.

## Writes

- `coach.yaml` `signals` only.
- `athlete/signals/` (the Oura fetch, or the athlete's Shortcut).
- Git: one commit, pushed.

## Unattended

Never in an unattended run: the Oura sign-in and the question need the athlete. Write nothing and stop.
