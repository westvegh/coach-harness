# Evals

The test bed that proves the harness behaves well end to end.

## Parts

| Part | Files | Runs in `npm test` |
|---|---|---|
| Mock Tally | `mock-tally/server.mjs`, `tools-list.json`, `client.ts`, `server.test.ts` | yes |
| Golden parity | `golden/*.json`, `golden/golden.test.ts` | yes |
| Scenario runner | `run.ts`, `lib/*.ts`, `lib/approver.mjs` | the offline parts |
| Scenarios | `scenarios/*.ts`, `scenarios/fixtures.test.ts` | the fixtures only |

## Mock Tally

A zero-dependency stdio MCP server with Tally's semantics, ported from Tally's MCP server. The tool list (`tools-list.json`) is pinned from Tally's published tool list.

- `MOCK_TALLY_STATE`: the JSON state file. The mock reads it before each call and writes it after. Every call is appended to `calls`.
- `MOCK_T2=1`: Tally T2 (`ifAbsent`, `expectedVersion` on skip and delete, `opId` receipts and replays, `operations` on reads). Off: those inputs are not in the tool list, and a call that sends them has them dropped, as zod does.
- `MOCK_T3=1`: Tally T3 (server training limits; off for users today): `update_training_limits`, the worse-only checks with move lineage, the `training_limit` refusals and `trainingLimits` in `get_training_context`.
- `MOCK_NOW`: a fixed instant. Scenario runs use the real clock, because the engine CLI has no clock override.

## Golden parity

Each golden is a stored day, one mutation call, and the day Tally stores afterwards. It was derived by hand from Tally's behavior, and each one cites where that behavior is defined. The test reads the seeded days the way `capture-reads` does, then runs `adapters/loggers/tally/rebuild.ts` and the mock on the same call. Both must equal the golden.

## Scenario runs

```
npm run eval                                    # every scenario once
npm run eval -- --runs 3 --only 03-two         # pass counts over 3 runs
npm run eval -- --rescore evals/results/<stamp> # re-run the checks on saved artifacts
```

Each run copies the public export to a temp folder, seeds the athlete instance and the mock, runs `claude -p`, collects the state and scores it with the scenario's pure check. Results go to `evals/results/<stamp>/` (gitignored): `summary.md`, and per run `artifacts.json`, `events.jsonl` and `checks.json`.

- The runner builds the public tree once per process with `scripts/export-public.sh`, so a run proves that a fresh copy of the template works. The export refuses a tree with uncommitted changes to tracked files; pass `--allow-dirty` to export them anyway.
- Each instance links the repo's `node_modules`, except a `fresh` scenario (01): it has no `node_modules`, and the model runs `npm ci` as the setup skill says. Before the model runs, the runner probes the instance's hooks (`lib/probes.ts`): a file edit must pass and a Tally write must be denied, with built-ins only.

### Isolation from the real Tally account

Runs use the claude.ai login (no API key). These safeguards keep every write on the mock:

1. `--strict-mcp-config` with an MCP config that holds the mock (`tallymock`) only;
2. `ENABLE_CLAUDEAI_MCP_SERVERS=false`, and `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` removed;
3. `--disallowedTools` for the claude.ai servers and every real Tally server name form;
4. a preflight on the stream's init event: any MCP server or tool other than the mock's kills the run before the model acts. The run is then an error, not a pass or fail. `lib/claude.test.ts` tests this with fake init events.

`--setting-sources project,local` also keeps the user's own hooks and `CLAUDE.md` out of the run.

### Interactive and unattended runs

- Unattended scenarios set `COACH_UNATTENDED=1` and use `--permission-mode dontAsk`.
- Interactive scenarios use `--permission-mode default` with `--permission-prompt-tool`. The guard's `ask` then goes to the scripted user (`lib/approver.mjs`, MCP server `evalapprover`), which answers from the scenario's rules and logs each prompt. Under `dontAsk`, every `ask` would be a denial, so an interactive yes could never be tested.
- The instance's `origin` is `git@github.com:eval-coach/athlete.git`. Its `core.sshCommand` is a fake ssh that serves a local bare repository, so fetch, `node engine/cli.ts push` and the pre-push hook see a GitHub URL and nothing reaches github.com. A fake `gh` on `PATH` logs every call and answers the REST calls the harness makes (the repository is private).

## Scenarios

| # | Name | Mode | Needs skills |
|---|---|---|---|
| 1 | `01-setup-scripted` | interactive | setup, audit |
| 2 | `02-one-category-no-change` | unattended | today |
| 3 | `03-two-categories-trim` | unattended | today |
| 4 | `04-two-reds-recovery` | unattended | today |
| 5 | `05-knee-limit-swap` | interactive | (guard) |
| 6 | `06-progression-over-10pct` | interactive | week, audit |
| 7 | `07-big-change-unattended` | unattended | week, block |
| 8 | `08a-approved-applied`, `08b-approved-stale` | unattended | today |
| 9 | `09-already-adjusted` | unattended | today |
| 10 | `10-pain-word` | interactive | (hooks, safety agent) |
| 11 | `11-urgent-symptom` | interactive | (hooks) |
| 12 | `12-supplement-advice` | interactive | (CLAUDE.md) |
| 13 | `13-limits-edit-unattended` | unattended | (guard) |
| 14 | `14-stale-snapshot` | interactive | (guard) |
| 15 | `15-safety-foreground` | interactive | (safety agent in the foreground) |
| 16 | `16-failed-trim-retried` | unattended | today |
| 17 | `17-aversion-recovery` | unattended | today |

Readiness scenarios follow the pattern rules (NA-REC-008 to NA-REC-012). The persona seeds 45 calm baseline days. 02 is one off morning (a note, no change). 03 seeds 3 off-mornings in a row and a low check-in (a trim). 04 seeds the same run and a red check-in (a recovery day). 09 and 16 seed the same run as 03. 17 is a green morning with want-to-train 1 (a recovery day). The file names of 02 to 04 are kept for result history.
