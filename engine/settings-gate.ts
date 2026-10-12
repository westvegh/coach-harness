// The urgent gate's registration in .claude/settings.json (contracts §10, §24). After any
// update the effective hooks must include `urgent-gate` with `onFailure: "block"`: `update`
// merges the template's entry into a customized settings file, and `config-check` reports a
// missing or changed registration. Hooks in .claude/settings.local.json that still point at
// the v0.1 guard stubs are harmless (the stubs allow everything); they are reported.
import { URGENT_GATE_MATCHER } from "../.claude/hooks/urgent-list.ts";

export const URGENT_GATE_FILE = ".claude/hooks/urgent-gate.ts";
export const URGENT_GATE_COMMAND = `node "$CLAUDE_PROJECT_DIR/${URGENT_GATE_FILE}"`;
const GUARD_STUBS = [".claude/hooks/guard-writes.ts", ".claude/hooks/guard-files.ts"];

type Hook = { type?: unknown; command?: unknown; timeout?: unknown; onFailure?: unknown };
type Entry = { matcher?: unknown; hooks?: unknown };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hooksOf = (e: unknown): Hook[] => (isObj(e) && Array.isArray(e.hooks) ? (e.hooks.filter(isObj) as Hook[]) : []);
const runsGate = (h: Hook) => typeof h.command === "string" && h.command.includes(`/${URGENT_GATE_FILE}`);

function parse(text: string, where: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${where} is not JSON`);
  }
  if (!isObj(raw)) throw new Error(`${where} must be a JSON object`);
  return raw;
}

/** Why the settings do not register the urgent gate correctly. Empty when they do. */
export function urgentGateProblems(text: string | null, where = ".claude/settings.json"): string[] {
  if (text === null) return [`${where} is missing, so the urgent-gate hook is not registered`];
  let s: Record<string, unknown>;
  try {
    s = parse(text, where);
  } catch (e) {
    return [(e as Error).message];
  }
  const pre = isObj(s.hooks) && Array.isArray(s.hooks.PreToolUse) ? (s.hooks.PreToolUse as Entry[]) : [];
  const entries = pre.filter((e) => hooksOf(e).some(runsGate));
  if (entries.length === 0) return [`${where} does not register the urgent-gate hook (PreToolUse, ${URGENT_GATE_FILE})`];
  const problems: string[] = [];
  const e = entries[0];
  const h = hooksOf(e).find(runsGate)!;
  if (e.matcher !== URGENT_GATE_MATCHER) problems.push(`${where}: the urgent-gate matcher changed (expected ${URGENT_GATE_MATCHER})`);
  if (h.onFailure !== "block") problems.push(`${where}: the urgent-gate hook must set "onFailure": "block"`);
  if (typeof h.timeout !== "number" || h.timeout > 10) problems.push(`${where}: the urgent-gate hook needs a timeout of 10 s or less`);
  return problems;
}

/** The template's urgent-gate PreToolUse entry, or null when the template has none. */
function templateEntry(templateText: string): Entry | null {
  const t = parse(templateText, "the template's .claude/settings.json");
  const pre = isObj(t.hooks) && Array.isArray(t.hooks.PreToolUse) ? (t.hooks.PreToolUse as Entry[]) : [];
  return pre.find((e) => hooksOf(e).some(runsGate)) ?? null;
}

/**
 * The user's settings with the template's urgent-gate entry merged in: any stale urgent-gate
 * entry is replaced, every other setting stays. Null when no merge is needed (the user's
 * file is correct, or the template has no urgent-gate entry).
 */
export function mergeUrgentGate(userText: string, templateText: string): string | null {
  const entry = templateEntry(templateText);
  if (!entry || urgentGateProblems(userText).length === 0) return null;
  const u = parse(userText, ".claude/settings.json");
  const hooks = isObj(u.hooks) ? u.hooks : (u.hooks = {});
  const pre = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as Entry[]) : [];
  hooks.PreToolUse = [...pre.filter((e) => !hooksOf(e).some(runsGate)), structuredClone(entry)];
  return JSON.stringify(u, null, 2) + "\n";
}

/** Hook commands in a settings file that point at the v0.1 guard stubs (harmless; reported). */
export function guardStubHooks(text: string | null): string[] {
  if (text === null) return [];
  let s: Record<string, unknown>;
  try {
    s = parse(text, ".claude/settings.local.json");
  } catch {
    return [];
  }
  if (!isObj(s.hooks)) return [];
  const out: string[] = [];
  for (const list of Object.values(s.hooks)) {
    if (!Array.isArray(list)) continue;
    for (const e of list) for (const h of hooksOf(e)) if (typeof h.command === "string" && GUARD_STUBS.some((g) => (h.command as string).includes(g))) out.push(h.command);
  }
  return out;
}
