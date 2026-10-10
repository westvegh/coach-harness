// Pure helpers for scenario checks: they read RunArtifacts and never the wording of the
// model's answer, only the state it left behind.
import { parse } from "yaml";
import { loadTaxonomy, classify } from "../../engine/taxonomy.ts";
import type { Taxonomy } from "../../engine/types.ts";
import { REPO } from "./instance.ts";
import type { Check, RunArtifacts, ToolUse } from "./types.ts";

export const MUTATIONS = ["plan_workout_day", "plan_workout_range", "update_planned_workout", "move_planned_workout", "skip_planned_workout", "delete_planned_workout", "update_user_profile", "update_training_limits"];

let TAX: Taxonomy | null = null;
export const taxonomy = (): Taxonomy => (TAX ??= loadTaxonomy({ root: REPO }));

export const check = (name: string, ok: boolean, detail?: string): Check => ({ name, ok, ...(detail ? { detail } : {}) });

/**
 * What the user saw: every assistant text block after tool use `afterTool` (an index into
 * a.tools; -1 for the whole run). Falls back to the final message for older artifacts.
 */
export function replyText(a: RunArtifacts, afterTool = -1): string {
  if (!a.messages) return a.result.text;
  return a.messages
    .filter((m) => m.afterTool > afterTool)
    .map((m) => m.text)
    .join("\n\n");
}

/** Mock calls that are mutations. */
export function mutationCalls(a: RunArtifacts) {
  return a.mock.calls.filter((c) => MUTATIONS.includes(c.tool));
}

/** Did a mutation call change the stored state? (written, updated, moved, deleted). */
export function wroteSomething(c: { result?: any; error?: string }): boolean {
  const r = c.result;
  if (!r || c.error) return false;
  if (Array.isArray(r.results)) return r.results.some((x: any) => x.status === "written");
  return ["updated", "moved", "deleted"].includes(r.status);
}

export const successfulWrites = (a: RunArtifacts) => mutationCalls(a).filter(wroteSomething);

/** Tool uses the model attempted against the mock's Tally tools (any server name form). */
export function tallyToolUses(a: RunArtifacts, suffixes = MUTATIONS): ToolUse[] {
  return a.tools.filter((t) => /^mcp__.*[Tt]ally.*__/.test(t.name) && suffixes.some((s) => t.name.endsWith(`__${s}`)));
}

/** Tool uses the hooks denied (the reason is in the tool result). */
export function deniedToolUses(a: RunArtifacts): ToolUse[] {
  // Claude Code reports a PreToolUse deny as "PreToolUse:<tool> hook error: <reason>"; the guard's reasons start with "coach guard:".
  return a.tools.filter((t) => t.result?.isError && /denied|deny|blocked|not allowed|refus|hook error|coach guard|banned/i.test(t.result.text));
}

export const day = (a: RunArtifacts, date: string) => (a.mock.days as Record<string, any>)[date] ?? null;
export const seedDay = (a: RunArtifacts, date: string) => (a.seed.days as Record<string, any>)[date] ?? null;

/** Exercises as comparable tuples (name, sets, weight). */
export const shape = (row: any) => (row?.exercises ?? []).map((e: any) => [e.name, e.suggestedSets, e.suggestedWeight ?? null]);

/** True when only notes and/or the day name differ (an annotate). */
export function onlyAnnotated(before: any, after: any): boolean {
  if (!before || !after) return before === after;
  return JSON.stringify(before.exercises) === JSON.stringify(after.exercises) && before.status === after.status && before.date === after.date;
}

/** New text appended to the log files during the run. */
export function newLog(a: RunArtifacts): string {
  let out = "";
  for (const [p, text] of Object.entries(a.after)) {
    if (!p.startsWith("athlete/log/") || !p.endsWith(".md") || text === null) continue;
    const before = a.before[p] ?? "";
    out += text.startsWith(before) ? text.slice(before.length) : text;
  }
  return out;
}

/** Log entries (## headers) for a date in the new log text. */
export function logEntries(a: RunArtifacts, date: string): string[] {
  return newLog(a)
    .split(/\n(?=## )/)
    .filter((e) => e.startsWith(`## ${date}`) || e.includes(`\n## ${date}`));
}

export const unchanged = (a: RunArtifacts, rel: string) => a.before[rel] === a.after[rel];

export const yamlOf = (text: string | null | undefined) => (text ? parse(text) : null);

/** Patterns of an exercise (engine classification). */
export function patternsOf(e: { exerciseId?: string; name?: string }) {
  return classify({ exerciseId: e.exerciseId ?? null, name: e.name ?? "" } as any, taxonomy());
}

/** Files created or changed during the run under a folder. */
export function changedUnder(a: RunArtifacts, prefix: string): string[] {
  return Object.keys(a.after).filter((p) => p.startsWith(prefix) && a.after[p] !== null && a.after[p] !== a.before[p] && !p.endsWith(".gitkeep"));
}
