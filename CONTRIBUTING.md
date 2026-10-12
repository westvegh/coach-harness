# Contributing

Thank you for your help. This page tells you how to set up the repository, run the tests, and add a method or an adapter. It also lists the guard rules that every change must keep.

## Set up

You need Node.js 22.18 or later (`.nvmrc`) and git.

```sh
git clone https://github.com/westvegh/coach-harness.git
cd coach-harness
npm ci
npm test
```

The development repository has no `coach.yaml`, only `coach.example.yaml`. The file guard is therefore off while you develop, and the write guard denies every logger write. Do not commit a `coach.yaml` or an `athlete/` folder.

## Tests

| Command | What it runs |
|---|---|
| `npm test` | `tsc --noEmit`, then every unit, hook, guard, signal, golden-parity and public-tree test |
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

## Guard rules you must not weaken

The guard exists so that a model mistake cannot hurt the athlete. A pull request that weakens one of these rules will not be merged, even when a test passes.

1. **Fail closed.** Every guard hook (`guard-writes`, `guard-files`) keeps `"onFailure": "block"` and a timeout in `.claude/settings.json`. Any exception, missing file or malformed input is a deny.
2. **Read before write.** A write to a day needs a read of that day in the same session in the last 15 minutes, and the version it read (`expectedVersion`), or `ifAbsent: true` for an empty day.
3. **Rebuild, then validate.** The guard checks the day and the week as they will be after the write, not the tool input alone.
4. **Limits are hard.** A ban or a cap in `athlete/limits.yaml` is never overridden by consent. An unclassified exercise is denied while any limit is active.
5. **Safety first.** A pending safety check or a hold with no regions allows only safer writes: notes, trims, rest, recovery and skips. A hold with regions blocks only the exercises that load a held region, and unclassified ones. Setting a hold is always allowed. Clearing it needs a live yes. Unattended runs never clear a hold.
6. **Classification is code.** `engine/classify.ts` decides small or big. A change that no small kind describes is big. The model's own label never counts.
7. **Unattended runs make no big change.** They write a proposal and open a pull request. The guard accepts an approval only from a merged pull request (a merge commit, not a squash) whose writes, base versions and limits hash still match.
8. **Protected files stay protected:** `athlete/limits.yaml`, `athlete/hold.yaml`, `athlete/.safety-pending`, `athlete/movements.local.yaml`, `athlete/.cache/**`, `methods/**`, `engine/**`, `adapters/**`, `git-hooks/**`, `.claude/**`, and the `approval` and `thresholds` keys of `coach.yaml`.
9. **Privacy.** No athlete data, tokens or personal data in tracked files. The pre-push hook blocks athlete files on a public remote. Commit messages and PR bodies carry plan changes and rule IDs only.
10. **No medical advice.** Never add medication, supplement, hormone or peptide advice, a diagnosis, or an under-fuelling target.

The exact rules are in [docs/contracts.md](docs/contracts.md) (§7, §17, §18, §20). If you think a rule is wrong, open an issue before you change it.

## Pull requests

- One change per pull request, with a short description: what changed and why.
- `npm test` passes.
- Docs change in the same pull request as the behavior they describe.
- Do not commit generated eval results (`evals/results/`).

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).
