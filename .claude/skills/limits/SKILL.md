---
name: limits
description: Proposes a change to the athlete's injury limits (athlete/limits.yaml) or the local exercise classification, shows the exact entry, and writes it only after the athlete's interactive yes. Use it when the user says "my knee hurts when I squat", "my physio said no overhead pressing", "my doctor cleared me", "add a limit", "remove a limit", "I can deadlift again", "cap my hinge sets", "change my pain threshold", or when the guard says "classify it first". Pain right now goes to the safety agent first. Never in an unattended run.
---

# Limits

Limits are hard rules the guard enforces in code (contracts §2). `athlete/limits.yaml` and `athlete/movements.local.yaml` are protected: the guard asks the athlete before every edit. You propose; the athlete decides.

Today is `TZ=<coach.yaml athlete.timezone> date +%F`.

## Steps

1. **Mode.** Run `node engine/cli.ts mode`. If it prints `unattended`, stop (see Unattended).
2. **Safety first.** Pain now, a new injury, or any warning sign: run the `safety` agent first, in the foreground (`run_in_background: false`; never as a background agent). In the same turn, ask its questions with the AskUserQuestion tool (CLAUDE.md hard rule 1); without that tool, paste its "Questions for the athlete (copy exactly):" block to the user word for word, as a quoted block: do not reword it, and add nothing that changes its meaning. An AskUserQuestion call that returns no answers (denied, failed or not available) means the athlete was not asked; paste the copy-exactly block in the same reply. Continue only with its `SAFETY RESULT` (a `new-limit` proposal, or `resolved`).
3. **Read.** Read `athlete/limits.yaml` and `athlete/hold.yaml` with the Read tool. Run `node engine/cli.ts limits-hash` and note the hash.
4. **Find the movements.** For each exercise the user names, run `node engine/cli.ts classify --exercise "<name>"`. It prints the patterns, the regions and the source. Choose patterns that load the region from `node engine/cli.ts limits regions`; `node engine/cli.ts limits schema` shows the entry shape.
   - `source: none` (unclassified): propose an entry for `athlete/movements.local.yaml` (`exercises: { <exerciseId or name>: [patterns] }`). Never classify an exercise so that it passes a limit.
5. **Draft the change.** One entry per region (contracts §2):
   - Add: the id from `node engine/cli.ts ids next --kind limit`, `region`, `rule` (`ban` or `cap`), `patterns` and/or `exercises`, `allow` (exceptions, by exerciseId when possible), `max_load` and `max_sets_per_week` for a cap, `note` (a short constraint, never a story), `source` (`athlete` or `clinician-reported`), `since` (today).
   - Remove or relax: say what the athlete reports (symptom gone, or a clinician's clearance). Record a clinician report as `clinician-reported`. Say "I record what you report. I do not verify it."
   - A change of `pain_threshold`: show the old and new value.
6. **Show and ask.** Show the exact YAML diff. Ask "Write this change? A) yes, B) change it, C) no".
7. **Write** after a yes: edit `athlete/limits.yaml` (or `athlete/movements.local.yaml`). The guard asks the athlete again for the exact edit. Never write it any other way.
8. **Check.** Run `node engine/cli.ts limits-hash`. The hash changed. If the athlete said yes to the safety agent's "Add these limits and end the … hold?", hand off to the `safety` agent again with that yes and "the limits are written", so it ends the hold with `hold clear --released-by-limits`. Run it in the foreground (`run_in_background: false`; never as a background agent). In the same turn, ask its questions with the AskUserQuestion tool (CLAUDE.md hard rule 1); without that tool, paste its "Questions for the athlete (copy exactly):" block to the user word for word, as a quoted block: do not reword it, and add nothing that changes its meaning. An AskUserQuestion call that returns no answers (denied, failed or not available) means the athlete was not asked; paste the copy-exactly block in the same reply. Open proposals with the old hash no longer apply; say so if `node engine/cli.ts proposals list --status proposed` lists any.
9. **Plan impact.** For each planned day in the next 7 days, read it with `get_planned_workout`. List the exercises the new limit blocks. Offer "Replace them now? A) yes, B) at the next weekly run". A yes runs the `week` skill steps 8 to 10 for those days.
10. **Server-side limits (only when available).** Run this step only when the Tally tool list includes `update_training_limits`. Otherwise skip this step silently: do not mention it to the athlete.
    1. **Resolve names.** Collect every name under `exercises` and `allow` in `athlete/limits.yaml`. Call `search_exercises` once with all of them. Write `.tmp/coach/resolved.json` as `{"<name as written>": {"exerciseId": "...", "name": "..."}}`, one exact match per name.
    2. **Read Tally's limits.** Call `get_training_context`. Save its result to `.tmp/coach/context.json`.
    3. **Compute.** Run `node engine/cli.ts limits sync-ops --server .tmp/coach/context.json --resolved .tmp/coach/resolved.json`.
    4. **Report.** Say each `skipped` and `localOnly` reason in plain words: the local guard still enforces them. For each name in `unresolved`, ask which exercise the athlete means, update the file, and run step 3 again.
    5. **Tighten.** If `ops` is not empty, list them in plain words and ask "Add these limits to Tally? A) yes, B) no". After a yes, call `update_training_limits` with `{"ops": <ops>, "expectedVersion": <expectedVersion>}`. The guard asks the athlete again. On `conflict`, run steps 2 and 3 again, once.
    6. **App only.** Show each `appOnly` sentence. Say: "Only you can remove or relax a Tally limit, in the Tally app: Settings → Training limits." Never rename or relabel an exercise to pass a Tally limit.
11. **Commit.** `git add athlete/limits.yaml athlete/movements.local.yaml` and commit "limits: <add|change|remove> <L-NNN> (<region>)". No pain details or clinician text in the message. Push to `main`.

## Writes

- `athlete/limits.yaml`: one reviewed entry (interactive yes only).
- `athlete/movements.local.yaml`: one classification (interactive yes only).
- Tally: `update_training_limits` with tightening ops only (interactive yes only), when the tool list has it.
- `.tmp/coach/resolved.json` and `.tmp/coach/context.json` (scratch files for the sync).
- Git: one commit.

## Unattended

Never change limits in an unattended run. Write nothing. Log "limit change requested: needs the athlete", commit, `git pull --rebase`, run `node engine/cli.ts push`, and stop. The safety agent can still set a hold.
