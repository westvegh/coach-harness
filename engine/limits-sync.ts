// Compares the compiled server rules with Tally's stored limits and returns the
// tightening ops an MCP client may send, plus what only the Tally app can loosen
// (Tally server-limits spec §5.2, §8).
import { CoachError } from "./errors.ts";
import { MAX_RULES, RULE_ID, norm } from "./server-match.ts";
import type { ServerRule } from "./server-match.ts";
import { responsePayload } from "./snapshot.ts";
import { isPlainObject } from "./yaml-file.ts";

export type TightenOp =
  | { op: "add_rule"; rule: ServerRule }
  | { op: "lower_cap"; ruleId: string; maxSetsPerWeek: number }
  | { op: "set_weekly_cap"; maxWeeklySets: number };

/** Tally's `trainingLimits` context field; null when the user has no limits row. */
export type ServerState = { version: number; rules: ServerRule[]; maxWeeklySets?: number | null } | null;

export type AppOnly = {
  ruleId: string | null;
  label: string;
  /** removed: not in limits.yaml; replaced: an older version of a limit; looser_locally: limits.yaml allows more; weekly_cap: no weekly cap in limits.yaml, or a higher one. */
  reason: "removed" | "replaced" | "looser_locally" | "weekly_cap";
  sentence: string;
};

export type SyncResult = { ops: TightenOp[]; appOnly: AppOnly[]; expectedVersion: number | null };

const WHERE = "Tally app: Settings → Training limits";

/** The matching content of a rule: kind and match lists. Ids, labels and cap numbers are not content. */
function contentKey(r: ServerRule): string {
  const set = (xs: string[]) => [...new Set(xs.map(norm))].sort();
  return JSON.stringify([
    r.kind,
    set(r.exerciseIds),
    set(r.keywords),
    set(r.exceptKeywords),
    [...new Set(r.allow.map((a) => `${norm(a.exerciseId)}|${norm(a.name)}`))].sort(),
  ]);
}

/** The id itself when free, else the id plus _2, _3 … (the first one not in use, spec §8). */
function freeId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const id = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    if (!used.has(id)) return id;
  }
}

/**
 * The ops that make Tally at least as strict as the compiled rules (spec §8):
 * - a compiled rule with no server rule of the same content → `add_rule`; when its id is
 *   taken (a changed rule), the new rule gets the next free `<id>_<n>`;
 * - a server cap of the same content above the compiled cap → `lower_cap`;
 * - a compiled weekly cap below the server's (or with none on the server) → `set_weekly_cap`.
 * Every server rule that is absent from the compiled set, or stricter than it (a limit the
 * user loosened or removed in limits.yaml), goes in `appOnly`: only the user can change it,
 * in the Tally app.
 */
export function syncOps(compiled: { rules: ServerRule[]; maxWeeklySets?: number }, server: ServerState): SyncResult {
  const serverRules = server?.rules ?? [];
  const ops: TightenOp[] = [];
  const appOnly: AppOnly[] = [];
  const used = new Set(serverRules.map((r) => r.id));
  const matched = new Set<ServerRule>();
  const replacedBy = new Map<string, string>();

  // compiled rules with the same content are one requirement, with the
  // strictest cap; one op per target rule. Two lowerings of one rule in a batch would
  // loosen the intermediate state, and Tally rejects the whole batch.
  const groups = new Map<string, ServerRule[]>();
  for (const c of compiled.rules) groups.set(contentKey(c), [...(groups.get(contentKey(c)) ?? []), c]);
  const required = [...groups.values()].map((g) => {
    const caps = g.map((c) => c.maxSetsPerWeek).filter((n): n is number => typeof n === "number");
    return { rule: caps.length > 0 ? { ...g[0], maxSetsPerWeek: Math.min(...caps) } : g[0], ids: g.map((c) => c.id) };
  });

  for (const { rule: c, ids } of required) {
    const same = serverRules.filter((s) => contentKey(s) === contentKey(c));
    if (same.length === 0) {
      const id = freeId(c.id, used);
      used.add(id);
      if (id !== c.id) replacedBy.set(c.id, id);
      ops.push({ op: "add_rule", rule: { ...c, id } });
      continue;
    }
    for (const s of same) matched.add(s);
    if (c.kind !== "cap" || c.maxSetsPerWeek === undefined) continue;
    const max = c.maxSetsPerWeek;
    for (const s of same) {
      if (typeof s.maxSetsPerWeek === "number" && s.maxSetsPerWeek < max) {
        appOnly.push({
          ruleId: s.id,
          label: s.label,
          reason: "looser_locally",
          sentence: `Tally caps "${s.label}" (${s.id}) at ${s.maxSetsPerWeek} sets a week, but athlete/limits.yaml allows ${max}. To allow ${max}, raise it in the ${WHERE}.`,
        });
      }
    }
    if (!same.some((s) => typeof s.maxSetsPerWeek === "number" && s.maxSetsPerWeek <= max)) {
      const target = same.find((s) => ids.includes(s.id)) ?? same[0];
      ops.push({ op: "lower_cap", ruleId: target.id, maxSetsPerWeek: max });
    }
  }

  for (const s of serverRules) {
    if (matched.has(s)) continue;
    const newer = replacedBy.get(s.id);
    appOnly.push(
      newer
        ? {
            ruleId: s.id,
            label: s.label,
            reason: "replaced",
            sentence: `Tally still has the old version of "${s.label}" (${s.id}). The new version is added as ${newer}. Remove the old one in the ${WHERE}.`,
          }
        : {
            ruleId: s.id,
            label: s.label,
            reason: "removed",
            sentence: `Tally has the limit "${s.label}" (${s.id}), which athlete/limits.yaml does not have. Remove or relax it in the ${WHERE}.`,
          },
    );
  }

  const w = server?.maxWeeklySets ?? null;
  const cw = compiled.maxWeeklySets;
  if (cw !== undefined && (w === null || w > cw)) ops.push({ op: "set_weekly_cap", maxWeeklySets: cw });
  else if (w !== null && (cw === undefined || w < cw)) {
    appOnly.push({
      ruleId: null,
      label: "Weekly cap",
      reason: "weekly_cap",
      sentence:
        cw === undefined
          ? `Tally caps all training at ${w} sets a week, which athlete/limits.yaml does not ask for. Remove or raise it in the ${WHERE}.`
          : `Tally caps all training at ${w} sets a week, but athlete/limits.yaml allows ${cw}. To allow ${cw}, raise it in the ${WHERE}.`,
    });
  }

  const added = ops.filter((o) => o.op === "add_rule").length;
  if (serverRules.length + added > MAX_RULES) {
    throw new CoachError("SERVER_LIMITS_FULL", `Tally holds at most ${MAX_RULES} rules: it has ${serverRules.length} and this sync adds ${added}. Remove old rules in the ${WHERE} first.`);
  }
  return { ops, appOnly, expectedVersion: server ? server.version : null };
}

// ---------- reading Tally's limits ----------

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseRule(v: unknown, i: number): ServerRule {
  if (!isPlainObject(v) || typeof v.id !== "string" || !RULE_ID.test(v.id) || (v.kind !== "ban" && v.kind !== "cap")) {
    throw new CoachError("SERVER_LIMITS_INVALID", `trainingLimits.rules[${i}] is not a Tally rule (id, kind ban|cap)`);
  }
  if (v.kind === "cap" && (typeof v.maxSetsPerWeek !== "number" || !Number.isInteger(v.maxSetsPerWeek))) {
    throw new CoachError("SERVER_LIMITS_INVALID", `trainingLimits.rules[${i}] (${v.id}) is a cap without maxSetsPerWeek`);
  }
  const allow = (Array.isArray(v.allow) ? v.allow : []).filter(isPlainObject).map((a) => ({ exerciseId: String(a.exerciseId ?? ""), name: String(a.name ?? "") }));
  return {
    id: v.id,
    label: typeof v.label === "string" ? v.label : v.id,
    ...(typeof v.region === "string" ? { region: v.region } : {}),
    kind: v.kind,
    exerciseIds: strings(v.exerciseIds),
    keywords: strings(v.keywords),
    exceptKeywords: strings(v.exceptKeywords),
    allow,
    ...(v.kind === "cap" ? { maxSetsPerWeek: v.maxSetsPerWeek as number } : {}),
  };
}

/** Validates Tally's `trainingLimits` value: `{version, rules, maxWeeklySets}` or null. */
export function parseServerLimits(v: unknown): ServerState {
  if (v === null) return null;
  if (!isPlainObject(v) || typeof v.version !== "number" || !Number.isInteger(v.version) || !Array.isArray(v.rules)) {
    throw new CoachError("SERVER_LIMITS_INVALID", "trainingLimits must be null or {version, rules, maxWeeklySets}");
  }
  const w = v.maxWeeklySets;
  if (w !== undefined && w !== null && (typeof w !== "number" || !Number.isInteger(w))) {
    throw new CoachError("SERVER_LIMITS_INVALID", "trainingLimits.maxWeeklySets must be a whole number or null");
  }
  return { version: v.version, rules: v.rules.map(parseRule), maxWeeklySets: (w as number | null | undefined) ?? null };
}

/**
 * Tally's limits from a `get_training_context` result: the tool response (MCP text
 * blocks), its parsed JSON, or the `trainingLimits` value itself. A context without the
 * field comes from a server without T3 (or with its flag off).
 */
export function serverLimitsFromContext(raw: unknown): ServerState {
  const payload = responsePayload(raw) ?? raw;
  if (payload === null) return null;
  if (isPlainObject(payload) && "trainingLimits" in payload) return parseServerLimits(payload.trainingLimits);
  if (isPlainObject(payload) && "rules" in payload && "version" in payload) return parseServerLimits(payload);
  throw new CoachError("NO_SERVER_LIMITS", "the training context has no trainingLimits field: this Tally server does not enforce limits yet (update_training_limits is not in the tool list)");
}
