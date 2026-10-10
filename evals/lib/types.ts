// Types shared by the eval runner and the scenarios.
import type { MockState } from "../mock-tally/client.ts";
import type { ApproverRule } from "./instance.ts";
import type { BootstrapState } from "./probes.ts";

export type Mode = "interactive" | "unattended";

/** What a scenario's setup can see and change before the run. */
export type SetupContext = {
  /** The temp copy of the repo (the athlete instance). */
  root: string;
  /** Today in the athlete's timezone, and dates around it. */
  today: string;
  tz: string;
  /** The mock Tally state; the runner writes it after setup. */
  mock: MockState;
  /** Writes a file under root (parent folders created). */
  write(rel: string, text: string): void;
  /** Reads a file under root. */
  read(rel: string): string;
  /** JSON the fake `gh` prints for `gh api repos/…/pulls?state=closed…` (default []). */
  ghPulls(prs: unknown[]): void;
  /** Runs git in root. */
  git(...args: string[]): string;
};

export type ToolUse = { id: string; name: string; input: any; result?: { isError: boolean; text: string } };

/** Everything a run leaves behind. Checks are pure functions of this. */
export type RunArtifacts = {
  scenario: string;
  run: number;
  mode: Mode;
  today: string;
  tz: string;
  /** The mock state before and after the run. */
  seed: MockState;
  mock: MockState & { calls: { at: string; tool: string; args: any; result?: any; error?: string }[] };
  /** Files under root before and after (only the watched paths). */
  before: Record<string, string | null>;
  after: Record<string, string | null>;
  /** Commits made during the run (newest first) and the branches that exist after it. */
  commits: { sha: string; subject: string; files: string[] }[];
  branches: string[];
  /** Commits that reached the fake remote's main. */
  pushedMain: string[];
  /** The fake `gh` invocations (argv after `gh`). */
  gh: string[][];
  /** The model's tool calls with their results, in order. */
  tools: ToolUse[];
  /**
   * Every assistant text block of the run, in order (a Stop hook can add a message after
   * the answer; the user sees them all). Older artifacts lack it: see replyText().
   */
  messages?: { afterTool: number; text: string }[];
  /** The final answer text and the run's metadata. */
  result: { text: string; isError: boolean; turns: number | null; costUsd: number | null; durationMs: number; exitCode: number | null; aborted: string | null };
  /** The permission prompts the scripted user answered (interactive scenarios). */
  prompts: { tool_name: string; input: any; behavior: string }[];
  /** Guard verdicts left on disk (a denied call is never consumed by log-writes). */
  verdicts: any[];
  /** The public export the instance was copied from (scripts/export-public.sh). */
  instance?: { exportSha: string; exportDirty: boolean; fresh: boolean };
  /** Fresh scenarios: the hook bootstrap probes run before the model (lib/probes.ts). */
  bootstrap?: BootstrapState;
};

/** A check result; `data` holds facts the report shows (for example which path a run took). */
export type Check = { name: string; ok: boolean; detail?: string; data?: Record<string, unknown> };

export type Scenario = {
  name: string;
  title: string;
  mode: Mode;
  /** Skills the scenario relies on; the runner reports the missing ones. */
  skills: string[];
  /** The mock's T2/T3 switches. T2 unset: it follows the adapter's declared capabilities. */
  mock?: { t2?: boolean; t3?: boolean };
  /** Relative paths whose content is captured before and after the run. */
  watch?: string[];
  /** The `claude -p` prompt. */
  prompt: string | ((ctx: { today: string }) => string);
  /**
   * Interactive scenarios: the scripted user's answers to permission prompts (the
   * guard's "ask"). First match wins; no match is a "no".
   */
  approver?: ApproverRule[];
  /** Extra tools to allow (beyond the defaults). */
  allowedTools?: string[];
  /**
   * A fresh copy of the template: no node_modules (the model runs `npm ci` as setup says).
   * The runner probes the hook bootstrap before the model runs (RunArtifacts.bootstrap).
   */
  fresh?: boolean;
  setup(ctx: SetupContext): void;
  check(a: RunArtifacts): Check[];
};
