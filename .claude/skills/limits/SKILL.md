---
name: limits
description: Changes the athlete's limits (athlete/limits.yaml) or the local exercise classification when the athlete asks, shows the exact entry, writes it after the athlete's yes and commits it. Use it when the user says "my physio said no overhead pressing", "my doctor cleared me", "add a limit", "remove a limit", "I can deadlift again", "cap my hinge sets", "change my pain threshold", or "this exercise is not classified". Pain right now goes to the safety skill first. Never in an unattended run.
---

# Limits

Limits are the athlete's rules for the coach (contracts §2). The coach reads `athlete/limits.yaml` before every plan and follows it; no hook checks it. You change a limit only when the athlete asks, and you commit the change.

Today is `TZ=<coach.yaml athlete.timezone> date +%F`.

## Steps

1. **Mode.** Run `node engine/cli.ts mode`. If it prints `unattended`, stop (see Unattended).
2. **Pain now.** Pain now, a new injury or a warning sign goes to the `safety` skill first: one question screen, then the limit the athlete chose. Come back here only for a change the athlete asks for in words (a clinician's instruction, a cap, a removal).
3. **Read.** Read `athlete/limits.yaml` with the Read tool.
4. **Find the movements.** For each exercise the athlete names, run `node engine/cli.ts classify --exercise "<name>"`. It prints the patterns, the regions and the source. Choose patterns that load the region from `node engine/cli.ts limits regions`; `node engine/cli.ts limits schema` shows the entry shape.
   - `source: none` (unclassified): propose an entry for `athlete/movements.local.yaml` (`exercises: { <exerciseId or name>: [patterns] }`). Never classify an exercise so that it slips past a limit.
5. **Draft the change.** One entry per region (contracts §2):
   - Add: the id from `node engine/cli.ts ids next --kind limit`, `region`, `rule` (`ban` or `cap`), `patterns` and/or `exercises`, `allow` (exceptions, by exerciseId when possible), `max_load` and `max_sets_per_week` for a cap, `build_back: true` for a cap that should rise as the region recovers, `note` (a short constraint, never a story), `source` (`athlete` or `clinician-reported`), `since` (today).
   - Remove or relax: say what the athlete reports (symptom gone, or a clinician's clearance). Record a clinician report as `clinician-reported`. Say "I record what you report. I do not verify it."
   - A change of `pain_threshold`: show the old and new value.
6. **Show and ask.** Show the exact YAML change. Ask "Write this change? A) yes, B) change it, C) no".
7. **Write** after a yes: edit `athlete/limits.yaml` (or `athlete/movements.local.yaml`). Run `node engine/cli.ts commit --message "limits: <add|change|remove> <L-NNN> (<region>)"`. A nonzero exit: stop, and say in one line that the commit failed and why. No pain details or clinician text in the message.
8. **Plan impact.** For each planned day in the next 7 days, read it with `get_planned_workout` (with `coach.yaml logger: files`, `node engine/cli.ts plans read --week <date>`; with `other`, that tool). Write the days to `.tmp/coach/week.json` (`{days}`) and run `node engine/cli.ts limits check --input .tmp/coach/week.json`. List what the new limit blocks. Offer "Replace them now? A) yes, B) at the next weekly run". A yes runs the `week` skill steps 8 to 10 for those days.
9. **Tally's own limits.** v0.2 never writes limits to Tally. When `get_training_context` shows training limits that an earlier version wrote, say once: "Tally still has limits from an earlier version. Only you can remove them, in the Tally app: Settings → Training limits." Never rename or relabel an exercise to pass a Tally limit.
10. **Push.** `git pull --rebase`, then `node engine/cli.ts push`.

## Writes

- `athlete/limits.yaml`: one reviewed entry (after the athlete's yes).
- `athlete/movements.local.yaml`: one classification (after the athlete's yes).
- `.tmp/coach/week.json` (a scratch file for the plan check).
- Git: one commit.

## Unattended

Never change limits in an unattended run. Write nothing to the limits files. Log "- proposal for the next live session: limit change requested: <what>", commit, `git pull --rebase`, run `node engine/cli.ts push`, and stop.
