// Hook bootstrap probes (docs/contracts.md §20 item 27). In a fresh copy
// of the template (no node_modules, no coach.yaml), the runner feeds the instance's own
// hooks one file edit and one Tally write, the way Claude Code would, before the model
// runs. The hooks must load with built-ins only: the edit is allowed, the write is denied.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MOCK_SERVER } from "./instance.ts";

export type Probe = { name: string; hook: string; tool: string; exitCode: number | null; decision: "allow" | "deny" | "block"; stdout: string; stderr: string };

/** What a PreToolUse hook decided: exit 2 blocks; a deny decision on stdout denies; else allow. */
export function hookDecision(exitCode: number | null, stdout: string): Probe["decision"] {
  if (exitCode === 2) return "block";
  if (exitCode !== 0) return "block";
  for (const line of stdout.split("\n")) {
    try {
      const v = JSON.parse(line);
      if (v?.hookSpecificOutput?.permissionDecision === "deny") return "deny";
    } catch {
      /* not JSON */
    }
  }
  return "allow";
}

function runHook(root: string, name: string, hook: string, input: Record<string, unknown>): Probe {
  const r = spawnSync(process.execPath, [join(root, ".claude/hooks", hook)], {
    cwd: root,
    input: JSON.stringify({ session_id: "eval-probe", cwd: root, hook_event_name: "PreToolUse", permission_mode: "default", ...input }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, COACH_UNATTENDED: "" },
    timeout: 20_000,
  });
  return { name, hook, tool: String(input.tool_name), exitCode: r.status, decision: hookDecision(r.status, r.stdout ?? ""), stdout: (r.stdout ?? "").slice(0, 2000), stderr: (r.stderr ?? "").slice(0, 2000) };
}

export type BootstrapState = { nodeModules: boolean; coachYaml: boolean; probes: Probe[] };

/** Runs the probes against an instance. Call it before the model run. */
export function bootstrapProbes(root: string): BootstrapState {
  const state = { nodeModules: existsSync(join(root, "node_modules")), coachYaml: existsSync(join(root, "coach.yaml")) };
  const probes = [
    runHook(root, "a file edit before npm ci and before coach.yaml", "guard-files.ts", {
      tool_name: "Write",
      tool_input: { file_path: join(root, "athlete/brief.md"), content: "# Athlete brief\n" },
    }),
    runHook(root, "a file edit (Edit) before npm ci and before coach.yaml", "guard-files.ts", {
      tool_name: "Edit",
      tool_input: { file_path: join(root, "README.md"), old_string: "coach", new_string: "coach" },
    }),
    runHook(root, "a Tally write before npm ci and before coach.yaml", "guard-writes.ts", {
      tool_name: `mcp__${MOCK_SERVER}__plan_workout_day`,
      tool_input: { date: "2026-10-12", timezone: "America/Los_Angeles", exercises: [{ exerciseId: "goblet_squat", name: "Goblet Squat", suggestedSets: 3, suggestedReps: 8 }] },
    }),
  ];
  return { ...state, probes };
}
