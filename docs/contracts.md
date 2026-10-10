# Engineering contracts (v1)

The file formats and module interfaces that the code follows. Read it before you change the engine, the guard, an adapter or a method pack. [how-it-works.md](how-it-works.md) explains the same parts in plain words. If code and this file disagree, fix one of them in the same change, and never weaken a guard rule to make a test pass ([CONTRIBUTING.md](../CONTRIBUTING.md)).

## 0. Conventions

- **Runtime:** Node ≥ 22.18. TypeScript runs directly through type stripping, so use only erasable syntax: no `enum`, `namespace`, or parameter properties. Use `import type` for types, and write `.ts` extensions in relative imports.
- **`tsconfig.json`:** `strict`, `noEmit`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `module: nodenext`.
- **Dependencies:** runtime `yaml`; dev `typescript`, `@types/node`. Nothing else without a reason in the PR.
- **Tests:** `node --test` with explicit globs. `npm test` runs `tsc --noEmit`, then all unit and hook tests.
- **Dates:** a calendar date is `YYYY-MM-DD` in the athlete's timezone (`coach.yaml athlete.timezone`). An instant is ISO 8601 with an offset.
- **IDs:**
  - Rules: `NA-<AREA>-NNN`. Limits: `L-NNN`. Operations: see §9.
  - Proposals: `P-YYYYMMDD-<kind>-<n>`.
- **Errors:** engine functions throw `CoachError {code, message}`. Hooks turn any throw into a deny (§7).
- **Protected files:** the guard (§7) protects these from model edits:
  - `athlete/limits.yaml`, `athlete/hold.yaml`, `athlete/.safety-pending`
  - `athlete/movements.local.yaml`, `athlete/.cache/**`
  - `athlete/block.yaml` and `athlete/signals/**` (§23)
  - `methods/**`, `engine/**`, `.claude/**`, `adapters/**`, `git-hooks/**`
  - the `approval` and `thresholds` keys of `coach.yaml`
  - in every mode, files that node, npm, git or a hook could run (§23)

## 1. `coach.yaml`

```yaml
version: 1
athlete:
  name: Alex
  timezone: America/Los_Angeles      # IANA, authoritative
  units: lbs                         # lbs | kg
  sleep_target_min: 480              # optional; minutes, 240-720 (default 480); readiness sleep target (§22)
method: nine-adaptations             # folder under methods/
template: { days: 4, emphasis: all-around }   # days 3|4|5; emphasis all-around|strength|hypertrophy|endurance|general-health
signals:
  wearable: apple-health-shortcut    # apple-health-shortcut | oura | none
  checkin: shortcut                  # shortcut | chat
logger: tally                        # folder under adapters/loggers/
consent:                             # optional (§23)
  logger_health_notes: false         # true: health details may go into logger notes
automation:
  mode: manual                       # cloud | mac | manual
  daily_window: { start: "05:07", end: "10:07" }
  weekly: { day: sun, time: "17:07" }
  verified: false                    # true only after a successful test run
  tool_prefix: mcp__tally__          # optional (§23): the connected Tally server's tool prefix
approval:                            # PROTECTED. Policy input to engine/classify.
  auto: [trim_session, swap_to_recovery, load_progression, reschedule_within_week]
  ask:  [new_exercise, volume_above_plan, override_user_day, skip_or_delete_user_day, limit_change, new_block, method_change]
thresholds: {}                       # PROTECTED. Optional overrides of §5 defaults, same keys.
```

Validation: `engine/config.ts` exports `loadConfig(path): CoachConfig`. Unknown keys are errors. A change kind cannot appear in both `auto` and `ask`. Hard-rule kinds (§6) cannot appear in `auto`.

## 2. `athlete/limits.yaml` (PROTECTED)

```yaml
version: 1
pain_threshold: 4                    # 0-10; check-in pain in a region at or above this blocks exercises that load it
limits:
  - id: L-001
    region: left-knee                # region id from engine/movements.yaml regions
    rule: ban                        # ban | cap
    patterns: [loaded_deep_knee_flexion]
    exercises: ["Barbell Back Squat"]   # case-insensitive exact names or exerciseIds
    allow: ["Box Squat"]             # explicit exceptions; beat patterns
    note: "No deep squats under load"
    source: athlete                  # athlete | clinician-reported
    since: 2026-10-09
  - id: L-002
    region: low-back
    rule: cap
    patterns: [hinge]
    max_load: { value: 135, unit: lbs }
    max_sets_per_week: 6
    note: "Hinge capped while rehabbing"
    source: clinician-reported
    since: 2026-10-01
```

`limitsHash(file)` is the SHA-256 of the canonical JSON of the parsed file (sorted keys).

## 3. Movement taxonomy

`engine/movements.yaml` ships with the harness. `athlete/movements.local.yaml` (protected) has the same shape and wins when both define an entry.

```yaml
version: 1
regions: [neck, shoulder, left-shoulder, right-shoulder, elbow, wrist, upper-back, low-back, hip, knee, left-knee, right-knee, ankle, ...]
patterns:
  squat:                    { loads: [knee, hip, low-back], muscles: [quads, glutes] }
  loaded_deep_knee_flexion: { loads: [knee] }
  hinge:                    { loads: [low-back, hip], muscles: [hamstrings, glutes] }
  overhead_press:           { loads: [shoulder, elbow], muscles: [shoulders, triceps] }
  # ...
keywords:                   # lowercase substring → patterns; the longest match wins
  "goblet squat": [squat]
  "box squat": [squat]
  "back squat": [squat, loaded_deep_knee_flexion]
  "romanian deadlift": [hinge]
exercises:                  # exact name or exerciseId → patterns (beats keywords)
  Barbell_Squat: [squat, loaded_deep_knee_flexion]
```

- **Side regions:** a side region (`left-knee`) also matches its parent (`knee`). A pattern that loads `knee` therefore triggers a `left-knee` limit.
- **Function:** `classify(ex: {exerciseId, name}, tax): {patterns: string[], regions: string[], muscles: string[], source: "exercise"|"keyword"|"none"}`.
  - The muscles come from the patterns, and the exercise's own `muscle` field is added.
  - `source: "none"` means the exercise is unclassified.

## 4. Method pack (`methods/<pack>/`)

`rules.yaml`:

```yaml
pack: nine-adaptations
version: 1
rules:
  - id: NA-PROG-001
    text: "Raise weekly hard sets per muscle by about 5-7% a week; never more than 10%."
    kind: sourced                 # sourced | policy
    severity: hard                # hard | soft
    source: { ref: S5, at: "01:12:30" }   # key in sources.md + timestamp; required when kind is sourced
    # precision: exact | chapter | approximate. approximate = the episode only, no `at`.
    check: { type: weekly_volume_increase_max, value: 0.10 }
```

**Check types the engine implements.** Other types fail the lint.

| type | value | used by |
|---|---|---|
| `weekly_volume_increase_max` | fraction | validate (hard) |
| `deload_depth` | `{volume: 0.7, load: 0.7}` | progression, audit |
| `deload_every_weeks` | integer | progression, audit |
| `weekly_sets_per_muscle_range` | `[min, max]` | audit (soft) |
| `top_set_jump_max` | fraction | validate (hard) |
| `session_minutes_max` | minutes | validate (soft) |
| `rep_range` | `{adaptation, min, max}` | audit (soft) |
| `rest_range_s` | `{adaptation, min, max}` | audit (soft) |
| `program_change_min_categories` | integer (3) | readiness (`propose_deload`: all three categories) |
| `single_day_action` | `note` | readiness (one day's flags: a note at most) |
| `off_mornings_short_pattern` | integer (3) | readiness (`trim`, `hold_progression`) |
| `off_mornings_long_pattern` | integer (7) | readiness (`propose_deload`) |
| `aversion_scale_max` | integer 1-5 (1) | readiness (want-to-train at or below it: aversion, `recovery`) |

**Prose files** (`principles/*.md`) cite rules inline as `[NA-PROG-001]`.

**Templates** (`templates/{3,4,5}-day.yaml`): days with focus and slot lists. Each slot has `pattern`, `adaptation`, `sets`, `reps` or `duration`, and `rest_s`. An `emphasis` table holds a set multiplier per adaptation for each emphasis.

**`sources.md`:** a table with key, title, URL, date, and notes.

**Lint (`engine/lint-methods.ts`) checks:**
- every ID in the prose exists in `rules.yaml`, and the reverse;
- every rule with `kind: sourced` has a `source` with a known key and a timestamp, unless its precision is `approximate` (then it has no timestamp);
- every check type is known;
- for each template and each emphasis, the weekly sets per muscle fall inside any `weekly_sets_per_muscle_range`. This is an error for the `hypertrophy` emphasis only, and a warning for every other emphasis, because the range is a hypertrophy rule. Planned: count secondary muscles at half credit.

## 5. Readiness (`engine/readiness.ts`)

**Input:**

```ts
type DayRecord = {
  date: string; source: string; observed_at: string; complete: boolean;
  sleep?: { duration_min: number; start_at: string; end_at: string; efficiency?: number };
  hrv?: { value_ms: number; method: "rmssd" | "sdnn" };
  rhr?: { bpm: number };
  vendor_score?: number;
  subjective?: { sleep_quality: 1|2|3|4|5; energy: 1|2|3|4|5; soreness: 1|2|3|4|5; stress: 1|2|3|4|5; want_to_train?: 1|2|3|4|5; pain?: { region: string; score: number }[] };
};
type SessionPerf = { date: string; planned_sets: number; completed_sets: number; reps_shortfall_ratio: number; rpe_drift?: number; top_set_dropped: boolean };
readiness(input: { today: string; now: string; tz: string; records: DayRecord[]; sessions: SessionPerf[]; sleep_target_min: number; thresholds?: Partial<Thresholds>; readiness_rules?: ReadinessRules }): Readiness
// ReadinessRules: the pack's checks with their rule IDs (readiness --date reads them, §4):
// { single_day_ids?, short_pattern?: {mornings, ids}, long_pattern?: {days, ids}, program_change?: {categories, ids}, aversion?: {max, ids} }
```

**Output:**

```ts
type CategoryState = "green" | "amber" | "red" | "unknown";
type Readiness = {
  date: string;
  wearable: { state: CategoryState; reasons: string[]; calibrating: boolean; observed_at?: string };
  subjective: { state: CategoryState; reasons: string[] };
  performance: { state: CategoryState; reasons: string[]; sessions_used: string[] };
  known: number;                  // categories not "unknown"
  decision: "none" | "note" | "trim" | "recovery" | "propose_deload";
  decision_reasons: string[];
  hold_progression: boolean;      // decision trim, recovery or propose_deload
  aversion: boolean;              // today's want_to_train at or below the aversion line
  deload_signal: boolean;         // the long pattern with all three kinds of evidence
  pattern: {
    mornings: { date: string; hrv: "off" | "ok" | "unknown"; rhr: "off" | "ok" | "unknown" }[];  // the last long-pattern days, oldest first
    off_mornings: { hrv: number; rhr: number; either: number };  // consecutive, ending today
    days_of_decline: number;      // = off_mornings.either
    short: boolean;               // days_of_decline >= short pattern (3)
    long: boolean;                // days_of_decline >= long pattern (7)
  };
  rule_ids: string[];
  pain: { region: string; score: number }[];
};
```

**Default thresholds** (`Thresholds`; overridable in `coach.yaml thresholds`):
- `baseline_days_min: 28`, `baseline_window_days: 42` (4 valid weeks inside 6; NA-REC-005)
- `hrv_z_amber: -1.0`, `hrv_z_red: -2.0`
- `rhr_z_amber: 1.0`, `rhr_z_red: 2.0`
- `sleep_ratio_amber: 0.85`
- `subjective_amber: 2.5`, `subjective_red: 1.5`
- `perf_shortfall_amber: 0.2`, `rpe_drift_amber: 1.5`
- `perf_expiry_days: 4`
- `trim_fraction: 0.2` (NA-REC-010, policy)

**Rules:**
- **Baselines:** computed per source and per HRV method. Methods are never mixed. Fewer than `baseline_days_min` valid days means `calibrating: true` and the wearable state is `unknown`. When the standard deviation is under 1% of the mean, use percent change: amber at −10%, red at −20% for HRV; the RHR mirror is +5% and +10%.
- **Wearable:** the worst of HRV, RHR and sleep. Two ambers make red.
- **Sleep record:** counts for `today` only when `end_at` is after 18:00 on the previous day and not after `now`. A future instant means the record is rejected, with the reason recorded.
- **Subjective:** the mean of the 4 scales, where soreness and stress are inverted (6 − x). Any scale at 1 makes it amber. Valid only when `date == today`.
- **Performance:** uses the last session within `perf_expiry_days`. Each session counts once: a session older than the last one used is ignored. Amber when the shortfall reaches `perf_shortfall_amber` or the RPE drift reaches `rpe_drift_amber`. Red when the 2 latest sessions are both amber.
- **Subjective `want_to_train`:** optional, not part of the mean. At or below the aversion line (`aversion_scale_max`, default 1) it sets `aversion`.
- **Off-mornings:** for each morning, HRV and resting HR are each scored against that morning's own baseline (the same window, source and HRV method rules as above): `off` at the amber line or beyond (HRV low, RHR high), `ok` inside the band, `unknown` with no complete reading or too short a baseline. `off_mornings` counts the consecutive off-mornings ending today, per signal and for either signal. An unknown or ok morning ends the run; a missing day is never off.
- **Decision** (first match wins; the pack's checks set the numbers):

| Condition | Decision | rule_ids |
|---|---|---|
| `aversion` | `recovery` | `aversion_scale_max` |
| Short pattern (`either` ≥ `off_mornings_short_pattern`, 3) and subjective or performance red today | `recovery` | `off_mornings_short_pattern` |
| `deload_signal`: long pattern (`either` ≥ `off_mornings_long_pattern`, 7) and at least `program_change_min_categories` (3) of physiology (the long pattern), subjective amber/red and performance amber/red | `propose_deload` | `off_mornings_long_pattern`, `program_change_min_categories` |
| Short pattern | `trim` | `off_mornings_short_pattern` |
| Any category amber or red today | `note` | `single_day_action` |
| Otherwise | `none` | none |

  `hold_progression` is true for `trim`, `recovery` and `propose_deload`. `deload_signal` stays true on a `recovery` day, so the week run still sees it. The `today` skill trims on `propose_deload`, and the `week` skill proposes the program change.

## 6. Change classification (`engine/classify.ts`)

```ts
type ChangeKind =
  | "annotate" | "trim_session" | "swap_to_recovery" | "load_progression" | "reschedule_within_week" | "block_session"   // small
  | "new_exercise" | "volume_above_plan" | "override_user_day" | "skip_or_delete_user_day"
  | "limit_change" | "new_block" | "method_change";                                       // big
classifyChange(before: DayPlan | null, after: DayPlan | null, ctx: { block: Block; history: SessionHistory; tool: LoggerTool; snapshotDay?: SnapshotDay }): { kinds: ChangeKind[]; big: boolean; reasons: string[] }
```

**Rules:**
- **`new_exercise`:** an exercise in `after` that is in neither the block's template slots nor the last 8 weeks of history (matched by exerciseId, then normalized name).
- **`volume_above_plan`:** the week's sets per muscle after the change exceed the block target for that muscle by more than 1 set.
- **`annotate`:** only `notes` or `dayName` change. It is small, always allowed under a hold, and is how a run leaves its reason.
- **`trim_session`:** the same exercises with fewer or equal sets and load.
- **`swap_to_recovery`:** `after` is a recovery day: only patterns tagged `recovery` (Zone 2, mobility, breathing) and no loaded patterns.
- **`load_progression`:** the same exercises, with a load or rep increase inside `top_set_jump_max`.
- **`block_session`:** a new day on an empty date (no day before, or `found: false`) whose exercises all match the current block week's template slots (by exerciseId, then normalized name, as for `new_exercise`), with sets per exercise not above the slot's prescription for that week. It is small, so the Sunday run applies a template week without a PR. The guard still runs every check on it: limits, safety, volume and progression. An exercise outside the slots makes the change `new_exercise` (big). A change that no small kind describes is big.
- **`override_user_day`:** the snapshot day has `source != "mcp"` or `userModified: true`, and the tool would change it.
- **`skip_or_delete_user_day`:** a skip or delete of such a day.
- **Several kinds:** the change is big when any kind is in `coach.yaml approval.ask`.

## 7. Guard (`engine/validate.ts` + `.claude/hooks/guard-writes.ts`)

```ts
type Verdict = { decision: "allow" | "ask" | "deny"; reasons: string[]; rule_ids: string[]; warnings: string[] };
guard(input: { tool: LoggerTool; args: unknown; mode: "interactive" | "unattended"; snapshot: Snapshot; limits: Limits; rules: Rules; tax: Taxonomy; config: CoachConfig; hold: Hold | null; pending: SafetyPending | null; approvals: ApprovalRecord[]; now: string; session_id: string }): Verdict
```

**Order of checks** (the first deny wins):

1. **Inputs present and valid.** Any parse or IO error is a deny with code `GUARD_ERROR`.
2. **Snapshot.** The snapshot must exist, carry the same `session_id`, and be no more than 15 minutes old. Otherwise deny with "refresh: read the affected days with get_planned_workout first".
3. **Versions.** A write to a date with an existing day must carry `expectedVersion`. `expectedUpdatedAt` alone is denied.
   - `plan_workout_range` is denied while any date in range has a day, and denied entirely until T2 (`logger.capabilities.rangeCreateIfAbsent`).
   - Skip and delete are denied until T2 (`logger.capabilities.versionedSkipDelete`). In interactive mode they return `ask` instead.
4. **Rebuild.** `rebuild(tool, args, snapshot) → {days: DayPlan[] (after), week: WeekPlan}` uses the logger adapter's rebuild functions.
5. **Safety.**
   - A `pending` safety file or an active `hold`: every write is denied unless every after-day is a recovery or rest day. Skip is always allowed: it is safer.
   - Today's check-in pain at or above `pain_threshold` in a region: exercises that load that region are denied.
6. **Limits.**
   - **Ban:** an exercise whose patterns or name match the limit is denied. Exceptions in the `allow` list beat patterns.
   - **Cap:** `max_load` is checked per set in the athlete's units, after conversion. `max_sets_per_week` is checked on the rebuilt week.
   - **Unclassified:** an exercise whose classification `source` is `none` is denied while any limit is active ("classify it first").
7. **Hard rules.**
   - `weekly_volume_increase_max` per muscle against the **reference week**: the last completed non-deload build week (§8). The deload-to-build transition may return to the pre-deload level. A base under 10 sets allows +1 set.
   - `top_set_jump_max` per exercise against the last logged top set.
8. **Consent.**
   - `classifyChange` gives `big`.
   - Interactive: `ask`.
   - Unattended: deny, unless an approval record matches exactly: the hash of the canonical tool call is in an approved proposal, every base version equals the snapshot version, and `limits_hash` equals the current one.
   - `overrideUserModified: true`, or a change to a user day: `ask` in interactive mode, deny in unattended mode, always.
9. **Soft rules.** These produce warnings only, for example `session_minutes_max` and `weekly_sets_per_muscle_range`.

**The hook (`guard-writes.ts`):**
- It reads the hook JSON from stdin.
- **Mode:** `unattended` when `CLAUDE_CODE_REMOTE` is set, or when the env `COACH_UNATTENDED=1` is set (the Mac launchd template sets it). Otherwise `interactive`.
- **Loads:** `.cache/snapshot.json`, `limits.yaml`, the pack rules, the taxonomy, `coach.yaml`, the hold, the pending file, and approvals.
- **Output:**
  - **Deny:** prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<reasons + rule IDs>"}}` and exits 0. On an exception it prints the reason to stderr and exits 2.
  - **Ask:** uses `permissionDecision: "ask"`.
  - **Allow:** exits 0 with no output, or with `additionalContext` warnings.
- **Matcher:** `^mcp__.*[Tt]ally.*__(plan_workout_day|plan_workout_range|update_planned_workout|move_planned_workout|skip_planned_workout|delete_planned_workout|update_user_profile)$`. It comes from `adapters/loggers/tally/adapter.yaml`. Observed names: `mcp__tally__…` (project server), `mcp__Tally_Workout__…` (claude.ai connector in a routine), `mcp__claude_ai_Tally_Workout__…` (connector in the local CLI).
- **Required in `settings.json`:** every guard hook (`guard-writes`, `guard-files`) sets `"onFailure": "block"` and `"timeout": 10`. Without it, a crash or a missing command lets the write through. Claude Code ≥ 2.1.295 is required; `setup` checks `claude --version`.

**`update_user_profile`:**
- Allowed in interactive mode only, with `ask`.
- Denied in unattended mode.
- Always denied when it clears `limits`, or when the new text drops a region named in `limits.yaml`.

## 8. Volume and progression (`engine/volume.ts`, `engine/progression.ts`)

```ts
weeklySetsByMuscle(week: WeekPlan | WeekLog, tax): Record<string, number>   // hard sets; warm-ups excluded when marked
referenceWeek(block: Block, logs: WeekLog[], today: string): WeekLog | null      // the last completed build week (not deload, not test)
nextWeekTargets(block: Block, ref: WeekLog | null, rules: Rules): Targets        // the block step, capped
```

- **Weeks** run Monday to Sunday in the athlete's timezone.
- **"Completed"** means at least 50% of the planned sessions were logged. A missed week keeps the previous reference.
- **Bootstrap:** with no completed build week, the reference is block week 1 as planned.
- **Deload:** `deload_depth` scales both volume and load. The week after a deload may return to the pre-deload reference, plus at most one regular step.

## 9. Snapshot, operations and logs

**`athlete/.cache/snapshot.json`** (PROTECTED; written only by the `capture-reads` hook):

```json
{ "version": 1, "session_id": "…", "captured_at": "…", "timezone": "…",
  "days": { "2026-10-12": { "version": "…", "updatedAt": "…", "source": "mcp", "userModified": false, "skipped": false,
                             "dayName": "…", "dayType": "…", "notes": "…", "exercises": [ … ], "captured_at": "…" } },
  "history": [ { "date": "…", "exercises": [ { "exerciseId": "…", "name": "…", "muscle": "…", "sets": [ { "weight": 0, "reps": 0, "rpe": null } ] } ] } ],
  "profile": { … } }
```

- The **`capture-reads`** PostToolUse hook matches Tally reads (`get_planned_workout`, `get_training_context`, `get_workout_history`). Its `tool_response` is an array of `{type: "text", text}` blocks, and the text is the tool's JSON (local and cloud). It parses each response and merges it into the snapshot.
- After every write, the same hook (on mutations) updates the written days from the write response.
- **Operation ID:** `op-<date>-<kind>-<sha256(canonical tool call)[0..12]>`. Before T2, it is recorded in the log and in a human-readable notes line. After T2, it is passed as Tally's `opId`.
- **`athlete/log/YYYY-MM.md`:** one entry per operation:

```
## 2026-10-12 07:07 · op-2026-10-12-trim_session-3fa1c2d9e0b4
- trigger: daily run (cloud) | user
- readiness: wearable amber (HRV z -1.3), subjective amber (2.3), performance green → trim
- rules: NA-REC-009, NA-PROG-001
- change: Lower A, 5 → 4 sets on squat pattern lifts
- approval: auto (trim_session)
- result: written (version …)
```

## 10. Safety files

- **`athlete/.safety-pending`** (written by `safety-detect`): `{at, terms: string[], source: "prompt" | "session-notes"}`. The user's text is never stored.
- **`athlete/hold.yaml`:** `{active, set_at, reason, regions, set_by, urgent?, cleared_at?, cleared_by?}`. `urgent: true` marks an urgent warning sign (§23).
- **`engine/hold.ts`:**
  - `set` is always allowed.
  - `clear` exits with a code the guard maps to `ask`: the `guard-files` hook allows `node engine/hold.ts clear` only in interactive mode, and asks first.
- **Term list:** in `engine/safety-terms.yaml`, with two lists: `urgent` (chest pain, fainting, …) and `pain` (pain, hurts, tweak, …), plus region words.

## 11. Signals

**The Shortcut file `athlete/signals/YYYY-MM-DD.json`:**

```json
{ "version": 1, "date": "2026-10-10", "source": "apple-health-shortcut", "submitted_at": "2026-10-10T06:41:12-07:00",
  "sleep": { "start_at": "…", "end_at": "…", "duration_min": 412 },
  "hrv": { "value_ms": 41.8, "method": "sdnn", "samples": 6 },
  "rhr": { "bpm": 54 },
  "checkin": { "sleep_quality": 3, "energy": 4, "soreness": 2, "stress": 3, "pain": [ { "region": "left-knee", "score": 2 } ] } }
```

- **Schema:** `adapters/signals/apple-health-shortcut/schema.json`. Every block after `submitted_at` is optional. `source` is `apple-health-shortcut` or `chat`. The `checkin` block may carry its own `source` and `submitted_at` (a chat check-in merged into a Shortcut file).
- **Normalizer:** `adapters/signals/apple-health-shortcut/normalize.ts`. It validates and maps the file to `DayRecord[]`: `observed_at` = `sleep.end_at` (else `submitted_at`), and `complete` only when sleep is present (a check-in-only record is `complete: false`). HRV method `sdnn` unless the file says `rmssd`. A check-in whose source differs from the file's becomes its own record, so sources stay separate. A future instant is rejected.
- **Chat check-in:** `adapters/signals/checkin/write.ts` (CLI `checkin`) writes the `checkin` block with `source: "chat"`; it creates the file or merges into it.
- **Loader:** `engine/signals.ts` (CLI `signals --from --to`) reads `athlete/signals/*.json` and `athlete/.cache/signals/*.json`, one record per source and date (complete first, then the latest `observed_at`), and reports bad files, and cached records that fail the `DayRecord` shape (including `null` blocks), as per-file or per-record warnings.
- **Oura:** `adapters/signals/oura/fetch.ts --days N` merges into `athlete/.cache/signals/oura.json` as `DayRecord[]` (method `rmssd`). Client ID, secret and tokens are in the macOS Keychain (service `coach-harness.oura`; accounts `client_id`, `client_secret`, `tokens`), changed under a lock file in `~/.config/coach-harness/`. The new refresh token is saved and read back before the access token is used. A refresh response without a new refresh token is an error (sign in again); the old token is never reused. The lock records pid and process start time; a live owner's lock is never broken. OAuth uses PKCE (S256); the callback listens on 127.0.0.1:8723 only, with the redirect URI `http://localhost:8723/callback`. Errors never carry provider or transport text: fixed messages plus allowlisted OAuth error codes. Every request has a timeout.

## 12. Logger adapter (`adapters/loggers/<name>/`)

- **`adapter.yaml`:** `name`, the tool map (reads and mutations to tool-name suffixes), the guard matcher regex, and capabilities:
  - `rangeCreateIfAbsent`, `versionedSkipDelete`, `opId` (all `false` for Tally until T2);
  - `protectsUserDays`.
- **`rebuild.ts`:** one function per mutation:
  - `(args, snapshot) → DayPlan[]` for day, update (operations applied with Tally semantics: unnamed exercises stay exactly as stored), move (status resets to planned), skip (status), delete (gone), and range.
  - `toDayPlan(snapshotDay)`.
- Parity with Tally is proven by the golden parity tests (`evals/golden/`).

## 13. Skills, agents, hooks (files)

- **Skills:** `.claude/skills/{setup,today,check-in,week,block,audit,limits,explain,method}/SKILL.md`. Each description is under 1,000 characters and names its trigger phrases. Every skill states its read order and writes, and it runs `node engine/cli.ts <command>` for numbers.
- **Agents:** `.claude/agents/{analyst,method-expert,safety}.md`.
- **Hooks** in `.claude/settings.json`: `session-context` (SessionStart), `safety-detect` (UserPromptSubmit), `guard-writes` and `guard-files` (PreToolUse), `capture-reads` and `log-writes` (PostToolUse), `commit-check` (Stop). Each one is a `.ts` file run with `node`, with a timeout of 10 s or less. The guard hooks are fail-closed.
- **`engine/cli.ts`:** subcommands `readiness`, `classify`, `validate`, `volume`, `hold init|set|clear`, `lint-methods`, `snapshot show`, `limits-hash`, `limits server-rules|sync-ops` and `oplog done` (§21), and the §15 and §22 helpers. Output is JSON on stdout. A nonzero exit means an error.

## 14. Automation facts (tested against Claude Code routines)

- **Routine creation:** `setup` creates routines with the RemoteTrigger tool, and **must** pass:
  - `mcp_connections` with the Tally connector only, because the default attaches every connector on the account;
  - `allowed_tools`;
  - a cron in the athlete's local time (UTC in the API; convert).
  - Cron: daily `7 5-10 * * *` (hourly, minimum interval 1 hour); weekly Sunday `7 17 * * 0`.
- **Finding the Tally connector:** each user's connector ID differs. `setup` creates the routine **disabled** (`enabled: false`), reads the `mcp_connections` the API returns (all connectors on the account), picks the one whose `url` is `https://mcp.tallyworkout.app/api/mcp`, then updates the routine with that connector only and `enabled: true`. With no Tally connector, setup stops and links the connect page. The create response lists every connector with `connector_uuid`, `name` and `url`.
- **Prompts dispatch explicitly:** "Read .claude/skills/today/SKILL.md and follow it exactly."
- **Pull requests** from a routine: `gh api -X POST repos/{owner}/{repo}/pulls -f title=… -f head=… -f base=main -f body=…`. `gh pr create` (GraphQL) is blocked in Claude Code sessions.
- **Apply after merge:** the `today` and `week` skills check `athlete/proposals/` on `main` for approved, unapplied proposals before anything else, and apply them under the guard's approval-record rule. A GitHub merge trigger is optional; the user adds it in the web UI.
- **The Mac launchd template** runs `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN COACH_UNATTENDED=1 claude -p "…" --permission-mode dontAsk --allowedTools …`. With an API key set, claude.ai connectors are disabled and usage bills to the API.
- **The allowed tools** of a routine and of the launchd template are `UNATTENDED_TOOLS` plus the 11 Tally tools under the connected server's prefix (§23). No open `Bash`, `Write` or `Edit`.
- **Network:** cloud runs reach Tally through the connector (no allowlist change). Oura direct in the cloud would need a Custom network environment plus a token broker, so v1 runs Oura on the Mac.

## 15. Coaching helpers (engine, used by skills)

```ts
// engine/adjust.ts
adjustDay(day: DayPlan, decision: "trim" | "recovery", ctx: { tax: Taxonomy; thresholds: Thresholds; template?: Template; limits: Limits }): { day: DayPlan; changes: string[] }
//  trim: for loaded (non-recovery) patterns, sets -= round(sets * trim_fraction), minimum 1; loads unchanged;
//        exercise order kept; recovery patterns untouched.
//  recovery: replace with a recovery day from the template's recovery slots (Zone 2 cardio, mobility,
//            breathing), duration matched to the planned session length, never loading a held or limited region.
// engine/loads.ts
suggestLoads(exercises: PlannedExercise[], history: SessionHistory, rules: Rules, units: "lbs" | "kg"): { exerciseId: string; suggestedWeight?: number; reason: string; rule_ids: string[] }[]
//  from the last logged top set: hit all reps at RPE <= target -> + one step (2.5% for upper, 5% for lower, rounded
//  to the unit's plate step: 5 lbs / 2.5 kg); missed reps -> repeat; missed twice -> -5%. Never above top_set_jump_max.
// engine/opid.ts
opId(date: string, kind: ChangeKind | "apply" | "week", call: { tool: string; args: unknown }): string   // contracts §9 format
// engine/mode.ts
mode(): "interactive" | "unattended"   // CLAUDE_CODE_REMOTE or COACH_UNATTENDED -> unattended
// engine/proposals.ts (extends approvals.ts)
createProposal(input: { kind; summary; writes: {tool, input}[]; base: Record<string, string>; limits_hash; rule_ids }): { id; path }
openProposalPR(proposal, opts: { owner; repo; branch }): { url }        // gh api REST; never gh pr create
markApplied(id, results): void
// engine/automation.ts
routineBody(kind: "daily" | "weekly", cfg: CoachConfig, repoUrl: string, connector: { uuid: string; name: string; url: string }): object
//  cron from cfg.automation in the athlete's timezone converted to UTC; mcp_connections = [Tally only] with
//  permitted_tools = the logger's tools; allowed_tools = Bash, Read, Write, Edit, Glob, Grep + the Tally tools;
//  prompt = explicit dispatch ("Read .claude/skills/<skill>/SKILL.md and follow it exactly. Unattended run.").
launchdPlist(kind, cfg, repoPath): string   // runs: env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN COACH_UNATTENDED=1 claude -p ...
```

**CLI commands** (`engine/cli.ts`; JSON on stdout):
- `mode`, `opid`, `adjust`, `loads`, `targets` (`nextWeekTargets`);
- `proposals create|open-pr|list|mark-applied`;
- `routine-body`, `launchd-plist`, `install-launchd` (writes to `~/Library/LaunchAgents` only with `--yes`);
- `signals`, `checkin`, `readiness`, `validate`, `classify`, `hold …`, `lint-methods`.

## 16. Decisions from building the engine

1. **Hard-rule kinds** are the 7 big kinds of §6 (`new_exercise` … `method_change`). They can never be in `approval.auto`. A kind in neither list is treated as `ask` (fail closed). `annotate` is small and in the default `auto` list.
2. **Performance amber:** `shortfall = max(reps_shortfall_ratio, 1 − completed_sets / planned_sets)`. `top_set_dropped` also gives amber.
3. **"Any scale at 1"** is read after inversion: soreness 5 counts as 1, and soreness 1 is good.
4. **`nextWeekTargets(block, ref, rules, opts?: {tax, week})`:** the taxonomy counts sets in a `WeekLog`; `week` tells it the target week, so the deload-to-build transition is known.
5. **`Block`** (defined in `engine/types.ts`):
   - `start` (a Monday);
   - `weeks[{week, kind: build|deload|test, sessions, targets: {muscle: sets}}]`;
   - `days[{day, focus, slots}]`.

   `athlete/block.yaml` follows it.
6. **`deload_depth` 0.7:** the deload week keeps 70% of the reference week's sets and load, rounded.

## 17. Approval provenance

- `createProposal` writes `status: proposed`. No engine or CLI path writes `approved` on `main`.
- The skill writes the approved copy only on the branch `proposal/<id>`, pushes it, opens the PR (REST) and records `pr_url`.
- **Merging the PR is the approval.** The guard accepts an approval record only when the file on `main` has `status: approved` **and** it arrived through a merge commit of `proposal/<id>`. Squash merges are not accepted, and the user docs say so.
- `guard-files` in unattended mode denies Bash commands that merge PRs (`gh pr merge`, `gh api … pulls/<n>/merge`) and denies Edit or Write of `athlete/proposals/**` on `main`. Interactive mode asks.
- `markApplied` adds `applied_at` and `results`.

## 18. Guard activation in the template repo

- `guard-files` is active only when `coach.yaml` exists at the repo root, which means an athlete instance has been set up. The template and development repo has only `coach.example.yaml`, so development is unaffected. No environment variable switches the guard off.
- In an instance, `guard-files` also protects `coach.yaml`: Edit, Write, and Bash `rm` or `mv` of it are `ask` in interactive mode and denied in unattended mode.
- `guard-writes` denies every Tally mutation when `coach.yaml` is missing. With no config, nothing can be written, so deleting it never opens a path.
- `permissions.deny` covers only `athlete/hold.yaml`, `athlete/.safety-pending` and `athlete/.cache/**`. Everything else is enforced by the hooks.

## 19. Schedule window and Mac launch

- **Cron covers both UTC offsets.** `routine-body` makes a daily and a weekly cron that fire under every UTC offset of the athlete's timezone in the current year. Los Angeles: daily `7 12-18 * * *`, weekly Sunday 17:07 as `7 0-1 * * 1`. No update is needed at a DST change.
- **`window-check --kind daily|weekly`** (`engine/automation.ts windowCheck`, CLI in `engine/cli-helpers.ts`): in an unattended run it exits 4 unless the local time is in the window. Daily: `daily_window.start` to `daily_window.end` + 30 min. Weekly: `weekly.day`, from `weekly.time` to `weekly.time` + 30 min. In an interactive run it exits 0.
- **The routine and launchd prompts run `window-check` first**, then dispatch the skill. The `today` and `week` skills also run it as their first step.
- **launchd:** `install-launchd` and `launchd-plist` resolve `command -v claude`, check that it is an executable file, and write the absolute path into `ProgramArguments` (its folder goes first on the plist `PATH`). No `claude` found means `CLAUDE_NOT_FOUND` and nothing is written. `--claude <path>` overrides.
- **Recovery days** match the planned duration to the second (no minimum or maximum), and leave out any exercise that a limit names by exercise or by pattern.
- **Load suggestions** are never above the last top set × (1 + `top_set_jump_max`). A cut that finds no lighter plate weight repeats the weight.

## 20. Decisions from building the guard

1. **Snapshot day shape (§9).** A day holds the logger's own exercise shape (for Tally: `suggestedSets`, `suggestedWeight`, …), not `sets[]`. The adapter's `toDayPlan` converts it. A day also has `found` (a read that found no day is stored with `found: false`), `weightUnit` and `weightUnitSource` (only when Tally knows the unit). The snapshot adds `planned` (the listing from `get_training_context`), `history_coverage` (item 18), `weightUnit` and `weightUnitSource`.
2. **Every date a write touches must be read in this session, within 15 minutes** (`get_planned_workout`, including empty dates and the destination of a move). This is stricter than §7 step 2, which checks only the whole snapshot's age.
3. **A write that raises a muscle's weekly sets needs the whole week, fresh** (item 19), and the history (`get_workout_history`, item 18) unless the week is block week 1. A write the snapshot cannot confirm (a plan write, a conflict, an uncertain result) removes the day and adds it to the listing, so it must be read again.
4. **No block, no volume rise.** Without `athlete/block.yaml`, any rise in a muscle's weekly sets is denied. With a block and no completed build week, the reference is block week 1 as planned; a muscle missing from it has a base of 0 (so +1 set).
5. **A raised top set needs the history read first.** Without it, the top-set check cannot run, so the write is denied.
6. **`guard()` takes 4 more inputs:** `block`, `pain` (today's check-in pain from `athlete/signals/<today>.json`), `limits_hash` and `logger` (the adapter). `classifyChange` takes `tax`, `rules`, `config`, `today` and `volume` in its context. `Verdict` adds `kinds`, `big`, `approval` and `code`.
7. **Kinds:** a change that no small kind describes is big (fail closed). A new day on an empty date is big unless it is a recovery day or a `block_session` (§6 ruling; item 24). A skip or delete of an MCP day is `trim_session`. Recovery exercises are never `new_exercise`. A move across weeks is big.
8. **Limits apply to every exercise of every after-day,** not only to the changed ones. Names match after normalization (case, spaces, `_`). `max_sets_per_week` and the volume cap deny only when the call raises the count: a trim of an over-cap week is allowed.
9. **Unit rule:** an exercise's weight is in Tally's known unit; when Tally does not know it, in the call's `weightUnit`; else in `coach.yaml athlete.units`.
10. **`update_user_profile` under a hold** is not blocked by the hold. It still follows its own rules: ask interactive, deny unattended, deny when it clears `limits`, deny when it drops a `limits.yaml` region the old text named (or any region, when the profile was not read).
11. **`guard-files`** is active only when `coach.yaml` exists. It also protects `adapters/**` and `git-hooks/**` (the adapter holds the capabilities and the matcher). It allows any single `node engine/cli.ts <command>` and `node engine/hold.ts set …` with no shell operators, `$` or backticks; `hold clear` asks. Bash is matched on protected names and on path operands (item 17; best effort). `permissions.deny` covers only `athlete/hold.yaml`, `athlete/.safety-pending` and `athlete/.cache/**`.
12. **Approval provenance (§17)** needs remote evidence (item 16). A base version of `null` means the date must still be empty.
13. **Operation IDs** use `sha256(canonical JSON of {tool: <suffix>, args})`, the same hash as approval records. `log-writes` takes the kind from the verdict that `guard-writes` saves in `athlete/.cache/verdicts/<tool_use_id>.json`.
14. **pre-push** looks up visibility with `gh api repos/<owner>/<repo>` (REST), because GraphQL (`gh repo view`) is blocked in Claude Code sessions. A non-GitHub URL is a failed lookup.
15. **Hooks honor `COACH_NOW`** (an instant) for tests. The hook process inherits the session's environment, which the model cannot change.

### Guard hardening

16. **Approval needs remote evidence.** `engine/approvals.ts` accepts an approved proposal on local `main` only when `gh api repos/<owner>/<repo>/pulls?state=closed&base=main&head=<owner>:proposal/<id>` (REST) lists a merged pull request from `proposal/<id>` into `main`, its `merge_commit_sha` is an ancestor of the fetched `origin/main`, it is a merge commit (not a squash), and it holds exactly `main`'s copy of the file. `origin` must be a GitHub URL; a failed `gh` call gives no record. Local merges never count. Unattended Bash denies `git merge`, `gh pr merge` and `gh api … pulls/<n>/merge`; interactive asks (best effort). **Residual risk:** a model holding the user's GitHub token could merge its own pull request through another path. Hard limits stay enforced by the guard, and Tally T3 adds the server-side backstop.
17. **Bash path operands and broad restores.** `guard-files` resolves absolute, `./`, `../`, `$CLAUDE_PROJECT_DIR` and `$PWD` operands against the repo root, and a protected file or folder (the folder name itself included) asks or denies. `git checkout|restore|reset|stash|clean` is broad when it names `.`, a protected path or a folder holding one, or no path at all; `reset --hard|--merge|--keep` is always broad. Not broad: `checkout -b|-B|--orphan <name>` with no start point, `stash list|show`, and a restore of an unprotected path. Broad: deny unattended, ask interactive. Proposal files stay guarded for Edit and Write only, because the proposal flow commits them with Bash. Branch switches with `git checkout <branch>` count as broad; skills switch branches with `git switch`.
18. **Responses are validated.** Every captured read is checked against Tally's result shape. An error or a malformed read never counts as evidence: it removes the day (`get_planned_workout`), the listing (`get_training_context`) or the history coverage (`get_workout_history`). `history_coverage` holds `captured_at`, `complete` (false while `nextCursor` remains; a later page completes the chain) and the requested `since`/`until`. The history is evidence only when it is complete, read in the last 15 minutes, starts no later than 8 weeks before today and ends no earlier than yesterday.
19. **Fresh evidence for the whole week.** When a call raises a muscle's sets in a week, every day of that week (Monday to Sunday, earlier days included) needs a `get_planned_workout` read in the last 15 minutes, or lies on or after the `from` date of a training-context listing read in the last 15 minutes that does not list it (an empty date). This check runs after the safety step and before the limits.
20. **The block is validated whole.** `engine/block.ts`: known keys only, `start` a Monday, unique week numbers, `kind` build|deload|test, and every count (`sessions`, `targets`, slot `sets`) a finite whole number of 0 or more (slot sets 1 or more). A bad block is `GUARD_ERROR` (deny), both from the file and as a `guard()` input.
21. **Rebuild of hidden stored exercises** is deferred to Tally T3: the server validates the full stored day, and T3 reads return nameless entries.
22. **Pre-push inspects every commit reachable from a pushed SHA,** with no exclusions, because cached remote-tracking refs can belong to another repository than the push URL. Paths are read NUL-delimited (`git diff-tree -z`). A pushed SHA that cannot be listed denies the push.
23. **Safer is always allowed.** Under a hold or a pending safety file, `skip_planned_workout` (skip, not restore) is allowed for any day, user days included, in both modes, before the T2 and consent checks. A trim (each exercise on the day before, with fewer or equal hard sets, top load and reps) is allowed under a hold; limits and hard rules still apply to it. Outside a hold, skipping a user day unattended stays denied.
24. **`block_session` (§6 ruling)** is implemented in `engine/classify.ts`: a new day on an empty date inside the block whose every exercise matches a block slot (exerciseId, then normalized name, then pattern for a slot that names no exercise) with hard sets not above the slot's sets (a deload week scales them by `deload_depth.volume`). It is in the default `approval.auto` of `coach.example.yaml`.
25. **`allow` binds to the exerciseId.** An `allow` entry that matches the exerciseId exempts the exercise. One that matches only the display name exempts it unless the exerciseId by itself classifies to a limited pattern; then the exercise is an identity conflict and is denied.
26. **One hash.** `engine/approvals.ts toolCallHash` is SHA-256 of `engine/opid.ts canonicalToolCall`; an operation ID's suffix is its first 12 hex characters. `proposals list` is part of the `proposals` command and adds `approved_on_main` and `not_approved_because`.

### Hook bootstrap

27. **Hooks work before `npm ci`.** Each hook entry file (the path `.claude/settings.json` runs) imports Node built-ins only: `.claude/hooks/bootstrap.ts` and, for guard-files, `.claude/hooks/fast-files.ts`. The engine code is in `<hook>.body.ts`, loaded with a dynamic `import()`. stdin is read once (`stdinText`), so the body reads the same input. The root is `CLAUDE_PROJECT_DIR`, else the input's `cwd`.
    - **Never rename or delete an entry file.** Write a new body first, then replace the entry content last, so the hook works at every step. A test checks that every command path in `settings.json` exists and that each entry imports built-ins only.
    - **No `coach.yaml`, decided with built-ins:** guard-files allows. guard-writes blocks a logger mutation with exit 2: `MISSING_FILE: coach.yaml is missing; …` plus "coach-harness is not set up yet (no coach.yaml). Run setup first." It allows any other tool. The block stays exit 2, not a JSON deny, because the §18 test pins that shape. The mutation list (`LOGGER_MUTATIONS`, and the regex `LOGGER_MUTATION` built from it) is in `bootstrap.ts`. Tests keep it equal to the adapter's mutations, `update_training_limits` included, and check that each `settings.json` matcher for guard-writes, log-writes and capture-reads selects every one in all three name forms.
    - **Engine cannot load, no `coach.yaml`:** capture-reads, log-writes and commit-check exit 0 with no output. session-context says "coach-harness is not set up. Run `npm ci`, then say 'set me up'." safety-detect adds "SAFETY: the pain and red-flag detector could not run (packages are not installed). …" and writes no pending file. This applies to any engine-load failure (a missing package or a missing or broken engine module). With `coach.yaml`, a load failure keeps the `detector-error` path.
    - **Engine cannot load, `coach.yaml` present:** fail closed with "coach-harness packages are missing. Run `npm ci`." guard-writes denies every call. guard-files checks first that the `yaml` package resolves from `engine/`. If it does not, the fast path and the read-only allowlist do not run, and only the repair passes: exactly `npm ci` or `npm install` (spaces or tabs only: no flag, no newline), optionally after `cd <repo root> && `. The folder may be quoted and holds no `$`, backtick or backslash. A bare command also needs the input's `cwd`, when given, to be the repo root. capture-reads and log-writes exit 2 with the reason. commit-check blocks the first stop and warns on the second. session-context gives the reason as context. safety-detect writes `detector-error`.
    - **guard-files fast path (latency).** With `coach.yaml`, `fast-files.ts` allows only calls that `fileGuard` also allows. For a file tool: a path outside the root, or a path that is not `coach.yaml`, not a protected file or folder, and not a proposal, compared without regard to case (item 28). For Bash: no quote, backslash, `$`, backtick or `/`, no `git` or `gh` word, no protected name, and no `.` or `..` operand. Anything else goes to the engine. A test keeps the lists equal to `engine/protect.ts` and checks every fast allow against `fileGuard` in both modes. **Residual:** a new protected name added only to `BASH_TOKENS` in `engine/protect.ts` must also be added to `BASH_NAMES` in `fast-files.ts`.
    - **Read-only Bash allowlist.** guard-files allows a Bash command in every mode, when the packages are installed, when it is one `ls`, `cat`, `head`, `tail`, `wc`, `stat` or `grep` as the first word, followed only by words made of letters, digits and `. _ / - , + @ : * ?`, separated by spaces or tabs. Anything else goes to the full guard: parentheses, brackets, braces, quotes, `$`, `=`, `~`, `!`, `#`, backslash, any shell operator or newline. zsh runs commands from glob qualifiers such as `x(e:cmd:)` and from `=(cmd)`. No `xargs`, `tee`, `sed`, `find`, `-exec` or `--in-place` word. It cannot write, so it may name a protected path. Tests run the allowed commands and the zsh attacks under bash and zsh.
    - **Compile cache.** `bootHook` turns on `module.enableCompileCache()` (V8 code cache in `$TMPDIR/node-compile-cache`, checked against each source's hash) before it loads the body. This saves about 40 ms per engine load. `NODE_DISABLE_COMPILE_CACHE=1` turns it off.
    - **Latency floor.** `settings.json` runs `node <hook>.ts`. Node loads its type stripper for any `.ts` file, so a one-line `.ts` file takes about 35 ms more than a bare `node` start. `scripts/bench-hooks.mjs` prints that floor next to each hook.
28. **Protected paths match without regard to case** (`engine/protect.ts` and the fast path). macOS volumes are case-insensitive by default, so `ENGINE/protect.ts`, `Athlete/Limits.yaml` and `.CLAUDE/settings.json` name protected files there. File paths, Bash operands, the Bash name tokens, `coach.yaml` and proposal paths are compared in lower case, and a path under a case variant of the repo root counts as inside the root. Over-protecting on a case-sensitive volume is harmless.

## 21. Server limits (Tally T3)

Tally can enforce training limits on its server too. The feature is off for users today, so this code is dormant: it acts only when the connected logger lists `update_training_limits`. The local guard always enforces `athlete/limits.yaml`.

1. **Compile** (`engine/limits-compile.ts compileServerRules(limits, tax, resolved)`): a ban becomes a Tally `ban` rule and a cap with `max_sets_per_week` a `cap` rule. A cap with only `max_load` is skipped; a cap's `max_load` stays local (`localOnly`). A limit with an allow entry missing from `resolved` is skipped, because without it Tally would refuse what the local guard allows. Except-keywords are every taxonomy phrase that holds a banned keyword but that `classify` maps to none of the limit's patterns: keywords, exercise entries, and two keywords that overlap by whole words ("incline bench" + "bench press").
2. **Matcher** (`engine/server-match.ts`): a TypeScript port of Tally's server matching rules. The property test (`engine/server-match.test.ts`) proves that for every taxonomy exercise and template pattern, the server matches exactly what the local guard matches. Known gaps, all in the safe direction (Tally matches less): an exercise named by `limits.yaml` but stored under another exerciseId, and an allow entry stored under its id with another name (Tally needs both).
3. **Sync** (`engine/limits-sync.ts syncOps`): the rule id of a changed rule is the old id plus `_2`, `_3`, … (the first one free). A form such as `L-001.2` fails Tally's id pattern. Content is the kind and the match lists; labels are not content.
4. **CLI:** `limits server-rules [--resolved]` and `limits sync-ops --server <file|-> [--resolved]` (`engine/cli-limits.ts`).
5. **Adapter:** `tools.limits.update: update_training_limits`; `capabilities.server_limits: { when_tool: update_training_limits }`, true at run time only when the tool list holds the tool (`engine/logger.ts serverLimits`). The guard, log and capture matchers (adapter and `settings.json`) include the tool.
6. **Guard:** `update_training_limits` is `limit_change`: ask interactive, deny unattended. Its input must hold 1-20 ops of `add_rule`, `lower_cap` or `set_weekly_cap` and an `expectedVersion`; anything else is denied.
7. **Refusals:** a result with `status: refused, code: training_limit` (read even when the response is flagged as an error) reconciles to the status `refused`, names the rule, and says it is not retried. The snapshot keeps every day the refused call named, so the after-write week check sees no change. A range without opId that wrote some days is `written` and names the refused days; only the written days leave the snapshot.
8. **Matching details.**
   - The matcher follows Tally's rules: whole-word keywords with a plural `s`/`es` (the rule of `taxonomy.ts keywordSpans`); `norm()` deletes Unicode format characters before NFKC; each field is read to 200 characters. The property test covers every template slot with its set count, plural and suffix variants, and differing names and ids. With differing names and ids, Tally refuses more than the local guard only on an identity conflict: the name alone or the id alone is limited, and the local guard classifies only one of them.
   - `syncOps` groups compiled rules by matching content, keeps the strictest cap, and makes one op per target rule.
   - A plan range reconciles every day first; any written day makes the status `written` (the week check runs), and refusals and conflicts are named.
9. **Tally T2 (safe writes).** `rangeCreateIfAbsent`, `versionedSkipDelete` and `opId` are `true`.
   - Every `plan_workout_range` day carries `ifAbsent: true`; the rebuild keeps a day that exists (Tally skips it, code `exists`). `ifAbsent` with `expectedVersion`, `expectedUpdatedAt`, `replace: true` or `overrideUserModified: true` is denied (a Tally validation error). `plan_workout_day` with `ifAbsent: true` over a day is denied with the reason.
   - `skip_planned_workout` and `delete_planned_workout` need the snapshot's `expectedVersion` in both modes. The skip under a hold or a pending safety check (§20 item 23) stays allowed.
   - `opId` is accepted on every day mutation (8-120 characters of letters, digits, `.`, `_`, `:` or `-`). The call hash (`canonicalToolCall`, approvals and operation IDs) leaves a top-level `opId` out. `log-writes` records the submitted `opId` (`oplog.ts loggedOpId`).
   - A result with `replayed: true` reconciles to the status `replayed`, lists the stored outcome per input, and asks for a re-read (`oplog.ts nextStep`); the snapshot forgets every date the call or the stored outcome names.
10. **Operation IDs and apply checks.**
    - **An opId is bound to its call.** The guard accepts a submitted `opId` only when it is the engine's operation ID for that call (`engine/opid.ts opIdProblem`): `op-<date>-<kind>-<hash>`, a real date, a known kind, and the first 12 hex characters of the hash of the canonical call without its `opId`. Anything else is denied, so one key cannot name two calls. The log records the submitted id.
    - **`node engine/cli.ts oplog done --date <YYYY-MM-DD> --kind <kind>`** (`engine/oplog.ts opDone`). It reads `athlete/log/*.md` and prints `{date, kind, done, status: done|not_done|uncertain, reason, reread, entries}`. Done only for a confirmed successful outcome of that kind on that date: a `written` result (a range by its written dates) or a `replayed` result whose stored outcome for the date succeeded. `conflict`, `skipped`, `refused` and `not_found` are not done; `uncertain` is not done and lists the dates in `reread`. Dates and kinds come from the change line and the operation ID. Example:

      ```
      $ node engine/cli.ts oplog done --date 2026-10-15 --kind trim_session
      {"date": "2026-10-15", "kind": "trim_session", "done": false, "status": "not_done",
       "reason": "no trim_session change on 2026-10-15 succeeded (conflict)", "reread": [],
       "entries": [{"heading": "2026-10-15 07:07 · op-2026-10-15-trim_session-3fa1c2d9e0b4", "op_id": "op-2026-10-15-trim_session-3fa1c2d9e0b4", "status": "conflict", "outcome": "conflict"}]}
      ```
    - **`node engine/cli.ts proposals check-applied --id <id> [--input <results.json>] [--now <instant>]`** (`engine/proposal-check.ts checkApplied`). `results.json` is a list with one tool result per write, in order (`null` when there is none), or `{results: [...]}`. Each write's dates are checked twice: the result in Tally's real shape (written, updated, moved, deleted, unchanged for a skip, per-day range results, replays) must be a success for the date, and the snapshot's read-back of the date (at most 15 minutes old) must show the change. It prints `{id, status: applied|partial|not-applied, writes: [{index, tool, dates, result, readback, applied}], missing}` and writes nothing. Example:

      ```
      $ node engine/cli.ts proposals check-applied --id P-20261014-reschedule_within_week-1 --input .tmp/coach/results.json
      {"id": "P-20261014-reschedule_within_week-1", "status": "applied",
       "writes": [{"index": 1, "tool": "move_planned_workout", "dates": ["2026-10-15", "2026-10-16"],
                   "result": {"2026-10-15": "done", "2026-10-16": "done"},
                   "readback": {"2026-10-15": "match", "2026-10-16": "match"}, "applied": true}],
       "missing": []}
      ```

## 22. Engine helpers for the skills

The skills never do arithmetic or reshape data. They run these commands. Every command prints JSON on stdout and takes `--root <dir>` (default: the current folder). Exit 2 is a usage error, exit 1 any other error (`{"error": {code, message}}`). `node engine/cli.ts <command> --help` prints `{command, usage}`: one usage line (`engine/cli-help.ts HELP`). `node engine/cli.ts --help` prints the general usage and every line. Each command imports its modules when it runs; the dispatch files import only `errors.ts` and `cli-help.ts` (tested). The `limits` and `oplog` commands (§21) and `proposals check-applied` load their modules the same way.

### 22.1 `hold init`

- **Purpose:** writes the inactive hold file that the guard needs (§10), so a fresh setup passes `validate`. Setup runs it once, after it writes `coach.yaml`.
- **Command:** `node engine/cli.ts hold init` (the same as `node engine/hold.ts init`).
- **Rules:** no hold file: writes `{active: false, set_at: null, reason: null, regions: [], set_by: null}` (the shape of `templates/athlete/hold.yaml`), exit 0, `created: true`. The create is atomic: the full file goes to a temporary name and is hard-linked to `hold.yaml`, which fails when a file exists, so a hold set meanwhile is never replaced. An inactive hold: no change, exit 0, `created: false`. An active hold: no change, **exit 3**, `{ok: false, active: true, message}`. A malformed file: no change, exit 1 (`HOLD_INVALID`).
- **Output:** `{"ok": true, "created": true, "hold": {...}, "path": "<root>/athlete/hold.yaml"}`.
- **Guard-files exception (planned; not yet in `engine/protect.ts`):** allow the exact commands `node engine/cli.ts hold init` and `node engine/hold.ts init` (with an optional `--root <dir>`), the same way as `hold set`. In `bashDecision`: `if (sub[0] === "hold" && (sub[1] === "set" || sub[1] === "init")) return allow`. It is safe because `init` never changes an existing hold. Today these commands get `ask` (interactive) or `deny` (unattended).

### 22.2 Tally day ↔ engine day; `adjust` and `loads` on Tally days

- **Module:** `engine/tally-shape.ts`. `tallyDayToPlan(day, {units})` → `DayPlan`; `planToTallyDay(plan)` → `{day, warnings}` (the day fields of `plan_workout_day`).
- **Forward:** each exercise becomes `suggestedSets` sets of `{weight: suggestedWeight, reps: repsMax ?? suggestedReps, duration_s: suggestedDuration, rpe}` (the same as the guard's `toDayPlan`). Units (§20 item 9): a read (it has `found`, `version` or `weightUnitSource`) is in Tally's known unit (`weightUnitSource` settings or history), else in `coach.yaml athlete.units`; write input (plan_workout_day arguments) is in its own `weightUnit`, else in `coach.yaml athlete.units`. Each exercise keeps its Tally fields in `tally`.
- **Back:** an exercise whose sets did not change comes back exactly as Tally stored it (`perSide`, `repsMax`, `rpe` and unknown fields included). A changed exercise gets `suggestedSets` = its hard sets, and the changed fields only, from the top set. A changed rep target sets `suggestedReps` and drops `repsMax`. An exercise with no Tally record (a recovery exercise) gets a snake_case `exerciseId` and a warning to resolve it with `search_exercises`. A missing `dayType` becomes `recovery` (a Recovery or Rest day) or `training`.
- **Commands:**
  - `adjust --from-snapshot <date> --decision trim|recovery [--planned-minutes n] [--session <id>] [--now <instant>]`: the day from the snapshot (read it with `get_planned_workout` first). The snapshot must be this session's (`--session`, else `CLAUDE_CODE_SESSION_ID`; neither: `SESSION_UNKNOWN`), no more than 15 minutes old, and the day read in the last 15 minutes; otherwise `SNAPSHOT_STALE` with the reason.
  - `adjust --decision trim|recovery < day.json`: a raw Tally day on stdin. Also accepted: a tool response `[{"type": "text", "text": "<json>"}]`, or `{"day": <Tally day>, "decision": …}`. The old `--input {day, decision}` with an engine day still works.
  - `loads --from-snapshot <date>` or `loads < day.json`: the same inputs and checks. Units: every history session is converted to the plan's unit (Tally's rule, `convertWeight`) before the suggestion; with a snapshot history or a Tally day, an exercise logged in a session without a unit gets no suggestion (`reason`: the unit is unknown). A history given in `--input` is taken as `units` unless a session names its own unit.
- **Output (Tally input only; adds to the §15 output):** `adjust` adds `tally_day` and `warnings`. `loads` adds `update: {date, weightUnit, operations: [{op: "modify", target: {exerciseId}, fields: {suggestedWeight}}], not_targeted: [names]}`, ready for `update_planned_workout` (an exercise without a unique exerciseId is in `not_targeted`).
- **Example:** `node engine/cli.ts adjust --decision trim < day.json` with squat 4 × 5 and lunge 3 × 8-12 gives:

```json
{ "changes": ["Squat: 4 → 3 sets", "Dumbbell Lunge: 3 → 2 sets"],
  "tally_day": { "date": "2026-10-15", "dayType": "legs", "dayName": "Legs", "weightUnit": "lbs",
    "exercises": [ { "exerciseId": "Barbell_Squat", "name": "Squat", "suggestedSets": 3, "suggestedReps": 5, "suggestedWeight": 225 },
                   { "exerciseId": "Dumbbell_Lunge", "name": "Dumbbell Lunge", "suggestedSets": 2, "suggestedReps": 8, "repsMax": 12, "suggestedWeight": 40, "perSide": true } ] },
  "warnings": [], "day": { … } }
```

### 22.3 Null base in proposals

- `proposals create` accepts `base: {"<date>": null}` for a date with no day. `matchApproval` then requires the date to be still empty (a snapshot read with `found: false`). A filled date, or a date not read, gives no match. An empty string is still refused. The PR body shows the date as "empty".
- **Example input:** `{"kind": "new_exercise", "summary": "Add a Friday legs day", "writes": [{"tool": "plan_workout_day", "input": {…}}], "base": {"2026-10-16": null}, "rule_ids": []}`.

### 22.4 `readiness --date <d>`

- **Purpose:** builds the §5 input from the files and prints the readiness. The model computes nothing.
- **Command:** `node engine/cli.ts readiness --date <YYYY-MM-DD> [--now <instant>]`. `readiness --input <file>` is unchanged. A date after today is a usage error.
- **Inputs it builds:**
  - `records`: `engine/signals.ts` from `date − (baseline_window_days + long pattern days + 1)` to `date`, in one read, so each morning of the long pattern has its own baseline.
  - `readiness_rules`: the pack's `single_day_action`, `off_mornings_short_pattern`, `off_mornings_long_pattern`, `program_change_min_categories` and `aversion_scale_max` checks, with their rule IDs.
  - `sleep_target_min`: `coach.yaml athlete.sleep_target_min`, an optional whole number of minutes from 240 to 720, default 480. Setup asks for it.
  - `thresholds`: `coach.yaml thresholds`. `session_change_min_categories` and `session_change_rule_ids`: the method pack.
  - `sessions`: each logged session in the snapshot history within `perf_expiry_days`, newest first, judged against **its own date's plan** (the snapshot day from `get_planned_workout`), never today's plan. `planned_sets`: the plan's sets. `completed_sets`: logged sets of planned exercises (a 0-rep set does not count), at most the plan per exercise. `reps_shortfall_ratio`: Σ max(0, target − reps) / Σ target, with the target at the bottom of the rep range. `rpe_drift`: the mean of logged RPE − planned RPE, absent when no set has both. `top_set_dropped`: the heaviest logged set is below the planned weight (converted when both units are known).
- **Unknown, never estimated:** a session whose plan is not in the snapshot stops the list: performance is `unknown` with the reason, and an older session never stands in for it. Missing measurements also stop it, with no `SessionPerf`: a planned exercise without a set count or a rep target, a logged set without reps, a planned weight with no logged weight, or a weight unit known on one side only. A timed exercise (a duration, no rep target) is not judged. The history read must be complete, read in the last 15 minutes, and cover `date − perf_expiry_days` to `date`; otherwise performance is `unknown` with the reason. So the skill reads `get_workout_history` and `get_planned_workout` for each logged date of the last `perf_expiry_days` days first.
- **Past dates:** the date is judged as of 23:59 local on that date.
- **Output:** the §5 `Readiness`, plus `inputs`: the full `ReadinessInput` used, `signals_warnings`, `sessions_judged: [{date, plan: found|missing|empty, perf?, notes}]` and `notes`, plus `pattern`.
- **`pattern`** (load progression is held only on a pattern, never on one red day): `{days (the date and the 2 days before it, oldest first), states: {wearable, subjective, performance} (each day's state, each earlier day judged as of its own end), red_days: {wearable, subjective, performance}, hold_progression, reason}`. `hold_progression` is true when wearable or subjective is red on at least 2 of the 3 days, or performance is red on the date. Performance counts for the date only, because one logged session stays in the window for several days. A day with no evidence is `unknown`, never red. The `today` skill runs its loads step only when `hold_progression` is false.
- **Example** (abridged; 35 nights of 480 min, then 400 min; no check-in; yesterday's plan 2 × 3 done as planned): `node engine/cli.ts readiness --date 2026-10-14` → `{"date": "2026-10-14", "wearable": {"state": "amber", "reasons": ["sleep 400 min = 83% of target: amber"], …}, "subjective": {"state": "unknown", …}, "performance": {"state": "green", "reasons": ["session 2026-10-13 on plan"], "sessions_used": ["2026-10-13"]}, "known": 2, "decision": "note", "decision_reasons": ["wearable off today, with 0 off-mornings in a row: one day is not a pattern"], "hold_progression": false, "aversion": false, "deload_signal": false, "pattern": {"off_mornings": {"hrv": 0, "rhr": 0, "either": 0}, "days_of_decline": 0, "short": false, "long": false, …}, "rule_ids": ["NA-REC-008"], "pain": [], "inputs": {"sleep_target_min": 480, "sessions": [{"date": "2026-10-13", "planned_sets": 2, "completed_sets": 2, "reps_shortfall_ratio": 0, "rpe_drift": 0, "top_set_dropped": false}], "readiness_rules": {"short_pattern": {"mornings": 3, "ids": ["NA-REC-009"]}, …}, …}}`.

### 22.5 `weeks --from <d> --to <d>`

- **Purpose:** the snapshot history as Monday-to-Sunday `WeekLog` entries, ready for `targets` (`{block, logs, today, target_week}`).
- **Rules:** every week from the week of `from` to the week of `to`, empty weeks included (a missed week). Dates go into week buckets in one pass. Sessions outside `from`-`to` are left out. Two sessions on one date merge into one `DayLog`. History dates are already local calendar dates (§0, §9).
- **Output:** `{from, to, logs: WeekLog[], coverage, warnings}`. `warnings` names what the history read does not cover (no read, incomplete, starts after `from`, ends before `to`): those sessions are unknown, not absent.
- **Example:** `node engine/cli.ts weeks --from 2026-09-28 --to 2026-10-18` → `{"logs": [{"week_start": "2026-09-28", "days": [{"date": "2026-09-28", "exercises": [{"name": "Squat", "sets": [{"weight": 225, "reps": 5, "rpe": null}, …]}]}]}, {"week_start": "2026-10-05", "days": []}, …], "warnings": []}`.

### 22.6 `block draft [--template <id>] --weeks <n> [--input <file.json>]`

- **Purpose:** expands a method-pack template into a block, with all the arithmetic in code.
- **Arguments:** `--template` (default `<coach.yaml template.days>-day`), `--weeks` 1-52, `--input` (optional): `{id?, start? (a Monday; default the next Monday), emphasis? (default coach.yaml), targets? ({muscle: week-1 sets}; default the template's own counts), step? (default 0.05, never above weekly_volume_increase_max), deload_weeks? (default every deload_every_weeks-th week), weekdays? (default 3-day mon wed fri; 4-day mon tue thu fri; 5-day mon tue wed fri sat), exercises? ({"<day>.<slot>" or pattern: {name, exerciseId}}), loads? ({exerciseId or name: working load in the athlete's units})}`.
- **Rules:**
  1. Base slot sets: `scaledSets` (emphasis multiplier, rounded, at least 1 unless the multiplier is 0; a 0 slot is left out).
  2. A slot's muscles: its exercise's classification, else its pattern's muscles (the guard counts the same way).
  3. Allocation: each target muscle's sets split across its slots in proportion to their base sets (largest remainder). A slot takes the smallest share its muscles give it, at least 1 set. A warning names a muscle that the 1-set minimum puts above its target.
  4. Build week j: `round(target × (1 + step)^(j − 1))`, capped by `allowedSets(previous build week, cap)`. Week 1 is capped the same way against the reference week (§8: the last completed non-deload week before the block, from the snapshot history, as the guard finds it), and every muscle of the template then gets a target. `capped` lists each week-1 target the cap lowered. With no reference week, week 1 is the targets as given.
  5. Deload week: each non-recovery slot keeps `max(1, round(previous build sets × deload_depth.volume))`; loads are `× deload_depth.load`, rounded to 5 lbs or 2.5 kg, at least one step.
  6. The block's slot `sets` are each slot's most in any build week (what `block_session` reads; a deload scales it). Each block week's `targets` are the sets it plans, so the guard and the plan agree.
  7. Resolved exercises only: a slot is in the returned days only when `exercises` names an exercise for it that classifies. Other slots are listed in `unresolved` and `ready` is false.
- **Output:** `{template, block (the athlete/block.yaml shape; validated when it has an id), ready, unresolved: [{slot, day, pattern, adaptation, sets, reason}], weeks: [{week, kind, week_start, load_factor, sets_by_muscle (weeklySetsByMuscle of the returned days), planned_by_muscle (every slot; the block week's targets), targets, days: DayPlan[] (each exercise also has pattern and adaptation)}], reference: {week_start, sets_by_muscle} | null, capped: [{muscle, base, planned, allowed}], rule_ids, warnings}`. `audit` checks `sets_by_muscle`; every drafted day passes the guard's `block_session` check (tested). Only a `ready` draft is a full plan.
- **Example:** `node engine/cli.ts block draft --weeks 6 --input d.json` with `{"id": "B-001", "start": "2026-10-19"}` → 5 build weeks and a deload in week 6 (`deload_every_weeks` 6), `"block": {"id": "B-001", "start": "2026-10-19", "weeks": [{"week": 1, "kind": "build", "sessions": 4, "targets": {"chest": 9, …}}, …], "days": [{"day": "mon", "focus": "Whole-body lifting, 5 to 10 reps", "slots": [{"pattern": "squat", "adaptation": "strength", "sets": 4, "reps": 5, "rest_s": 180}, …]}, …]}`.

### 22.7 `ids next --kind block|limit|proposal [--change <kind>]`

- **Purpose:** the next free ID, so the model never counts.
- **Rules:** `block`: `B-NNN`, one past the highest in `athlete/block.yaml` and `athlete/blocks/*.yaml` (the block skill keeps old blocks there). `limit`: `L-NNN`, one past the highest in `athlete/limits.yaml`. `proposal`: `P-YYYYMMDD-<change>-<n>` for today in the athlete's timezone, the same rule as `createProposal`; `--change` is required.
- **Output:** `{"kind": "block", "id": "B-008", "taken": ["B-002", "B-007"]}`.

### 22.8 `signals refresh`

- **Purpose:** refreshes the Oura cache for the last 3 days before a daily run loads signals. Oura is Mac-only in v1 (§14).
- **Rules:** it fetches only when `coach.yaml` sets `signals.wearable: oura`, the platform is macOS, and the Keychain holds an Oura sign-in. Otherwise it changes nothing, exits 0, and says why in one line: no coach.yaml, not configured, not macOS, no Keychain access, or no Oura sign-in. A failed fetch also exits 0 with `refreshed: false` and the adapter's fixed error (`error: {code, message}`); the run goes on with the cached signals. It never prints a token.
- **Output:** `{"refreshed": false, "note": "Oura is not configured (signals.wearable is apple-health-shortcut)"}`, or `{"refreshed": true, "note": "Oura refreshed 2026-10-12 to 2026-10-14 (3 records)", "result": {path, from, to, records, kept, auth, warnings}}`.
- `signals --from --to` (§11) is unchanged.

### 22.9 `lint-methods [--pack <name>] [--volume]`

- **Purpose:** runs `engine/lint-methods.ts` from the CLI, so skills never name an `engine/` path.
- **Rules:** the pack is `--pack`, else `coach.yaml method`, else `nine-adaptations`, under `methods/`. Exit 1 when the pack has errors.
- **Output:** `{"pack": "nine-adaptations", "ok": true, "errors": [], "warnings": […], "volume": [{template, emphasis, sets}] (with --volume)}`.

## 23. Launch hardening

### Unattended allowlist

- **Runner list:** `engine/automation.ts UNATTENDED_TOOLS`: `Read`, `Glob`, `Grep`; `Bash(node engine/cli.ts:*)`, `Bash(git status|diff|log|add|commit|pull|switch:*)`, `Bash(gh api:*)`, `Bash(date:*)`, `Bash(printenv CLAUDE_CODE_REMOTE)`; `Edit` and `Write` on `athlete/log/**`, `athlete/proposals/**`, `.tmp/coach/**`. There is no `git push`: pushes go through `node engine/cli.ts push`.
- **Guard:** in an unattended run (`CLAUDE_CODE_REMOTE` or `COACH_UNATTENDED` set), `engine/protect.ts unattendedBash` denies a Bash command unless every segment is on the list. Segments are split as in §20 (a file-descriptor duplication is dropped; one final redirect may go from the engine CLI into `.tmp/coach/`).
  - **Words (`strictWords`):** each word is made of plain parts (`[A-Za-z0-9._/:=@,+%-]`) and quoted parts whose text holds no `$`, backtick, backslash or newline. An unquoted `{ } * ? [ ] ~ ! #`, any backslash (so no backslash-newline continuation) and `$` even inside quotes deny: nothing is left for the shell to expand. One exception: a newline inside quotes is allowed in the value of `git commit -m`, `--message`, `-am` or `--message=`, so a message can hold a body and a `Co-Authored-By` line. The splitter does not cut inside quotes. A quoted newline anywhere else denies, and an unquoted newline still ends the command.
  - **Engine:** `node engine/cli.ts <command>` and `node engine/hold.ts <command>` (the hold entry; the §10 hold rules apply). `install-launchd` and `checkin` deny, and both commands also refuse themselves when an unattended marker is set.
  - **git:** no option before the subcommand. `status` (`--porcelain`, `--short`, `-s`, `--branch`, `-b`), `diff` (`--stat`, `--name-only`, `--cached`, `--staged`, `--quiet`, `--exit-code`, `--`) and `log` (`--oneline`, `-n <N>`, `-<N>`, `--format=<fmt>`, `--since=<date>`, `--stat`, `--name-only`) take only these options, plus path and ref operands. `add`, `commit`, `pull` and `switch` accept only their listed options. `pull` takes no remote or branch (it pulls the current branch's upstream, so no other branch is merged locally). `switch` must be the whole command (not joined to another), and denies while `athlete/block.yaml` has uncommitted changes. `push` denies: use `node engine/cli.ts push`.
  - **gh api:** `repos/<owner>/<repo>` or its `pulls[/<n>]`, where `<owner>/<repo>` equals the `origin` remote's GitHub repository (`engine/prepush.ts githubRepo`, case-insensitive); no GitHub origin denies. The effective method is `-X`/`--method` when given, else POST when any `-f`, `-F`, `--field` or `--raw-field` is present, else GET. GET passes; POST passes only on `pulls`. No `-F k=@file`, `--input` or `-H`.
  - **Others:** `printenv` reads only `CLAUDE_CODE_REMOTE` or `COACH_UNATTENDED`; `date` takes only `+FORMAT` operands and `-u`, after an optional `TZ=<zone>`.
  - Bash with `run_in_background: true` denies, also for the `npm ci` repair when the engine cannot load. An unquoted single `&` (background) denies, also at the end of the command; `splitWithSeparators` keeps each separator, so `&&` still joins two commands. Edit and Write outside `UNATTENDED_WRITE_DIRS` deny. The fast path (`.claude/hooks/fast-files.ts`) never decides an unattended call.
- **Paths:** `realish` (engine and fast path) resolves every symbolic link with `lstat` and `readlink`, dangling links included, one component at a time; more than 40 links in one path is a loop (ask interactive, deny unattended; the fast path sends it to the engine). Callers join the root and the raw relative path without normalizing it (`rawAbs`), so `..` after a link goes to the parent of the link's target, as the operating system reads it. A missing component counts as a folder that a write could create, and the walk goes on through it. So a link in `.tmp/coach/` or `athlete/log/` cannot point a write or a redirect elsewhere, also through `link/..`.
- **Package repair:** a cloud run starts from a fresh clone with no `node_modules`. Then the guard cannot load and allows only the exact `npm ci` / `npm install` repair (§20 item 27), in both modes; the routine prompt says "If node_modules is missing, run npm ci first." The run cannot change what `npm ci` installs: `package.json` and `package-lock.json` are executable files (below).
- **Executable files (every mode):** a write to `package.json`, `package-lock.json`, `.npmrc`, `*.js|cjs|mjs|ts|cts|mts|sh`, a path under `node_modules/`, `.husky/`, `.git/` or `.github/workflows/`, or an existing file with an execute bit: `ask` interactive, deny unattended.
- **Residual risk:** interactive Bash keeps the §20 rules; Claude Code asks the user before each command that is not allowed. docs/safety-and-privacy.md says so.

### Protected evidence

- `athlete/block.yaml` and `athlete/signals/**` are protected paths (Edit, Write and Bash names).
- The guard's block is the approved block: the working tree on `main` (or outside git), and `git show main:athlete/block.yaml` on any other branch (`engine/guard-context.ts readApprovedBlock`). A block on a branch authorizes nothing.
- `node engine/cli.ts block write --input <block.json> --proposal <id>` writes `athlete/block.yaml` only on `proposal/<id>`, for a `proposed` `new_block` proposal. A previous block with another id moves to `athlete/blocks/<old id>.yaml`. It commits both files on the branch ("proposal <id>: block <block id>"); when the commit fails, it restores the previous files and throws `GIT_ERROR`. Other errors: `WRONG_BRANCH`, `PROPOSAL_STATE`, `BLOCK_INVALID`.
- `node engine/cli.ts checkin` throws `UNATTENDED` in an unattended run and writes nothing.

### Urgent state

- An urgent event is active when the pending file holds an urgent term (`engine/safety-terms.yaml urgent`), or the active hold has `urgent: true`, the word "urgent" in its reason, or an urgent term in its reason (`engine/validate.ts urgentEvent`).
- Under it the guard denies every day that still holds an exercise whose logger exercises differ in any field from the day before the call (the full Tally objects: sets, reps, load, duration, distance, per side, …): trims and recovery workouts deny. A note or name change on unchanged exercises, a rest day (no exercises), a skip and a delete pass.
- `hold set` stores `urgent: true` when `--urgent` is given, when the new reason has the word "urgent" or an urgent term, or when the active hold it extends is urgent by the same test (`engine/safety.ts isUrgentHold`, which the guard uses too).
- The plan representation carries `distance_m` (Tally `distanceMeters`) on each set and `perSide` on the exercise. A change in either is a prescription change, not `annotate`; a longer distance or a new `perSide: true` is not a trim. `classifyChange` labels a change `trim_session` only when `isTrimOf` holds for every exercise; `extraWork` (per side, a longer distance or duration, a higher RPE, more sets with warm-ups, a warm-up above every earlier set) on any exercise makes the change neither a trim nor a `load_progression`, so it is big. `hold status` (through `cli.ts`) adds `urgent` and `urgent_reason`. Extra work is judged per kept set position as well as by the maximum (`extraWork`), so a rise below the old maximum counts. `swap_to_recovery`, and a recovery day under a hold, need a day that adds no work to an exercise it keeps (`addsWork`: extra work, more hard sets, a heavier top set or more reps).

### Hooks in fresh clones

- `node engine/cli.ts prepush-check [--remote origin]`: exit 0 and `{ok: true, repo, visibility, hook_installed: true}` only when the pre-push hook at `git rev-parse --git-path hooks/pre-push` equals `git-hooks/pre-push` and is executable, and `gh api repos/<owner>/<repo>` reports `private` or `internal`. Otherwise exit 1 with `{ok: false, reason}`.
- `node engine/cli.ts push [--branch <name>]` is the only push of an unattended run. The branch (default: the current branch) must exist as `refs/heads/<name>` (`git show-ref --verify`); a name that starts with `refs/`, a detached HEAD, a bad name or a missing branch is `USAGE`. It runs `install-git-hooks`, then `prepush-check`, then reads every push URL of `origin` (`git remote get-url --all --push origin`, `insteadOf` and `pushInsteadOf` applied). Each one must name the GitHub repository that the check looked up; otherwise exit 1. Then `git push --no-follow-tags [-u] origin refs/heads/<name>:refs/heads/<name>` (`-u` when the branch has no upstream): the explicit pair leaves no destination to `remote.origin.push`, and `--no-follow-tags` overrides `push.followTags`. A failed check exits 1 with `{ok: false, pushed: false, reason}` and pushes nothing. Success prints the `argv` it ran.
- The routine prompt, `today`, `week`, `block`, `limits` and `setup` push with it. Unattended, raw `git push` denies. Interactive sessions may still run `git push` (the installed pre-push hook checks it). Setup runs `install-git-hooks` and `prepush-check` and requires `ok: true`.

### Logger notes

- Notes to the logger are generic by default (the `today` skill's "Notes to the logger" table). Symptoms, regions, pain scores and readiness values go into a logger note only with `coach.yaml consent.logger_health_notes: true`, a separate question in setup.

### CI

- `.github/workflows/test.yml` runs when `github.repository` is the template, or when a copy sets the repository variable `COACH_CI` to `true`. `tests/privacy.test.ts` checks tokens on the repository; the zero-athlete-files check runs on the public export (`tests/public-tree.test.ts`).

### Logger tool names

- `install-launchd` and `launchd-plist` take the Tally prefix from `--tool-prefix`, else `coach.yaml automation.tool_prefix`, else the connected Tally servers in `claude mcp list` (`toolPrefixFromServer`: `mcp__<name>__`, non `[A-Za-z0-9_-]` → `_`). A prefix must match `^mcp__[A-Za-z0-9_-]*[Tt]ally[A-Za-z0-9_-]*__$` (`BAD_TOOL_PREFIX`); none found: `NO_LOGGER_TOOLS`.
- `install-launchd --yes` first runs a probe (`claude -p … --permission-mode dontAsk --output-format stream-json --allowedTools <prefix>get_training_context`, no API key, `COACH_UNATTENDED=1`) and installs nothing unless a `get_training_context` call returned without an error (`LOGGER_PROBE_FAILED`).
- Cloud routines use the connector's own name (`mcp__<connector name>__`).


### Latency

- `fileGuard` looks up the branch and main's proposals only for a path under `athlete/proposals/`. `scripts/bench-hooks.mjs` measures four unattended calls too (Edit `athlete/log/x.md`, Write `.tmp/coach/x.json`, `node engine/cli.ts mode`, `git switch main`).

### Eval re-run fixes

- **Bash over-blocks:** a file-descriptor duplication (`2>&1`, `>&2`, `1>&2`) names no file and is dropped before the segment rules (`normalizeSegment`). An engine call may end with one `>` or `>>` into `.tmp/coach/` (resolved inside the root, no script extension); this is on the unattended allowlist too. A read-only command (§20) may carry whole quoted words whose text holds only letters, digits, spaces and `. _ - : / @ , +`. Loops stay strict: CLAUDE.md asks for one engine command per Bash call.
- **Agents in the foreground:** every agent call in the skills sets `run_in_background: false`. `safety-detect` removes closed `<task-notification>…</task-notification>` blocks (background-task results) before it scans; the athlete's own words outside them are scanned as before.
- **Safety questions:** the `safety` agent ends its output with a "Questions for the athlete (copy exactly):" block. The main session pastes it word for word, as a quoted block, without rewording.

## 24. Template updates

A user's repo is made with GitHub's "Use this template": one fresh commit and no link to the template. `node engine/cli.ts update` brings later template releases into it.

### Ownership

- **Template files:** every file the public export ships (`scripts/public-tree.txt`). The update owns them.
- **User files:** `coach.yaml`, everything under an `athlete/` segment, and any file not in the template manifest (for example a method the user added under `methods/<name>/`). The update never writes, moves or deletes them.

### The manifest

- `scripts/export-public.sh` writes `template-manifest.json` at the export root after the copy (`scripts/template-manifest.ts`): `{version: 1, repo: "https://github.com/<owner>/coach-harness", release: <package.json version>, files: {<path>: {mode: "100644" | "100755", blob: <git blob id>}}}`, sorted by path, for every exported file but the manifest. The blob id is git's (`blob <size>\0<bytes>`, sha1); the mode is 100755 when the owner may execute the file.
- The manifest is a protected file (`PROTECTED_FILES` in `engine/protect.ts` and `.claude/hooks/fast-files.ts`): Edit or Write asks interactive and denies unattended.
- The source of an update is the local manifest's `repo`; only `https://github.com/<owner>/<repo>` (optional `.git`) is accepted. There is no `coach.yaml` key for it.

### Path rules

Both manifests are validated before any plan (`engine/manifest.ts pathProblem`). A path is valid only when the public-tree rules of its own release (`scripts/public-tree.txt` at HEAD for the local manifest, in the fetched commit for the new one) ship it; it is relative, with no empty, `.` or `..` segment; compared by segment without regard to case, it has no `athlete` segment (except `templates/athlete/`, which ships), and no `.git`, `node_modules` or `.husky` segment; it is not `coach.yaml`, `.npmrc`, `.claude/settings.local.json` or `template-manifest.json`; it holds no `*`, `?`, `[` or `]` and does not start with `:` (git would read it as a pattern). Two paths that differ only in case are refused. Every git command that takes manifest paths runs with `--literal-pathspecs`. In the fetched tree (`git ls-tree -r <sha>`), a manifest path that is a symlink (`120000`) or a submodule (`160000`), or whose mode or blob differs from the manifest, refuses the update.

### The plan

old = the local manifest, new = the fetched manifest, local = `git ls-tree -r HEAD` (the working tree must be clean). Mode and blob are compared together.

| old | new | local | action |
|---|---|---|---|
| A | A | A | unchanged |
| A | B | A | replace with B |
| A | B | B | unchanged |
| A | B | C | conflict |
| A | A | C | keep the user's version |
| A | A | missing | stays deleted |
| A | B | missing | conflict |
| A | missing | A | delete |
| A | missing | C | keep (now a user file) |
| A | missing | missing | nothing |
| missing | B | missing | add |
| missing | B | B | unchanged |
| missing | B | C | conflict |

A template write (replace or add) whose path differs only in case from a local path that the plan keeps is a conflict with only `--keep-mine` (on a case-insensitive disk the two names are one file); a clean case-only rename (the old name deleted, the new one added) is not a conflict, and the commit records the new name. An add whose destination, or a name in its folder that differs only in case, already exists on disk outside HEAD (an ignored or untracked file) is a conflict with both fixes; other ignored files are fine. A settlement flag must be one of the fixes the plan offered for that path. A copy with no local manifest is refused (`NO_MANIFEST`), with the manual path in the message.

### The command

- `update --check [--ref <tag or branch>]` (default `main`) and `update --yes --to <sha> [--keep-mine <path>]... [--take-template <path>]...`; both together is `USAGE`.
- Refusals (`UNATTENDED`, `UPDATE_REFUSED`), in this order: an unattended marker; uncommitted or untracked changes; a branch other than `main`; a `url.<x>.insteadOf` whose prefix starts the source URL or `https://github.com/`, or is empty (read with `git config -z`; an empty prefix matches every URL); `protocol.ext.allow` or `protocol.file.allow` set to `always`. Only then the first fetch: when there is an `origin`, its `main` is fetched explicitly into `refs/coach-upstream/origin-main`, and a failed fetch, an unknown ref or `main` behind it refuses (a git error is never "0 behind").
- The fetch: `--ref` passes `git check-ref-format --branch` and does not start with `-`; `git fetch --no-tags -- <repo> +<ref>:refs/coach-upstream/<ref>` with `GIT_TERMINAL_PROMPT=0`. `--yes` fetches again and refuses unless the commit equals `--to`.
- `--check` prints `source`, `ref`, `to`, `release_from`, `release_to`, `changelog` (the `## ` sections of the fetched `CHANGELOG.md` that the local one lacks, with their text), `plan` (counts and paths), `conflicts` (each with `--keep-mine` and `--take-template`), and `up_to_date`. It changes nothing.
- `--yes`: an unsettled conflict changes nothing (`UPDATE_CONFLICT`). `--take-template` copies the local file to `.tmp/coach/update-backup/<path>` first. Every new blob is read and checked against the manifest before any write. Every project file a hook command in `.claude/settings.json` names (the new one, or the current one when it does not change) must exist after the update: each command is split at `&&` and `;`, and every word that is `$CLAUDE_PROJECT_DIR/<path>` (in or out of quotes) or a relative path with a `/` or a script extension counts, and so do an absolute path under the project root (checked as a relative one) and the value of a path option (`--import`, `--require`, `-r`, `--loader`, `--experimental-loader`, `--env-file`, given as `--x=value` or as the next word; any other option value with a `/`); an absolute path outside the project (a system `node`) is not a template file; any other shell syntax refuses the update (`engine/update.ts commandPaths`). Backups, deletions, then each file go through one checked writer: every existing part of the path is checked with `lstat` (no symlink, no path outside the root), then a temp file in the same folder, the mode, and a rename; temp files are tracked. Any error rolls back in a case-safe order (temp files, added paths, originals from HEAD including case twins, backups and replaced ignored files) and prints the manual fix (`git reset --hard && git clean -fd` outside Claude Code); when a rollback step fails (a failed `git reset` included), the message says so. The rollback also removes staged additions from the index, and restores the bytes and the mode of backups and replaced ignored files through the checked writer. Then the new manifest, `git add -f -A` of the written, deleted and manifest paths, and one commit on `main`: `update: coach-harness <from> → <to> (<short sha>)` with the trailer `Coach-Template-Commit: <full sha>`.
- `--yes` prints `npm_ci_needed` (`package-lock.json` changed), `reinstall_git_hooks` (`git-hooks/` changed) and `restart_claude_code` (anything under `.claude/` changed).
- `node engine/cli.ts config-check` loads `coach.yaml` with the current engine and prints `{ok, problems}` (exit 1 on a problem). The `update` skill runs it after an update.
- **Rule:** a release never adds a required `coach.yaml` key; a new key gets a default in code.

### The guard

- The fast path never allows `update` (any arguments).
- An engine call is recognized only when every word passes the strict word rule (plain parts plus quoted parts with no `$`, backtick, backslash or newline; `strictWords`), in both guards. Any other form (`upda\<newline>te`, `updat?`) is not an engine call, so the protected-name rule decides (ask interactive, deny unattended). Before any check, both guards remove each backslash-newline outside single quotes, as the shell does (`joinContinuations`), so `node en\<newline>gine/cli.ts upda\<newline>te` is judged as `node engine/cli.ts update`. Interactive, a segment whose first word is `node` and whose words fail the strict rule asks; it never falls through to allow.
- `engineCallDecision`: `update` with `--yes`, `--keep-mine` or `--take-template` asks interactive ("update replaces the coach's code and needs your yes"); `update --check` passes.
- Unattended, `update` denies (with any arguments), and the command refuses itself.

