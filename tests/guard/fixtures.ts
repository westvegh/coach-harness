// Shared fixtures for the guard tests. Tally shapes are copied from the Tally server code
// and tests (workout-api/lib/mcp/tools/updatePlannedWorkout.test.ts, getPlannedWorkout.ts,
// movePlannedWorkout.test.ts, skipPlannedWorkout.ts, deletePlannedWorkout.ts).
import { join } from "node:path";
import { encodeTallyVersion } from "../../adapters/loggers/tally/version.ts";
import { validateConfig } from "../../engine/config.ts";
import { dayFromPlannedWorkout } from "../../engine/snapshot.ts";
import { loadTaxonomy } from "../../engine/taxonomy.ts";
import { readYamlFile } from "../../engine/yaml-file.ts";
import type { Block, CoachConfig, Rules, Snapshot, SnapshotDay, SnapshotSession, Taxonomy } from "../../engine/types.ts";

export const REPO = new URL("../..", import.meta.url).pathname;

// From updatePlannedWorkout.test.ts.
export const bench = { exerciseId: "Barbell_Bench_Press", name: "Bench Press", suggestedSets: 3, suggestedReps: 8, suggestedWeight: 135 };
export const squat = { exerciseId: "Barbell_Squat", name: "Squat", suggestedSets: 4, suggestedReps: 5, suggestedWeight: 225 };
export const row3 = { exerciseId: "Cable_Row", name: "Cable Row", suggestedSets: 3, suggestedReps: 10 };
export const curl = { exerciseId: "Dumbbell_Curl", name: "Curl", suggestedSets: 2, suggestedReps: 12 };

export const SESSION = "sess-1";
/** Wednesday 2026-10-14, 07:00 in Los Angeles. The week is 2026-10-12 (Mon) to 2026-10-18. */
export const NOW = "2026-10-14T07:00:00-07:00";
export const TODAY = "2026-10-14";
export const v = (id: string, t: string | null) => encodeTallyVersion(id, t);

/** A get_planned_workout result (getPlannedWorkout.ts toPlannedWorkoutDetail). */
export function plannedDay(date: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date,
    found: true,
    dayType: "push",
    dayName: "Push",
    notes: "keep",
    source: "mcp",
    userModified: false,
    skipped: false,
    updatedAt: "t0",
    version: v(`r-${date}`, "t0"),
    exercises: [bench, squat, row3],
    weightUnit: "lbs",
    weightUnitSource: "settings",
    ...over,
  };
}

export function snapDay(date: string, over: Record<string, unknown> = {}, at = NOW): SnapshotDay {
  return dayFromPlannedWorkout(plannedDay(date, over), at);
}

export function emptyDay(at = NOW): SnapshotDay {
  return dayFromPlannedWorkout({ found: false, exercises: [], weightUnit: "lbs", weightUnitSource: "settings" }, at);
}

export function snapshot(days: Record<string, SnapshotDay>, over: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    session_id: SESSION,
    captured_at: NOW,
    timezone: "America/Los_Angeles",
    days,
    history: [],
    history_coverage: { captured_at: NOW, complete: true },
    weightUnit: "lbs",
    weightUnitSource: "settings",
    planned: { captured_at: NOW, from: TODAY, dates: {} },
    ...over,
  };
}

export function config(over: Record<string, unknown> = {}): CoachConfig {
  const raw = readYamlFile(join(REPO, "coach.example.yaml")) as Record<string, unknown>;
  return validateConfig({ ...raw, ...over });
}

let taxCache: Taxonomy | null = null;
export function tax(): Taxonomy {
  return (taxCache ??= loadTaxonomy({ localPath: null }));
}

export function rules(): Rules {
  return readYamlFile(join(REPO, "methods/nine-adaptations/rules.yaml")) as Rules;
}

/** A block starting Monday 2026-09-07: weeks 1-5 build, 6 deload, 7 build (2026-10-19). */
export function block(over: Partial<Block> = {}): Block {
  return {
    version: 1,
    id: "B-001",
    method: "nine-adaptations",
    template: { days: 4, emphasis: "all-around" },
    start: "2026-09-07",
    weeks: [
      { week: 1, kind: "build", sessions: 2, targets: { chest: 6, triceps: 6, quads: 8, glutes: 8, "upper-back": 6, lats: 6 } },
      { week: 2, kind: "build", sessions: 2, targets: { chest: 6, triceps: 6, quads: 8, glutes: 8, "upper-back": 6, lats: 6 } },
      { week: 3, kind: "build", sessions: 2, targets: { chest: 6, triceps: 6, quads: 8, glutes: 8, "upper-back": 6, lats: 6 } },
      { week: 4, kind: "build", sessions: 2, targets: { chest: 6, triceps: 6, quads: 8, glutes: 8, "upper-back": 6, lats: 6 } },
      { week: 5, kind: "build", sessions: 2, targets: { chest: 6, triceps: 6, quads: 8, glutes: 8, "upper-back": 6, lats: 6 } },
      { week: 6, kind: "build", sessions: 2, targets: { chest: 6, triceps: 6, quads: 8, glutes: 8, "upper-back": 6, lats: 6 } },
      { week: 7, kind: "build", sessions: 2, targets: { chest: 6, triceps: 6, quads: 8, glutes: 8, "upper-back": 6, lats: 6 } },
    ],
    days: [
      { day: "mon", focus: "push", slots: [{ pattern: "horizontal_push", adaptation: "strength", sets: 3 }, { pattern: "squat", adaptation: "strength", sets: 4 }, { pattern: "horizontal_pull", adaptation: "hypertrophy", sets: 3 }] },
    ],
    ...over,
  };
}

/** A logged session (get_workout_history shape, as captured). */
export function session(date: string, exercises: { name: string; exerciseId?: string; sets: number; weight?: number; reps?: number }[]): SnapshotSession {
  return {
    date,
    weightUnit: "lbs",
    exercises: exercises.map((e) => ({
      exerciseId: e.exerciseId ?? "",
      name: e.name,
      muscle: "",
      sets: Array.from({ length: e.sets }, () => ({ weight: e.weight ?? null, reps: e.reps ?? 8, rpe: null })),
    })),
  };
}

export function fakeGhBin(): string {
  const { chmodSync, mkdtempSync, writeFileSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os") as typeof import("node:os");
  const bin = mkdtempSync(join(tmpdir(), "fake-gh-"));
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\ncase "$*" in *"-X POST"*) echo '{"html_url": "https://github.com/o/r/pull/7"}'; exit 0;; esac\nif [ -z "$FAKE_PRS" ]; then echo "HTTP 401" >&2; exit 1; fi\nprintf '%s\\n' "$FAKE_PRS"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

/** A merged pull request as GitHub's REST API lists it. */
export function mergedPr(id: string, mergeSha: string): Record<string, unknown> {
  return { number: 7, merged_at: "2026-10-14T13:00:00Z", merge_commit_sha: mergeSha, head: { ref: `proposal/${id}` }, base: { ref: "main" } };
}
