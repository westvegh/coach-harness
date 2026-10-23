# Contributing

Thank you for your help. This page tells you how to set up the repository, run the tests, and add a method or an adapter. It also lists the rules that every change must keep.

## Set up

You need Node.js 22.18 or later (`.nvmrc`) and git.

```sh
git clone https://github.com/westvegh/coach-harness.git
cd coach-harness
npm ci
npm test
```

The development repository has no `coach.yaml`, only `coach.example.yaml`. Do not commit a `coach.yaml` or an `athlete/` folder.

## Tests

| Command | What it runs |
|---|---|
| `npm test` | `tsc --noEmit`, then every unit, hook, signal, skill and public-tree test |
| `npm run typecheck` | `tsc --noEmit` only |
| `npm run eval` | The model scenarios against a mock Tally (runs `claude -p`; uses your Claude login; not in CI). See `evals/README.md`. |

CI runs `npm ci` and `npm test` on every push and pull request to the template repository. A copy made for an athlete runs no CI by default: it commits private athlete files, and the public-export checks are for the template. To turn CI on in your copy, set the repository variable `COACH_CI` to `true` (Settings > Secrets and variables > Actions > Variables).

Rules for tests:

- Every bug fix has a test that fails before the fix.
- Tests use fixtures and local files only. No network calls, no real tokens, and no real personal data.
- Build token-shaped strings at run time (see `tests/privacy.test.ts`), so the privacy scan does not flag the test file.

## Code style

- TypeScript runs directly in Node (type stripping). Use only erasable syntax: no `enum`, no `namespace`, no parameter properties. Write `.ts` extensions in relative imports.
- The runtime has one dependency (`yaml`). Do not add a dependency without a reason in the pull request.
- The engine computes every number. Skills and agents run `node engine/cli.ts <command>` and never do arithmetic.
- User-facing text uses short, plain sentences in active voice. No hype.

## Add a method pack

See [docs/adding-a-method.md](docs/adding-a-method.md). Run `node engine/cli.ts lint-methods --pack <name> --volume` and `npm test`. Write in your own words, link every source, and credit the author with a "not affiliated" line.

## Add a logger or a signal source

See [docs/adding-a-logger-or-signal.md](docs/adding-a-logger-or-signal.md). Open an issue first for a new logger: it needs engine changes.

## Rules you must not weaken

In v0.2, code enforces two rules. Everything else is the coach's judgment, guided by `CLAUDE.md`, the skills and the method pack. The engine computes numbers and reports problems. It does not block a plan.

A pull request that weakens either enforced rule will not be merged, even when a test passes.

1. **The urgent stop fails closed.** The `urgent-gate` hook keeps `"onFailure": "block"` and a timeout of 10 seconds or less in `.claude/settings.json`. While `athlete/.urgent-stop` exists, the hook denies every plan-write tool on any MCP server and every edit under `plans/`. A crash of the hook blocks the call. Code refuses `urgent clear` in a scheduled run. In a live session, the coach clears the stop only on the athlete's answer.
2. **Athlete data goes only to a private repository.** The pre-push hook looks up the destination's visibility with `gh`. It refuses a push of athlete data (`athlete/`, `plans/`, `coach.yaml`) to a public repository or to an internal one (GitHub Enterprise), because other people can read both. The hook also refuses the push when the lookup fails. `node engine/cli.ts push` pushes only when `prepush-check` finds a private repository and the installed hook.

Two more rules apply to every change:

- **Privacy in tracked files.** No athlete data, tokens or personal data in tracked files. Commit messages and pull request bodies carry plan changes and rule IDs only.
- **No medical advice.** Never add medication, supplement, hormone or peptide advice, a diagnosis, or an under-fuelling target.

The exact rules are in [docs/contracts.md](docs/contracts.md) (§10 and §10a). If you think a rule is wrong, open an issue before you change it.

## Pull requests

- One change per pull request, with a short description: what changed and why.
- `npm test` passes.
- Docs change in the same pull request as the behavior they describe.
- Do not commit generated eval results (`evals/results/`).

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).
