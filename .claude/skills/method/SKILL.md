---
name: method
description: Builds a new method pack from sources the user gives (podcasts, papers, books, articles), as a synthesis in our own words with links and timestamps, rule IDs, three weekly templates and a passing lint. Use it when the user says "add a method from these sources", "make a method pack", "build a training method from this podcast", "turn this program into a method", "new method", or "write rules for this approach". It never copies third-party text. Interactive only; every pack file needs the user's yes.
---

# Method

A method pack follows `methods/README.md` and contracts §4. Copy the layout of `methods/nine-adaptations/`. `methods/**` is protected: the guard asks the user before each file is written.

## Steps

1. **Mode.** Run `node engine/cli.ts mode`. If it prints `unattended`, stop (see Unattended).
2. **Scope.** Ask: the pack name (lowercase, with dashes), the rule prefix (2-4 capital letters, for example `HB`), who it is for, and the sources (URLs, titles, dates). Ask "Do you have the right to use these sources for a synthesis? A) yes, public material, B) not sure". For B, stop and say why.
3. **Read the sources.** Read only what the user gives or links. Note each claim with its source key and a timestamp or page. Never copy transcripts, long quotes or tables. Write every rule and every principle in your own words and structure.
4. **Draft the files** (in the session first, not on disk):
   - `METHOD.md`: what it is, who it is for, how to use it, credit, and the disclaimer "A synthesis of <name>'s public teaching, written independently. Not affiliated with or endorsed by <name>. Not medical advice."
   - `sources.md`: a table with key, title, URL, date, notes.
   - `rules.yaml`: `pack`, `version`, `rules` with `id` (`<PREFIX>-<AREA>-NNN`), `text`, `kind` (`sourced` or `policy`), `severity` (`hard` only for checks the engine enforces), `source: { ref, at, precision }` (required for `sourced`), and an optional `check` of a known type (`methods/README.md` lists them).
   - `principles/*.md`: the method in prose. Cite each rule inline as `[ID]`. Every rule ID appears in the prose, and every ID in the prose exists in `rules.yaml`.
   - `templates/3-day.yaml`, `4-day.yaml`, `5-day.yaml`: days with focus and slots (`pattern` from `engine/movements.yaml`, `adaptation`, `sets`, `reps` or `duration`, `rest_s`), and an `emphasis` table.
   - `assessments.md`: tests per quality, their order and frequency.
5. **Show the draft.** Show the rule list (ID, text, kind, source) and one template. Ask "Write the pack? A) yes, B) change it, C) no".
6. **Write** after a yes: create `methods/<pack>/…`. The guard asks the user for each file.
7. **Lint.** Run `node engine/cli.ts lint-methods --pack <pack> --volume`. Fix every error (show each fix, and write it after a yes). Report the warnings.
8. **Audit a sample.** Run the `audit` skill on one template week with the new pack, to check that the rules read well.
9. **Commit.** Commit "method <pack>: new pack (<n> rules)". Push. Say how to switch: "Change `method` in coach.yaml with the block skill (a method change needs your yes)."

## Writes

- `methods/<pack>/**`: a new pack only, never an existing one (interactive yes only).
- Git: one commit.

## Unattended

Never build a method pack in an unattended run. Write nothing, log "method pack requested: needs the user", and stop.
