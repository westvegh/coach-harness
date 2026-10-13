# How it works

coach-harness turns Claude Code into a strength and conditioning coach. Claude plans your training from a method pack, follows your limits, changes each day's session from your recovery data, and writes the plan where you keep it: a spreadsheet file in your repo, Tally on your iPhone, or a tool you already use. The engine makes every number. Code enforces two things only: the urgent stop and privacy. The coach's judgment, guided by the method pack and the skills, does the rest, and git records every change.

This page explains the parts. The exact formats are in [contracts.md](contracts.md).

## The loop

```
recovery signals ─► readiness ─► method rules ─► change ─► limits ─► your plans
     ▲                                                                   │
     └──────────────── logged sessions (performance) ◄───────────────────┘
```

1. **Signals.** Recovery data comes in each morning: sleep, HRV and resting heart rate from a wearable, and a short check-in from you.
2. **Readiness.** The engine scores three categories: wearable, subjective and performance.
3. **Method rules.** The method pack says what to do with that score: keep the session, add a note, trim it, or swap to a recovery day.
4. **Limits.** The coach reads `athlete/limits.yaml` before every plan and checks the planned week with `node engine/cli.ts limits check`. It fixes every conflict before it writes.
5. **Your plans.** The plan goes where your plans live (see "Where plans live"). You log your sets there, or tell the coach in chat. Your logged sessions become the performance signal for the next day.

Your history stays in files in your own private git repository.

## The parts

### Signals

A signal adapter turns one data source into daily records. Three adapters ship:

- **Apple Health, through an iOS Shortcut that you build.** The Shortcut reads last night's sleep, HRV and resting heart rate, asks the check-in questions, and commits one file a day to your private repo. The guide is `adapters/signals/apple-health-shortcut/SHORTCUT.md`.
- **Oura, on your Mac.** A fetcher reads the Oura API with your own Oura app credentials. The credentials stay in the macOS Keychain.
- **Check-in in chat.** Say "check in" and answer four 1-5 scales (sleep quality, energy, soreness, stress), an optional "want to train" scale, and pain by body region.

Each record carries the time the data was true and a flag that says whether it is complete. Old or future data does not count for today.

### Readiness

The readiness rules follow Dr. Andy Galpin's public teaching on recovery (Huberman Lab guest series, episodes 2 and 5, 2023), written in our own words. This project is not affiliated with or endorsed by Dr. Galpin. The rules are `NA-REC-003` to `NA-REC-012` in `methods/nine-adaptations/rules.yaml`.

The engine (`engine/readiness.ts`) scores three categories each morning as green, amber, red or unknown:

- **Wearable:** HRV and resting heart rate against your own baseline, and sleep against your sleep target. The baseline needs 28 valid days within the last 6 weeks. Until then the category is "calibrating". It is never compared with other people.
- **Subjective:** today's check-in. It has four 1-5 scales and an optional question: "How much do you want to train today?"
- **Performance:** your last logged sessions against their plans: missed sets or reps, harder effort than planned, or a dropped top set.

It acts on patterns, not on single days. An "off-morning" is a morning when HRV is below your normal band, or resting heart rate is above it. A morning with no reading is unknown. It does not count as off, and it ends a run of off-mornings.

| What the engine sees | Decision |
|---|---|
| Nothing off | No change |
| One off day, in any category | A note only. A dip after a hard session is often the training working. |
| 3 or more off-mornings in a row | Hold weight increases and trim about 20% of the sets |
| That run, plus a red check-in or red performance today | A recovery day |
| "Want to train" at 1 (you do not want to train at all) | Offer a recovery day. An unattended run makes it a recovery day. |
| 7 or more off-mornings in a row, plus a low check-in and a performance drop | Propose an early deload or a new block. You approve it. |

On a run of off-mornings, the coach also asks whether your sleep, eating or drinking changed. It never sets food or supplement targets. A change to the whole program needs all three kinds of evidence, and it needs your yes. The output of `node engine/cli.ts readiness --date <date>` shows the run (`pattern`), the `decision`, the reasons and the rule IDs.

### Method packs

A method pack (`methods/<pack>/`) holds a training method in three forms:

- **Rules** (`rules.yaml`): each rule has an ID, a source, and an optional check that the engine runs. For example, "raise weekly sets per muscle by 10% or less".
- **Prose** (`principles/*.md`): the method in plain words. It cites rule IDs, so the coach can explain each decision.
- **Templates** (`templates/3-day.yaml` and others): weekly frames that the planner fills with exercises.

The pack that ships is `nine-adaptations`. See [adding-a-method.md](adding-a-method.md) to write your own.

### The engine

The engine (`engine/`) is TypeScript with one dependency. Claude runs it through one command, `node engine/cli.ts <command>`, and it prints JSON. It computes readiness, weekly sets per muscle, next week's targets, load suggestions, trims, recovery days and change classes. Claude reports each number with the command that made it. It never does the arithmetic itself.

### Sets per exercise and cluster sets

- **Sets per exercise.** When the coach drafts a week, one exercise gets at most 4 hard sets in a session (the method's default). The extra sets for a muscle go to another exercise. When no exercise can take them, the draft names the muscle that gets fewer sets than wanted. You can choose more: a plan with more sets stays valid, and the audit only notes it.
- **Cluster sets.** A cluster is a set split into short mini-sets with a few seconds of rest between them, for example 6 mini-sets of 6 reps at a weight you could lift 12 times. The coach records each exercise you do as a cluster in `coach.yaml`. A cluster counts as its total reps divided by that rep max: 6 × 6 at a 12-rep weight counts as 3 hard sets. The coach keeps the cluster the same from week to week and gives the other exercises the rest of the muscle's sets. A cluster's weight goes up only when you did every rep at the same weight; otherwise it stays the same. It never drops for a short last mini-set.

### Change classes

The engine classifies every change to a day (`engine/classify.ts`). The model's own label does not count.

- **Small changes** apply on their own: a trim, a recovery swap, a load step inside the cap, a move inside the week, a note, a session from the current block.
- **Big changes** need you: a new exercise, more volume than planned, a change to a day you built or edited yourself, a change to your limits, a new block or a new method.

In a live session, the coach asks you, with clickable options. A scheduled run makes no big change: it writes one line in your athlete log ("proposal for the next live session: …"), and the coach offers it the next time you talk to it.

### What code enforces, and what it does not

Code enforces two rules. Nothing else blocks the coach.

1. **The urgent stop.** When you name an urgent warning sign (chest pain, fainting, new numbness or weakness, and the other terms in `engine/safety-terms.yaml`), the message hook writes `athlete/.urgent-stop` and commits it, and the coach pushes it next (a cloud run sees it after that push). While the stop exists, code blocks: every MCP tool, on any server, whose name ends in `plan_workout_day`, `plan_workout_range`, `update_planned_workout`, `move_planned_workout`, `skip_planned_workout`, `delete_planned_workout`, `update_user_profile` or `update_training_limits`; Edit, Write and MultiEdit under `plans/`; and `plans write` and `plans done`. Code also refuses `urgent clear` in a scheduled run and without a reason. The rest is the coach's instruction only: no change in a tool you connected yourself, no plan change through the shell, and asking you before `urgent clear`. Only your answer in a live session should clear it: "A clinician has seen me about it" or "It was a false alarm".
2. **Privacy.** A git pre-push hook refuses a push when the remote repository is public or its visibility cannot be checked. `node engine/cli.ts push` checks the same before it pushes.

Code does not check your plans. The coach follows your limits and the method's rules because `CLAUDE.md`, the skills and the method pack tell it to, and the `audit` skill reports any conflict. The coach can still misread a limit. The evals in `evals/` measure how often it follows them, and git and your logger show every change.

### Where plans live

`coach.yaml logger` says where your plans live:

- **`files`** (the default without Tally): one spreadsheet file per week, `plans/<YYYY>-W<ww>.csv`, in your private repo. The coach fills the plan columns. You fill the `done_` columns in Numbers, Excel or Google Sheets, or you tell the coach in chat ("did all sets, last set of squats felt heavy") and it fills them.
- **`tally`**: [Tally](tally.md) on your iPhone, through its MCP tools. You log sets at the gym, and the coach reads them back.
- **`other`**: a tool you already use and connected to Claude Code (for example Google Sheets or Notion). The coach follows that tool's own instructions. When the tool does not answer, the coach uses files.

You can switch at any time ("move my plans to Tally"). With files, the coach mentions Tally once, after the third session you log by hand, and never again.

### Memory

Your athlete files live in `athlete/` in your private repo:

- `brief.md`: your goals, history, schedule, equipment and preferences (a lasting choice you state, such as a rep range, goes here, and every later plan follows it);
- `limits.yaml`: your limits (a ban, or a cap on sets or load, for a body region);
- `block.yaml`: the current training block;
- `log/YYYY-MM.md`: one entry for each change, with the readiness, the rule IDs and the result, and any proposal for the next live session.

With `logger: files`, your weekly plans are in `plans/`. The coach commits after each change, and a Stop hook commits any changed file under `athlete/`, `plans/` and `coach.yaml` that is left. So git records every change to `athlete/`, `plans/` and `coach.yaml`. With Tally, each write gets a summary line in the athlete log; the Tally day itself is not in git. A change in another tool you connected is not recorded in git.

## Updates

Your repo is a copy of the template with no link back to it. Each release ships `template-manifest.json`: every template file with its git mode and blob id. `node engine/cli.ts update --check` fetches the template's new release and compares, per file, the old manifest, the new manifest and your file. A file you did not change is replaced; a file you changed that the template did not change stays yours; a file both changed is a conflict that you settle (keep yours, or take the template's with a backup). Your `coach.yaml` and `athlete/` files are never touched. `update --yes --to <sha>` writes the plan all or nothing and commits once. The `update` skill walks you through it and runs the checks after.

## Safety

When you mention pain or an injury, the coach asks one screen of clickable questions: how to handle the region (train normally, go light and build back, or avoid loading it for now), the side, and a short warning-sign check. It writes the limit you chose. When you say it is better, it asks one question and removes or loosens the limit.

A hook reads every message you send for urgent warning signs only. An urgent sign starts the urgent stop (see above). A scheduled run can never clear it.

The coach is not medical advice. See [safety-and-privacy.md](safety-and-privacy.md).

## Automation

After setup, say "automate it" to choose one of three modes:

| Mode | What runs | Notes |
|---|---|---|
| Manual | Nothing runs by itself. You talk to the coach. | The default. |
| Mac | launchd runs `claude -p` on your Mac each morning and on Sunday. | Needed for Oura. The Mac must be awake. |
| Cloud | Claude Code cloud routines run each morning and on Sunday. | Needs a Claude plan with routines. Reads Apple Health through the Shortcut file. |

The scheduled runs need Tally for now. With `logger: files` or `other`, run the coach by hand: "how should I train today?" each morning and "plan next week" on Sunday.

A scheduled run is unattended: it asks no questions, makes only small changes, and writes each big change as a log line for the next live session. The daily run checks today's session once in a morning window. The weekly run plans next week. The details are in `automation/routine.md` (cloud) and `automation/launchd/README.md` (Mac).
