---
name: method
description: Builds a new method pack from sources the user gives (podcasts, papers, books, articles), as a synthesis in our own words with links and timestamps, rule IDs, three weekly templates and a passing lint. Use it when the user says "add a method from these sources", "make a method pack", "build a training method from this podcast", "turn this program into a method", "new method", or "write rules for this approach". It never copies third-party text. Interactive only; one yes approves the whole reviewed pack.
---

# Method

A method pack follows `methods/README.md` and contracts §4. Copy the layout of `methods/nine-adaptations/`. The user approves the whole reviewed pack once; ordinary fixes after that need no new yes.

## Steps

1. **Mode.** Run `node engine/cli.ts mode`. If it prints `unattended`, stop (see Unattended).
2. **Scope.** Ask: the pack name (lowercase, with dashes), the rule prefix (2-4 capital letters, for example `HB`), who it is for, and the sources (URLs, titles, dates). Ask "Do you have the right to use these sources for a synthesis? A) yes, public material, B) not sure". For B, stop and say why.
3. **Read the sources.** Read only what the user gives or links. Note each claim with its source key and a timestamp or page. Never copy transcripts, long quotes or tables. Write every rule and every principle in your own words and structure.
4. **Draft the files** (in the session first, not on disk):
   - `METHOD.md`: what it is, who it is for, how to use it, credit, and the disclaimer "A synthesis of <name>'s public teaching, written independently. Not affiliated with or endorsed by <name>. Not medical advice."
   - `sources.md`: a table with key, title, URL, date, notes.
   - `rules.yaml`: `pack`, `version`, `rules` with `id` (`<PREFIX>-<AREA>-NNN`), `text`, `kind` (`sourced` or `policy`), `severity` (`hard` only for checks the engine runs), `source: { ref, at, precision }` (required for `sourced`), and an optional `check` of a known type (`methods/README.md` lists them).
   - `principles/*.md`: the method in prose. Cite each rule inline as `[ID]`. Every rule ID appears in the prose, and every ID in the prose exists in `rules.yaml`.
   - `templates/3-day.yaml`, `4-day.yaml`, `5-day.yaml`: days with focus and slots (`pattern` from `engine/movements.yaml`, `adaptation`, `sets`, `reps` or `duration`, `rest_s`), and an `emphasis` table.
   - `assessments.md`: tests per quality, their order and frequency.
5. **Show the draft.** Show the rule list (ID, text, kind, source), one template and the list of files. Ask once: "Write the whole pack? A) yes, B) change it, C) no". This one yes covers every file of the reviewed pack.
6. **Write** after that yes: create every file under `methods/<pack>/`. Do not ask again per file.
7. **Lint.** Run `node engine/cli.ts lint-methods --pack <pack> --volume`. Fix every error yourself (an ordinary fix: a typo, a missing field, a number the lint names), and list the fixes in one line. Ask again only when a fix changes what a rule says. Report the warnings.
8. **Audit a sample.** Run the `audit` skill on one template week with the new pack, to check that the rules read well.
9. **Commit.** Commit "method <pack>: new pack (<n> rules)". Push. Say how to switch: "Change `method` in coach.yaml with the block skill (a method change needs your yes)."

## Writes

- `methods/<pack>/**`: a new pack only, never an existing one (interactive yes only).
- Git: one commit.

## Unattended

Never build a method pack in an unattended run. Write nothing, log "method pack requested: needs the user", and stop.
