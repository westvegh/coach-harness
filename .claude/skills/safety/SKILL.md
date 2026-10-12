---
name: safety
description: Handles pain, an injury or a warning sign in one clickable question screen, writes the limit the athlete chose, and clears the urgent stop only on the athlete's answer. Use it when the athlete mentions pain or an injury ("my knee hurts", "I tweaked my back", "sore shoulder", "it hurts when I squat"), says a region is better ("it's better", "it's gone", "my knee is fine now"), when old notes in the history name pain, when a check-in reports pain, or when the session context says URGENT STOP. It never diagnoses and never gives medication or supplement advice.
---

# Safety

Pain is not soreness [NA-REC-007]. The athlete chooses how the coach handles a painful region. You ask one screen of clickable questions, write the limit the athlete chose, and plan around it. You never refuse to plan, and you never diagnose.

Today is `TZ=<coach.yaml athlete.timezone> date +%F`.

## Steps

1. **Urgent first.** If the session context says `URGENT STOP`, or the athlete names an urgent warning sign (chest pain, fainting, new numbness or weakness, severe shortness of breath, a sudden severe headache), give the urgent-care text from `engine/safety-text.ts` (`URGENT_CARE_TEXT`) first, keeping every instruction. If the stop file does not exist yet, run `node engine/cli.ts urgent set --term <name> --source answer` (it commits and pushes). Make no training change. Go to step 6.
2. **One question screen.** Ask at most 4 questions in one AskUserQuestion call. All questions in one call are fixed before any answer; a follow-up is a second call. The screen holds, in this order:
   - **One handling question per region** (one or two regions): "<Region>: how should the coach handle it?" with the options "It's fine now: train normally", "Go light and build back slowly", "Avoid loading it for now (the safest choice while it hurts)". Say the caution once, in the option text, never as a refusal.
   - **One side question, shared,** only for regions that have sides (shoulder, elbow, wrist, hip, knee, ankle) and whose side is not known. One region: "<Region>: which side?" with "Left", "Right", "Both". Two regions: "Which side?" (`multiSelect: true`) with "<Region A>: left", "<Region A>: right", "<Region B>: left", "<Region B>: right"; both sides of a region means both of its options are chosen. Leave out the options of a region whose side is known.
   - **One warning-sign question:** "Any of these now?" (`multiSelect: true`) with "New numbness or weakness", "Swelling with heat or redness", "Cannot bear weight", "None of these".
   - Two regions are 4 questions at most: two handling questions, one side question, one warning-sign question.
   - More than two regions: one screen per two regions. The warning-sign question goes on the first screen only.
   - A warning-sign answer other than "None of these": run `node engine/cli.ts urgent set --term "<new numbness, new weakness or other urgent sign>" --source answer` and go to step 1. For swelling with heat or redness, or for not bearing weight, use `--term "other urgent sign"`.
3. **The movements.** By default, the limit covers the patterns that load the region: run `node engine/cli.ts limits regions` and take every pattern whose `loads` includes the region (or its parent). Ask a second screen only when you cannot tell, for example "Which movements hurt?" (`multiSelect: true`; Pressing, Pulling, Squatting or lunging, Lifting from the floor).
4. **Write the limit the athlete chose** in `athlete/limits.yaml`. Run `node engine/cli.ts limits schema` for the shape and `node engine/cli.ts ids next --kind limit` for the id. `region` is an id from `limits regions` (`left-knee`, `low-back`, …); `source` is `athlete` (or `clinician-reported` when a clinician set it); `since` is today; `note` is a short constraint, never the athlete's story.
   - "It's fine now": no limit. Write one line in the athlete log: "<region>: athlete reports it is fine; train normally".
   - "Go light and build back slowly": `rule: cap` with `max_sets_per_week` (about half the region's current weekly sets, from `node engine/cli.ts volume`) and `build_back: true`. The `week` skill asks once a week how the region felt and raises the cap.
   - "Avoid loading it for now": `rule: ban` on the patterns that load the region.
   - Say it in one line, for example "Left knee: no loaded deep knee bends for now." (no limit id or file path). The Stop hook commits the file; commit it yourself when you go on to plan.
5. **Plan around it, without asking.** The athlete's answer on the screen is the yes for these changes: ask no second question. Under the urgent stop, change nothing.
   - For the next 7 days, read the planned days where the plans live (`coach.yaml logger`: Tally, `node engine/cli.ts plans read --week <date>`, or the athlete's tool). Write the days to `.tmp/coach/week.json` with the Write tool and run `node engine/cli.ts limits check --input .tmp/coach/week.json`.
   - For each day that breaks the new limit and that the coach wrote (with Tally: `source` is `mcp` and `userModified` is false): change only what breaks the limit. A ban: replace the exercise with one of the same slot that does not load the region (search it with `search_exercises` with Tally), or remove it. A cap: lower the sets or the load to the cap. Keep the rest of the day as it is. Write it as the `week` skill's step 10 does (read first, `expectedVersion`, read back; `plans write` with files). Run `limits check` again on the changed days.
   - A day the athlete built or edited in the app: leave it, and say so in one line, for example "Thursday is your own day in Tally, so I left it: it has Box Squat."
   - Say what changed in one line, for example "Changed today and Thursday: Goblet Squat and Leg Press out, Leg Curl and Hip Thrust in." No changes needed: say nothing about it.
6. **Clear the urgent stop** (live session only). Ask one AskUserQuestion: "Has a clinician seen you about it?" with "A clinician has seen me about it", "It was a false alarm", "Not yet". On the first, run `node engine/cli.ts urgent clear --reason clinician`; on the second, `node engine/cli.ts urgent clear --reason false-alarm`. "Not yet", no answer, or no question tool: the stop stays. Never clear it on your own reading.
7. **"It's better" or "it's gone."** Ask "Remove the <region> limit? A) Yes, B) Loosen it, C) Keep it". A: delete the entry. B: raise the cap one step (one more set a week, or about 10% more load), or turn a ban into a cap with `build_back: true`. Write one line in the athlete log.
8. **Old notes** (setup, the weekly review). When `node engine/cli.ts safety scan-notes` reports pain notes, ask one multi-select: "Which of these still bother you?" with one option per region named, plus "None of these". A chosen region goes to step 2. Log the rest as resolved by the athlete.
9. **Always:** never diagnose, never name a likely cause, and never give medication, supplement, hormone or peptide advice. Say "See a clinician for new pain, pain that gets worse, or pain that does not settle." once per conversation.

Without AskUserQuestion (print mode), or when a call returns no answers, ask the same questions as text with lettered options, for example "Left knee: how should the coach handle it? A) It's fine now: train normally, B) Go light and build back slowly, C) Avoid loading it for now". Wait for the answer.

## Writes

- `athlete/limits.yaml`: the limit the athlete chose (a live answer only).
- `athlete/log/<YYYY-MM>.md`: one line for a region that is fine, a removed limit, or resolved old notes.
- `athlete/.urgent-stop` and `athlete/log/urgent-clearances.jsonl`, only through `node engine/cli.ts urgent set` and `node engine/cli.ts urgent clear --reason clinician|false-alarm`.

## Unattended

No one can answer, so ask nothing and change no limit. A check-in or a note that names pain: avoid loading that region today (an `annotate` note "Adjusted for recovery"), and write one log line "- proposal for the next live session: ask about <region>". An urgent sign: run `node engine/cli.ts urgent set --term <name> --source note` (or `checkin`); never clear the stop.
