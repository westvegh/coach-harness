# coach-harness

coach-harness turns Claude Code into your strength and conditioning coach. It plans your training from a cited method, follows your limits, stops on urgent warning signs, and records every change in git.

**Status:** v0.2, an early release. Expect rough edges and breaking changes.

> **Not medical advice.** The coach plans and adjusts training only. It does not diagnose or treat, and it gives no advice about medication or supplements. See [Safety and privacy](#safety-and-privacy).

## Who it is for

People who train and who already use Claude Code. You should be comfortable with git, a terminal and Node.js.

## What you need

- **Claude Code 2.1.295 or later.** The urgent-stop hook blocks plan writes on failure only from that version. Check with `claude --version`.
- **Node.js 22.18 or later** (the version is in `.nvmrc`). Check with `node --version`.
- **A GitHub account and the GitHub CLI** (`gh`). Your coaching repository must be private.
- **Optional: [Tally](docs/tally.md) on iPhone,** to log sets at the gym. Without it, your plans go in a weekly spreadsheet file in your repo, or in a tool you already use.
- **Optional recovery data:** an Apple Watch through an iOS Shortcut that you build, or Oura on a Mac. Without them, the coach uses your check-ins and your logged sessions.
- **For scheduled cloud runs (optional):** a Claude plan with Claude Code routines, and Tally.

## Quick start

1. Click **Use this template** on GitHub, set it to **Private**, then click **Create repository**.
2. Clone your new repository and install the packages:

   ```sh
   git clone https://github.com/<you>/<your-repo>.git
   cd <your-repo>
   npm ci
   ```

3. Start Claude Code in the folder:

   ```sh
   claude
   ```

4. Say **"set me up"**.

## Setup: five screens of clickable questions

On the basic path, setup asks five screens of questions. You click your answers and type nothing.

1. **Basics:** units, days a week, session length and equipment.
2. **Goal:** all-around, strength, size or endurance.
3. **Health check:** the PAR-Q+ questions, and anything that limits your training now.
4. **Plans and data:** where your plans go, and the services that get your data.
5. **Week 1:** the coach shows the week as a table. You click "Write it".

When a Tally server is connected, the coach uses it without a question. If you say you do not use Tally, the coach leaves it out, even when it is connected.

Without Tally history, the coach asks about your recent training. It offers a workout export it found in Downloads or on your Desktop (from Strong, Hevy or Fitbod, for example), steps to export one from your app, two quick questions (how long you have trained and how many days a week), or "Skip". The coach reads only the file you choose.

Before the week 1 table, the coach says in a few lines why the week looks as it does: the split, how the next weeks build, and what your limits change.

Optional paths add a screen only when you choose them: "Show details" on the data question, an export from another app, the two quick questions, a body region that limits your training now, and "Change something" on week 1. In our evals, scripted answers on the basic path reached week 1 in 5 screens, with Tally and with plans in files.

When you state a lasting preference, such as a rep range or an exercise you dislike, the coach writes it in your athlete brief and follows it in later plans.

Setup also checks that your repository is private before the first push, and installs a git hook that refuses a push of your athlete files to a public repository.

After setup, talk to the coach in plain words: "how should I train today?", "check in", "plan next week", "I did my workout", "my knee hurts". You can add recovery data, daily and weekly automation, injury history or assessments later. Just ask.

## Where your plans go

| Choice | How it works |
|---|---|
| **Files in this repo** (the default without Tally) | One spreadsheet file per week, `plans/<YYYY>-W<ww>.csv`. Fill in what you did in Numbers, Excel or Google Sheets, or tell the coach in chat ("did all sets, last set of squats felt heavy"). |
| **Tally** | Plans go to the Tally app on your iPhone. You log sets at the gym, and the coach reads them back. |
| **A tool you already use** | Plans go to a tool you connected to Claude Code, for example Google Sheets or Notion. |

You can switch at any time: say "move my plans to Tally".

## How it works

```
recovery signals ─► readiness ─► method rules ─► change ─► your limits ─► your plans
```

1. Recovery data comes in each morning: sleep, HRV and resting heart rate. Say "check in" for today's report. The coach reads the data first, and asks one question ("How do you feel today?") only on a day when the answer can change the workout.
2. The engine scores three categories: wearable, subjective and performance.
3. The method's rules decide: keep the session, add a note, trim it, or swap to a recovery day. An isolated low reading usually gives a note only. Two exceptions: when you do not want to train at all, the coach makes it a recovery day (you can keep the session instead), and an urgent warning sign stops all training changes.
4. The coach reads your limits before every plan, and checks the planned week against them with the engine.
5. The plan goes where your plans live. You log your sets. Your log feeds the next day.

The engine makes every number. The coach recommends: it gives its pick and the reason, and you change it if you want. Small changes apply on their own. Big changes need your yes; a scheduled run saves each big change for the next time you talk to the coach.

**What git records:** every change to `athlete/`, `plans/` and `coach.yaml`, and a summary line in your athlete log for each Tally write. Changes the coach makes in another tool you connected are not recorded in git. The full description is in [docs/how-it-works.md](docs/how-it-works.md).

## What code enforces, and what it does not

Code enforces two rules:

1. **The urgent stop.** When you mention an urgent warning sign, such as chest pain, fainting, or new numbness or weakness, a hook writes `athlete/.urgent-stop` and commits it, and the coach pushes it next (a cloud run sees the stop after that push). While the stop exists, code blocks: every plan tool on any MCP server whose name ends in `plan_workout_day`, `plan_workout_range`, `update_planned_workout`, `move_planned_workout`, `skip_planned_workout`, `delete_planned_workout`, `update_user_profile` or `update_training_limits`; Edit, Write and MultiEdit under `plans/`; and `plans write` and `plans done`. Code also refuses `urgent clear` in a scheduled run and without a reason.
2. **Privacy.** Your athlete data never goes to a public repository. The push command and a git pre-push hook refuse a public destination.

The rest of the stop is the coach's instruction, not code: it gives the urgent-care text, writes nothing to another tool you connected, makes no plan change through the shell, and asks you before it runs `urgent clear`. Only your answer in a live session should clear the stop: "A clinician has seen me about it" or "It was a false alarm".

Code does **not** check your plans. The coach follows your limits and the method's rules because its instructions tell it to, not because a hook blocks it. It can misread a limit. The `audit` skill checks a planned week against your limits on request, git records every change, and the evals in `evals/` measure how often the coach follows your limits.

## Safety and privacy

- **Pain and injuries:** the coach asks one screen of clickable questions: train normally, go light and build back, or avoid loading the region for now. It writes the limit you chose. When you say "it's better", one question removes or loosens the limit.
- **Your limits** live in `athlete/limits.yaml`: a ban, or a cap on weekly sets or load, for a body region. The coach changes them only when you ask, and commits each change.
- **Your data** goes to Anthropic (your conversations with Claude, and the files the coach reads), your private GitHub repository, your Mac, and Tally or the tool you chose. The harness has no server.
- **Tally notes:** with Tally, the short note on a changed day can include readiness values, body regions and pain scores. That is the default. Choose "Show details" on setup's data question, then "Yes, but keep Tally notes generic", to keep them out.
- **The pre-push hook** cannot stop you from making the repository public later in GitHub's settings, so keep it private.

The details are in [docs/safety-and-privacy.md](docs/safety-and-privacy.md) and [docs/safety.md](docs/safety.md).

## The method pack

The pack that ships is **nine adaptations** (`methods/nine-adaptations/`). It treats fitness as nine separate adaptations: skill, speed, power, strength, hypertrophy, muscular endurance, anaerobic capacity, maximal aerobic output and long-duration endurance. It has 3-, 4- and 5-day templates, each with five emphases (all-around, strength, hypertrophy, endurance, general health).

The pack is a synthesis of Dr. Andy Galpin's public teaching, written in our own words. Each sourced rule has a link, with a timestamp where the source pins one; rules marked approximate cite the episode only. Rules marked `policy` are the pack's own choices, not source teaching, and `rules.yaml` labels them apart. The pack is not affiliated with or endorsed by Dr. Galpin.

You can write your own pack. See [docs/adding-a-method.md](docs/adding-a-method.md).

## Automation

After setup, say "automate it" to choose a mode:

| Mode | What runs |
|---|---|
| **Manual** | Nothing runs by itself. You talk to the coach. |
| **Mac** | launchd runs the coach on your Mac each morning and on Sunday. Needed for Oura. See [automation/launchd/README.md](automation/launchd/README.md). |
| **Cloud** | Claude Code cloud routines run the coach each morning and on Sunday. See [automation/routine.md](automation/routine.md). |

The scheduled runs need Tally for now. A scheduled run asks no questions and makes small changes only. It writes each big change in your log, and the coach offers it the next time you talk to it.

## Updating

Say "update the coach" in Claude Code. The coach shows what changes, asks before it writes, and never touches `coach.yaml` or `athlete/`. It needs `template-manifest.json`, which ships with each release; a copy made before updates existed cannot be updated this way.

**From v0.1.x to v0.2:** the first upgrade runs the v0.1 update skill that your session already has.

1. Open Claude Code in your main checkout (on `main`, not a git worktree), and say "update the coach". Answer its questions.
2. When it finishes, quit Claude Code and start it again. Run nothing else first: the running session still has the v0.1 hooks.
3. Say "finish the update". The v0.2 coach installs the packages and the git hook, checks your config and runs the tests.
4. If your copy has an old hold or safety check, the coach asks one question: remove them (v0.2 uses limits instead), or show them first. An old urgent hold becomes the urgent stop, and removing the old files never clears it.

Your plans stay in Tally. v0.2 no longer copies your limits to Tally; limits already in Tally stay until you remove them in the Tally app.

## Docs

- [How it works](docs/how-it-works.md)
- [Safety and privacy](docs/safety-and-privacy.md)
- [Tally](docs/tally.md)
- [Adding a method](docs/adding-a-method.md)
- [Adding a logger or a signal source](docs/adding-a-logger-or-signal.md)
- [Engineering contracts](docs/contracts.md)

## Contributing

Bug reports, method packs and adapters are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Report security problems privately: see [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE). Linked third-party sources keep their own rights.
