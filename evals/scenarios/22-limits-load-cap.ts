// Scenario 22: a weight in words (keep overhead pressing at 50 lb or less). The block's Overhead
// Press is at 95 lbs, so next week must lower it or swap it. The scorer checks every set of
// overhead pressing, warm-ups included. See _limits.ts.
import { limitsScenario } from "./_limits.ts";

export default limitsScenario(
  "22-limits-load-cap",
  "Limits followed: overhead pressing at 50 lb or less (in words), next week planned",
  "- Left shoulder: keep overhead pressing at 50 lb or less on every set, warm-ups included. (since 2026-10-01)",
  { says: "overhead pressing at 50 lb or less", patterns: ["overhead_press"], kind: "load", max: 50, unit: "lbs" },
);
