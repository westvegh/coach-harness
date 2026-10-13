# Adding a logger or a signal source

An adapter connects coach-harness to an outside system. There are 2 kinds:

- **Signal adapters** (`adapters/signals/<name>/`) bring recovery data in: sleep, HRV, resting heart rate, a vendor score, and the daily check-in.
- **Loggers** hold the training plan and the workout log. `coach.yaml logger` picks one: `files` (a spreadsheet per week in the repo), `tally` ([Tally](tally.md), through `adapters/loggers/tally/`) or `other` (a tool the athlete connected, with no adapter code).

This page tells you how to add one, for example Whoop or Garmin as a signal source. The binding formats are in [contracts.md](contracts.md) (§5, §11, §12). If this page and the contracts disagree, the contracts win.

Before you start a large adapter, open an issue that describes it. Read [CONTRIBUTING.md](../CONTRIBUTING.md) for the rules that every change must keep.

## Signal adapters

### The record: `DayRecord`

Every signal adapter produces `DayRecord` values (`engine/types.ts`, contracts §5). One record is one source's view of one morning.

```ts
type DayRecord = {
  date: string;          // YYYY-MM-DD, the morning the record is for, in the athlete's timezone
  source: string;        // "apple-health-shortcut", "chat", "oura", "whoop", ...
  observed_at: string;   // ISO 8601 instant with an offset: when the data was true
  complete: boolean;     // the source finished its data for this date
  sleep?: { duration_min: number; start_at: string; end_at: string; efficiency?: number };
  hrv?: { value_ms: number; method: "rmssd" | "sdnn" };
  rhr?: { bpm: number };
  vendor_score?: number; // the vendor's own score (Oura readiness, Whoop recovery); shown, not scored
  subjective?: {         // the check-in; scales 1-5. The rating is one group: overall, or the four scales together
    overall?: 1|2|3|4|5;   // "How do you feel today?"; never with the four scales
    sleep_quality?: 1|2|3|4|5; energy?: 1|2|3|4|5; soreness?: 1|2|3|4|5; stress?: 1|2|3|4|5;
    want_to_train?: 1|2|3|4|5;                    // 1 means aversion
    pain?: { region: string; score: number }[];   // score 0-10; [] means "no pain now"
  };                     // at least one field (engine/checkin-shape.ts)
  checkin_at?: string;   // when the check-in was answered
};
```

Field rules:

- **`date`** is the wake-up date, not the date sleep started.
- **`observed_at`** is the end of the sleep period when there is one (`sleep.end_at`). Otherwise it is the time of the observation, for example when the check-in was answered. It is not the time you fetched the data.
- **`complete`** is `true` only when sleep is present (contracts §11): the source has the main sleep period for the night. A record without sleep is `false`. This includes a vendor score alone, sleep still syncing, and a check-in. The loader prefers a complete record.
- **`sleep.duration_min`** is time asleep, not time in bed. `efficiency` is a percent (0–100) when the source gives one.
- **`hrv.method`** must be the real method. Apple Health reports SDNN. Oura, Whoop and Garmin report RMSSD. The engine keeps a separate baseline per source and per method. It never mixes them, so a wrong method label corrupts a baseline.
- **`rhr.bpm`** is the resting heart rate for the night. For Oura it is `lowest_heart_rate`.
- Leave out a block that has no data. Do not send zeros for missing values.

### Freshness

The readiness engine decides what counts for today. Your adapter supplies the instants it needs:

- Sleep counts for today only when `sleep.end_at` is after 18:00 on the previous day and not after now, in the athlete's timezone.
- A record with any instant in the future is rejected, and the reason is recorded.
- A check-in counts only on its own `date`.
- Baselines use the 42 days before each morning, one value per date and metric, from the same source. At least 28 valid days are needed. Until then the wearable category is `unknown (calibrating)`.

### Where records live

| Location | Written by | Committed? |
|---|---|---|
| `athlete/signals/YYYY-MM-DD.json` | the iOS Shortcut (`apple-health-shortcut`), chat check-ins (`checkin`) | yes, to the private repo, so cloud runs can read them |
| `athlete/.cache/signals/<source>.json` | fetchers that run on the Mac (`oura`) | no (`athlete/.cache/` is ignored) |

`engine/signals.ts` loads both for a date range:

```
node engine/cli.ts signals --from 2026-10-01 --to 2026-10-10
```

The output is `{from, to, records, warnings}`. It keeps one record per source and date: the complete one, then the latest `observed_at`. A file that does not validate is skipped and named in `warnings`. A cached record is checked against the full `DayRecord` shape (a `null` block, a wrong type or an out-of-range value is malformed). A malformed record is skipped with its own warning. One bad entry cannot hide the others.

### The existing signal adapters

- **`apple-health-shortcut/`**: an iOS Shortcut writes the daily file. `schema.json` is the file format. `normalize.ts` validates a file and maps it to `DayRecord[]`. `SHORTCUT.md` is the build guide.
- **`checkin/`**: `write.ts` writes a chat check-in into the daily file with `source: "chat"`. When a Shortcut file already exists, the check-in block is merged into it and marked `source: "chat"`. The normalizer then returns 2 records (the Shortcut's wearable data and the chat check-in), so the sources stay separate. A later chat check-in merges into today's block by group: a new rating replaces the old rating, a new pain or want-to-train answer replaces the old one, `none` clears it, and the rest stays. CLI: `node engine/cli.ts checkin --date … [--overall 1-5 | --sleep-quality … --energy … --soreness … --stress …] [--want-to-train 1-5|none] [--pain left-knee:3|none]`.
- **`oura/`** (Mac only in v1): `auth.ts` runs the OAuth flow, and `fetch.ts --days N` writes `athlete/.cache/signals/oura.json`. The sign-in is saved in the Mac's Keychain, so it serves every coach copy on the Mac. A failed fetch prints `sign_in_needed: true` only for the sign-in error codes, so the coach asks for a sign-in only when one can help. See "Credentials" below.

### Add a new signal source (Whoop, Garmin, ...)

Pick one of 2 patterns.

**A. A fetcher on the Mac** (like Oura). Use it when the source has an API.

1. Make `adapters/signals/<name>/fetch.ts`. It fetches a date range, maps it to `DayRecord[]` with `source: "<name>"`, and merges it into `athlete/.cache/signals/<name>.json`. Replace the fetched dates and keep older dates, so a short fetch does not erase the 30-day baseline. Write the file atomically (`adapters/signals/write-json.ts`).
2. Pick the main sleep period per day. Ignore naps and deleted periods.
3. Store credentials in the macOS Keychain, never in the repo (see below).
4. Inject `fetch` and the secret store, so tests run with fixtures and no network.
5. Add tests in `tests/signals/` with fixtures written from the vendor's public API docs. Never put a real token or real personal data in a fixture.

**B. A file in the repo** (like the Shortcut). Use it when the data comes from the phone or a third-party app, and cloud runs must see it.

1. Write the same `athlete/signals/YYYY-MM-DD.json` format with your own `source` value, or add a new schema and normalizer next to the existing ones.
2. Extend `engine/signals.ts` only if the file format is new.

For both patterns:

- Do not merge your data into another source's record. Two wearables give 2 records.
- Set `hrv.method` correctly.
- Add your source as a data recipient in `docs/safety-and-privacy.md` and in the `recovery-data` skill (it names each recipient when the athlete adds recovery data), and to `coach.yaml signals.wearable` if it is a wearable.

### Credentials

- Secrets go in the macOS Keychain, with one service per source. Oura uses the service `coach-harness.oura`:
  - accounts `client_id` and `client_secret` (the user stores them: `security add-generic-password -U -s coach-harness.oura -a client_id -w`);
  - account `tokens` (a JSON value that `auth.ts` writes).
- Never print a token or a secret. Never write one to a file in the repo.
- Error messages are fixed text. They never include a response body, an `error_description`, a header value or an exception message from the network layer, because any of these can echo a credential. An OAuth `error` code is shown only when it is on the RFC 6749 list (`adapters/signals/oura/errors.ts`). A CLI prints an unexpected error by its type only.
- Give every HTTP request an explicit timeout (`AbortSignal.timeout`).
- Pass secrets to `security` on stdin, not as arguments (other processes can read arguments).
- Oura refresh tokens are single-use. A refresh runs under a lock file in `~/.config/coach-harness/`. The new tokens are saved and read back before the new access token is used. A refresh response without a new refresh token is an error that asks the user to sign in again. The old token is never reused. If your source also rotates refresh tokens, do the same.
- The lock records the owner's pid and process start time. A lock whose owner is alive is never broken, however old it is. A dead owner's lock is broken only after a check that it is still the same lock. An empty or corrupt lock is broken after a 5-second grace period.
- The OAuth flow uses PKCE (S256). Its callback server listens on `127.0.0.1` only. It refuses to start when another program listens on `[::1]` on the same port.

## Loggers

`coach.yaml logger` says where plans live (contracts §24). There are three values:

| Logger | Code | How the coach reads and writes |
|---|---|---|
| `files` | `engine/plans-files.ts`, `engine/cli-plans.ts` | `node engine/cli.ts plans write`, `plans read` and `plans done` on `plans/<YYYY>-W<ww>.csv` (contracts §12a). |
| `tally` | `adapters/loggers/tally/` | The Tally MCP tools. |
| `other` | none | The connected tool's own MCP tools, by that tool's own instructions. |

The urgent stop covers each one: the urgent gate denies the plan-write tools of any MCP server (by name suffix) and every edit under `plans/`, and `plans write` and `plans done` refuse. With `other`, the gate cannot know the tool's names, so the coach's instructions carry the stop.

### The Tally adapter

- **`adapter.yaml`:** the name; the tool map (which tool-name suffixes read the plan and the log, and which change them); `matcher` (the regex of the write tools, for `log-writes`) and `capture_matcher` (the reads and writes whose responses update the snapshot cache, for `capture-reads`); the capabilities `rangeCreateIfAbsent`, `versionedSkipDelete`, `opId` and `protectsUserDays`.
- **`day.ts`:** the mutation and read suffixes, and `toDayPlan`, which turns a stored Tally day into the engine's `DayPlan`.
- **`version.ts`:** the row version Tally checks on each write.

No code rebuilds or checks a write before it is sent (v0.2). The coach reads each day before it writes, passes the version it read, and reads the day back after.

The logger also gives the **performance** signal: logged sessions against the plan (`SessionPerf` in contracts §5). With `files`, `engine/coach-snapshot.ts` builds the same snapshot from `plans/`, so the readiness, weeks, loads and block-draft tools need no logger-specific path.

### Add a new logger

Most tools need no code: connect the tool's MCP server to Claude Code, and choose "A tool you already use" in setup (`logger: other`). The coach follows the tool's own instructions.

A logger with its own adapter needs engine changes, because parts of the engine import Tally's shapes directly (`engine/logger.ts`, `engine/snapshot.ts`, `engine/loads.ts`). The steps:

1. Make `adapters/loggers/<name>/adapter.yaml` and a `day.ts` with `toDayPlan`. Copy the layout of `adapters/loggers/tally/`.
2. Make the logger selectable in `engine/logger.ts` and `engine/config.ts`, and map its read responses into the snapshot shape (contracts §9, §20 item 1).
3. Put the same `matcher` and `capture_matcher` regexes in `.claude/settings.json`. A test keeps them equal to `adapter.yaml`.
4. Make sure the urgent gate's mutation suffixes (`.claude/hooks/urgent-list.ts`) cover every tool that changes a plan.
5. Add the logger to the "Where plans live" table in `CLAUDE.md`. Skills name tools by suffix.

Run `npm test` before you open the pull request.
