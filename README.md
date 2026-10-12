# coach-harness

coach-harness turns Claude Code into your strength and conditioning coach: it plans your training from a cited method, adjusts each day from your recovery data, and enforces your injury limits in code.

**Status:** v0.1, an early release. Expect rough edges and breaking changes.

> **Not medical advice.** The coach plans and adjusts training only. It does not diagnose or treat, and it gives no advice about medication or supplements. See [Safety and privacy](#safety-and-privacy).

## Who it is for

People who train and who already use Claude Code. You should be comfortable with git, a terminal and Node.js.

## What you need

- **Claude Code 2.1.295 or later.** The guard hooks fail closed only from that version. Check with `claude --version`.
- **Node.js 22.18 or later** (the version is in `.nvmrc`). Check with `node --version`.
- **A GitHub account and the GitHub CLI** (`gh`). Your coaching repository must be private.
- **A training logger.** [Tally](docs/tally.md) on iPhone is the only logger included today. You can add another through an adapter: see [Adding a logger or a signal source](docs/adding-a-logger-or-signal.md).
- **Optional recovery data:** an Apple Watch through an iOS Shortcut that you build, or Oura on a Mac. Without them, the coach uses your check-ins and your logged sessions.
- **For scheduled cloud runs (optional):** a Claude plan with Claude Code routines.

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

Setup takes about 30 minutes. The `setup` skill checks your tools, runs a short health screen, asks for your consent for each data recipient, interviews you, connects Tally and your recovery data, proposes your first training block, and writes week 1 after your yes. It also installs a git hook that blocks pushes of your athlete files to a public repository.

After setup, talk to the coach in plain words: "how should I train today?", "check in", "plan next week", "my knee hurts".

## How it works

```
recovery signals ─► readiness ─► method rules ─► guard ─► Tally (your phone)
```

1. Recovery data comes in each morning: sleep, HRV and resting heart rate, and a short check-in.
2. The engine scores three categories: wearable, subjective and performance.
3. The method's rules decide: keep the session, add a note, trim it, or swap to a recovery day. One bad signal alone changes nothing.
4. The guard rebuilds the day and the week, and checks them against your limits and the method's hard rules before any write.
5. The plan goes to your phone. You log your sets. Your log feeds the next day.

Code makes every number. Small changes apply on their own; big changes need your yes. The full description is in [docs/how-it-works.md](docs/how-it-works.md).

## The method pack

The pack that ships is **nine adaptations** (`methods/nine-adaptations/`). It treats fitness as nine separate adaptations: skill, speed, power, strength, hypertrophy, muscular endurance, anaerobic capacity, maximal aerobic output and long-duration endurance. It has 3-, 4- and 5-day templates, each with five emphases (all-around, strength, hypertrophy, endurance, general health).

The pack is a synthesis of Dr. Andy Galpin's public teaching, written in our own words. Each sourced rule has a link, with a timestamp where the source pins one; rules marked approximate cite the episode only. Rules marked `policy` are the pack's own choices, not source teaching, and `rules.yaml` labels them apart. The pack is not affiliated with or endorsed by Dr. Galpin.

You can write your own pack. See [docs/adding-a-method.md](docs/adding-a-method.md).

## Safety and privacy

- A hook reads every message you send. A pain word or an urgent warning sign pauses training changes until you answer a few questions.
- A hold for a body region (a shoulder, say) blocks only the exercises that load that region; other training goes on. A hold with no region, or an unanswered safety check, allows only notes, rest and recovery work. An urgent warning sign allows no exercise at all: only notes, rest days and skips. Only you can clear a hold, in a live session.
- Your injury limits are enforced in code. The model cannot edit them.
- Your data stays in your private repository, your logger, and on your Mac. The harness has no server.
- A git pre-push hook blocks a push of athlete files to a public repository. It cannot stop you from making the repository public later in GitHub's settings, so keep it private.

The details are in [docs/safety-and-privacy.md](docs/safety-and-privacy.md) and [docs/safety.md](docs/safety.md).

## Automation

Setup asks which mode you want:

| Mode | What runs |
|---|---|
| **Manual** | Nothing runs by itself. You talk to the coach. |
| **Mac** | launchd runs the coach on your Mac each morning and on Sunday. Needed for Oura. See [automation/launchd/README.md](automation/launchd/README.md). |
| **Cloud** | Claude Code cloud routines run the coach each morning and on Sunday. See [automation/routine.md](automation/routine.md). |

A scheduled run asks no questions. It makes small changes only, and it opens a pull request in your repository for a big change. Merging the pull request is your yes.

## Updating

Say "update the coach" in Claude Code. The coach shows what changes, asks before it writes, and never touches `coach.yaml` or `athlete/`.
It needs `template-manifest.json`, which ships with each release; a copy made before updates existed cannot be updated this way.
The command behind it is `node engine/cli.ts update --check`, then `update --yes --to <sha>`.

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
