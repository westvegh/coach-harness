---
name: limits
description: Changes the athlete's limits (athlete/limits.md, in the athlete's own words) or the local exercise classification when the athlete asks, shows the new line and commits it. Use it when the user says "change my limits", "my physio said no overhead pressing", "my doctor cleared me", "add a limit", "remove a limit", "my knee is better", "I can deadlift again", "go easy on my left shoulder", "ask me about pain from 3 up", or "this exercise is not classified". Pain right now goes to the safety skill first. Never in an unattended run.
---

# Limits

Limits are the athlete's rules for the coach, in the athlete's own words, in `athlete/limits.md` (contracts §2). One bullet per limit, with its date. The coach reads the file before every plan and plans around every line by judgment. No code checks a plan against it. You change a line only when the athlete asks, and you commit the change.

Today is `TZ=<coach.yaml athlete.timezone> date +%F`.

## Steps

1. **Mode.** Run `node engine/cli.ts mode`. If it prints `unattended`, stop (see Unattended).
2. **Pain now.** Pain now, a new injury or a warning sign goes to the `safety` skill first: one question screen, then the line the athlete chose. Come back here only for a change the athlete asks for in words (a clinician's instruction, a new rule, a removal, "it's better").
3. **Read** `athlete/limits.md` with the Read tool. If it does not exist, start it from `templates/athlete/limits.md`. If `athlete/limits.yaml` still exists, run `node engine/cli.ts migrate-limits` first (the update skill's last step) and read the new file.
4. **Write the line in the athlete's words.** Ask no questions about numbers or movement names. Keep what the athlete said:
   - Add: one bullet, for example `- Left shoulder: no bench press or dips for now. Light pressing is fine. (since 2026-10-23)`. When a clinician gave the rule, add "from my physio" (or the athlete's word for them) inside the brackets. Say "I record what you report. I do not verify it."
   - Change: edit that line to what the athlete says now, and give it the new date.
   - Remove ("my knee is better", "my doctor cleared me"): delete the line. When it was the last line, write "None yet." under the intro line.
   - An exercise the athlete names that `node engine/cli.ts classify --exercise "<name>"` reports as `source: none`: you may add an entry to `athlete/movements.local.yaml` (`exercises: { <exerciseId or name>: [patterns] }`) after the athlete's yes. Never classify an exercise so that it slips past a limit.
   - A numbered limit keeps the athlete's number and unit exactly ("at most 6 sets a week", "50 lb or less"). Never invent a number the athlete did not give.
5. **Show it.** Show the new line (or say which line you removed) in one short message. The athlete's request is the yes: ask nothing more.
6. **Commit.** Run `node engine/cli.ts commit --message "limits: <add|change|remove> (<region>)"`. A nonzero exit: stop, and say in one line that the commit failed and why. No pain details or clinician text in the message.
7. **The coming days.** Read the planned days of the next 7 days where the plans live (`get_planned_workout`; with `coach.yaml logger: files`, `node engine/cli.ts plans read --week <date>`; with `other`, that tool). Check each against the new line yourself. List what the new line rules out, in plain words. Offer "Change those days now? A) Yes, B) At the next weekly run". A yes runs the `week` skill's steps 8 to 10 for those days. A day the athlete built or edited needs its own yes, as the `week` skill says.
8. **The pain threshold** ("ask me about pain from 3 up"): it is `thresholds.pain_threshold` in `coach.yaml` (0 to 10; default 4). Edit that line with the Edit tool, say the old and the new value, and commit as in step 6 (`limits: pain threshold <old> to <new>`).
9. **Tally's own limits.** The coach never writes limits to Tally. When `get_training_context` shows training limits that an earlier version wrote, say once: "Tally still has limits from an earlier version. Only you can remove them, in the Tally app: Settings → Training limits." Never rename or relabel an exercise to pass a Tally limit.
10. **Push.** `git pull --rebase`, then `node engine/cli.ts push`.

When you tell the athlete about a limit, use their words. Never say "hard sets", "cap", "allow list", "pattern" or "build back" unless the athlete said it.

## Writes

- `athlete/limits.md`: the line the athlete asked for.
- `coach.yaml` `thresholds.pain_threshold`: only when the athlete asks.
- `athlete/movements.local.yaml`: one classification (after the athlete's yes).
- Git: one commit.

## Unattended

Never change limits in an unattended run. Write nothing to `athlete/limits.md`. Log "- proposal for the next live session: limit change requested: <what>", commit, `git pull --rebase`, run `node engine/cli.ts push`, and stop.
