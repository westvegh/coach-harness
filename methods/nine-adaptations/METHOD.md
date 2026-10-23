# Nine adaptations

> A synthesis of Dr. Andy Galpin's public teaching, written independently. Not affiliated with or endorsed by Dr. Galpin. Not medical advice.

## What it is

A training method pack for `coach-harness`. It turns one coherent view of training into rules the engine can check, prose the coach can explain, and weekly templates the planner can fill.

The view comes from Dr. Andy Galpin's public teaching, mainly his six-part guest series on the Huberman Lab podcast (January-February 2023). Fitness is treated as nine separate adaptations (skill, speed, power, strength, hypertrophy, muscular endurance, anaerobic capacity, maximal aerobic output and long-duration endurance), each with its own stimulus, dose and recovery. All text in this pack is written in our own words and structure. Every sourced rule links to a public episode and a timestamp (`sources.md`). Where we made a choice the source does not make, the rule says `kind: policy`.

## Who it is for

- Adults who want all-round fitness: strong, muscular enough, fit for hard efforts and for long easy ones.
- People who train 3 to 5 days a week, with or without a coach.
- It is not a sport-specific peaking plan, a rehabilitation program or a medical protocol. Pain, injury and health conditions belong with a clinician. The coach loads a painful region only as the athlete chooses, and the harness stops all training changes on urgent warning signs.

## How to use it

1. Set `method: nine-adaptations` in `coach.yaml`, and choose `template: { days: 3|4|5, emphasis: ... }`. Emphasis is one of `all-around`, `strength`, `hypertrophy`, `endurance`, `general-health`.
2. Run the assessment battery (`assessments.md`) before the first block, then about once or twice a year.
3. Let the planner build a block from the template: 5 build weeks and a deload week, repeated.
4. Each day, the harness reads readiness against the athlete's own baseline. It acts on patterns, not single days: a note for one off day, a trim and no progression after 3 off-mornings in a row, a recovery day on aversion, and a proposal after 7 or more. The rules are in `principles/07-recovery-readiness.md`.

### What is in the folder

| Path | Contents |
|---|---|
| `principles/01-08` | The method in prose. Each claim that the harness acts on cites a rule ID, for example `[NA-PROG-001]`. |
| `rules.yaml` | 49 rules with IDs, severities, sources and machine checks. |
| `templates/3-day.yaml`, `4-day.yaml`, `5-day.yaml` | Weekly frames with slots by movement pattern, and an emphasis table of set multipliers per adaptation. |
| `assessments.md` | Field tests per adaptation, their order and frequency. |
| `sources.md` | The public sources, and how the timestamps were checked. |

### The hard rules: computed and reported, not enforced

Five rules are hard: the 10% weekly volume cap [NA-PROG-001], the 10% top-set ceiling [NA-PROG-003], the return after a deload [NA-PROG-008], the small-base allowance [NA-PROG-009], and a painful region loaded only as the athlete chose [NA-REC-007]. The engine builds the first four into its targets and load suggestions. For [NA-REC-007], the athlete's choice becomes a limit, and `limits check` reports a plan that breaks it. The audit reports a break of any of the five. The coach follows them in every plan.

No code blocks a plan that breaks a hard rule. In v0.2, code enforces only the urgent stop and privacy. Everything else is soft: the audit warns, and the coach explains.

## Credit

The training model, the methods and the numbers are Dr. Andy Galpin's public teaching, as presented in the Huberman Lab guest series with Dr. Andrew Huberman. Please listen to the original episodes, which are linked in `sources.md`. They go far deeper than this pack. Any error in this synthesis is ours, not his.

## Disclaimer

A synthesis of Dr. Andy Galpin's public teaching, written independently. Not affiliated with or endorsed by Dr. Galpin.

Not medical advice. This pack is general training information, not a diagnosis or a treatment. Talk to a qualified clinician before you start or change training if you have a health condition, an injury, pain, or symptoms such as chest pain, fainting or unusual shortness of breath.
