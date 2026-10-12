// Scenario 20: a ban (right shoulder: no overhead pressing). The block's Upper A has Overhead
// Press 3 x 8, so next week must leave it out or swap it. See _limits.ts.
import { limitsScenario } from "./_limits.ts";

export default limitsScenario("20-limits-ban", "Limits followed: a ban on overhead pressing, next week planned", {
  id: "L-001",
  region: "right-shoulder",
  rule: "ban",
  patterns: ["overhead_press", "vertical_push"],
  note: "No overhead pressing for now",
  since: "2026-10-01",
});
