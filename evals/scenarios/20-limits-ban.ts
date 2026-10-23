// Scenario 20: a ban in plain words (right shoulder: no overhead pressing and no dips). The block's
// Upper A has Overhead Press 3 x 8, so next week must leave it out or swap it. The scorer's rule
// is the line's meaning, stated in code (the old file's patterns: overhead_press, vertical_push).
// See _limits.ts.
import { limitsScenario } from "./_limits.ts";

export default limitsScenario(
  "20-limits-ban",
  "Limits followed: no overhead pressing (in plain words), next week planned",
  "- Right shoulder: no overhead pressing and no dips for now. (since 2026-10-01)",
  { says: "no overhead pressing and no dips", patterns: ["overhead_press", "vertical_push"], kind: "avoid" },
);
