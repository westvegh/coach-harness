---
name: check-in
description: Records how the athlete feels today on four 1-5 scales (sleep quality, energy, soreness, stress), an optional want-to-train item, and pain by region, and hands pain at or above the threshold to the safety agent. Use it when the user says "check in", "morning check-in", "I slept badly", "slept great", "I'm tired", "I'm sore", "I feel wrecked", "stressed", "low energy", "feeling good today", "I don't want to train today", or uses a pain word such as "it hurts", "pain", "tweaked", "sore knee" or "my back is acting up". It writes the check-in with the engine, then offers today's run.
---

# Check-in

A check-in is one of the three readiness categories (subjective). It counts for today only.

Today is `TZ=<coach.yaml athlete.timezone> date +%F`.

## Steps

1. **Mode.** Run `node engine/cli.ts mode`. In an unattended run there is no one to ask: stop (see Unattended).
2. **Safety first.** If the session context says `SAFETY FIRST`, or the user used an urgent term (chest pain, fainting, new numbness or weakness, sudden severe headache), run the `safety` agent before anything else, in the foreground (`run_in_background: false`; never as a background agent). In the same turn, paste its "Questions for the athlete (copy exactly):" block to the user word for word, as a quoted block: do not reword it, and add nothing that changes its meaning. Ask nothing about training.
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
   - "How bad, from 0 (none) to 10 (worst)? A) 0-1, B) 2-3, C) 4-5, D) 6-7, E) 8-10, F) not sure". Then ask for the exact number in that range ("A) 4, B) 5"). For an unsure exact number, record the top of the chosen range. For F) not sure, read `pain_threshold` in `athlete/limits.yaml` with the Read tool and record that value. Say so: an unsure score counts as at the threshold, so step 6 hands it to the safety agent.
   Map the answer to a region id from `engine/movements.yaml` (for example `left-knee`, `low-back`).
5. **Write it.** Run:
   `node engine/cli.ts checkin --date <today> --sleep-quality <n> --energy <n> --soreness <n> --stress <n> [--want-to-train <n>] [--pain <region>:<score>,...]`
   Leave out `--want-to-train` when the athlete chose "skip".
   It creates or merges `athlete/signals/<today>.json` with `source: chat`.
6. **Pain at or above the threshold.** Read `pain_threshold` in `athlete/limits.yaml` with the Read tool (default 4). If any pain score is at or above it, hand off to the `safety` agent with the region, the score and the user's answers. Run it in the foreground (`run_in_background: false`; never as a background agent). In the same turn, paste its "Questions for the athlete (copy exactly):" block to the user word for word, as a quoted block: do not reword it, and add nothing that changes its meaning. Do not plan training until it returns a `SAFETY RESULT`. The guard already blocks exercises that load that region today.
7. **Commit.** `git add athlete/signals` and commit "check-in <today>". No pain text in the message.
8. **Offer today's run:** "Adjust today's session now? A) yes, B) no". A yes runs the `today` skill. With want to train at 1, say first: "Not wanting to train is a reason to rest. The daily run will offer a recovery day [NA-REC-012]."

## Writes

- `athlete/signals/<today>.json`, only through `node engine/cli.ts checkin`.
- Git: one commit.

## Unattended

A check-in needs the athlete. In an unattended run, write nothing and ask nothing. The Shortcut file (`athlete/signals/<today>.json`) carries the phone check-in instead; the `today` skill reads it.
