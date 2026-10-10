# How it works

coach-harness turns Claude Code into a strength and conditioning coach. Claude plans your training from a method pack, changes each day's session from your recovery data, and writes the plan to the app where you log your sets. Code, not the model, makes every number and checks every write.

This page explains the parts. The exact formats are in [contracts.md](contracts.md).

## The loop

```
recovery signals ─► readiness ─► method rules ─► change ─► guard ─► logger (your phone)
     ▲                                                                   │
     └──────────────── logged sessions (performance) ◄───────────────────┘
```

1. **Signals.** Recovery data comes in each morning: sleep, HRV and resting heart rate from a wearable, and a short check-in from you.
2. **Readiness.** The engine scores three categories: wearable, subjective and performance.
3. **Method rules.** The method pack says what to do with that score: keep the session, add a note, trim it, or swap to a recovery day.
4. **Guard.** Before any write, the guard rebuilds the result and checks it against your limits and the method's hard rules.
5. **Logger.** The plan goes to the app on your phone. You log your sets there. Your logged sessions become the performance signal for the next day.

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

### Change classes

The engine classifies every change to a day (`engine/classify.ts`). The model's own label does not count.

- **Small changes** apply on their own: a trim, a recovery swap, a load step inside the cap, a move inside the week, a note, a session from the current block.
- **Big changes** need you: a new exercise, more volume than planned, a change to a day you built or edited yourself, a change to your limits, a new block or a new method.

In a live session, the coach asks you. In a scheduled run, it opens a pull request in your repo. Merging the pull request is the approval.

### The guard

Claude Code hooks in `.claude/hooks/` run on every tool call that matters. The guard fails closed: any error, missing file or timeout blocks the write.

Before every write to your logger, the guard:

1. checks that the affected days were read in this session in the last 15 minutes, and that the write carries the version it read;
2. rebuilds the day and the week as they will be after the write;
3. checks the result against safety holds, your limits, the method's hard rules (for example the volume cap and the top-set cap) and the change class.

The guard also protects key files from edits by the model: your limits, the hold file, the method pack, the engine, the adapters and the hooks. You change those files yourself, or the coach proposes the change and asks you.

### The logger

A logger adapter (`adapters/loggers/<name>/`) connects the coach to the app that holds your plan and your workout log. It lists the app's tools and has one rebuild function per write tool, so the guard can compute the result before the write. [Tally](tally.md) is the reference logger.

### Memory

Your athlete files live in `athlete/` in your private repo:

- `brief.md`: your goals, history, schedule and equipment;
- `limits.yaml`: your injury limits;
- `block.yaml`: the current training block;
- `log/YYYY-MM.md`: one entry for each change, with the readiness, the rule IDs and the result;
- `proposals/`: big changes that wait for your yes.

The coach commits after each change. Git is the record.

## Updates

Your repo is a copy of the template with no link back to it. Each release ships `template-manifest.json`: every template file with its git mode and blob id. `node engine/cli.ts update --check` fetches the template's new release and compares, per file, the old manifest, the new manifest and your file. A file you did not change is replaced; a file you changed that the template did not change stays yours; a file both changed is a conflict that you settle (keep yours, or take the template's with a backup). Your `coach.yaml` and `athlete/` files are never touched. `update --yes --to <sha>` writes the plan all or nothing and commits once. The `update` skill walks you through it and runs the checks after.

## Safety

A hook reads every message you send. When it finds a pain word or an urgent warning sign, it pauses training changes until you answer a few questions. A hold allows only notes, rest and recovery work. Scheduled runs can never clear a hold.

The coach is not medical advice. See [safety-and-privacy.md](safety-and-privacy.md).

## Automation

You choose one of three modes during setup:

| Mode | What runs | Notes |
|---|---|---|
| Manual | Nothing runs by itself. You talk to the coach. | The default. |
| Mac | launchd runs `claude -p` on your Mac each morning and on Sunday. | Needed for Oura. The Mac must be awake. |
| Cloud | Claude Code cloud routines run each morning and on Sunday. | Needs a Claude plan with routines. Reads Apple Health through the Shortcut file. |

A scheduled run is unattended: it asks no questions, makes only small changes, and opens a pull request for big ones. The daily run checks today's session once in a morning window. The weekly run plans next week. The details are in `automation/routine.md` (cloud) and `automation/launchd/README.md` (Mac).
