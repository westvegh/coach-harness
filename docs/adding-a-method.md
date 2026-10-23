# Adding a method

A method pack is one training method, written so that the engine can check it, the coach can explain it, and the planner can fill its weekly templates. The pack that ships is `methods/nine-adaptations/`.

The file format is in [methods/README.md](../methods/README.md) and in [contracts.md](contracts.md) §4. This page gives the steps.

## Two ways to make a pack

- **With the coach.** Open Claude Code in the repo and say "make a method pack from these sources", then give links to podcasts, papers, books or articles. The `method` skill writes the pack with you, one file at a time, and asks for your yes on each file. It runs the lint at the end.
- **By hand.** Follow the steps below.

## Steps

1. **Copy the layout.** Copy `methods/nine-adaptations/` to `methods/<your-pack>/`. Keep the file names.
2. **List your sources** in `sources.md`: key, title, URL, date and notes. Use public sources only.
3. **Write the rules** in `rules.yaml`. Give each rule a unique ID (`<PREFIX>-<AREA>-NNN`), a `kind` (`sourced` or `policy`) and a `severity`.
   - A `sourced` rule needs a `source` with a key from `sources.md` and a timestamp.
   - Mark a rule `hard` only when it has a `check` that the engine runs. The engine builds a hard rule into its numbers, and the audit reports a plan that breaks one. No hook blocks such a plan: the coach follows the rule.
   - Use only the check types in [methods/README.md](../methods/README.md). A new check type needs engine support first.
   - Optional: a per-exercise session maximum, `check: { type: max_sets_per_exercise_session, value: 4, adaptations: [power, strength, hypertrophy, muscular_endurance] }`, kind `policy`, severity `soft`. When the coach drafts a week, one exercise of the listed adaptations then gets at most `value` hard sets in a session, and the extra sets go to another exercise. List only resistance adaptations: conditioning, recovery and cluster work is never limited. The lint accepts it only with a whole number of 1 or more and known adaptation names. Without the check, the draft has no maximum.
4. **Write the prose** in `principles/*.md`. Cite each rule inline, for example `[NA-PROG-001]`. Every rule must be cited, and every cited ID must exist.
5. **Write the templates** `templates/3-day.yaml`, `4-day.yaml` and `5-day.yaml`. Each slot names a movement pattern from `engine/movements.yaml`, an adaptation, sets, reps or duration, and rest. List all five emphases. Optional: a top-level `why:` list of 3 to 5 plain lines for the athlete (the split, why work outside the goal stays, how the block builds, the lighter week), and a one-line `why` on each day. The setup and block skills show them before the week table as "Why this week". Keep each line at 25 words or fewer, with no rule ids and no file paths; the lint checks both. A pack may leave them out.
6. **Write `METHOD.md`** (what the method is, who it is for, credit and a disclaimer) and `assessments.md` (field tests).
7. **Run the lint:**

   ```sh
   node engine/cli.ts lint-methods --pack <your-pack> --volume
   ```

   It fails on a missing or unknown rule ID, a sourced rule without a source, an unknown check type, an unknown pattern, or hypertrophy volume outside the pack's range.
8. **Run the tests:** `npm test`.
9. **Use it.** Set `method: <your-pack>` in `coach.yaml`. A method change is a big change: the coach asks you, and plans a new block.

## Write in your own words

- Do not copy text, transcripts, long quotes or tables from a source. State the method in your own structure and words, and link the source with a timestamp.
- Check your draft against the notes you worked from:

  ```sh
  node scripts/overlap-check.ts methods/<your-pack> <notes-folder>
  ```

  It reports any run of 8 or more words that the pack shares with your notes. Aim for zero. Do not commit its output.
- Credit the source in `METHOD.md`, and say that the pack is not affiliated with or endorsed by its author.

## In an athlete repo

No hook protects `methods/**`. In a live session, Claude Code asks you before the model edits a pack, because `.claude/settings.json` does not allow those edits. A scheduled run's tool list does not include them either. Change a pack in a commit that you review.

## Share it

To add a pack to the public repository, open a pull request. Include the lint output and a short note about the sources. See [CONTRIBUTING.md](../CONTRIBUTING.md).
