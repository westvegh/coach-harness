# Engineering contracts (v1)

The file formats and module interfaces that the code follows. Read it before you change the engine, a hook, an adapter or a method pack. [how-it-works.md](how-it-works.md) explains the same parts in plain words. If code and this file disagree, fix one of them in the same change ([CONTRIBUTING.md](../CONTRIBUTING.md)).

**v0.2 (trust the coach).** Code enforces two things only: the urgent stop (§10) and privacy (§10a). Everything else is the coach's judgment, guided by `CLAUDE.md`, the skills and the method pack; the engine is a set of tools that report. Sections and items marked "Removed in 0.2" describe the v0.1 guard and stay only as a record ([docs/build/v0.2-trust-the-coach.md](build/v0.2-trust-the-coach.md) is not public; the CHANGELOG has the summary).

## 0. Conventions

- **Runtime:** Node ≥ 22.18. TypeScript runs directly through type stripping, so use only erasable syntax: no `enum`, `namespace`, or parameter properties. Use `import type` for types, and write `.ts` extensions in relative imports.
- **`tsconfig.json`:** `strict`, `noEmit`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `module: nodenext`.
- **Dependencies:** runtime `yaml`; dev `typescript`, `@types/node`. Nothing else without a reason in the PR.
- **Tests:** `node --test` with explicit globs. `npm test` runs `tsc --noEmit`, then all unit and hook tests.
- **Dates:** a calendar date is `YYYY-MM-DD` in the athlete's timezone (`coach.yaml athlete.timezone`). An instant is ISO 8601 with an offset.
- **IDs:**
  - Rules: `NA-<AREA>-NNN`. Limits: `L-NNN`. Operations: see §9.
  - Proposals: removed in 0.2. A change for the next live session is one line in the athlete log ("- proposal for the next live session: …").
- **Errors:** engine functions throw `CoachError {code, message}`. A hook that throws exits 2; the urgent gate is registered with `onFailure: "block"`, so its crash blocks the call (§10).
- **Protected files:** removed in 0.2. No file is protected from the coach. `.claude/settings.json` keeps one deny pair, for `athlete/.cache/**` (the snapshot cache that only `capture-reads` writes).

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
logger: tally                        # optional (0.2): tally | files | other (§12a)
tally_mentioned: false               # optional (0.2): true once the coach mentioned Tally to a files|other athlete
consent:                             # optional (§23)
  logger_health_notes: true          # optional; default true (0.2); false keeps logger notes generic
automation:
  mode: manual                       # cloud | mac | manual
  daily_window: { start: "05:07", end: "10:07" }
  weekly: { day: sun, time: "17:07" }
  verified: false                    # true only after a successful test run
  tool_prefix: mcp__tally__          # optional (§23): the connected Tally server's tool prefix
approval:                            # Policy input to engine/classify (big or small).
  auto: [trim_session, swap_to_recovery, load_progression, reschedule_within_week]
  ask:  [new_exercise, volume_above_plan, override_user_day, skip_or_delete_user_day, limit_change, new_block, method_change]
thresholds: {}                       # Optional overrides of §5 defaults, same keys.
clusters:                            # optional (0.2.4): exercises done as cluster sets (§8a); default none
  - name: EZ Bar Curls (Cluster)     # required: the plans CSV has no exerciseId
    exerciseId: custom-123           # optional: the logger's id
    mini_sets: 6
    reps: 6                          # per mini-set
    rm: 12                           # the rep max the load matches; above reps
    rest_s: 10                       # optional
    since: 2026-09-01                # optional; before it, the exercise is straight sets
```

Validation: `engine/config.ts` exports `loadConfig(path): CoachConfig`. Unknown keys are errors. A change kind cannot appear in both `auto` and `ask`. Hard-rule kinds (§6) cannot appear in `auto`.

v0.2 defaults (§24 rule: a release never adds a required key):
- `logger` is optional and one of `tally | files | other`. Without the key: `tally` when `automation.tool_prefix` is set (a copy that already uses Tally stays on Tally), else `files` (`engine/config.ts defaultLogger`). v0.1 required the key, so every v0.1 copy has `logger: tally` and stays on Tally with no edit.
- `tally_mentioned` (boolean, default false) is written only by `tally-mention` (§12a).
- `clusters` (0.2.4) is optional, default none in code: an existing copy works without editing `coach.yaml`. `config-check` validates it: whole numbers, `rm` above `reps`, `since` a date, no two entries for one exercise (the same `exerciseId`, or the same normalized name). The coach writes it; the athlete never edits it.
- `consent.logger_health_notes` defaults to true: setup's one data question names the readiness and pain scores in Tally notes. Only an explicit `false` keeps the notes generic.

## 2. `athlete/limits.yaml`

```yaml
version: 1
pain_threshold: 4                    # 0-10; check-in pain at or above this goes to the safety skill
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
    build_back: true                 # optional, cap only: the week skill raises the cap a step while the region feels fine
    note: "Hinge capped while rehabbing"
    source: clinician-reported
    since: 2026-10-01
```

`limitsHash(file)` is the SHA-256 of the canonical JSON of the parsed file (sorted keys).

- **Who follows it:** the coach, in every plan (`CLAUDE.md` hard rule 4). No hook checks a write against it (v0.2).
- **Who changes it:** the coach, when the athlete asks (the `safety` and `limits` skills), and commits the change.
- **`build_back`** (optional, `true` only on a cap): the athlete chose "go light and build back slowly". The `week` skill asks once a week how the region felt and raises the cap by one set (or about 10% load) when it felt fine. `engine/limits.ts` refuses it on a ban.
- **`limits check --input <file.json>`** (`engine/limits-check.ts checkLimits`; `{week}` or `{days}`): a report, not a gate. Findings: `banned` (an exercise that a ban matches), `over_sets` (a weekly hard-set count over `max_sets_per_week`), `over_load` (a set over `max_load`, after unit conversion), `unclassified` (an exercise the taxonomy does not know, while any limit exists; the coach judges it). Warm-ups count toward `max_load` but not toward the weekly sets. Skipped days do not count. Output `{ok, findings}`; `ok` is false on any finding but `unclassified`. Matching: by name or exerciseId, else by pattern unless `allow` exempts it; an `allow` entry binds to the exerciseId first (§20 item 25).

## 3. Movement taxonomy

`engine/movements.yaml` ships with the harness. `athlete/movements.local.yaml` has the same shape and wins when both define an entry.

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

**Templates** (`templates/{3,4,5}-day.yaml`): days with focus and slot lists. Each slot has `pattern`, `adaptation`, `sets`, `reps` or `duration`, and `rest_s`. An `emphasis` table holds a set multiplier per adaptation for each emphasis. Optional (0.2.2): a top-level `why:` list of 3 to 5 plain lines for the athlete (why the week looks as it does), and a one-line `why` per day; at most 25 words a line, no rule ids or code paths (the lint checks them; never a runtime check). `block draft --out` prints them as `why`.

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
  temperature?: { deviation_c: number }; // the vendor's nightly deviation from the athlete's baseline, °C; shown, not scored
  // The rating is one group: overall, or the four scales together; never both. At least one field
  // (engine/checkin-shape.ts, V6). pain: [] records "no pain now".
  subjective?: { overall?: 1|2|3|4|5; sleep_quality?: 1|2|3|4|5; energy?: 1|2|3|4|5; soreness?: 1|2|3|4|5; stress?: 1|2|3|4|5; want_to_train?: 1|2|3|4|5; pain?: { region: string; score: number }[] };
  checkin_at?: string;            // when the check-in was answered (its submitted_at); pain is handled per check-in.
                                  // An instant, not in the future (the normalizer, the cached-record check and the readiness
                                  // input check reject anything else). An older cached record without it: the loader sets
                                  // it to the record's observed_at, so the "pain handled" key is always there.
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
- **Subjective:** from the latest check-in record dated today. With `overall`: at or below `subjective_red` red, at or below `subjective_amber` amber, else green (with the defaults: 1 red, 2 amber, 3 to 5 green), reason `feels <word> (<n>/5)` (1 wrecked, 2 run down, 3 okay, 4 good, 5 great). Else the mean of the 4 scales, where soreness and stress are inverted (6 − x); any scale at 1 makes it amber. Else (a check-in with only `want_to_train` or `pain`) `unknown`, reason `no rating today`; `want_to_train` and `pain` still count. No check-in today: `unknown`, reason `no check-in for today`. Valid only when `date == today`.
- **Check-in shape** (V6, `engine/checkin-shape.ts checkinBlockProblems`, one function for the CLI, the daily-file normalizer, the cached-record check and the readiness input check): the rating is one group, `overall` or the four scales together (all four or none), never both; at least one of the rating, `want_to_train` or `pain` (an empty list counts). Each scale is a whole number from 1 to 5. The schema subset cannot state these rules, so they are code.
- **Wearable reasons** carry the value itself: `HRV (rmssd) 48 ms, z -0.3 (baseline 51.2 ± 6)`, `RHR 52 bpm, z 0.4 (…)`, `sleep 412 min = 86% of target`.
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
- **`annotate`:** only `notes` or `dayName` change. It is small, and is how a run leaves its reason.
- **`trim_session`:** the same exercises with fewer or equal sets and load.
- **`swap_to_recovery`:** `after` is a recovery day: only patterns tagged `recovery` (Zone 2, mobility, breathing) and no loaded patterns.
- **`load_progression`:** the same exercises, with a load or rep increase inside `top_set_jump_max`.
- **`block_session`:** a new day on an empty date (no day before, or `found: false`) whose exercises all match the current block week's template slots (by exerciseId, then normalized name, as for `new_exercise`), with sets per exercise not above the slot's prescription for that week. It is small, so the Sunday run applies a template week without asking. The coach still follows the limits and the method on it. An exercise outside the slots makes the change `new_exercise` (big). A change that no small kind describes is big.
- **`override_user_day`:** the snapshot day has `source != "mcp"` or `userModified: true`, and the tool would change it.
- **`skip_or_delete_user_day`:** a skip or delete of such a day.
- **Several kinds:** the change is big when any kind is in `coach.yaml approval.ask`.

## 7. Guard

Removed in 0.2: no hook validates a plan write. `.claude/hooks/guard-writes.ts` stays as an entry that allows every call (a running v0.1 session still calls it until it restarts; v0.3 deletes it).

## 8. Volume and progression (`engine/volume.ts`, `engine/progression.ts`)

```ts
weeklySetsByMuscle(week: WeekPlan | WeekLog, tax, clusters = []): Record<string, number>   // counted sets (§8a); warm-ups excluded when marked
referenceWeek(block: Block, logs: WeekLog[], today: string): WeekLog | null      // the last completed build week (not deload, not test)
nextWeekTargets(block: Block, ref: WeekLog | null, rules: Rules): Targets        // the block step, capped
```

- **Weeks** run Monday to Sunday in the athlete's timezone.
- **"Completed"** means at least 50% of the planned sessions were logged. A missed week keeps the previous reference.
- **Bootstrap:** with no completed build week, the reference is block week 1 as planned.
- **Deload:** `deload_depth` scales both volume and load. The week after a deload may return to the pre-deload reference, plus at most one regular step.
- **Counting (0.2.4):** every volume count is in counted sets (§8a): the reference week, `targets`, `weeks` (`sets_by_muscle` per week), `volume`, `limits check` cap totals and `block draft`.
- **Clusters in `targets`:** a block slot whose `exercise` matches a `clusters` entry on its date in the target week is a cluster slot (`mini_sets`; a deload week `max(1, round(mini_sets × deload_depth.volume))`). `targets` adds `clusters: [{day, exercise, mini_sets, reps, rm, counted, muscles}]`, `straight` (each target minus the clusters' counted sets, never below 0: what the straight exercises get) and `cluster_above_target: [{muscle, target, cluster_sets}]` (advisory: a cluster alone above a target stays as prescribed).

## 8a. Cluster sets (0.2.4, `engine/clusters.ts`)

A cluster is one block of short mini-sets with a short rest between them (for example 6 mini-sets of 6 reps at a 12-rep-max load, 10 s apart). Policy [NA-DES-010]; an estimate with no standard source.

- **The record.** `coach.yaml clusters` (§1) is the only record of which exercises are clusters. Week files, plans CSV rows and Tally days carry no style. A block slot's `style`, `rm` and `rest_s` are a copy for the reader; recognition never reads them. An athlete who trains one exercise straight on some days and as a cluster on others uses two exercise names.
- **Recognition** (`clusterOf(exercise, date, list)`, one helper for every site). A list entry matches when both have an `exerciseId` and they are equal, else when the normalized names are equal. A matched exercise is a cluster on or after `since` (always without it) and straight sets before it; the name rule does not apply to it. With no matching entry, a name with the whole word "cluster" (any case) is a cluster with `rm` = 2 × its largest work mini-set. Otherwise straight sets. Each occurrence is resolved with its own date: each drafted day, each planned day read back from Tally or a CSV, each logged session. An entry with no date (the legacy `loads` input `{exercises, history}` without `date`) uses today in the athlete's timezone (coach.yaml, else the system's).
- **The list for a command.** The input's `clusters` when it has the key, else `coach.yaml`'s, else none (`loadClusters`). `coach.yaml` stays optional. `block draft --out` copies a list that came in its input into each week file (`{week, clusters}`), so the commands that read the week file count it before `coach.yaml` exists.
- **Counted sets** measure training volume. Work mini-sets are the non-warm-up sets; reps count when they are a whole number of 1 or more. No work mini-sets → 0; work mini-sets but no reps → their number; else `max(1, round(total reps ÷ rm))`, rounded half up (`rm`: the list entry's, else 2 × the largest work mini-set). 6 × 6 at 12RM = 3; 6,6,6,6,6,5 at 12RM = 3; 6,6,0 at 12RM = 1. Straight sets count each hard set.
- **Physical sets** describe the work: each mini-set. `adjust` (`trimDay` drops mini-sets; `estimateMinutes`), the deload's mini-sets, `classify` (`block_session` against the slot's `sets`, the extra-work check), `readiness --date` (completed sets), `loggedSessions`, `tally-days` `suggestedSets` and the plans CSV `sets` column use physical sets.
- **`volume --input <week>`** adds `clusters: [{date, exercise, mini_sets, reps, rm, counted, text}]` (`text`: "6 × 6 cluster, counts as 3 sets", for the audit) and `session_max: [{date, exercise, sets, max, rule_id, text}]`: straight exercises above the pack's per-exercise session maximum in one session (advisory, §22.6 rule 3a; an exercise is limited by its drafted `adaptation`, else when it trains a muscle). Each key appears only when it has entries. `weeks` adds `sets_by_muscle` (counted) to each week.
- **Warm-ups.** `snapshot.ts` (history sessions), the history file of `loads --fill --history` and `weeks` keep `warmup: true` where the source has it (an export: Strong "Set Order" W, Hevy `set_type` warmup). Tally history has no warm-up marker (workout-api `lib/mcp`), so a Tally session's sets are all work sets.

## 9. Snapshot, operations and logs

**`athlete/.cache/snapshot.json`** (written only by the `capture-reads` hook; a cache the reporting tools read):

```json
{ "version": 1, "session_id": "…", "captured_at": "…", "timezone": "…",
  "days": { "2026-10-12": { "version": "…", "updatedAt": "…", "source": "mcp", "userModified": false, "skipped": false,
                             "dayName": "…", "dayType": "…", "notes": "…", "exercises": [ … ], "captured_at": "…" } },
  "history": [ { "date": "…", "name": "…", "notes": "…", "id": "…", "startedAt": "…", "server": "…",
                 "exercises": [ { "exerciseId": "…", "name": "…", "muscle": "…", "notes": "…", "sets": [ { "weight": 0, "reps": 0, "rpe": null } ] } ] } ],
  "server": "…", "profile": { … } }
```

- The **`capture-reads`** PostToolUse hook matches Tally reads (`get_planned_workout`, `get_training_context`, `get_workout_history`). Its `tool_response` is an array of `{type: "text", text}` blocks, and the text is the tool's JSON (local and cloud). It parses each response and merges it into the snapshot.
- After every write, the same hook (on mutations) updates the written days from the write response.
- **0.2.2:** the history keeps each session's `notes` and each exercise's `notes` (the note scan reads them), plus `id` and `startedAt` when Tally returns them. A history page merges by session identity: the `id`, else date, name and start time; a page never removes another page's session on the same date, and a repeated page changes nothing. `server` (on the snapshot and on each session) is the part of the tool name between `mcp__` and the tool. The snapshot belongs to one server (V4b): a read from a server other than the snapshot's `server` starts a new snapshot, so the last server read wins (no inference from names; a cloud routine's connector name differs from the local one). A 0.2.1 session (no `id`, `startedAt` or `server`) on a new page's date is replaced by the page. `node engine/cli.ts snapshot reset` deletes the cache (setup runs it after the Tally account question); `safety scan-notes` prints `server` (one name, a list when the cache is mixed, or null) and `sessions` (the sessions scanned).
- **Operation ID:** `op-<date>-<kind>-<sha256(canonical tool call)[0..12]>` (`engine/opid.ts opId`, `toolCallHash`). It is passed as Tally's `opId`.
- **`log-writes`** (v0.2) appends one entry per logger write. The kind is the one in the submitted `opId`, else `unclassified`; `approval` names who made the write: "the coach, in a live session" or "the coach, in an unattended run". It no longer reads guard verdicts.
- **`athlete/log/YYYY-MM.md`:** one entry per operation:

```
## 2026-10-12 07:07 · op-2026-10-12-trim_session-3fa1c2d9e0b4
- trigger: daily run (cloud) | user
- readiness: wearable amber (HRV z -1.3), subjective amber (2.3), performance green → trim
- rules: NA-REC-009, NA-PROG-001
- change: Lower A, 5 → 4 sets on squat pattern lifts
- approval: the coach, in an unattended run
- result: written (version …)
```

## 9a. History windows and parallel capture (V7)

`engine/history-windows.ts`, `engine/snapshot-lock.ts`, `engine/coverage.ts`.

- **The lock.** Parallel Tally reads run one `capture-reads` hook each, and each hook loads, merges and saves `snapshot.json`. The hook holds `athlete/.cache/snapshot.lock` for the load-merge-save. The lock record (`<pid> <token> <time>`) is published whole (written to a private file and hard-linked into place). A waiter retries every 5 to 15 ms for up to 5 s (the hook timeout is 10 s). A lock whose owner process is gone, or that is older than 30 s, is broken under a second lock (`.break`) and only while it still holds the record that was judged stale; a record that does not parse is judged by its age only. A timeout exits 2 (the read is not saved) and appends `{at, session_id, tool, date|since|until|cursor, reason}` to `athlete/.cache/capture-failures.jsonl`; the coverage functions count it as failed until that same read is captured again (a day captured after it; a window's first page after it; a page with that cursor after it). Older consumers (`safety scan-notes`, `loads`, `adjust`, `readiness`) keep reading `snapshot.json` directly and see every read.
- **A window** is a `get_workout_history` read with an inclusive `since`/`until`, key `<since>..<until>` (an absent bound is open). State in `snapshot.history_windows[key]`: `{since, until, generation, pages: [{cursor, next, captured_at, suspect?}], complete, failed?, superseded_cursors?}`.
  - A first page (no `cursor`) starts a new generation: the window's sessions of older generations leave the history unless another window's page holds them. A refresh to empty empties the window.
  - A later page counts only when its `cursor` is the `nextCursor` of a page in the same window's current chain (with `since`/`until` in the read: that window only; a cursor-only read: the one window whose chain returned it; else it is an **orphan**: it counts for nothing, its sessions are not kept, `history_orphans` counts it). A page read again replaces the chain from that point: the sessions of the replaced and cut pages leave unless another page holds them (each session carries one tag per page, `<key>#<generation>#<index>`).
  - **Generations are bound to requests** (V7b). Tally's requests cannot carry a generation, but every tool use belongs to one assistant message, and Claude Code runs a message's tool calls and their hooks before the next model call. The hook reads the message id of each history request from the transcript (`transcript_path`, `tool_use_id`; `engine/transcript.ts`, the last 8 MB). A first page keeps the previous generation's open tail cursor with its own message (`superseded: [{cursor, batch}]`) for the whole generation. A page that brings that cursor from the refresh's own message was sent before this generation existed: it is dropped (an orphan), in either arrival order. From a known later message it is this generation's. From an unknown message it is kept as data and marked `suspect`. V7d: so is any continuation whose own message the hook could not find (`batch: null`), first generation included. A new first page after an ambiguous chain is a restart; one is allowed for the session: a chain that is ambiguous again after it is `failed`, given up (unknown), with nothing more to read, for every consumer of the chain coverage (the note scan, `loads`, readiness). V7c: a refresh's message that was not in the transcript yet is looked up again (`tool_use_id`) when a page with its cursor arrives. A chain with a suspect page or a failed later page is `ambiguous`: it is incomplete until a new first page restarts it (`need` names the first page, never another cursor read). A failed response keeps the window's generation, pages, `superseded` and overflow flag; a failed page sent with the refresh is the old read and changes nothing.
  - **Complete:** the chain ended with no `nextCursor`, no page is suspect, and the chain has at most 10 pages. More than 10 pages (a last page included; the failure stays until a new first page, a replay of an earlier page does not clear it), an error, a malformed page or a saved-file notice (a page too large for the hook, V4 F5: "Error: result … exceeds maximum allowed tokens. Output has been saved to …") is **failed**.
  - Sessions merge by identity (`sessionKey`: the id, else date, name and start time), so a session that two windows return counts once.
- **Coverage** of a range (`historyCoverage`): `complete` when complete windows whose every page is under 15 minutes old cover every date; else `failed` (a failed window over a gap), `stale` (an old page), or `missing`, with the `gaps` and `need`: the next page of a window with a page left (its own `since`, `until`, `limit: 10`, `cursor`), the suspect page's cursor, two half windows for a saved-file notice, the window again when failed or stale, the planned windows over a date no window names. A snapshot from another session is missing. A snapshot with no windows (the files logger, or a cache from before V7) falls back to `history_coverage`.
- **`history_coverage`** stays for the older consumers (`readiness --date`, `weeks`): the union of the complete windows fresh at the last merge that reaches furthest forward, with its oldest page's time; with no complete window, incomplete (with the reason when the latest read failed).
- **Atomic windows: the daily run** (V7c, `atomicCoverage`). The `today` skill reads history only as atomic windows: one request and one response each, never a continuation page. Windows are 7 days (`ATOMIC_WINDOW_DAYS`), tiling 8 weeks before today to today (8 windows; the oldest takes the 1-day remainder). A window holds at most 9 sessions at up to 9 sessions a week, so one page of 10 holds it; at 2 sessions every day a week splits once (4 and 3 days: 8 and 6 sessions). Measured with the eval fixture (4 sessions a week, about 815 characters a session): the 8 responses are about 26,500 characters (about 6,600 tokens), 400 characters more than 2-week windows; one full page of 10 is about 8,200 characters, far under the 50,000-character limit at which Claude Code saves a result to a file. A response with a `nextCursor` is never continued: the window is `split` (`coverage.history.split`) and `need` names its two halves by date; a split repeats down to one day, and one day that still has a `nextCursor` is `failed` (safety unknown, nothing more to read). A window's newest response replaces the older one (a first page is a new generation), and the halves of a split window replace it only inside their own ranges, and only when their own response has no `nextCursor` (V7d): outside the ranges whole halves cover, the split window's sessions stay as data (not coverage), so a note there, an urgent one included, is still scanned when a sibling half fails; the split window goes once whole halves cover all its dates. **Trade-off, documented:** a trainer who trains twice a day every day has 14 sessions a week, so each 7-day window splits once (2 more calls in the read round); 7 days stays the size because most weeks need no split. Coverage: windows whose single response has no `nextCursor`, not failed, under 15 minutes old, tile every date; otherwise `failed` (an error, or a one-day split), `stale`, or `missing` (a split waiting for its halves, or dates no window names). Post asks each read once more at most (`asked`), then it is in `gave_up`. The daily run does not need the request binding below; it stays for the cursor chain.
- **The read plan** (`planWindows`): 2-week windows that tile 8 weeks before today to today, newest first (10-day windows with 5 sessions a week), each `limit: 10`; a remainder shorter than half a window joins the oldest window. The page size stays `limit: 10` (V4 F5, `docs/build/reports/V4-setup-polish.md` "The hook finding (F5)": a page of 20 reached the hook as the saved-file notice, not as data); a larger page only after a probe through the real hook on the real Claude Code version proves it. The old single chain (one `since`/`until`, then cursor-only pages) still works: it is one window.
- **The history range, by consumer** (the read stays 8 weeks):

| Consumer | Needs | Why |
|---|---|---|
| `safety scan-notes` | 3 days to today | the notes the urgent and pain scan reads |
| `readiness --date` | sessions within `perf_expiry_days` (4), and for a session with no plan, 28 days before it | each judged session; the last time each exercise was done (V6 L) |
| `loads` | every outcome it reads (the last top set and the one before, per exercise) | the step, the repeat and the miss rule; coverage checked over 8 weeks |
| the coach's own load | 4 weeks | the weights logged in the last 4 weeks (CLAUDE.md rule 3) |
| `classify` | 8 weeks | whether an exercise is new (`NEW_EXERCISE_WEEKS`) |
| the long pattern | wearable signal files | not Tally |

- **The note scan and `loads` report coverage** (V7): `safety scan-notes` adds `coverage: complete | incomplete`, `coverage_detail` (status, reason, `need`) and `urgent_unknown` (incomplete coverage and no urgent term: it cannot say "no urgent sign"); a match still sets the stop. With `--input`, a bare list is scanned but its coverage is unknown; `{history, complete: true}` is complete. `loads` adds `coverage` (8 weeks to the planned date) when it read the history from the cache, from the same snapshot read as its data; from `--from-snapshot`, an incomplete history holds every load (`held_suggestion` keeps the engine's number).

## 10. The urgent stop

Rule 1 of v0.2. Urgent warning signs (the `urgent` list of `engine/safety-terms.yaml`: chest pain, fainting, new numbness or weakness, severe shortness of breath, a sudden severe headache, …) stop all training changes. The athlete cannot override it. It clears only on the athlete's answer in a live session.

- **The file:** `athlete/.urgent-stop` = `{version: 1, at, terms: string[], sources: ("chat"|"checkin"|"note"|"answer"|"legacy")[]}`. Term names, sources and the time only, never the athlete's words. A new event extends it (union). A file that cannot be read still stops (`terms: ["unreadable stop file"]`). It is committed and pushed, so a cloud run sees it.
- **Trigger routes** (`engine/urgent.ts`):
  1. **A chat message:** `safety-detect` (UserPromptSubmit) runs `detect` and acts on urgent terms only (negations ignored: a false alarm is cheap). It writes the stop, commits it in an athlete copy (`coach.yaml` present; `git add` then `git commit --only` of that path), and adds an "URGENT STOP" context: give `URGENT_CARE_TEXT`, make no training change, push now with `node engine/cli.ts push`. Ordinary pain words make it do nothing (the coach notices pain without a word list).
  2. **A check-in:** `node engine/cli.ts checkin … --urgent <term>,…` (`adapters/signals/checkin/write.ts`). The terms must be urgent term names. The writer writes and commits the stop first, before the date check and before the signal file is read, so a damaged or invalid signal file cannot prevent it; the CLI pushes it, also when the check-in itself then fails.
  3. **A note:** `node engine/cli.ts safety scan-notes --since <date>` (`scanSessionNotes`, run by the `today` and `week` skills) writes, commits and pushes the stop for an urgent term in a note dated after the latest clearance of that term. Pain notes are reported in `matches` only. `--dry-run` writes nothing.
  4. **Anything else the coach recognizes** (an answer, a file): `node engine/cli.ts urgent set --term <name> --source chat|checkin|note|answer`. `<name>` is an urgent term name or `other urgent sign`. It writes, commits and pushes.
- **Persistence on every call:** `urgent set`, the check-in route and `urgent clear` reconcile the commit and the push each time, not only when the content changed (`persist`): an uncommitted change to the stop (or the clearance record) is committed, and a commit not yet on the upstream (`unpushed`) is pushed. A failed push is retried by the next call. `safety-detect` and the legacy conversion commit on every call (they do not push).
- **The gate:** `.claude/hooks/urgent-gate.ts` (PreToolUse, built-ins only, `"onFailure": "block"`, timeout 10). Matcher (`.claude/hooks/urgent-list.ts URGENT_GATE_MATCHER`): `^(mcp__.+__(plan_workout_day|plan_workout_range|update_planned_workout|move_planned_workout|skip_planned_workout|delete_planned_workout|update_user_profile|update_training_limits)|Edit|Write|MultiEdit)$`. While the stop file exists it denies every such MCP call, whatever the server's name, and every Edit, Write or MultiEdit whose `file_path` is under `plans/`: the file's lexical and real path are compared with the lexical and real path of `<root>/plans`, so a `plans` symlink to an outside folder, another alias to that folder and a symlinked root count; a file not yet written resolves through its deepest existing ancestor; case is ignored. A file tool with no path is denied (fail closed). Without the file it allows everything at once. With `logger: other`, the gate cannot know the tool names: the context message and the skill text carry the stop there.
- **Clear:** `node engine/cli.ts urgent clear --reason clinician|false-alarm`, after the `safety` skill's question ("A clinician has seen me about it", "It was a false alarm", "Not yet"). It refuses in an unattended run (`UNATTENDED`) and without one of the two reasons (`USAGE`). It appends `{date, at, terms, sources, reason}` to `athlete/log/urgent-clearances.jsonl` (`date` in the athlete's timezone; no symptom text), deletes the stop, commits both paths and pushes. Nothing to clear: `{cleared: false}`, no record.
- **The clearance skip:** the note scan drops an urgent term in a note dated on or before the latest clearance of the same term (`clearedThrough`). A new note after it stops again.
- **`urgent status`:** `{ok, stopped, stop, clearances}` (the last three records).
- **Removed in 0.2:** `athlete/.safety-pending`, `athlete/hold.yaml`, `engine/hold.ts` and the `hold` command (a limit does the job of a regional hold; a systemic symptom is the coach's call).
- **Term list:** `engine/safety-terms.yaml`, with `urgent` and `pain` lists and region words. `safety detect --text` prints the matcher's result and writes nothing.

## 10a. Privacy

Rule 2 of v0.2. Athlete data never goes to a public repository.

- **`git-hooks/pre-push`:** refuses a push when the destination's visibility cannot be checked, or when it is public and any pushed commit touches athlete data: `athlete/`, `plans/` or `coach.yaml` (`engine/prepush.ts isAthleteData`, V3b) (§20 items 14 and 22).
- **`node engine/cli.ts install-git-hooks`** (`engine/cli-git.ts installGitHooks`): copies the hook into git's hooks folder; a different existing hook is kept as a backup.
- **`node engine/cli.ts prepush-check [--remote origin]`** and **`node engine/cli.ts push [--branch <name>]`**: §23 "Hooks in fresh clones". `push` is the trusted push of every skill and of `urgent set` (`pushBranch`).
- **`session-context`** installs the pre-push hook when it is missing, differs or is not executable (a fresh clone has none), in an athlete copy (`coach.yaml` present), and says so in one line. The hooks path is resolved from `git rev-parse --git-path hooks/pre-push` (absolute in a linked worktree or with an absolute `core.hooksPath`).
- **Setup** checks that the repository is private before the first push.
- Nothing else: the coach is trusted with other git and shell use.

## 11. Signals

**The Shortcut file `athlete/signals/YYYY-MM-DD.json`:**

```json
{ "version": 1, "date": "2026-10-10", "source": "apple-health-shortcut", "submitted_at": "2026-10-10T06:41:12-07:00",
  "sleep": { "start_at": "…", "end_at": "…", "duration_min": 412 },
  "hrv": { "value_ms": 41.8, "method": "sdnn", "samples": 6 },
  "rhr": { "bpm": 54 },
  "checkin": { "sleep_quality": 3, "energy": 4, "soreness": 2, "stress": 3, "pain": [ { "region": "left-knee", "score": 2 } ] } }
```

- **Schema:** `adapters/signals/apple-health-shortcut/schema.json`. Every block after `submitted_at` is optional. `source` is `apple-health-shortcut` or `chat`. The `checkin` block may carry its own `source` and `submitted_at` (a chat check-in merged into a Shortcut file). The `checkin` block (V6): an optional rating group (`overall` 1-5, or the four scales together), optional `want_to_train`, optional `pain` (an empty list records "no pain now"), and at least one of them; the group rules are checked in code (`engine/checkin-shape.ts`). The Shortcut keeps sending the four scales; a chat check-in usually sends `overall`.
- **Normalizer:** `adapters/signals/apple-health-shortcut/normalize.ts`. It validates and maps the file to `DayRecord[]`: `observed_at` = `sleep.end_at` (else `submitted_at`), and `complete` only when sleep is present (a check-in-only record is `complete: false`). HRV method `sdnn` unless the file says `rmssd`. An optional `temperature: { deviation_c: number }` block stays on the file's source record, including when it is the only block. Its value must be from -5 to 5 °C; it is shown, not scored. A check-in whose source differs from the file's becomes its own record, so sources stay separate. The record with the check-in carries `checkin_at` (the check-in's `submitted_at`, else the file's). An empty pain list is kept. A future instant is rejected.
- **Chat check-in:** `adapters/signals/checkin/write.ts` (CLI `checkin --date <d> [--overall 1-5 | --sleep-quality 1-5 --energy 1-5 --soreness 1-5 --stress 1-5] [--want-to-train 1-5|none] [--pain region:score,...|none] [--urgent <term>,...]`) writes the `checkin` block with `source: "chat"`; it creates the file or merges into it. The command needs at least one of `--overall`, the four scales, `--want-to-train`, `--pain` or `--urgent`; `--overall` with the four scales, or only some of the four, is a usage error. The merge is by group (V6), in the writer only: a new rating replaces the old rating group (`overall` replaces the four scales and the other way round); a new `want_to_train` or `pain` replaces the old value; `none` clears it (`--pain none` stores `pain: []`; `--want-to-train none` removes `want_to_train`); a group the answer leaves out stays. The block's `source` and `submitted_at` become the new answer's, and `replaced` names the earlier answer. A clear that leaves no field removes the block (the file and its wearable data stay). A clear with no earlier answer today writes nothing (`action: "unchanged"`, with a `note`). `--urgent` alone writes and commits the stop and changes no signal file. Readiness and the loader never merge records: one check-in block per daily file, and one record per source and date.
- **Loader:** `engine/signals.ts` (CLI `signals --from --to`) reads `athlete/signals/*.json` and `athlete/.cache/signals/*.json`, one record per source and date (complete first, then the latest `observed_at`), and reports bad files, and cached records that fail the `DayRecord` shape (including `null` blocks), as per-file or per-record warnings.
- **Oura:** `adapters/signals/oura/fetch.ts --days N` merges into `athlete/.cache/signals/oura.json` as `DayRecord[]` (method `rmssd`). It also reads `temperature_deviation` from `daily_readiness` into `temperature.deviation_c`, including readiness-only records. This is the night's deviation from the athlete's own Oura baseline in °C; shown, not scored. Finite values from -5 to 5 are kept. Missing, null or non-number values are omitted without a warning; a finite value outside the range is dropped with one warning and the rest of the record stays. No new endpoint or OAuth scope is needed. Client ID, secret and tokens are in the macOS Keychain (service `coach-harness.oura`; accounts `client_id`, `client_secret`, `tokens`), changed under a lock file in `~/.config/coach-harness/`. The new refresh token is saved and read back before the access token is used. A refresh response without a new refresh token is an error (sign in again); the old token is never reused. The sign-in is per Mac, so it serves every coach copy on it. On failure the fetch prints `{error: {code, message}, sign_in_needed}`; `sign_in_needed` is true only for the sign-in codes `OURA_NOT_AUTHORIZED`, `OURA_REAUTH`, `OURA_UNAUTHORIZED` and `OURA_TOKEN_STORE` (`SIGN_IN_ERROR_CODES`, V6). The `recovery-data` skill runs the fetch first and shows the sign-in command only then. The lock records pid and process start time; a live owner's lock is never broken. OAuth uses PKCE (S256); the callback listens on 127.0.0.1:8723 only, with the redirect URI `http://localhost:8723/callback`. Errors never carry provider or transport text: fixed messages plus allowlisted OAuth error codes. Every request has a timeout.

## 12. Logger adapter (`adapters/loggers/<name>/`)

- **`adapter.yaml`:** `name`, the tool map (`tools.reads`, `tools.mutations`, and `tools.limits.update: update_training_limits`, which v0.2 never calls but still logs and gates), the `log-writes` matcher regex (`matcher`), the `capture-reads` matcher (`capture_matcher`), and capabilities: `rangeCreateIfAbsent`, `versionedSkipDelete`, `opId` (all `true` for Tally since T2) and `protectsUserDays`. Removed in 0.2: `capabilities.server_limits`.
- **`day.ts`** (Tally): the tool name lists (`MUTATIONS`, `READS`), Tally's weight conversion (`convertWeight`) and `toDayPlan(date, snapshotDay, fallbackUnit)`, a snapshot day as an engine `DayPlan`.
- **`engine/logger.ts`:** `loadAdapterConfig(name)` and `validateAdapterConfig`. Removed in 0.2: `rebuild.ts`, `loadLogger`, `affectedDates` and the golden parity tests (they existed for the guard). The golden JSON files in `evals/golden/` stay as data for the mock server.
- The urgent gate's mutation list (`.claude/hooks/urgent-list.ts PLAN_MUTATIONS`) equals the adapter's mutations; a test keeps them equal.

## 12a. Where plans live: `logger: tally | files | other` (0.2)

Tally is optional. `coach.yaml logger` says where plans live, and every skill that reads or writes plans follows it (`CLAUDE.md` "Where plans live" maps each job).

- **`tally`:** the Tally MCP tools, as in §12. Setup uses Tally without a question when a Tally server answers.
- **`files`:** one CSV per ISO week, `plans/<YYYY>-W<ww>.csv` (`engine/plans-files.ts`). Columns, in order: `date, day, exercise, sets, reps, load, unit, notes, done_sets, done_reps, done_load, felt`. One row per exercise per date. `day` is the session name; `notes` on a day's first row is the day's note; `reps` is a number, a range (`8-10`, the bottom counts as the target) or a duration (`40min`, `600s`); `load` is the top working set (empty for bodyweight; `unit` then empty). The athlete fills the `done_` columns in any spreadsheet app, or the coach does from a chat report: `done_reps` and `done_load` take one value for every set or one per set (`5,5,4`, also `/`, `;` or spaces); `felt` is text, or an RPE (`8`, `RPE 8`). The reader accepts a BOM, CRLF and quoted fields, and keeps a column the athlete added on every write, in the file's own column order. **Nothing is lost** (V2b fix 1): a row without a `YYYY-MM-DD` date (a spreadsheet date such as `10/12/2026`) or without an exercise is kept by column name, and a line whose quote never closes is kept verbatim (reading goes on at the next line); both are reported in `warnings`, written back on every write, and scanned by `safety scan-notes` (dated their week's Monday). **Counts** (fix 3): a `sets` or `done_sets` cell is a whole number from 0 to 20 and a reps value one from 0 to 100, else it is unknown (no sets, no `suggestedSets`) with a warning; the raw cell stays in the file. **Units** (fix 2): every row keeps its own unit; the snapshot converts each row's load to `athlete.units` (Tally's rounding), and a replan of a logged exercise keeps the logged unit and converts the new plan load to it.
  - `plans write --input <file.json>`: the days in `{days}`, `{week: {days}}`, `{day}`, `{tally_day}` (adjust's output) or one `{date, exercises}`; exercises in the engine shape (`sets`; warm-ups are not plan sets) or Tally's (`suggestedSets`, `suggestedReps`, `repsMax`, `suggestedWeight`, `suggestedDuration`). Each given date is replaced; other dates stay. A row with any done value keeps its done columns and added columns when the new plan has the same exercise (name compared without case or punctuation) on that date; a logged row the new plan drops is kept and listed in `dropped_done`. Prints `{files, dates, rows, kept_done, dropped_done}`. Atomic (temp file and rename).
  - `plans read --week <YYYY-MM-DD | YYYY-Www>`: `{file, exists, week, week_start, days (DayPlans), logged (DayLogs), unplanned_logged, warnings}`. A row is planned when its `sets`, `reps` or `load` has a value (`hasPlanColumns`, V6b). A date with no planned row is not in `days`; when it has logged rows it is in `unplanned_logged` (a rest day with logged work), and the snapshot gives it `found: false`. Its logged rows stay in `logged`.
  - `plans done --date <d> (--as-planned | --exercise <name>) [--sets n] [--reps r] [--load x] [--felt <text>]`: fills the done columns. `--as-planned` copies the plan (a rep range: its top); with no `--exercise` it fills every row of the date not yet logged; an explicit value wins. `NOT_PLANNED` when the date has no such row. Prints `{file, updated, logged_sessions}`.
  - **The tools read the files** (`engine/coach-snapshot.ts coachSnapshot`): with `logger: files`, `readiness --date`, `weeks`, `loads --from-snapshot`, `adjust --from-snapshot`, `block draft` and `classify` read a snapshot built from `plans/` (`days`: every planned date in Tally's shape; `history`: the logged rows; `history_coverage.complete` false, with `warnings`, when a row or a count could not be read, else true; no session or age check), and `safety scan-notes` scans the `notes` and `felt` text.
  - **The urgent stop:** the urgent gate denies Edit and Write under `plans/` (§10). `plans write` and `plans done` run through Bash, which the gate does not see, so they refuse with `URGENT_STOP` while `athlete/.urgent-stop` exists (readable or not). `plans read` still works.
- **`other`:** a tool the athlete already uses (an MCP server they connected, for example Google Sheets or Notion). Skill text only, no adapter code: the coach uses that tool's own instructions. When it does not answer, the coach says so in one line and runs `logger set files` (V2b fix 4), so the engine reads the files from then on. With `other`, `coachSnapshot` returns no snapshot (a Tally cache left from earlier use is not the record): the tools report unknown unless the coach passes the evidence with `--input`; `adjust` and `loads --from-snapshot` refuse with `NO_SNAPSHOT`.
- **`logger set tally|files|other`** (`engine/cli-setup.ts setLogger`): writes `coach.yaml logger` (comments kept) and prints `{logger, previous, changed}`. The urgent gate cannot know its tool names: the context message and the skill text carry the stop there.
- **The Tally mention** (`tally-mention [--sessions <n>]`, `engine/cli-setup.ts`): with `files` or `other`, once, after the third session logged by hand or in chat (`files`: the dates with a logged row; `other`: `--sessions`, the count the coach read from the tool). It writes `tally_mentioned: true` into `coach.yaml` (comments kept) before it prints `{mention: true, text}`, so it never repeats; otherwise `{mention: false, reason}`. With `tally` it never mentions. The skills run it in live sessions only. The text: "If logging by hand gets old: Tally logs sets on your iPhone at the gym, and I read them back. Get it here: https://apps.apple.com/us/app/tally-workout-app/id6758911546. Say 'switch to Tally' to try it."
- `capture-reads` and `log-writes` match Tally tool names only, so they read the Tally adapter whatever `logger` says.
- **The today brief by logger** (V7, §22b): `tally` reads the snapshot (the reads pre names); `files` makes no reads and post reads `plans/` (no protection by `source`, the `[coach]` line, `logged_only`), and writes go through `plans write`; `other` passes that tool's notes history and today's day to post with `--input`, and `today-write-prep` returns `classify` and the limits only.

## 13. Skills, agents, hooks (files)

- **Skills:** `.claude/skills/{setup,today,check-in,log,safety,week,block,audit,limits,explain,method,update,recovery-data,automation,injury-history}/SKILL.md`. v0.2 setup asks five clickable screens to week 1 with Tally or with files (its "Screens" table; `tests/skills.test.ts` walks the scripted answer paths); recovery data, automation and injury history are their own skills, offered in one line at the end of setup. Each description is under 1,000 characters and names its trigger phrases. Every skill states its steps and writes, and runs `node engine/cli.ts <command>` for numbers.
- **Agents:** `.claude/agents/{analyst,method-expert}.md`. Removed in 0.2: the `safety` agent (the `safety` skill replaces it: subagents cannot show clickable questions).
- **Hooks** in `.claude/settings.json`: `session-context` (SessionStart), `safety-detect` (UserPromptSubmit, `onFailure: continue`), `urgent-gate` (PreToolUse, `onFailure: block`; the only gate), `capture-reads` and `log-writes` (PostToolUse; records), `commit-check` (Stop). Each one is a `.ts` file run with `node`, with a timeout of 10 s or less.
  - **`session-context`:** today's date; the urgent stop first (with the urgent-care text and the clear question); the v0.1 safety files (§24 "Migration to 0.2"); the limits summary; setup progress (the last line of `athlete/log/setup.md`); what is due and the block week; privacy (installs the pre-push hook when missing; tracked-file findings).
  - **`commit-check`** (built-ins only): the auto-commit. With `coach.yaml`, it reads `git status --porcelain -z` (NUL-delimited, renames included, so spaces and Unicode stay intact) and commits the changed paths among `athlete/`, `plans/` and `coach.yaml` (`git add`, then `git commit --only`, never other staged work) with the message "coach: update …", and says nothing. It never runs `git add` or `git commit` with an empty path list. A failed commit is one `systemMessage` line.
  - **`guard-writes.ts`, `guard-files.ts`:** v0.1 entries kept as allow-all stubs with no imports; not registered. v0.3 deletes them.
- **`permissions`** in `.claude/settings.json`: `deny` keeps `Edit` and `Write` of `athlete/.cache/**`. `allow` is a narrow list, so auto mode runs the coach's commands without a prompt (auto mode honors narrow allow rules and drops broad ones such as `Bash(node *)`): `Bash(node engine/cli.ts <sub>)` for `mode`, `window-check *`, `readiness *`, `signals *`, `checkin *`, `weeks *`, `targets *`, `block draft *`, `ids next *`, `adjust *`, `loads *`, `volume *`, `classify *`, `opid *`, `oplog done *`, `limits schema`, `limits regions`, `limits check *`, `safety scan-notes *`, `snapshot show`, `lint-methods *`, `config-check`, `urgent status`, `urgent set *`, `urgent clear --reason clinician`, `urgent clear --reason false-alarm`, `install-git-hooks`, `prepush-check`, `push`, `update --check`; v0.2 V2 adds `plans write *`, `plans read *`, `plans done *`, `setup-check`, `init-athlete`, `allow-server *`, `worktree status`, `worktree ff-main`, `worktree ff-branch`, `commit --message *`, `tally-mention`, `tally-mention *`, `push --branch main`, `update --check --root *`, `update --yes --to *` (the update skill asks the athlete once in chat), and in V2b `logger set *`, `worktree main-checkout`, `worktree remove-temp`, `history-files`, and in V3b `help` and `help *`, and in V7 `today-brief --stage pre`, `today-brief --stage post`, `today-brief --stage post *`, `today-write-prep --input *` and `save --run *` (§22b); plus `Bash(npm ci)`, `Bash(git -C * merge --ff-only *)`, `Bash(node adapters/signals/oura/fetch.ts *)`, `Bash(git pull --rebase)`, and `Edit` and `Write` of the coach's own files (`athlete/**`, `plans/**`, `coach.yaml`, `.tmp/coach/**`, each also with a leading `/`; the cache deny rules win), and `Read(~/Downloads/*.csv)`, `Read(~/Desktop/*.csv)` (a training export at setup). The Tally server's name varies, so setup writes `mcp__<server>` into `.claude/settings.local.json` (`allow-server`, §22a), a user file the update never touches. `tests/hooks/settings.test.ts` pins the list; `tests/skills.test.ts` checks that every engine command the skills run is covered (except the one-time `routine-body` and `install-launchd`).
- **`engine/cli.ts`:** subcommands `readiness`, `volume`, `limits-hash`, `limits schema|regions|check`, `oplog done`, `snapshot show`, `safety detect|scan-notes`, `classify`, `urgent set|clear|status`, `signals`, `checkin`, `install-git-hooks`, `prepush-check`, `push`, `update`, `config-check`, `plans write|read|done` (§12a), `setup-check`, `init-athlete`, `allow-server`, `worktree status|ff-main|ff-branch`, `commit`, `tally-mention`, `logger set`, `history-files` (§22a), `today-brief`, `today-write-prep`, `save` (§22b), and the §15 and §22 helpers. Removed in 0.2: `validate`, `hold …`, `proposals …`, `block write`, `limits server-rules|sync-ops`, `ids next --kind proposal`. Output is JSON on stdout. A nonzero exit means an error.

## 14. Automation facts (tested against Claude Code routines)

- **Routine creation:** `setup` creates routines with the RemoteTrigger tool, and **must** pass:
  - `mcp_connections` with the Tally connector only, because the default attaches every connector on the account;
  - `allowed_tools`;
  - a cron in the athlete's local time (UTC in the API; convert).
  - Cron: daily `7 5-10 * * *` (hourly, minimum interval 1 hour); weekly Sunday `7 17 * * 0`.
- **Finding the Tally connector:** each user's connector ID differs. `setup` creates the routine **disabled** (`enabled: false`), reads the `mcp_connections` the API returns (all connectors on the account), picks the one whose `url` is `https://mcp.tallyworkout.app/api/mcp`, then updates the routine with that connector only and `enabled: true`. With no Tally connector, setup stops and links the connect page. The create response lists every connector with `connector_uuid`, `name` and `url`.
- **Prompts dispatch explicitly:** "Read .claude/skills/today/SKILL.md and follow it exactly."
- **Pull requests and apply after merge:** removed in 0.2. A routine opens no pull request; a big change is one log line ("- proposal for the next live session: …"), and the next live session offers it (`today` step 3).
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
//            breathing), duration matched to the planned session length, never loading a limited region.
// engine/loads.ts
suggestLoads(exercises: PlannedExercise[], history: SessionHistory, rules: Rules, units: "lbs" | "kg", opts?: { tax?, strictUnits?, clusters?, date? }): { exerciseId: string; suggestedWeight?: number; reason: string; rule_ids: string[] }[]
//  from the last logged top set (warm-ups left out, 0.2.4): hit all reps at RPE <= target -> + one step (2.5% for
//  upper, 5% for lower, rounded to the unit's plate step: 5 lbs / 2.5 kg); missed reps -> repeat; missed twice -> -5%,
//  only when the last top set is at or above the one before (compared in the output unit, after conversion and
//  rounding); a miss at a lighter weight after a miss repeats that lighter weight ("missed at 55 after a miss at
//  60 lbs: repeat 55", V6). Never above top_set_jump_max.
//  A cluster on the planned date (§8a) is judged as one block: only logged sessions where it was a cluster on that
//  session's date count (none -> no suggestion). Work mini-sets: non-warm-up sets with a weight above 0 and reps;
//  W = the weight of the most work mini-sets (ties: the lighter). The planned total: the plan's work mini-set reps,
//  else mini_sets × reps from the list. Hit (every work mini-set at W, total reps >= the planned total, no RPE
//  above the target) -> one step up under top_set_jump_max (a repeat when no plate step fits); otherwise repeat W
//  ("cluster: 35 of 36 reps at 35 lbs on <date> -> repeat", "cluster: mixed weights on <date> -> repeat 35 lbs").
//  A cluster never gets the missed-twice drop.
// engine/opid.ts
opId(date: string, kind: ChangeKind | "apply" | "week", call: { tool: string; args: unknown }): string   // contracts §9 format
// engine/mode.ts
mode(): "interactive" | "unattended"   // CLAUDE_CODE_REMOTE or COACH_UNATTENDED -> unattended
// engine/proposals.ts: removed in 0.2 (a proposal is one line in the athlete log).
// engine/automation.ts
routineBody(kind: "daily" | "weekly", cfg: CoachConfig, repoUrl: string, connector: { uuid: string; name: string; url: string }): object
//  cron from cfg.automation in the athlete's timezone converted to UTC; mcp_connections = [Tally only] with
//  permitted_tools = the logger's tools; allowed_tools = Bash, Read, Write, Edit, Glob, Grep + the Tally tools;
//  prompt = explicit dispatch ("Read .claude/skills/<skill>/SKILL.md and follow it exactly. Unattended run.").
launchdPlist(kind, cfg, repoPath): string   // runs: env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN COACH_UNATTENDED=1 claude -p ...
```

**CLI commands** (`engine/cli.ts`; JSON on stdout):
- `mode`, `opid`, `adjust`, `loads`, `targets` (`nextWeekTargets`);
- `routine-body`, `launchd-plist`, `install-launchd` (writes to `~/Library/LaunchAgents` only with `--yes`);
- `signals`, `checkin`, `readiness`, `classify`, `urgent …`, `limits …`, `lint-methods`.

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

Removed in 0.2: no proposal files, branches or pull requests. A big change in an unattended run is one log line for the next live session, and the athlete's answer there is the approval.

## 18. Guard activation in the template repo

Removed in 0.2 (there is no guard). In the template repo (no `coach.yaml`), `safety-detect` writes no commit, `commit-check` does nothing, and `session-context` installs no git hook; the urgent gate still acts on an `athlete/.urgent-stop` file if one exists.

## 19. Schedule window and Mac launch

- **Cron covers both UTC offsets.** `routine-body` makes a daily and a weekly cron that fire under every UTC offset of the athlete's timezone in the current year. Los Angeles: daily `7 12-18 * * *`, weekly Sunday 17:07 as `7 0-1 * * 1`. No update is needed at a DST change.
- **`window-check --kind daily|weekly`** (`engine/automation.ts windowCheck`, CLI in `engine/cli-helpers.ts`): in an unattended run it exits 4 unless the local time is in the window. Daily: `daily_window.start` to `daily_window.end` + 30 min. Weekly: `weekly.day`, from `weekly.time` to `weekly.time` + 30 min. In an interactive run it exits 0.
- **The routine and launchd prompts run `window-check` first**, then dispatch the skill. The `today` and `week` skills also run it as their first step.
- **launchd:** `install-launchd` and `launchd-plist` resolve `command -v claude`, check that it is an executable file, and write the absolute path into `ProgramArguments` (its folder goes first on the plist `PATH`). No `claude` found means `CLAUDE_NOT_FOUND` and nothing is written. `--claude <path>` overrides.
- **Recovery days** match the planned duration to the second (no minimum or maximum), and leave out any exercise that a limit names by exercise or by pattern.
- **Load suggestions** are never above the last top set × (1 + `top_set_jump_max`). A cut that finds no lighter plate weight repeats the weight.

## 20. Decisions from building the guard

Most items described the v0.1 guard and are removed in 0.2; the rest still hold.

1. **Snapshot day shape (§9).** A day holds the logger's own exercise shape (for Tally: `suggestedSets`, `suggestedWeight`, …), not `sets[]`. The adapter's `toDayPlan` converts it. A day also has `found` (a read that found no day is stored with `found: false`), `weightUnit` and `weightUnitSource` (only when Tally knows the unit). The snapshot adds `planned` (the listing from `get_training_context`), `history_coverage` (item 18), `weightUnit` and `weightUnitSource`.
2. Removed in 0.2: the 15-minute read rule for each written date (a guard input).
3. Removed in 0.2: the whole-week evidence rule (a guard input).
4. Removed in 0.2: no block, no volume rise (the guard's volume check).
5. Removed in 0.2: the history read before a raised top set (a guard check).
6. Removed in 0.2: the extra `guard()` inputs.
7. **Kinds:** a change that no small kind describes is big (fail closed). A new day on an empty date is big unless it is a recovery day or a `block_session` (§6 ruling; item 24). A skip or delete of an MCP day is `trim_session`. Recovery exercises are never `new_exercise`. A move across weeks is big.
8. Removed in 0.2: limits on every after-day (the guard's limit check; `limits check` reports instead, §2).
9. **Unit rule:** an exercise's weight is in Tally's known unit; when Tally does not know it, in the call's `weightUnit`; else in `coach.yaml athlete.units`.
10. Removed in 0.2: `update_user_profile` under a hold.
11. Removed in 0.2: `guard-files`.
12. Removed in 0.2: approval provenance.
13. **Operation IDs** use `sha256(canonical JSON of {tool: <suffix>, args})` (`engine/opid.ts toolCallHash`). `log-writes` takes the kind from the submitted `opId` (v0.2; the verdict hand-off is removed).
14. **pre-push** looks up visibility with `gh api repos/<owner>/<repo>` (REST), because GraphQL (`gh repo view`) is blocked in Claude Code sessions. A non-GitHub URL is a failed lookup.
15. **Hooks honor `COACH_NOW`** (an instant) for tests. The hook process inherits the session's environment, which the model cannot change.

### Hardening

16. Removed in 0.2: approval needs remote evidence.
17. Removed in 0.2: Bash path operands and broad restores (`guard-files`).
18. **Responses are validated.** Every captured read is checked against Tally's result shape. An error or a malformed read never counts as evidence: it removes the day (`get_planned_workout`), the listing (`get_training_context`) or the history coverage (`get_workout_history`). `history_coverage` holds `captured_at`, `complete` (false while `nextCursor` remains; a later page completes the chain) and the requested `since`/`until`. The history is evidence only when it is complete, read in the last 15 minutes, starts no later than 8 weeks before today and ends no earlier than yesterday.
19. Removed in 0.2: fresh evidence for the whole week.
20. **The block is validated whole.** `engine/block.ts`: known keys only, `start` a Monday, unique week numbers, `kind` build|deload|test, and every count (`sessions`, `targets`, slot `sets`) a finite whole number of 0 or more (slot sets 1 or more). A bad block is `GUARD_ERROR` (deny), both from the file and as a `guard()` input.
21. Removed in 0.2: rebuild of hidden stored exercises.
22. **Pre-push inspects every commit reachable from a pushed SHA,** with no exclusions, because cached remote-tracking refs can belong to another repository than the push URL. Paths are read NUL-delimited (`git diff-tree -z`). A pushed SHA that cannot be listed denies the push.
23. Removed in 0.2: safer is always allowed under a hold.
24. **`block_session` (§6 ruling)** is implemented in `engine/classify.ts`: a new day on an empty date inside the block whose every exercise matches a block slot (exerciseId, then normalized name, then pattern for a slot that names no exercise) with hard sets not above the slot's sets (a deload week scales them by `deload_depth.volume`). It is in the default `approval.auto` of `coach.example.yaml`.
25. **`allow` binds to the exerciseId.** An `allow` entry that matches the exerciseId exempts the exercise. One that matches only the display name exempts it unless the exerciseId by itself classifies to a limited pattern; then the exercise is an identity conflict and is denied.
26. Removed in 0.2: `approvals.ts` and `proposals list`.

### Hook bootstrap

27. **Hooks work before `npm ci`.** Each hook entry file (the path `.claude/settings.json` runs) imports Node built-ins only: `.claude/hooks/bootstrap.ts`, and `.claude/hooks/urgent-list.ts` for the urgent gate. The engine code is in `<hook>.body.ts`, loaded with a dynamic `import()` (`urgent-gate` and `commit-check` need none). stdin is read once (`stdinText`). The root is `CLAUDE_PROJECT_DIR`, else the input's `cwd`.
    - **Never rename or delete an entry file that a running session may call.** The v0.1 entries `guard-writes.ts` and `guard-files.ts` stay as stubs that import nothing and allow everything (they ran with `onFailure: block`); v0.3 deletes them. A test checks that every command path in `settings.json` exists and that each entry, and both stubs, import built-ins only.
    - **Engine cannot load, no `coach.yaml`:** capture-reads, log-writes and commit-check exit 0 with no output. session-context says "coach-harness is not set up. Run `npm ci`, then say 'set me up'." safety-detect says the urgent detector could not run and writes nothing.
    - **Engine cannot load, `coach.yaml` present:** capture-reads and log-writes exit 2 with "coach-harness packages are missing. Run `npm ci`." session-context gives the reason as context. safety-detect asks the coach to check the message for urgent signs itself (and run `urgent set` for one). The urgent gate and commit-check run with built-ins and work as always.
    - **Compile cache.** `bootHook` turns on `module.enableCompileCache()` before it loads the body (about 40 ms less per engine load). `NODE_DISABLE_COMPILE_CACHE=1` turns it off.
    - **Latency floor.** `settings.json` runs `node <hook>.ts`; any `.ts` file costs about 35 ms more than a bare `node` start. `scripts/bench-hooks.mjs` prints that floor next to each hook.
28. Removed in 0.2: protected paths match without regard to case.

## 21. Server limits (Tally T3)

Removed in 0.2: the sync of `athlete/limits.yaml` to Tally (`engine/limits-compile.ts`, `engine/server-match.ts`, `engine/limits-sync.ts`, `limits server-rules|sync-ops`). A limit that only the Tally app can remove broke the one-click promise. Limits already in Tally stay until the athlete removes them in the app; the `limits` skill says so once. Still true:

- **Refusals:** a result with `status: refused, code: training_limit` reconciles to the status `refused` in the log, names the rule, and says it is not retried.
- **Tally T2 (safe writes):** `rangeCreateIfAbsent`, `versionedSkipDelete` and `opId` are `true`. Every `plan_workout_range` day carries `ifAbsent: true`; skip and delete carry `expectedVersion`; `opId` is accepted on every day mutation and left out of the call hash; a `replayed: true` result reconciles to `replayed` and asks for a re-read (`oplog.ts nextStep`).
- **`node engine/cli.ts oplog done --date <YYYY-MM-DD> --kind <kind>`** (`engine/oplog.ts opDone`): reads `athlete/log/*.md` and prints `{date, kind, done, status: done|not_done|uncertain, reason, reread, entries}`. Done only for a confirmed success.

## 22. Engine helpers for the skills

The skills never do arithmetic or reshape data. They run these commands. Every command prints JSON on stdout and takes `--root <dir>` (default: the current folder). Exit 2 is a usage error, exit 1 any other error (`{"error": {code, message}}`). `node engine/cli.ts <command> --help` prints `{command, usage}`: one usage line (`engine/cli-help.ts HELP`). `node engine/cli.ts --help` prints the general usage and every line. Each command imports its modules when it runs; the dispatch files import only `errors.ts` and `cli-help.ts` (tested). The `limits` and `oplog` commands (§21) and `proposals check-applied` load their modules the same way.

### 22.1 `hold init`

Removed in 0.2 (there is no hold file).

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

Removed in 0.2 (there are no proposal files).

### 22.4 `readiness --date <d>`

- **Purpose:** builds the §5 input from the files and prints the readiness. The model computes nothing.
- **Command:** `node engine/cli.ts readiness --date <YYYY-MM-DD> [--now <instant>]`. `readiness --input <file>` is unchanged. A date after today is a usage error.
- **Inputs it builds:**
  - `records`: `engine/signals.ts` from `date − (baseline_window_days + long pattern days + 1)` to `date`, in one read, so each morning of the long pattern has its own baseline.
  - `readiness_rules`: the pack's `single_day_action`, `off_mornings_short_pattern`, `off_mornings_long_pattern`, `program_change_min_categories` and `aversion_scale_max` checks, with their rule IDs.
  - `sleep_target_min`: `coach.yaml athlete.sleep_target_min`, an optional whole number of minutes from 240 to 720, default 480. Setup asks for it.
  - `thresholds`: `coach.yaml thresholds`. `session_change_min_categories` and `session_change_rule_ids`: the method pack.
  - `sessions`: each logged session in the snapshot history within `perf_expiry_days`, newest first, judged against **its own date's plan** (the snapshot day from `get_planned_workout`), never today's plan. `planned_sets`: the plan's sets. `completed_sets`: logged sets of planned exercises (a 0-rep set does not count), at most the plan per exercise. `reps_shortfall_ratio`: Σ max(0, target − reps) / Σ target, with the target at the bottom of the rep range. `rpe_drift`: the mean of logged RPE − planned RPE, absent when no set has both. `top_set_dropped`: the heaviest logged set is below the planned weight (converted when both units are known).
- **Unknown, never estimated:** a session whose date was not read (no `days[date]` in the snapshot) stops the list: performance is `unknown` with the reason, and an older session never stands in for it. **A session with no plan** (V6): a date that was read and has no planned day (`days[date].found: false`; with `logger: files`, a date whose rows have no planned columns) is judged against the athlete's own history (`judgeUnplanned`): for each exercise, the most recent earlier logged session of the same exercise within 28 days, in the same unit after conversion; when that session's sets give no top set, the exercise is not judged (an older session never stands in). `top_set_dropped` when the top set's weight is lower than last time, or the same weight with fewer reps; `rpe_drift` is the mean of the top-set RPE minus last time's top-set RPE (exercises with both); `planned_sets` and `completed_sets` are the logged work sets, and `reps_shortfall_ratio` is 0. Warm-ups are left out. An exercise with no earlier session is not judged; a session in which no exercise can be judged stays unknown ("session <date> not judged: no plan and no earlier session to compare") and stops the list. Missing measurements also stop it, with no `SessionPerf`: a planned exercise without a set count or a rep target, a logged set without reps, a planned weight with no logged weight, or a weight unit known on one side only. A timed exercise (a duration, no rep target) is not judged. The history read must be complete, read in the last 15 minutes, and cover `date − perf_expiry_days` to `date`; otherwise performance is `unknown` with the reason. So the skill reads `get_workout_history` and `get_planned_workout` for each logged date of the last `perf_expiry_days` days first.
- **Past dates:** the date is judged as of 23:59 local on that date.
- **Output:** the §5 `Readiness`, plus `inputs`: the full `ReadinessInput` used, `signals_warnings`, `sessions_judged: [{date, plan: found|missing|empty, perf?, notes}]` and `notes`, plus `pattern`.
- **`pattern`** (load progression is held only on a pattern, never on one red day): `{days (the date and the 2 days before it, oldest first), states: {wearable, subjective, performance} (each day's state, each earlier day judged as of its own end), red_days: {wearable, subjective, performance}, hold_progression, reason}`. `hold_progression` is true when wearable or subjective is red on at least 2 of the 3 days, or performance is red on the date. Performance counts for the date only, because one logged session stays in the window for several days. A day with no evidence is `unknown`, never red. The `today` skill runs its loads step only when `hold_progression` is false.
- **Example** (abridged; 35 nights of 480 min, then 400 min; no check-in; yesterday's plan 2 × 3 done as planned): `node engine/cli.ts readiness --date 2026-10-14` → `{"date": "2026-10-14", "wearable": {"state": "amber", "reasons": ["sleep 400 min = 83% of target: amber"], …}, "subjective": {"state": "unknown", …}, "performance": {"state": "green", "reasons": ["session 2026-10-13 on plan"], "sessions_used": ["2026-10-13"]}, "known": 2, "decision": "note", "decision_reasons": ["wearable off today, with 0 off-mornings in a row: one day is not a pattern"], "hold_progression": false, "aversion": false, "deload_signal": false, "pattern": {"off_mornings": {"hrv": 0, "rhr": 0, "either": 0}, "days_of_decline": 0, "short": false, "long": false, …}, "rule_ids": ["NA-REC-008"], "pain": [], "inputs": {"sleep_target_min": 480, "sessions": [{"date": "2026-10-13", "planned_sets": 2, "completed_sets": 2, "reps_shortfall_ratio": 0, "rpe_drift": 0, "top_set_dropped": false}], "readiness_rules": {"short_pattern": {"mornings": 3, "ids": ["NA-REC-009"]}, …}, …}}`.

### 22.5 `weeks --from <d> --to <d> [--input <file.json>]`

- **Clusters (0.2.4):** each week has `sets_by_muscle` in counted sets (§8a). The list comes from `--input` (`{clusters}`) when given, else from `coach.yaml`.

- **Purpose:** the snapshot history as Monday-to-Sunday `WeekLog` entries, ready for `targets` (`{block, logs, today, target_week}`).
- **Rules:** every week from the week of `from` to the week of `to`, empty weeks included (a missed week). Dates go into week buckets in one pass. Sessions outside `from`-`to` are left out. Two sessions on one date merge into one `DayLog`. History dates are already local calendar dates (§0, §9).
- **Output:** `{from, to, logs: WeekLog[], coverage, warnings}`. `warnings` names what the history read does not cover (no read, incomplete, starts after `from`, ends before `to`): those sessions are unknown, not absent.
- **Example:** `node engine/cli.ts weeks --from 2026-09-28 --to 2026-10-18` → `{"logs": [{"week_start": "2026-09-28", "days": [{"date": "2026-09-28", "exercises": [{"name": "Squat", "sets": [{"weight": 225, "reps": 5, "rpe": null}, …]}]}]}, {"week_start": "2026-10-05", "days": []}, …], "warnings": []}`.

### 22.6 `block draft [--template <id>] --weeks <n> [--input <file.json>]`

- **Purpose:** expands a method-pack template into a block, with all the arithmetic in code.
- **Arguments:** `--template` (default `<coach.yaml template.days>-day`), `--weeks` 1-52, `--input` (optional): `{id?, start? (a Monday; default the next Monday), emphasis? (default coach.yaml), targets? ({muscle: week-1 sets}; default the template's own counts), step? (default 0.05, never above weekly_volume_increase_max), deload_weeks? (default every deload_every_weeks-th week), weekdays? (default 3-day mon wed fri; 4-day mon tue thu fri; 5-day mon tue wed fri sat), exercises? ({"<day>.<slot>" or pattern: {name, exerciseId}}), loads? ({exerciseId or name: working load in the athlete's units})}`.
- **Rules:**
  1. Base slot sets: `scaledSets` (emphasis multiplier, rounded, at least 1 unless the multiplier is 0; a 0 slot is left out).
  2. A slot's muscles: its exercise's classification, else its pattern's muscles (`volume` counts the same way).
  3. Allocation: each target muscle's sets split across its slots in proportion to their base sets (largest remainder). A slot takes the smallest share its muscles give it, at least 1 set. A warning names a muscle that the 1-set minimum puts above its target.
  3a. The per-exercise session maximum (0.2.4; the pack check `{type: max_sets_per_exercise_session, value, adaptations}`, [NA-DES-009]: 4). A limited slot is a non-recovery, non-cluster slot of an adaptation the check lists. For every build week: rule 3, then every limited slot above the maximum is lowered to it (never below 1). Then, for each target muscle in sorted name order, while it is below its target: the candidates are the limited slots with base sets above 0 that train it and are below the maximum, by base sets descending, then template order; the first whose added set puts no other muscle above its target gets one set; repeat until none qualifies. What is still missing goes in the week's `short: [{muscle, requested, planned, reason}]`, `reason` `at_max` (every candidate is at the maximum), `other_target` (a candidate is below it, but one more set puts another muscle above its target) or `no_slot` (no limited slot trains it), with one plain warning each. `targets` are the requested sets (after the cap), `planned_by_muscle` the allocated sets, `short` the gap. The maximum is a drafting default and an audit finding (`volume` `session_max`), never a refusal: a block, week file or plan with more sets stays valid and writable. A pack without the check has no maximum and its drafts are unchanged.
      One exercise once a day (eligibility per week: a slot that is straight on its date, before a cluster's `since`, is limited; a slot that is a duplicate in any week is unresolved for the block): when two limited slots on one day resolve to the same exercise (same `exerciseId`, else the same normalized name), the later slot is in `unresolved` with the reason "same exercise twice on <day>: choose another exercise for this slot", and `ready` is false. Conditioning, recovery and cluster slots may repeat an exercise on a day (design decision, 2026-10-12: the 4-day template's two interval slots). A week file the coach writes with a repeated exercise stays valid.
  3b. Cluster slots (§8a): a slot whose exercise matches a `clusters` entry on its date is a cluster slot that week. A slot whose exercise is a cluster only by its name (no entry) is a cluster slot too, as `volume` counts it: the template's sets of its reps, at 2 × reps as the rep max, every week, with a warning to add an entry (V5b fix 2), so `planned_by_muscle` equals `volume` on the saved week files. It keeps `mini_sets` of the list's `reps` in every build week (allocation and the weekly step do not change it), counts its counted sets toward its muscles before the other slots are allocated (the straight slots get each target minus them), and never receives overflow sets. A cluster alone above a target stays and is listed in the week's `cluster_above_target` (advisory). A deload week keeps `max(1, round(mini_sets × deload_depth.volume))` mini-sets. The block slot gets `style: cluster`, `rm`, `rest_s` (the list's) and `sets` = `mini_sets` (the most in any build week).
  4. Build week j: `round(target × (1 + step)^(j − 1))`, capped by `allowedSets(previous build week, cap)`. Week 1 is capped the same way against the reference week (§8: the last completed non-deload week before the block, from the snapshot history, as the guard finds it), and every muscle of the template then gets a target. `capped` lists each week-1 target the cap lowered. With no reference week, week 1 is the targets as given.
  5. Deload week: each non-recovery slot keeps `max(1, round(previous build sets × deload_depth.volume))` (a cluster slot: of its `mini_sets`); the week's requested `targets` are `round(previous build week's planned sets × deload_depth.volume)`, as `targets` gives them, apart from `planned_by_muscle`, and `cluster_above_target` lists a cluster alone above one (V5b fix 5); loads are `× deload_depth.load`, rounded to 5 lbs or 2.5 kg, at least one step.
  6. The block's slot `sets` are each slot's most in any build week after the maximum (what `block_session` reads; a deload scales it). `engine/block.ts` accepts the optional slot fields `style` (`cluster` | `straight`), `rm` and `rest_s`; a block without them is valid, and so is a slot with more sets than the maximum. Each block week's `targets` are the sets it plans, so the guard and the plan agree.
  7. Resolved exercises only: a slot is in the returned days only when `exercises` names an exercise for it that classifies. Other slots are listed in `unresolved` and `ready` is false.
- **Output:** `{template, block (the athlete/block.yaml shape; validated when it has an id), ready, unresolved: [{slot, day, pattern, adaptation, sets, reason}], weeks: [{week, kind, week_start, load_factor, sets_by_muscle (weeklySetsByMuscle of the returned days), planned_by_muscle (every slot; the block week's targets), targets, short, cluster_above_target, days: DayPlan[] (each exercise also has pattern and adaptation)}], reference: {week_start, sets_by_muscle} | null, capped: [{muscle, base, planned, allowed}], rule_ids, warnings}`. `audit` checks `sets_by_muscle`; every drafted day passes the guard's `block_session` check (tested). Only a `ready` draft is a full plan.
- **Example:** `node engine/cli.ts block draft --weeks 6 --input d.json` with `{"id": "B-001", "start": "2026-10-19"}` → 5 build weeks and a deload in week 6 (`deload_every_weeks` 6), `"block": {"id": "B-001", "start": "2026-10-19", "weeks": [{"week": 1, "kind": "build", "sessions": 4, "targets": {"chest": 9, …}}, …], "days": [{"day": "mon", "focus": "Whole-body lifting, 5 to 10 reps", "slots": [{"pattern": "squat", "adaptation": "strength", "sets": 4, "reps": 5, "rest_s": 180}, …]}, …]}`.

- **Before `coach.yaml` exists (0.2.2):** the input gives `method`, `days`, `emphasis`, `units`, `timezone` and `logger` (`tally`: the Tally cache; `files`: `plans/`; `none`: no history, and a leftover Tally cache is ignored). With `coach.yaml`: `method`, `units`, `timezone` and `logger` come from it; `days` from `--template`, else `coach.yaml`; `emphasis` from the input, else `coach.yaml`. The error names only the values with no source (`MISSING_FILE` without `coach.yaml`).
- **`--out <dir>` (0.2.2):** writes `<dir>/block.json` (the `block`) and `<dir>/week-<n>.json` per block week, `{week: {week_start, kind, load_factor, days}}`, and prints only a summary (under 8 KB for a 6-week, 5-day block): `{template, block_id, start, block_file, ready, unresolved: {count, by_day: {<weekday>: ["<day.slot> <pattern>[ (reason)]"]}}, warnings, rule_ids, capped, reference, progression: {build_weeks, step, deload_weeks}, short: [{muscle, reason, weeks: "<week>: <wanted>→<planned>, …"}], why: {week: string[], days: [{day, why}], short?: string[] (plain lines naming the short muscles, for the athlete)}, weeks: [{week, kind, week_start, load_factor, file, sets_by_muscle, cluster_above_target?}]}`. The short-muscle warnings fold into one line there (the full draft keeps one per week). Without `--out` the output is the full draft above. The deload-load warnings fold into one line: `loads --fill` sets the loads.

### 22.6a The week file: `loads --fill`, `tally-days`, `block write` (0.2.2)

- **The week file** `{week: {week_start, kind, load_factor, days}}` goes to `loads --fill`, `limits check`, `volume` and `plans write` (they ignore the extra keys) and to `tally-days`. Every form those commands took before still works.
- **`loads --input <week file> --fill [--history <file>]`:** fills each exercise occurrence by day and position (a duplicate exercise is filled on each day), hard sets only (warm-ups keep their weight): the base suggestion (§15, from the history), then `× load_factor` once, rounded to the plate step (5 lbs, 2.5 kg) and at least one step, as `block draft` rounds. An exercise with no suggestion keeps its weight. `--history` is `{units, sessions: [{date, exercises: [{name, sets: [{weight, reps}]}]}]}` (the coach writes it from an export); when given it is the whole history (it wins over the logged weeks); weights convert to the athlete's units. It writes the file in place (temporary file, then rename) and prints `{file, units, load_factor, history: file | logged weeks | none, filled, suggestions: [{date, index, exercise, weight, reason}]}`.
- **Clusters in the week file (0.2.4):** `{week, clusters?}`: the input's list (§8a). `plans write` gives a cluster row the note "Cluster: <n> × <reps> at <rm>RM, <rest_s> s between mini-sets" (missing parts left out); on the first row of a day the day note comes first: "<day note> | Cluster: …". Old "Cluster:" text is removed from the day note before a write, so writing the same day again never duplicates it. Logged reps of unequal mini-sets ("6,6,6,6,6,5") are stored and read back exactly.
- **`tally-days --input <week file>`:** `{days: [{date, dayType, dayName, notes?, exercises, weightUnit, timezone?}], warnings}`, one `plan_workout_day` input per date, converted with `entryToTallyExercise` (durations included; a custom timed exercise gets `trackingType: duration`; an exercise without an `exerciseId` gets a snake_case id and a warning). The coach adds only `ifAbsent`, `expectedVersion`, `replace` and `opId`. Tally has no per-exercise notes: each cluster exercise (§8a) adds one day-note line "Cluster: <exercise name>: <n> × <reps> at <rm>RM, <rest_s> s between mini-sets", after the coach's notes; every old line that starts with "Cluster:" goes first. Tally day notes are at most 1,000 characters (workout-api `lib/mcp/schemas.ts`, JavaScript length): a line that does not fit is left out with a warning, and the coach's own notes are never cut. `suggestedSets` is the number of mini-sets.
- **`block write --input <dir>/block.json`:** refuses under the urgent stop (`URGENT_STOP`; both files unchanged); validates the block (`BLOCK_INVALID`); when `athlete/block.yaml` holds a block with another id, copies it first to `athlete/blocks/<safe id>.yaml` (`[A-Za-z0-9._-]`, no `..`; `-2`, `-3` … when the name holds other content; the same content is reused, so a retry archives nothing new); then writes `athlete/block.yaml` atomically. The same id rewrites in place. A failed write leaves the active block and every archive as they were. Prints `{written, id, archived, replaced: new | same-id | other-id}`.

### 22.7 `ids next --kind block|limit`

- **Purpose:** the next free ID, so the model never counts.
- **Rules:** `block`: `B-NNN`, one past the highest in `athlete/block.yaml` and `athlete/blocks/*.yaml` (the block skill keeps old blocks there). `limit`: `L-NNN`, one past the highest in `athlete/limits.yaml`. Removed in 0.2: `proposal`.
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

## 22a. Setup v2 helpers (0.2)

`engine/cli-setup.ts`. `setup-check`, `init-athlete`, `allow-server` and `worktree` load Node built-ins only, so they run before `npm ci`.

- **`setup-check`:** setup's silent checks in one call: `{mode, node: {version, need, ok}, claude: {version, need, ok}, npm_ci_needed, timezone, name, coach_yaml, setup_progress, worktree, problems}`. `claude.ok` is null when `claude --version` does not answer (go on). `name` is the first word of `git config user.name` (for `athlete.name`, no typed answer); `timezone` is the system's IANA zone. `problems` lists what stops setup: an unattended run, Node older than 22.18, Claude Code older than 2.1.295. `setup_progress` is the last `setup: <part> done|stopped …` line of `athlete/log/setup.md` (the v0.1 `setup: step <n> done` form is read too; `session-context` uses the same rule).
- **`init-athlete`:** copies `templates/athlete/{brief.md,limits.yaml,baselines.json,block.yaml}` to `athlete/` when missing and makes `athlete/log/`. Never overwrites.
- **`allow-server --server <name>`:** adds `mcp__<name>` to `permissions.allow` in `.claude/settings.local.json`, keeping every other key; idempotent; a name outside `[A-Za-z0-9_-]` is `USAGE`; a file that does not parse is `SETTINGS_INVALID` and is left as it is.
- **`commit --message <text>`:** commits `athlete/`, `plans/` and `coach.yaml` only (`git add`, then `git commit --only` of the paths with staged changes; never other staged work), like the Stop hook, with no permission prompt. Prints `{committed, reason?, ok, paths}`; exits 0 when it committed or there was nothing to commit, and 1 on a failed commit (not a repository, a refusing hook, a git error): the skills stop and say so in one line (V2b fix 9).
- **`history-files`:** the two newest likely workout exports directly in `~/Downloads` and `~/Desktop` (`{files: [{path, name, folder, modified}]}`), the options of setup's history question. 0.2.2: it reads only the first line (at most 4 KB) of each regular `.csv` file (symlinks skipped; a BOM stripped; comma, semicolon or tab), normalizes each column name (lowercase, trimmed, `_` and spaces as one, a unit suffix such as `(kg)` or `_kg` dropped), and lists a file only when one whole column is `exercise`, `exercise name` or `exercise title` and another is `reps`, `weight`, `set order`, `set index` or `sets`. It never prints a header or the name of a file that does not match. `COACH_HISTORY_HOME` replaces the home folder. The coach reads the chosen file with the Read tool; `Read(~/Downloads/*.csv)` and `Read(~/Desktop/*.csv)` are the only read allow rules.
- **`worktree status | ff-main | ff-branch`:** §24 "A copy in a worktree".
- **`tally-mention`:** §12a.

## 22b. The fast today (V7)

The `today` skill's data work in two engine passes, one preparation call per write, and one save. Each field calls the same code as its old command (`windowCheckFor`, `scanNotesResult`, `readinessDateResult`, `loadsFor`, `adjustFor`, `classifyResult`, `opDone`, `checkLimits`); the old commands stay. The engine computes and reports; the model decides. No new gate.

**The run** (`engine/today-run.ts`). Pre writes `.tmp/coach/today-run.json` `{run_id, session_id, local_date, started_at, asked?}`; `run_id` is `r-<YYYYMMDD>-<HHMM>-<4 hex>` in the athlete's timezone. Each stage writes its output with `{run_id, session_id, local_date, computed_at, stage}` to `.tmp/coach/today-<run_id>-<stage>.json`, and the full diagnostics to `.tmp/coach/today-brief-<stage>.json`. Post reruns keep the run.

**`today-brief --stage pre`** (`engine/today-brief.ts`): the work of `window-check --kind daily` first (out of the window: exit 4, the window only, no run); then `{run_id, window, mode, local: {date, time, weekday, timezone, now}, logger, capabilities: {opId}, wearable, logger_health_notes, units, clusters, urgent: {stopped, stop, clearances}, limits: {pain_threshold, limits (each limit in full), text (one line each)}, preferences (the "Preferences" lines of athlete/brief.md), checkin_pain: [{region, score, checkin_at, source, handled}], proposals: [{text, entry}], signals_refresh, reads, tools?}`. `signals_refresh` is `not_applicable` under a known urgent stop (no wearable fetch). `reads` (Tally only): today's `get_planned_workout`, `get_training_context {historyWeeks: 2}`, `get_planned_workout` for each of the `perf_expiry_days` dates before today, and the history windows (§9a); a read this session made in the last 15 minutes is left out. `tools.toolsearch`: one `select:` query for the reads and the writes, with `automation.tool_prefix`, else the snapshot's server, else `mcp__claude_ai_Tally_Workout__`. A proposal occurrence is open when no "- proposal handled: <yes|no>: <the same text>" line comes after that occurrence (a proposal made again after an earlier one was handled is open again); a check-in pain entry is handled when the log has "- pain handled: <region> <checkin_at>".

**`today-brief --stage post [--input <evidence.json>]`** (after the reads):

- `coverage` (always): `{history: {status, reason?, gaps?}, safety_notes: complete|incomplete|failed, days: {<date>: complete|missing|failed|stale}}` for today and each date with a logged session in the expiry window.
- `safety_notes`: the note scan since today minus 3 days, its side effect unchanged (an urgent term newer than its last clearance writes, commits and pushes the stop): `{matches, urgent_terms, urgent_stop, coverage, sessions, server}`.
- `urgent` (always): `{stopped, stop, unknown}`; `unknown` is true when the scan's coverage is incomplete and no stop is set.
- `today_day`: `found` (with `write_base`: the path of `.tmp/coach/today-<run_id>-day.json`, the whole day as read with every Tally field, for a whole-day write — the compact exercises are for the report only; `version` to pass as `expectedVersion` unchanged, `updatedAt` for information, `protected`, `source`, `userModified`, `skipped`, `dayName`, `notes`, the exercises in short), `none` (a read with `found: false`: a rest day; files: `logged_only`), or `missing | failed | stale` with the read to make.
- `already_adjusted`: Tally: `{done, kinds: {<kind>: done|not_done|uncertain}, done_changes, uncertain: [{kind, reread, reason, entries}]}` for `trim_session`, `swap_to_recovery`, `load_progression`, `annotate`; files: the `[coach]` line in today's notes.
- `limits_check`: `limits check` on today's day.
- `readiness`: `{decision, hold_progression, aversion, deload_signal, states, decision_reasons, pattern: {days_of_decline, short, long}, rule_ids, pain, report_facts: {wearable_source, sleep, sleep_target_min, hrv, rhr, calibrating, sessions, days_of_decline, unknowns}}`.
- `loads` (when `hold_progression` is false and the history is complete): the `loads --from-snapshot` result, `deload_week`, and `own_load_bounds` per exercise with a load: `{name, planned, engine, last_top_set, cap, cap_reason, choices, unit}` (the weights logged in the last 4 weeks and today's planned weight, at most the cap: the higher of the engine's suggestion and the last top set, never above a matching limit's `max_load`, never a raise in a deload week).
- `adjust` (decision `trim`, `recovery` or `propose_deload`): `{decision, tally_day, changes, warnings}`.
- `need_reads`: the reads still missing (pagination always; a failed, stale or missing read once, tracked in the run's `asked`; a stale read again after 15 minutes). `gave_up`: the reads asked once that still fail; safety stays unknown.
- **Field prerequisites:** a field that cannot run is `{status: "not_applicable", reason}`, a field that throws `{status: "failed", reason}`; `urgent` and `coverage` always come back. No `loads` and no `adjust` under the urgent stop, with safety unknown, on a rest day, with today's day `missing | failed | stale`, or with `logger: other`.
- The post file adds `log: {readiness_line, rule_ids, decision}` for `save --no-change`.
- **Size:** the compact output was about 1,250 tokens on a typical day in the eval run (scenario 34); `tests/v7-brief.test.ts` checks under 2,000.

**By logger** (§12a): `tally` as above. `files`: no reads; post reads `plans/` (no protection by `source`; the `[coach]` line check; `logged_only`); writes through `plans write`. `other`: post takes `--input` `{history: [notes history, as scan-notes --input], history_complete, today: {read: ok|failed, found, protected?, day}}`; without it the logger fields are `missing` and safety is unknown.

**`today-write-prep --input <{after | edit, tool, kind, before?}.json>`** (`engine/today-write-prep.ts`): the change is `edit` (V7b) — `{notes?, exercises?: [{index, set: {<field>: <value or null>}} | {index, remove: true}]}` applied to today's day as read, every other field kept — or `after`, the whole Tally-shaped day (adjust's `tally_day`, or the day in post's `today_day.write_base` file, changed). `tool` is `update_planned_workout` or `plan_workout_day`, `kind` an operation kind. Today only. The final day is checked in the unit the write sends (`after.weightUnit`, else the stored day's unit; V7b). An exercise id may be empty only with `logger: files` (named exercises). `annotate` is built from the stored day with new notes only: an `edit` with exercises, or an `after` that changes the exercises, the day name, the day type or the unit, is refused; its required `update_planned_workout` operation restates a field an exercise already has with its stored value (V7c: the first of `suggestedSets`, `suggestedReps`, `repsMax`, `suggestedWeight`, `suggestedDuration`, `distanceMeters`, `rpe`, `perSide`; never an invented value); a day with none of them is refused with a pointer to `plan_workout_day`, which writes the stored day unchanged with the new notes. It reads the day from the snapshot once (this session's, under 15 minutes old; else `NO_SNAPSHOT`, `NOT_IN_SNAPSHOT` or `SNAPSHOT_STALE` naming the read) for both `before` and `snapshotDay`, and prints `{date, kind, logger, protected, version, classify, limits: {ok, final_day: {ok, findings}, week: {status: ok|over|unknown|not_needed, findings, missing?, need_reads?}}, write}`. The week check runs when a limit has `max_sets_per_week`: the ISO week with today replaced; a day the snapshot does not hold (and the training context does not list as empty) makes it `unknown`. `write.plain` (and on a protected day `write.approved` with `overrideUserModified: true`) is `{tool, args}` with `expectedVersion`, `timezone`, `weightUnit` and, with `capabilities.opId`, its own `opId` (`opIdProblem` passes). `update_planned_workout` gets index operations (`modify` with the changed fields, a gone field as null; `remove`; `replace` in place; `add` after the last kept exercise), checked by applying them to `before`; a reorder is an error (use `plan_workout_day`). A notes-only write restates the first exercise's set count (Tally needs at least one operation). `annotate` refuses a change to the exercises. `files`: `write.plain` is the `plans write` input `{tally_day}`. `other`: `before` is required, `write` is null. Malformed input fails with the expected shape and an example.

**`classify --before-snapshot <date> --input <{after, tool}.json>`**: `before` and `snapshotDay` from one snapshot read, with the same rules.

**`save --run <run_id> --message <text> [--no-change <reason>] [--input <{lines}.json>] [--sessions <n>]`** (`engine/save.ts`):

- The log entry, in the month file of the run's date: `--no-change` appends the standard no-change entry (`## <date> <HH:MM> · no-change`, `- trigger:`, `- readiness:` from the post file, `- rules:`, `- change: none (<reason>)`); it refuses (`POST_STALE`, "run post again") a missing post file, another run or session, another date, a result older than 15 minutes, a check-in or safety file (`athlete/signals/<date>.json`, `athlete/limits.yaml`, `athlete/.urgent-stop`, the clearances) changed after it, or an urgent stop the result does not know. `--input` appends the lines as given, under a `· today` heading unless the first line is a heading. Each entry ends with `- run: <run_id>`; when that line is in the log, nothing is appended (a retry adds nothing twice) and `--no-change` reads no post result, so a retry the next day only publishes (V7b). `--part <event>` saves lines (the "pain handled" lines) as their own entry with `- run: <run_id> <event>` at once, so an early exit (already adjusted) cannot lose them and the run's own entry is not blocked. V7c: one marker per event (`safety-<region>-<checkin_at>`, `safety-<region>-note-<date>`; no spaces), so a second region in the same run is its own entry.
- `tally-mention` with `logger: files` or `other` in a live session, before the commit (`other` needs `--sessions`).
- **Layouts:** on `main`: commit → fetch → rebase onto `origin/main` (as `git pull --rebase`) → the trusted push of `main` (`pushBranch`: the hooks, the privacy check, every push URL, the explicit destination ref). A branch (a linked worktree, with `main` checked out elsewhere or not at all): commit on the branch → fetch → rebase the branch onto `origin/main` (abort on a conflict) → fast-forward `main` to the branch (`ffMain`) → push `main`. `main` itself is never rebased in a branch layout. Before the fast-forward, `.tmp/coach/save-state.json` records `{run_id, main_before, main_after}`; the next save (after its fetch) gives `main` back to `main_before` when the remote does not have `main_after` and `main` is still there (`reset --keep` in the checkout that has it, else `update-ref` with the old value), so a failed push or a crash never strands `main`.
- **Outcomes:** `published` (the remote has the commit; `main`, the branch and `origin/main` match), `local_sync_failed` (published, a local check after the push failed), `not_published` (exit 1; nothing reached the remote; "- push skipped: <reason>" is added to the entry and committed locally), `publish_unknown` (exit 1; `git push` failed and `ls-remote` did not answer), `nothing_to_save` (nothing to commit and nothing unpushed). A refusal before `git push` runs is `not_published`; after a `git push` error, `ls-remote origin` decides: the pushed commit, or a tip whose history contains it after a fetch (another push URL took it and the remote moved on), is published; a fetch that fails is `publish_unknown` (V7b). It stops at the first failure before the push: a failed commit, a rebase conflict (aborted), dirty `main`, a detached HEAD, a refused fast-forward.

## 23. Launch hardening

### Unattended allowlist

Removed in 0.2: the hook that enforced the list (`engine/protect.ts unattendedBash`), the executable-file rule and the package-repair rule. `engine/automation.ts UNATTENDED_TOOLS` still goes to routines and the launchd template as their allowed tools; V3 revisits it.

### Protected evidence

Removed in 0.2: protected `athlete/block.yaml` and `athlete/signals/**`, the approved-block rule and `block write`. `node engine/cli.ts checkin` still throws `UNATTENDED` in an unattended run and writes nothing.

### Urgent state

Removed in 0.2: the urgent hold and the urgent pending terms. The urgent stop (§10) replaces them.

### Hooks in fresh clones

- `node engine/cli.ts prepush-check [--remote origin]`: exit 0 and `{ok: true, repo, visibility, hook_installed: true}` only when the pre-push hook at `git rev-parse --git-path hooks/pre-push` equals `git-hooks/pre-push` and is executable, and `gh api repos/<owner>/<repo>` reports `private` or `internal`. Otherwise exit 1 with `{ok: false, reason}`.
- `node engine/cli.ts push [--branch <name>]` is the trusted push of every skill and of `urgent set` (`engine/cli-git.ts pushBranch`). The branch (default: the current branch) must exist as `refs/heads/<name>` (`git show-ref --verify`); a name that starts with `refs/`, a detached HEAD, a bad name or a missing branch is `USAGE`. It runs `install-git-hooks`, then `prepush-check`, then reads every push URL of `origin` (`git remote get-url --all --push origin`, `insteadOf` and `pushInsteadOf` applied). Each one must name the GitHub repository that the check looked up; otherwise exit 1. Then `git push --no-follow-tags [-u] origin refs/heads/<name>:refs/heads/<name>` (`-u` when the branch has no upstream): the explicit pair leaves no destination to `remote.origin.push`, and `--no-follow-tags` overrides `push.followTags`. A failed check exits 1 with `{ok: false, pushed: false, reason}` and pushes nothing. Success prints the `argv` it ran.
- The routine prompt, `today`, `week`, `block`, `limits` and `setup` push with it. A raw `git push` still runs the installed pre-push hook. `session-context` installs the hook when it is missing (§10a). Setup runs `install-git-hooks` and `prepush-check` and requires `ok: true`.

### Logger notes

- Notes to the logger are generic by default (the `today` skill's "Notes to the logger" table). Symptoms, regions, pain scores and readiness values go into a logger note only with `coach.yaml consent.logger_health_notes: true`, a separate question in setup.

### CI

- `.github/workflows/test.yml` runs when `github.repository` is the template, or when a copy sets the repository variable `COACH_CI` to `true`. `tests/privacy.test.ts` checks tokens on the repository; the zero-athlete-files check runs on the public export (`tests/public-tree.test.ts`).

### Logger tool names

- `install-launchd` and `launchd-plist` take the Tally prefix from `--tool-prefix`, else `coach.yaml automation.tool_prefix`, else the connected Tally servers in `claude mcp list` (`toolPrefixFromServer`: `mcp__<name>__`, non `[A-Za-z0-9_-]` → `_`). A prefix must match `^mcp__[A-Za-z0-9_-]*[Tt]ally[A-Za-z0-9_-]*__$` (`BAD_TOOL_PREFIX`); none found: `NO_LOGGER_TOOLS`.
- `install-launchd --yes` first runs a probe (`claude -p … --permission-mode dontAsk --output-format stream-json --allowedTools <prefix>get_training_context`, no API key, `COACH_UNATTENDED=1`) and installs nothing unless a `get_training_context` call returned without an error (`LOGGER_PROBE_FAILED`).
- Cloud routines use the connector's own name (`mcp__<connector name>__`).


### Latency

- `scripts/bench-hooks.mjs` measures the hooks Claude Code runs: the urgent gate (no stop, and a stop with a plan write), the two stubs, session-context (no stop, and a stop) and safety-detect.

### Eval re-run fixes

- **Bash over-blocks:** a file-descriptor duplication (`2>&1`, `>&2`, `1>&2`) names no file and is dropped before the segment rules (`normalizeSegment`). An engine call may end with one `>` or `>>` into `.tmp/coach/` (resolved inside the root, no script extension); this is on the unattended allowlist too. A read-only command (§20) may carry whole quoted words whose text holds only letters, digits, spaces and `. _ - : / @ , +`. Loops stay strict: CLAUDE.md asks for one engine command per Bash call.
- **Agents in the foreground:** every agent call in the skills sets `run_in_background: false`. `safety-detect` removes closed `<task-notification>…</task-notification>` blocks (background-task results) before it scans; the athlete's own words outside them are scanned as before.
- **Safety questions:** removed in 0.2 (the `safety` agent and its copy-exactly block). The `safety` skill asks with AskUserQuestion, or as text with lettered options in print mode.

## 24. Template updates

A user's repo is made with GitHub's "Use this template": one fresh commit and no link to the template. `node engine/cli.ts update` brings later template releases into it.

### Ownership

- **Template files:** every file the public export ships (`scripts/public-tree.txt`). The update owns them.
- **User files:** `coach.yaml`, everything under an `athlete/` segment, and any file not in the template manifest (for example a method the user added under `methods/<name>/`). The update never writes, moves or deletes them.

### The manifest

- `scripts/export-public.sh` writes `template-manifest.json` at the export root after the copy (`scripts/template-manifest.ts`): `{version: 1, repo: "https://github.com/<owner>/coach-harness", release: <package.json version>, files: {<path>: {mode: "100644" | "100755", blob: <git blob id>}}}`, sorted by path, for every exported file but the manifest. The blob id is git's (`blob <size>\0<bytes>`, sha1); the mode is 100755 when the owner may execute the file.
- The manifest was a protected file in v0.1; removed in 0.2 (no file is protected).
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

Removed in 0.2: the guard's asks and denies for `update` and the protected manifest. The `update` skill asks the athlete once and runs it; `update` still refuses itself in an unattended run.

### Migration to 0.2

- **Restart boundary.** A running v0.1 session keeps its old hooks until it restarts. `guard-files` and `guard-writes` ran with `onFailure: block`, so their entry files stay as stubs that allow everything (v0.3 deletes them). After `update --yes`, the `update` skill tells the athlete to restart at once and runs nothing else first.
- **Settings.** `update` replaces a stock `.claude/settings.json` (the new hook list and allow rules) and deletes the removed files. After any update the effective hooks include `urgent-gate` with `onFailure: "block"`: when the athlete keeps a customized `settings.json` (`--keep-mine`), `update` merges the template's urgent-gate entry into it, replacing a stale one and keeping every other setting (`engine/settings-gate.ts mergeUrgentGate`; `settings_merged: true`). Hooks in `.claude/settings.local.json` that point at the guard stubs are harmless and are reported (`local_guard_hooks`). `config-check` reports a missing settings file or a missing or changed urgent-gate registration (matcher, `onFailure`, timeout) as a problem, and local guard-stub hooks as a note.
- **Restart, then finish.** With `restart_claude_code: true`, the `update` skill asks for a restart right after `update --yes` and runs nothing else. "Finish the update" in the new session runs `npm ci`, `install-git-hooks`, `config-check`, `npm test`, the push and the old-files question.
- **Legacy files, before the first training write in the new session** (`engine/legacy.ts classifyLegacy`, run by `session-context`): an urgent hold (the `urgent` flag, the word "urgent" or an urgent term in its reason, or an unreadable hold file) or urgent terms in `athlete/.safety-pending` become `athlete/.urgent-stop` first (source `legacy`; committed), unless a clearance on or after the event's date covers the term. Then the context asks one question: "Your copy has an old hold or safety check. The v0.2 coach uses limits instead. Remove them? A) Yes, B) Show them first". Removing them never clears a converted urgent stop.
- **A copy in a worktree:** the v0.1 `update` refuses any branch but `main`, so the first upgrade runs against the main checkout (`--root <main checkout>`, when it is clean and not behind); then the coach fast-forwards the worktree branch and asks for a restart.

### A copy in a worktree (0.2)

`engine/worktree.ts`; fast-forward only, never a merge commit or a force.

- `worktree status`: `{git, worktree, branch, main_checkout, main_checkout_branch, main_checked_out_at, clean, main_clean, ahead, behind}` (the main checkout is the first `git worktree list --porcelain` entry; `ahead`/`behind` against the local `main`).
- `worktree ff-main`: moves `main` to this branch's commit. Where `main` is checked out, that checkout must be clean (`git -C <it> merge --ff-only refs/heads/<branch>`); where it is not, `git fetch . <branch>:main` (a fast-forward or nothing). Refused (exit 1, `reason`): a dirty main checkout, a diverged `main`, no local `main`, a detached HEAD. Skipped (ok): on `main`, or nothing to move.
- `worktree ff-branch`: moves this branch to `main` (`git merge --ff-only main`); this checkout must be clean.
- `worktree main-checkout` (V2b fix 8): `{ok, path, temporary}`: the folder where `main` is checked out (`main_checked_out_at`, which need not be the main checkout), else a new temporary worktree of `main` at `.tmp/coach/main-checkout` (gitignored). It never switches another checkout's branch. `worktree remove-temp` removes that temporary checkout only, with `git worktree remove` and never `--force` (a checkout with changes is refused and kept).
- **Setup** in a worktree on another branch works on the branch, commits, runs `worktree ff-main`, then `push --branch main` (it tells the athlete only when that fails).
- **Update** in a worktree: `commit`, `worktree ff-main`, `worktree main-checkout`, `update --check --root <path>`, `update --yes --to <sha> --root <path>` (the update's own refusals apply to that checkout: clean, on `main`, not behind `origin`), then `worktree ff-branch`, `worktree remove-temp` and the restart; "finish the update" pushes with `push --branch main`. Tested end to end in both layouts (`tests/update.test.ts`).

