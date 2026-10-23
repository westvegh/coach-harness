// Pure helpers for scenario checks: they read RunArtifacts and never the wording of the
// model's answer, only the state it left behind.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { call as mockCall, readState, versionOf, writeState, type MockState } from "../mock-tally/client.ts";
import { parseCsv } from "../../engine/plans-files.ts";
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

// ---------------------------------------------------------------------------
// v0.2 friction helpers (0.3.0: the limit scorer is evals/lib/limit-rules.ts).
// ---------------------------------------------------------------------------

/** The AskUserQuestion screens of a run (or of tool uses from `fromTool` on). */
export function screens(a: RunArtifacts): NonNullable<RunArtifacts["screens"]> {
  return a.screens ?? [];
}

/** The AskUserQuestion calls the model made, with their index in a.tools. */
export function askCalls(a: RunArtifacts): { i: number; t: ToolUse }[] {
  return a.tools.map((t, i) => ({ i, t })).filter(({ t }) => t.name === "AskUserQuestion");
}

/** The first tool use that changed a file (Write, Edit or a Bash command naming it), or -1. */
export function firstWriteTo(a: RunArtifacts, rel: string): number {
  const name = rel.split("/").pop()!;
  return a.tools.findIndex((t) => {
    const i = t.input ?? {};
    if (["Write", "Edit", "MultiEdit"].includes(t.name)) return typeof i.file_path === "string" && i.file_path.endsWith(rel);
    return t.name === "Bash" && typeof i.command === "string" && i.command.includes(name) && /(>|\btee\b|\bcp\b|\bmv\b|\bsed\b|writeFile)/.test(i.command);
  });
}

/** Agent or Task calls (v0.2 flows run no subagent). */
export const agentCalls = (a: RunArtifacts) => a.tools.filter((t) => t.name === "Agent" || t.name === "Task");

/**
 * A command the coach asked the athlete to type: a `! <cmd>` line, or "type|paste|enter|run
 * this" followed by a node, npm or git command in backticks.
 */
export function typedCommandAsked(text: string): string | null {
  const m = /(^|\n)\s*!\s*(node|npm|git)\b[^\n]*/.exec(text) ?? /\b(type|paste|enter|run this|run the command|you run|please run|you can run|you need to run)\b[^\n]{0,80}`[^`]*\b(node|npm|git)\b[^`]*`/i.exec(text);
  return m ? m[0].trim() : null;
}

/** A mock Tally row as an engine DayPlan (lbs unless the row says otherwise). */
export function mockDayPlan(date: string, row: any): any {
  const ex = (row?.exercises ?? []).map((e: any) => ({
    exerciseId: typeof e.exerciseId === "string" ? e.exerciseId : null,
    name: String(e.name ?? ""),
    muscle: e.muscle ?? null,
    unit: e.weightUnit ?? row.weight_unit ?? "lbs",
    sets: Array.from({ length: Number(e.suggestedSets ?? 0) }, () => ({ reps: e.suggestedReps ?? null, ...(typeof e.suggestedWeight === "number" ? { weight: e.suggestedWeight } : {}) })),
  }));
  return { date, dayName: row?.day_name, status: row?.status === "skipped" ? "skipped" : "planned", source: row?.source ?? "mcp", userModified: !!row?.user_modified, exercises: ex };
}

/** The rows of a plans/ week file (header names as keys). */
export function parseCsvRows(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const [head, ...rest] = rows;
  if (!head) return [];
  return rest.map((cells) => Object.fromEntries(head.map((h, i) => [h.replace(/^﻿/, ""), cells[i] ?? ""])));
}

/** The assistant text of turn `n` (0 is the prompt), from the turn records. */
export function turnText(a: RunArtifacts, n: number): string {
  const t = a.turns ?? [];
  const msgs = a.messages ?? [];
  const from = t[n]?.firstMessage ?? 0;
  const to = t[n + 1]?.firstMessage ?? msgs.length;
  return msgs.slice(from, to).map((m) => m.text).join("\n");
}

/**
 * Replays the run's successful Tally writes, in order, on the seeded mock state (offline:
 * one mock process per call). Each `expectedVersion` is replaced with the replayed row's
 * current version, since versions carry the original write times. Returns the stored days
 * after each write, so a check can judge every intermediate state, not only the last one,
 * and `mismatch` when the replay does not end where the run did.
 */
export function replayWrites(a: RunArtifacts): { steps: { call: number; tool: string; days: Record<string, any> }[]; errors: string[]; mismatch: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "coach-replay-"));
  const state = join(dir, "state.json");
  const steps: { call: number; tool: string; days: Record<string, any> }[] = [];
  const errors: string[] = [];
  try {
    writeState(state, { ...a.seed, calls: [], operations: [] } as MockState);
    const opts = { state, t2: true };
    a.mock.calls.forEach((c, i) => {
      if (!MUTATIONS.includes(c.tool) || !wroteSomething(c)) return;
      const args = JSON.parse(JSON.stringify(c.args ?? {}));
      const rows = readState(state).days;
      const fix = (o: any) => {
        if (o && typeof o === "object" && "expectedVersion" in o && rows[o.date]) o.expectedVersion = versionOf({ id: rows[o.date].id, updated_at: rows[o.date].updated_at });
      };
      fix(args);
      if (Array.isArray(args.days)) args.days.forEach(fix);
      const r = mockCall(opts, c.tool, args);
      if (r.isError) errors.push(`call ${i} ${c.tool} ${String(args.date ?? "")}: ${r.text.slice(0, 160)}`);
      steps.push({ call: i, tool: c.tool, days: readState(state).days });
    });
    const final = readState(state).days;
    const shapeOf = (d: any) => JSON.stringify((d?.exercises ?? []).map((e: any) => [e.name, e.suggestedSets, e.suggestedWeight ?? null]));
    const dates = new Set([...Object.keys(final), ...Object.keys(a.mock.days)]);
    const mismatch = [...dates].filter((d) => shapeOf(final[d]) !== shapeOf((a.mock.days as Record<string, any>)[d]));
    return { steps, errors, mismatch };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The path-like words of a shell command (V4b): split on spaces, quotes, parentheses, `=`, `,` and
 * shell operators; a word with a `/`, or one that starts with `~` or `..`, or the bare word given
 * in `names`; never a URL or an option.
 */
export function pathTokens(command: string, names: string[] = []): string[] {
  return command
    .split(/[\s"'`()=,;|&<>]+/)
    .map((t) => t.replace(/[:]+$/, ""))
    .filter((t) => t && !t.startsWith("-") && !t.includes("://") && (t.includes("/") || t.startsWith("~") || t.startsWith("..") || names.includes(t)));
}
