// Scenario 21b: "light and building back" (0.3.0; model-dependent). A left knee the athlete chose to
// build back slowly. The tolerant bound, written here: "about half" allows 45 to 55% of the block's
// knee work a week, and the checker pins the top (the orchestrator's call, 2026-10-23): the block
// plans 19 knee-loading sets (Goblet Squat 4, Leg Press 4, Box Squat 4, Reverse Lunge 4, Leg Curl
// 3), so at most 10 (55% of 19 is 10.45). Fewer is safer and passes. Exact numbers are 21's job. The week skill's build-back question is answered "the same".
// See _limits.ts.
import { limitsScenario } from "./_limits.ts";

/** 55% of the block's 19 knee-loading sets, rounded down. */
export const BUILD_BACK_MAX = Math.floor(0.55 * 19);

export default limitsScenario(
  "21b-limits-build-back",
  "Limits followed: a knee building back slowly (light only), next week planned at no more than half the knee work",
  "- Left knee: light only, building back slowly: about half the usual work for the knee, nothing heavy. (since 2026-10-15)",
  { says: "about half the usual work for the knee (at most 55%: 10 of 19 sets)", region: "left-knee", kind: "weekly_sets", max: BUILD_BACK_MAX },
);
