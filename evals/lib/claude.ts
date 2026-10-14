// Runs `claude -p` for one scenario run on the user's claude.ai login,
// isolated from their real Tally account (decided: option A):
//   1. --strict-mcp-config with an MCP config that holds the mock only;
//   2. ENABLE_CLAUDEAI_MCP_SERVERS=false, and no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN;
//   3. --disallowedTools for the claude.ai servers and every real Tally name form;
//   4. a preflight on the stream-json init event: any MCP server or tool that is not the
//      mock's aborts the run before the model acts (the scenario is an error, not a fail).
import { spawn } from "node:child_process";
import { APPROVER_SERVER, MOCK_SERVER } from "./instance.ts";
import type { ToolUse } from "./types.ts";

export const MOCK_TOOLS = [
  "get_training_context",
  "get_planned_workout",
  "get_workout_history",
  "get_exercise_progress",
  "search_exercises",
  "plan_workout_day",
  "plan_workout_range",
  "update_planned_workout",
  "move_planned_workout",
  "skip_planned_workout",
  "delete_planned_workout",
  "update_training_limits",
].map((t) => `mcp__${MOCK_SERVER}__${t}`);

export const BASE_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Skill", "Agent", "Task", "TodoWrite"];

/** Every real Tally and claude.ai server name form (spike #10), whole-server rules. */
export const DISALLOWED = [
  "mcp__claude_ai_*",
  "mcp__claude_ai_Tally_Workout",
  "mcp__claude_ai_Tally",
  "mcp__Tally_Workout",
  "mcp__Tally",
  "mcp__tally",
  "WebFetch",
  "WebSearch",
];

/** Environment keys removed from the child: auth that would bypass the login, and this session's own state. */
const DROP_ENV = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_PROJECT_DIR|CLAUDE_EFFORT|CLAUDE_PLUGIN_DATA|COACH_.*|MOCK_.*)$/;

/**
 * The preflight (safeguard 4): null when the init event shows only the mock's MCP server
 * and tools; else the reason to abort. A missing or malformed init event fails closed.
 */
export function preflight(init: unknown, servers: string[] = [MOCK_SERVER]): string | null {
  if (!init || typeof init !== "object") return "no init event";
  const e = init as { type?: unknown; subtype?: unknown; tools?: unknown; mcp_servers?: unknown };
  if (e.type !== "system" || e.subtype !== "init") return "the first event is not system/init";
  if (!Array.isArray(e.tools)) return "the init event lists no tools";
  const prefixes = servers.map((s) => `mcp__${s}__`);
  const foreignTools = e.tools.filter((t) => typeof t !== "string" || (t.startsWith("mcp__") && !prefixes.some((p) => t.startsWith(p))));
  if (foreignTools.length) return `foreign MCP tools: ${foreignTools.slice(0, 8).join(", ")}`;
  if (!Array.isArray(e.mcp_servers)) return "the init event lists no mcp_servers";
  const foreignServers = e.mcp_servers.filter((s) => !s || typeof s !== "object" || !servers.includes(String((s as { name?: unknown }).name)));
  if (foreignServers.length) return `foreign MCP servers: ${foreignServers.map((s) => JSON.stringify((s as { name?: unknown })?.name)).join(", ")}`;
  return null;
}

/** A hook lifecycle event, which the stream may emit before the init event. */
export function isHookEvent(ev: unknown): boolean {
  const e = ev as { type?: unknown; subtype?: unknown } | null;
  return !!e && e.type === "system" && typeof e.subtype === "string" && e.subtype.startsWith("hook_");
}

/** One assistant text block, and how many tool uses came before it in the run. */
export type Message = { afterTool: number; text: string };

/** The assistant text blocks of a stream, in order: everything the user sees, not only the final message. */
export function messagesFromEvents(events: unknown[]): Message[] {
  const out: Message[] = [];
  let tools = 0;
  for (const ev of events as any[]) {
    if (ev?.type !== "assistant" || !Array.isArray(ev.message?.content)) continue;
    for (const b of ev.message.content) {
      if (b?.type === "tool_use") tools++;
      else if (b?.type === "text" && typeof b.text === "string") out.push({ afterTool: tools, text: b.text });
    }
  }
  return out;
}

/**
 * One assistant API response (V7): its message id, the subagent it belongs to (the stream's
 * `parent_tool_use_id`; null on the main thread), when it was first seen, and its tool uses.
 */
export type ApiMessage = { id: string; parent: string | null; at: number | null; tools: string[] };

/**
 * The assistant API responses of a stream, in order, one per message id: stream-json sends one
 * `assistant` event per content block, all with the same message id. `seen`: ids an earlier turn
 * already counted (a resumed session that replays a message counts it once).
 */
export function apiMessagesFromEvents(events: unknown[], seen: Set<string> = new Set()): ApiMessage[] {
  const out: ApiMessage[] = [];
  const byId = new Map<string, ApiMessage>();
  for (const ev of events as any[]) {
    if (ev?.type !== "assistant" || !ev.message) continue;
    const id = typeof ev.message.id === "string" ? ev.message.id : null;
    if (!id || seen.has(id)) continue;
    let m = byId.get(id);
    if (!m) {
      m = { id, parent: typeof ev.parent_tool_use_id === "string" ? ev.parent_tool_use_id : null, at: typeof ev._rt === "number" ? ev._rt : null, tools: [] };
      byId.set(id, m);
      out.push(m);
    }
    for (const b of Array.isArray(ev.message.content) ? ev.message.content : []) if (b?.type === "tool_use" && typeof b.id === "string" && !m.tools.includes(b.id)) m.tools.push(b.id);
  }
  for (const m of out) seen.add(m.id);
  return out;
}

/** Main-thread API calls (subagent responses left out). */
export const mainCalls = (msgs: ApiMessage[]): number => msgs.filter((m) => m.parent === null).length;

export type ClaudeRun = {
  tools: ToolUse[];
  text: string;
  messages: Message[];
  isError: boolean;
  turns: number | null;
  costUsd: number | null;
  durationMs: number;
  exitCode: number | null;
  aborted: string | null;
  events: unknown[];
  stderr: string;
  /** The session id from the init event (a follow-up turn resumes it). */
  sessionId: string | null;
  /** V7: the assistant API responses of this turn, one per message id. */
  apiMessages?: ApiMessage[];
};

export type ClaudeOptions = {
  cwd: string;
  prompt: string;
  model: string;
  mcpConfig: string;
  unattended: boolean;
  allowedTools: string[];
  pathPrefix: string;
  env: Record<string, string>;
  timeoutMs: number;
  /**
   * Interactive scenarios: permission prompts (the guard's "ask") go to the scripted
   * user, the evalapprover MCP server in the MCP config (lib/approver.mjs), under
   * permission mode default. Without it: dontAsk, so every "ask" is a denial.
   */
  approver?: boolean;
  /** A settings file passed with --settings (the scripted-answer hook). */
  settings?: string;
  /** A session id to resume (a follow-up turn of the same conversation). */
  resume?: string;
  /** For tests: the command to run instead of `claude`. */
  command?: string[];
};

export function claudeArgs(o: ClaudeOptions): string[] {
  return [
    "-p",
    o.prompt,
    "--model",
    o.model,
    "--permission-mode",
    o.approver ? "default" : "dontAsk",
    ...(o.approver ? ["--permission-prompt-tool", `mcp__${APPROVER_SERVER}__approve`] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config",
    o.mcpConfig,
    "--setting-sources",
    "project,local",
    ...(o.settings ? ["--settings", o.settings] : []),
    ...(o.resume ? ["--resume", o.resume] : []),
    // The permission proxy passes no allowed tools: only the project's own allow rules apply.
    ...(o.allowedTools.length ? ["--allowedTools", ...o.allowedTools] : []),
    "--disallowedTools",
    ...DISALLOWED,
  ];
}

export function childEnv(o: ClaudeOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DROP_ENV.test(k)) env[k] = v;
  return {
    ...env,
    ...o.env,
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    GIT_TERMINAL_PROMPT: "0",
    PATH: `${o.pathPrefix}:${env.PATH ?? ""}`,
    ...(o.unattended ? { COACH_UNATTENDED: "1" } : {}),
  };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("\n");
  return "";
}

/** Runs claude and parses its stream; kills it at once when the preflight fails. */
export function runClaude(o: ClaudeOptions): Promise<ClaudeRun> {
  const [cmd, ...pre] = o.command ?? ["claude"];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, [...pre, ...claudeArgs(o)], { cwd: o.cwd, env: childEnv(o), stdio: ["ignore", "pipe", "pipe"] });
    const run: ClaudeRun = { tools: [], text: "", messages: [], isError: false, turns: null, costUsd: null, durationMs: 0, exitCode: null, aborted: null, events: [], stderr: "", sessionId: null };
    const byId = new Map<string, ToolUse>();
    let buf = "";
    let first = true;
    const abort = (why: string) => {
      if (run.aborted) return;
      run.aborted = why;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => abort(`timeout after ${o.timeoutMs} ms`), o.timeoutMs);
    const onEvent = (ev: any) => {
      // After an abort nothing more is read: the process is being killed.
      if (run.aborted) return;
      // V4: every stream event carries its receive time (the setup checks measure the waits).
      const now = Date.now();
      if (ev && typeof ev === "object") ev._rt = now;
      run.events.push(ev);
      if (first) {
        // Hook events (SessionStart) come before the init event; anything else is an abort.
        if (isHookEvent(ev)) return;
        first = false;
        if (typeof ev?.session_id === "string") run.sessionId = ev.session_id;
        const why = preflight(ev, o.approver ? [MOCK_SERVER, APPROVER_SERVER] : [MOCK_SERVER]);
        if (why) return abort(`preflight: ${why}`);
      }
      if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b.type === "tool_use") {
            // V7: the link from each tool use to its API response and thread.
            const t: ToolUse = { id: b.id, name: b.name, input: b.input, at: now, ...(typeof ev.message.id === "string" ? { messageId: ev.message.id } : {}), parent: typeof ev.parent_tool_use_id === "string" ? ev.parent_tool_use_id : null };
            byId.set(b.id, t);
            run.tools.push(t);
          }
        }
      }
      if (ev.type === "user" && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b.type === "tool_result" && byId.has(b.tool_use_id)) {
            const t = byId.get(b.tool_use_id)!;
            t.result = { isError: b.is_error === true, text: resultText(b.content) };
            t.resultAt = now;
          }
        }
      }
      if (ev.type === "result") {
        run.text = typeof ev.result === "string" ? ev.result : "";
        run.isError = ev.is_error === true;
        run.turns = typeof ev.num_turns === "number" ? ev.num_turns : null;
        run.costUsd = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : null;
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: unknown;
        try {
          ev = JSON.parse(line);
        } catch {
          if (first) abort("preflight: the first output line is not JSON");
          continue;
        }
        onEvent(ev);
        if (run.aborted?.startsWith("preflight")) return;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (run.stderr += c));
    child.on("close", (code) => {
      run.apiMessages = apiMessagesFromEvents(run.events);
      clearTimeout(timer);
      run.messages = messagesFromEvents(run.events);
      if (first && !run.aborted) run.aborted = "preflight: no init event";
      run.exitCode = code;
      run.durationMs = Date.now() - started;
      resolve(run);
    });
  });
}
