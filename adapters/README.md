# Adapters

An adapter connects coach-harness to an outside system:

- `signals/`: recovery data in (Apple Health through an iOS Shortcut, Oura, chat check-ins).
- `loggers/`: the app that holds the plan and the workout log (Tally).

The guide to adding one is [docs/adding-a-logger-or-signal.md](../docs/adding-a-logger-or-signal.md). The formats are in [docs/contracts.md](../docs/contracts.md) (§5, §11, §12).

Change an adapter in a reviewed commit.
