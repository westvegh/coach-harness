---
name: check-in
description: Records how the athlete feels today on four 1-5 scales (sleep quality, energy, soreness, stress), an optional want-to-train item, pain by region and any urgent warning sign, and hands pain at or above the threshold to the safety skill. Use it when the user says "check in", "morning check-in", "I slept badly", "slept great", "I'm tired", "I'm sore", "I feel wrecked", "stressed", "low energy", "feeling good today", "I don't want to train today", or uses a pain word such as "it hurts", "pain", "tweaked", "sore knee" or "my back is acting up". It writes the check-in with the engine, then offers today's run.
---

# Check-in

A check-in is one of the three readiness categories (subjective). It counts for today only.

Today is `TZ=<coach.yaml athlete.timezone> date +%F`.

## Where plans live

A check-in writes no plan. It reads `coach.yaml logger` only to route: a report of a finished session ("did all sets", "last set felt heavy") with `logger: files` or `other` goes to the `log` skill after the check-in; with Tally, the athlete logs it in the app. The `today` run it offers follows the logger (CLAUDE.md "Where plans live").

## Steps

1. **Mode.** Run `node engine/cli.ts mode`. In an unattended run there is no one to ask: stop (see Unattended).
2. **Urgent first.** If the session context says `URGENT STOP`, or the athlete names an urgent warning sign (chest pain, fainting, new numbness or weakness, sudden severe headache), follow the `safety` skill step 1 before anything else. Ask nothing about training.
3. **Ask the four scales and the want-to-train item**, all at once. Each answer is 1 to 5:
   - Sleep quality: "1 very bad … 5 very good".
   - Energy: "1 very low … 5 very high".
   - Soreness: "1 none … 5 very sore".
   - Stress: "1 none … 5 very high".
   - Want to train: "How much do you want to train today? 1 I do not want to train at all … 5 I really want to train". A 1 means aversion, not ordinary tiredness [NA-REC-012]. This item is optional: "F) skip" leaves it out.
   Use the words the user already gave. Ask only for the missing items. Do not guess a number: ask "A) 1, B) 2, C) 3, D) 4, E) 5" (and "F) skip" for want to train).
4. **Ask about pain directly**, every time: "Any pain today? A) no, B) yes". For a yes, ask with options:
   - "Where? A) knee, B) low back, C) shoulder, D) hip, E) ankle, F) elbow or wrist, G) neck or upper back, H) other (name it)".
   - "Which side? A) left, B) right, C) both, D) middle, E) not sure".
   - "How bad, from 0 (none) to 10 (worst)? A) 0-1, B) 2-3, C) 4-5, D) 6-7, E) 8-10, F) not sure". Then ask for the exact number in that range ("A) 4, B) 5"). For an unsure exact number, record the top of the chosen range. For F) not sure, read `pain_threshold` in `athlete/limits.yaml` with the Read tool and record that value. Say so: an unsure score counts as at the threshold, so step 6 hands it to the `safety` skill.
   Map the answer to a region id from `engine/movements.yaml` (for example `left-knee`, `low-back`).
   - Ask once, with the pain question or after it: "Any of these now? A) chest pain or pressure, B) fainting or nearly fainting, C) new numbness or weakness, D) none of these" (multi-select). A, B or C: pass the term names with `--urgent` in step 5 (`chest pain`, `fainting`, `new numbness`, `new weakness`).
5. **Write it.** Run:
   `node engine/cli.ts checkin --date <today> --sleep-quality <n> --energy <n> --soreness <n> --stress <n> [--want-to-train <n>] [--pain <region>:<score>,...] [--urgent <term>,...]`
   Leave out `--want-to-train` when the athlete chose "skip".
   It creates or merges `athlete/signals/<today>.json` with `source: chat`. With `--urgent` it also writes, commits and pushes the urgent stop: give the urgent-care text and stop (the `safety` skill step 1).
6. **Pain at or above the threshold.** Read `pain_threshold` in `athlete/limits.yaml` (default 4). For a pain score at or above it, run the `safety` skill for that region: one question screen, then the limit the athlete chose. Below the threshold, note it and plan as usual.
7. **Commit.** Run `node engine/cli.ts commit --message "check-in <today>"`. No pain text in the message. A nonzero exit: stop, and say in one line that the commit failed and why. When the athlete also reported a finished session, run the `log` skill now (`logger: files` or `other`).
8. **Offer today's run:** "Adjust today's session now? A) yes, B) no". A yes runs the `today` skill. With want to train at 1, say first: "Not wanting to train is a reason to rest. The daily run will offer a recovery day [NA-REC-012]."

## Writes

- `athlete/signals/<today>.json`, only through `node engine/cli.ts checkin` (and `athlete/.urgent-stop` with `--urgent`).
- Git: one commit.

## Unattended

A check-in needs the athlete. In an unattended run, write nothing and ask nothing. The Shortcut file (`athlete/signals/<today>.json`) carries the phone check-in instead; the `today` skill reads it.
