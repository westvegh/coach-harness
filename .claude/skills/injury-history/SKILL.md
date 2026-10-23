---
name: injury-history
description: Records past-year injuries or pain after setup, region by region, as a note or as a line in athlete/limits.md the athlete chooses through the safety skill. Use it when the user says "add my injury history", "I had a knee injury last year", "old injuries", "past injuries", "my back used to bother me" or "record my injuries". It asks one multi-select question for the regions, then for each region whether it still bothers the athlete, writes a note for a healed region and hands a region that still bothers them to the safety skill. It never diagnoses. Interactive only.
---

# Injury history

Setup asks only about what limits training now. This skill records the past year, so the coach knows which regions to watch. A healed region is a note; a region that still bothers the athlete gets the limit the athlete chooses.

Today is `TZ=<coach.yaml athlete.timezone> date +%F`.

## Steps

1. **Mode.** Run `node engine/cli.ts mode`. Unattended: stop (see Unattended).
2. **Urgent first.** If the session context says `URGENT STOP`, or the athlete names an urgent warning sign, follow the `safety` skill step 1 first.
3. **The regions** (one AskUserQuestion call, `multiSelect: true`): "Which regions had an injury or pain in the past year?" with "Shoulder", "Low back", "Knee", "None". "Other" takes another region, for example hip, elbow or ankle.
4. **Now or healed** (one AskUserQuestion call, one question per region, at most 4): "Shoulder: does it bother you now?" with "Healed: no problem now", "It still bothers me sometimes". More than four regions: a second screen.
5. **Healed:** write one line per region in `athlete/brief.md` under "Injury history" (the region, the side when known, and "healed"), and no limit. The coach keeps an eye on it in the weekly review.
6. **Still bothers:** run the `safety` skill for those regions: its one question screen per two regions, then the limit the athlete chose.
7. **Always:** never diagnose, and never name a likely cause. Say "See a clinician for new pain, pain that gets worse, or pain that does not settle." once per conversation.
8. **Commit.** Run `node engine/cli.ts commit --message "injury history: <n> regions"`. A nonzero exit: stop, and say in one line that the commit failed and why. No region names or details in the message.

## Writes

- `athlete/brief.md` "Injury history" lines.
- `athlete/limits.md`, only through the `safety` skill (the athlete's choice, in plain words).
- Git: one commit.

## Unattended

Never in an unattended run: the questions need the athlete. Write nothing and stop.
