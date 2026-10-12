// Run mode (contracts §7, §15): unattended for cloud routines and Mac launchd runs.

export type RunMode = "interactive" | "unattended";

/**
 * `unattended` when CLAUDE_CODE_REMOTE is set (cloud routines set it to "true"), or when
 * COACH_UNATTENDED is set (the Mac launchd template sets it to 1). Unattended is the
 * stricter mode, so any value counts as set except an empty string, and "0" for
 * COACH_UNATTENDED.
 */
export function mode(env: NodeJS.ProcessEnv = process.env): RunMode {
  const remote = env.CLAUDE_CODE_REMOTE;
  if (remote !== undefined && remote !== "") return "unattended";
  const coach = env.COACH_UNATTENDED;
  if (coach !== undefined && coach !== "" && coach !== "0") return "unattended";
  return "interactive";
}

/** The markers of an unattended run. Any non-empty value counts. */
export const UNATTENDED_MARKERS = ["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED"];

/** The first unattended marker that is set, or null in an interactive run. */
export function unattendedMarker(env: NodeJS.ProcessEnv = process.env): string | null {
  return UNATTENDED_MARKERS.find((k) => (env[k] ?? "") !== "") ?? null;
}
