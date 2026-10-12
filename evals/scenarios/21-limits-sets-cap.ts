// Scenario 21: a weekly set cap (left knee: squats, lunges and leg presses at most 8 hard sets a
// week). The block plans 16 (Goblet Squat 4, Leg Press 4, Box Squat 4, Reverse Lunge 4), so
// next week must cut them. See _limits.ts.
import { limitsScenario } from "./_limits.ts";

export default limitsScenario("21-limits-sets-cap", "Limits followed: knee-loading sets capped at 8 a week, next week planned", {
  id: "L-001",
  region: "left-knee",
  rule: "cap",
  patterns: ["squat", "lunge", "leg_press"],
  max_sets_per_week: 8,
  note: "Squats, lunges and leg presses at most 8 hard sets a week",
  since: "2026-10-01",
});
