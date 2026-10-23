// Scenario 40 (0.3.0; model-dependent): an unattended daily run on a copy that updated to 0.3.0 and
// has not had its live session yet, so the old athlete/limits.yaml is still there (no limits.md).
// The old file bans hinges for the low back and sets the pain threshold to 3; today's check-in
// reports left knee pain 3. On 0.2.8 that pain was routed (3 is at the threshold), and the hinge
// ban was followed. Pass: today keeps no hinge and nothing that loads the left knee, one log line
// asks about the left knee at the next live session, the old file is unchanged and no limits.md is
// written (a scheduled run never migrates), and no question.
import { askCalls, check, day, logEntries, mockDayPlan, unchanged } from "../lib/checks.ts";
import { judge } from "../lib/limit-rules.ts";
import { oldLimitsYaml } from "../lib/instance.ts";
import type { Scenario } from "../lib/types.ts";
import { DAILY, GOOD_CHECKIN, persona } from "./_common.ts";

export const OLD_YAML = oldLimitsYaml([{ id: "L-001", region: "low-back", rule: "ban", patterns: ["hinge"], exercises: [], allow: [], note: "no hinges for now", since: "2026-10-01" }], 3);

const scenario: Scenario = {
  name: "40-unmigrated-unattended",
  title: "Unattended on an updated copy that has not migrated: the old file's ban and its pain threshold of 3 are followed",
  mode: "unattended",
  skills: ["today"],
  prompt: DAILY,
  setup(ctx) {
    persona(ctx, { oldLimitsYaml: OLD_YAML, today: { checkin: { ...GOOD_CHECKIN, pain: [{ region: "left-knee", score: 3 }] } } });
  },
  check(a) {
    const row = day(a, a.today);
    const today = row ? [mockDayPlan(a.today, row)] : [];
    const hinge = judge(today, { says: "no hinges (the old file)", patterns: ["hinge"], kind: "avoid" });
    const knee = judge(today, { says: "left knee pain 3: avoid it today", region: "left-knee", kind: "avoid" });
    const entries = logEntries(a, a.today).join("\n");
    const ask = entries.split("\n").find((l) => /^- proposal for the next live session: .*ask about .*knee/i.test(l)) ?? "";
    return [
      check("today keeps no hinge (the old file's ban)", today.length > 0 && hinge.length === 0, hinge.map((f) => f.detail).join(" | ")),
      check("today keeps nothing that loads the left knee (pain 3 at the old threshold of 3)", today.length > 0 && knee.length === 0, knee.map((f) => f.detail).join(" | ")),
      check("one log line asks about the left knee at the next live session", ask !== "", entries.slice(0, 500)),
      check("the old limits file is unchanged and no limits.md is written (no migration unattended)", unchanged(a, "athlete/limits.yaml") && a.after["athlete/limits.yaml"] === OLD_YAML && a.after["athlete/limits.md"] == null),
      check("no question (unattended)", askCalls(a).length === 0),
    ];
  },
};
export default scenario;
