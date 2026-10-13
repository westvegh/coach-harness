# Method packs

A method pack is one coherent training method, written so that three readers can use it: the engine (rules it can check), the coach (prose it can explain), and the planner (weekly templates it can fill). `coach.yaml` selects a pack with `method: <folder>`.

The binding format is in `docs/contracts.md` §4. This page explains it for people who write new packs. The flagship pack is `nine-adaptations/`; copy its layout.

## Layout

```
methods/<pack>/
  METHOD.md            what it is, who it is for, how to use it, credit, disclaimer
  principles/*.md      the method in prose; cites rule IDs inline, e.g. [NA-PROG-001]
  rules.yaml           every rule the harness acts on
  templates/3-day.yaml weekly frames, one per training-days option
  templates/4-day.yaml
  templates/5-day.yaml
  assessments.md       field tests, their order and frequency
  sources.md           table of public sources: key | title | URL | date | notes
```

Change a pack in a reviewed commit, with the athlete's yes (the `method` skill).

## `rules.yaml`

```yaml
pack: nine-adaptations
version: 1
rules:
  - id: NA-PROG-001                 # <PREFIX>-<AREA>-NNN, unique
    text: "Never raise weekly volume for a muscle by more than 10% over the reference week."
    kind: sourced                   # sourced: the source says it. policy: the pack's own choice.
    severity: hard                  # hard: the audit reports a hard finding. soft: a warning.
    source: { ref: E4, at: "01:36:25", precision: exact }   # required when kind is sourced
    check: { type: weekly_volume_increase_max, value: 0.10 } # optional; only known types
    note: "Optional context for reviewers."
```

- **`source.ref`** must be a key in `sources.md`. **`at`** is `HH:MM:SS` into that source. **`precision`** is `exact` (the statement itself was checked) or `chapter` (only the chapter start is certain).
- A policy rule may carry a `source` as its basis. Say in `note` what the pack chose.
- Mark a rule `hard` only when the engine enforces it. Everything else is `soft`.

### Check types

| type | value | meaning |
|---|---|---|
| `weekly_volume_increase_max` | fraction | cap on week-over-week sets per muscle |
| `deload_depth` | `{volume, load}` fractions | how deep a deload week goes |
| `deload_every_weeks` | integer N | a cycle of N weeks whose last week is a deload |
| `weekly_sets_per_muscle_range` | `[min, max]` | hard sets per muscle per week |
| `top_set_jump_max` | fraction | cap on a top set over the last logged top set |
| `session_minutes_max` | minutes | planned session length |
| `rep_range` | `{adaptation, min, max}` | reps per set for slots of that adaptation |
| `rest_range_s` | `{adaptation, min, max}` | rest seconds for slots of that adaptation |
| `session_change_min_categories` | integer | readiness categories needed to change a session |
| `program_change_min_categories` | integer | categories needed to change the program |
| `max_sets_per_exercise_session` | integer N (1 or more), plus `adaptations: [...]` beside `value` | when the coach drafts a week, one exercise of those adaptations gets at most N hard sets in a session (a drafting default and an audit finding, never a refusal) |

Any other type fails the lint. Adding a type means adding engine support first.

## Templates

```yaml
pack: nine-adaptations
version: 1
name: three-day
days: 3
week:
  - day: 1
    focus: "Speed and power, then hypertrophy"
    slots:
      - { pattern: plyometric, adaptation: power, sets: 3, reps: 3, rest_s: 180 }
      - { pattern: squat, adaptation: hypertrophy, sets: 4, reps: [6, 10], rest_s: 150 }
      - { pattern: zone2_cardio, adaptation: long_duration, sets: 1, duration: [2400, 3600], rest_s: 0 }
emphasis:
  all-around: {}
  strength: { strength: 1.34, hypertrophy: 0.75 }
  hypertrophy: { hypertrophy: 1.5 }
  endurance: { long_duration: 1.5 }
  general-health: { strength: 0.67 }
```

- **`pattern`** is a pattern ID from `engine/movements.yaml`. The planner picks exercises for it.
- **`adaptation`** is one of `skill`, `speed`, `power`, `strength`, `hypertrophy`, `muscular_endurance`, `anaerobic_capacity`, `max_aerobic`, `long_duration`, or `recovery` for mobility and breathing.
- **`reps`** or **`duration`** (seconds): a number or `[min, max]`. For conditioning, `sets` counts rounds or bouts.
- **`emphasis`** must list all five emphases. Each maps adaptations to set multipliers; a missing adaptation means 1. Sets round to the nearest whole set, and any multiplier above 0 keeps at least one set.

## The lint

```
node engine/lint-methods.ts methods/<pack> [--volume] [--json] [--taxonomy <movements.yaml>]
```

It fails (exit 1) when:

- a rule ID in the prose is missing from `rules.yaml`, or a rule is not cited in `principles/*.md`;
- a sourced rule has no source, or a source key is not in `sources.md`;
- a check type is unknown, or a check value has the wrong shape;
- a template uses a pattern the taxonomy does not know;
- under the `hypertrophy` emphasis, a muscle's weekly hard sets fall outside a `weekly_sets_per_muscle_range` rule. Other emphases produce warnings.

Weekly sets count only `strength`, `hypertrophy` and `muscular_endurance` slots, and credit every muscle of the slot's pattern in full. Muscles come from `engine/movements.yaml`; the lint has a small built-in fallback for common patterns. `--volume` prints the table. It also warns when a slot's reps or rest fall outside the pack's `rep_range` and `rest_range_s` rules.

## Writing a pack from someone else's method

- Use public sources only, and link them with timestamps.
- Write in your own words and structure. No transcripts, no long quotes, no copied tables.
- Run the copied-expression check against any notes you worked from:

  ```
  node scripts/overlap-check.ts methods/<pack> <notes-folder>
  ```

  It reports any run of 8 or more words shared with the folder. Aim for zero, and do not commit its output.
- Credit the source in `METHOD.md`, and say that the pack is not affiliated with or endorsed by its author.
