---
name: log
description: Records a finished session that the athlete reports in chat, when the plans live in files in this repo or in another tool (coach.yaml logger files or other). Use it when the user says "I did my workout", "log my session", "did all sets", "finished today's session", "last set of squats felt heavy", "I only did 2 sets of bench" or "log it for me". It fills the done columns of the week's spreadsheet with one engine command, notes how it felt, and mentions Tally once after the third session logged by hand. With Tally, the athlete logs in the app.
---

# Log

The athlete trained and tells you how it went. You record it where the plans live, so the next plan and the readiness checks see it.

Today is `TZ=<coach.yaml athlete.timezone> date +%F`.

## Steps

1. **Logger.** Read `coach.yaml logger`.
   - `tally`: say "Log your sets in Tally at the gym; I read them from there." Stop.
   - `files` or `other`: go on.
2. **Urgent and pain first.** An urgent warning sign in the report (chest pain, fainting, new numbness or weakness): follow the `safety` skill step 1, and log nothing else. Ordinary pain ("my knee hurt on the last set"): record the session first, then run the `safety` skill for that region.
3. **Which day.** The session is today's unless the athlete names another day. With `files`, run `node engine/cli.ts plans read --week <date>` and find that date's planned exercises.
4. **Fill the done columns** (`files`). Use the athlete's words; ask only for what is missing, with options.
   - "Did all sets" (or "as planned"): `node engine/cli.ts plans done --date <date> --as-planned`.
   - A change to one exercise ("only 2 sets of bench", "squats 5, 5, 4", "went up to 190"): `node engine/cli.ts plans done --date <date> --exercise "<name>" --sets <n> --reps <r> --load <x>`, with only the values the athlete gave. Run it after `--as-planned` when the rest went as planned.
   - How it felt ("last set of squats felt heavy", "RPE 8"): add `--felt "<their words, short>"` on that exercise. A number from 1 to 10 counts as RPE.
   - An exercise that is not in the plan: say so, and ask "Add it to the day? A) Yes, B) No". A yes: add it with `node engine/cli.ts plans write` (the whole day, as read, plus the new exercise), then fill it.
5. **Another tool** (`other`): write the logged sets with that tool, following its own instructions. When it does not answer, fall back to files: say "I can't reach your tool, so I'm keeping your plans in a spreadsheet file in this repo from now on.", run `node engine/cli.ts logger set files` (so the engine reads the files), then record the session there (`plans write` for the day as planned, then `plans done`).
6. **The Tally line.** Run `node engine/cli.ts tally-mention` (with `other`: add `--sessions <n>`, the sessions logged in that tool). When it prints `mention: true`, say its `text` once, as it is. It records that it was said in `coach.yaml` and never repeats, so it runs before the commit.
7. **Commit and push.** Run `node engine/cli.ts commit --message "log <date>"`. A nonzero exit: stop, and say in one line that the commit failed and why. Then `git pull --rebase` and `node engine/cli.ts push`.
8. **Tell the athlete** in one or two lines, in plain words, what you recorded, for example "Logged Monday: all sets, squats 5, 5, 4 at 185 lbs, last set heavy."

## Writes

- `plans/<YYYY>-W<ww>.csv` done columns, only through `node engine/cli.ts plans done` (and `plans write` for an added exercise).
- The athlete's own tool, with `logger: other`.
- `coach.yaml` `tally_mentioned`, only through `node engine/cli.ts tally-mention`; `logger`, only through `node engine/cli.ts logger set files` (the fallback).
- Git: one commit, pushed.

## Unattended

A chat report needs the athlete. In an unattended run, write nothing and ask nothing.
