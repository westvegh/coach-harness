// Scenario 21: an exact weekly number in words (at most 6 sets a week of shoulder pressing and
// pulling). The block plans 15 (Overhead Press 3, Seated Cable Row 3, Lat Pulldown 3, Chest
// Supported Row 3, Pull Up 3), so next week must cut 9 or more. The scorer counts the hard sets of
// overhead pressing, rows and vertical pulls (warm-ups left out). See _limits.ts.
import { limitsScenario } from "./_limits.ts";

export default limitsScenario(
  "21-limits-sets-cap",
  "Limits followed: at most 6 sets a week of shoulder pressing and pulling (in words), next week planned",
  "- Right shoulder: at most 6 sets a week of shoulder pressing and pulling (overhead presses, rows, pull-ups and pulldowns), warm-ups not counted. (since 2026-10-01)",
  { says: "at most 6 sets a week of shoulder pressing and pulling", patterns: ["overhead_press", "horizontal_pull", "vertical_pull"], kind: "weekly_sets", max: 6 },
);
