---
name: check-in
description: Records what the athlete says about today in their own words - how they feel, pain, or not wanting to train - and then gives today's report through the today skill. It asks about nothing else, and it hands pain at or above the threshold to the safety skill. Use it when the user says "check in", "morning check-in", "I slept badly", "slept great", "I'm tired", "I'm sore", "I'm wrecked", "I feel wrecked", "stressed", "low energy", "feeling good today", "I don't want to train today", or uses a pain word such as "it hurts", "pain", "tweaked", "my knee hurts", "sore knee" or "my back is acting up". It writes what is clear with the engine, then runs today's report.
---

# Check-in

A check-in is one of the three readiness categories (subjective). It counts for today only. The coach reads the data first: the athlete does not fill in a form. This skill records only what the athlete brings up, then the `today` skill gives the report. The `today` run asks one "How do you feel today?" question, and only on a day when the answer can change the workout.

Today is `TZ=<coach.yaml athlete.timezone> date +%F`.

## Where plans live

A check-in writes no plan. It reads `coach.yaml logger` only to route: a report of a finished session ("did all sets", "last set felt heavy") with `logger: files` or `other` goes to the `log` skill; with Tally, the athlete logs it in the app. The `today` run follows the logger (CLAUDE.md "Where plans live").

## Steps

1. **Mode.** Run `node engine/cli.ts mode`. In an unattended run there is no one to ask: stop (see Unattended).
2. **Urgent first.** If the session context says `URGENT STOP`, or the athlete names an urgent warning sign (chest pain, fainting, new numbness or weakness, sudden severe headache), follow the `safety` skill step 1 before anything else. Ask nothing about training.
3. **Record the athlete's own words.** Record only what they said, and only what is clear. Ask nothing else.
   - **How they feel.** Words that clearly match one option of the one question give `--overall`: "wrecked" 1, "run down" 2, "okay" or "fine" 3, "good" 4, "great" 5. Unclear words (for example "slept badly", "a bit tired"): record nothing. The `today` run asks "How do you feel today?" only on a day when the answer can change the workout.
   - **Not wanting to train.** Ask: "Not wanting to train at all, or just tired?" with the options "I do not want to train at all" and "Just tired". The first gives `--want-to-train 1` [NA-REC-012]. "Just tired" records nothing, except when today already has `want_to_train` at the aversion line (1): then it is a correction, so record `--want-to-train none`.
   - **A correction of an earlier answer today** ("I want to train after all") clears or replaces that answer the same way: `--want-to-train none`, or the new value.
   - **Pain is one list for the day.** A new `--pain` replaces today's whole list, so read today's check-in first with `node engine/cli.ts signals --from <today> --to <today>` and pass every region that still hurts:
     - A new or changed region: pass it together with today's other regions (for example `--pain left-knee:5,low-back:3`).
     - A correction for one region ("the knee is fine now"): pass `--pain` with the remaining regions only (for example `--pain low-back:3`). Never `--pain none` for one region.
     - `--pain none` only when the athlete says there is no pain now at all, for every region.
   - **Pain.** Ask only for what is missing, with options:
     - "Where? A) knee, B) low back, C) shoulder, D) hip, E) ankle, F) elbow or wrist, G) neck or upper back, H) other (name it)".
     - "Which side? A) left, B) right, C) both, D) middle, E) not sure".
     - "How bad, from 0 (none) to 10 (worst)? A) 0-1, B) 2-3, C) 4-5, D) 6-7, E) 8-10, F) not sure". Then ask for the exact number in that range ("A) 4, B) 5"). For an unsure exact number, record the top of the chosen range. For F) not sure, record the pain threshold (the session context's "Pain threshold" line; it is `thresholds.pain_threshold` in `coach.yaml`, default 4). Say so: an unsure score counts as at the threshold, so step 5 hands it to the `safety` skill.
     Map the answer to a region id from `engine/movements.yaml` (for example `left-knee`, `low-back`). "No pain now" for every region after earlier pain today gives `--pain none`.
   - **A warning sign** the athlete names: pass the term names with `--urgent` (`chest pain`, `fainting`, `new numbness`, `new weakness`). The hook usually wrote the stop already; the call is idempotent. Then follow the `safety` skill step 1.
   - **A finished session** ("did all sets"): the `log` skill for `logger: files` or `other`, after step 4.
   - "Check in" alone: nothing to record. Go to step 6.
4. **Write it** when there is something to record. Run:
   `node engine/cli.ts checkin --date <today> [--overall <n>] [--want-to-train <n>|none] [--pain <region>:<score>,...|none] [--urgent <term>,...]`
   Pass only what step 3 recorded. It merges into today's check-in by answer (`athlete/signals/<today>.json`, `source: chat`): a new value replaces the old one, `none` clears it, and what you leave out stays. With `--urgent` it also writes, commits and pushes the urgent stop: give the urgent-care text and stop (the `safety` skill step 1).
   Then run `node engine/cli.ts commit --message "check-in <today>"`. No pain text in the message. A nonzero exit: stop, and say in one line that the commit failed and why. When the athlete also reported a finished session, run the `log` skill now (`logger: files` or `other`).
5. **Pain at or above the threshold.** Step 4's `checkin` output prints `pain_threshold` (from `coach.yaml`; before the 0.3.0 migration, from the old limits file; default 4) and `pain_to_safety`, today's pain entries at or above it. For each one, run the `safety` skill for that region: one question screen, then the line the athlete chose. When it finishes, append "- pain handled: <region> <checkin_at>" to the log, with the check-in's time that step 4 printed (`file.checkin.submitted_at`), so the `today` run does not ask again. Below the threshold, note it and plan as usual.
6. **Run the `today` skill** (interactive) at once, with no question first, and once only: its first step (`today-brief --stage pre`) reads the check-in you just wrote. It gives today's report.

## Writes

- `athlete/signals/<today>.json`, only through `node engine/cli.ts checkin` (and `athlete/.urgent-stop` with `--urgent`).
- `athlete/log/<YYYY-MM>.md`: the "pain handled" line after the `safety` skill.
- Git: one commit for the check-in. The `today` run makes its own.

## Unattended

A check-in needs the athlete. In an unattended run, write nothing and ask nothing. The Shortcut file (`athlete/signals/<today>.json`) carries the phone check-in instead; the `today` skill reads it.
