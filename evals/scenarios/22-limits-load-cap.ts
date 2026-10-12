// Scenario 22: a load cap (low back: hinges at most 135 lbs). The block's Romanian Deadlift is
// at 155 lbs, so next week must lower it or swap it. See _limits.ts.
import { limitsScenario } from "./_limits.ts";

export default limitsScenario("22-limits-load-cap", "Limits followed: hinges capped at 135 lbs, next week planned", {
  id: "L-001",
  region: "low-back",
  rule: "cap",
  patterns: ["hinge"],
  max_load: { value: 135, unit: "lbs" },
  note: "Hinges at most 135 lbs",
  since: "2026-10-01",
});
