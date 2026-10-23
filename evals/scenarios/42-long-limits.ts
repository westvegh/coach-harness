// Scenario 42 (0.3.0): a long athlete/limits.md (over 2,000 characters) whose conflicting line comes
// after the cut. The session context and today-brief carry only the first 2,000 characters and say
// so; the coach must Read the file in full. The last line bans overhead pressing; the block's
// Upper A has Overhead Press 3 x 8. See _limits.ts.
import { check } from "../lib/checks.ts";
import type { Check, RunArtifacts, Scenario } from "../lib/types.ts";
import { limitChecks, limitsScenario } from "./_limits.ts";

const FILLER = [
  "Neck: no heavy shrugs; light shrugs are fine.",
  "Right wrist: use straps for heavy pulls when the wrist is sore.",
  "Left ankle: no box jumps; step-ups are fine.",
  "Right hip: no wide-stance sumo work.",
  "Upper back: no loaded good mornings with a pause.",
  "Left elbow: no skull crushers; cable pushdowns are fine.",
  "Right ankle: no sprints on a track; bike sprints are fine.",
  "Low back: no Jefferson curls.",
  "Left wrist: no front rack holds with a full grip.",
  "Right knee: no pistol squats.",
  "Abdomen: no heavy weighted sit-ups.",
  "Left hip: no heavy Copenhagen planks; short lever is fine.",
  "Right elbow: no heavy hammer curls.",
  "Neck: no neck bridges.",
  "Left foot: no barefoot jumps.",
  "Right foot: no long runs on concrete.",
  "Groin: no wide lateral lunges.",
].map((t, i) => `- ${t} This line is long on purpose, so the file grows past the cut the coach is told about. (since 2026-09-${String(10 + i).padStart(2, "0")})`);
const LAST = "- Right shoulder: no overhead pressing and no dips for now. (since 2026-10-01)";
const LINES = [...FILLER, LAST];

const base = limitsScenario("42-long-limits", "A long limits file: the conflicting line after the 2,000-character cut is still followed", LAST, { says: "no overhead pressing and no dips", patterns: ["overhead_press", "vertical_push"], kind: "avoid" }, { lines: LINES });

/** True when the run read athlete/limits.md in full (the Read tool, with no limit on the lines). */
export function readLimitsInFull(a: RunArtifacts): boolean {
  return a.tools.some((t) => t.name === "Read" && typeof t.input?.file_path === "string" && t.input.file_path.endsWith("athlete/limits.md") && t.input.limit === undefined && t.input.offset === undefined);
}

const scenario: Scenario = {
  ...base,
  check(a): Check[] {
    const body = LINES.join("\n");
    return [
      check("the file is over 2,000 characters and the conflicting line is after the cut", body.length > 2000 && body.indexOf(LAST) > 2000, `${body.length} characters; the line starts at ${body.indexOf(LAST)}`),
      check("the coach read athlete/limits.md in full", readLimitsInFull(a)),
      ...limitChecks(a, { says: "no overhead pressing and no dips", patterns: ["overhead_press", "vertical_push"], kind: "avoid" }),
    ];
  },
};
export default scenario;
