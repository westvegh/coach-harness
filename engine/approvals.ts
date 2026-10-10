// Approval records (contracts §7 step 8, §17). A proposal file in
// athlete/proposals/ becomes an approval record only when:
//   - on local `main` it has `status: approved`, and
//   - GitHub (REST, `gh api`) shows a merged pull request from proposal/<id> into main
//     whose merge commit is in the fetched origin/main, is a merge commit, and holds
//     exactly main's copy of the file.
// Local merges, squash merges and direct commits never count. Working-tree copies are
// never trusted.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { sha256Hex } from "./canonical.ts";
import { isCalendarDate, parseInstant } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { canonicalToolCall } from "./opid.ts";
import { githubRepo } from "./prepush.ts";
import { isPlainObject, readYamlFile } from "./yaml-file.ts";
import type { CalendarDate, Snapshot } from "./types.ts";

export const PROPOSALS_RELATIVE = "athlete/proposals";
export const APPROVAL_REF = "main";

export type ProposalStatus = "proposed" | "approved" | "applied";
export type ProposalWrite = { tool: string; input: unknown };
export type Proposal = {
  id: string;
  kind: string;
  created_at: string;
  status: ProposalStatus;
  /** date → the snapshot version the writes were built on; null: the date was empty. */
  base: Record<CalendarDate, string | null>;
  limits_hash: string;
  writes: ProposalWrite[];
  summary: string;
  rule_ids: string[];
  pr_url?: string;
  applied_at?: string;
  results?: unknown;
};

export type ApprovalRecord = {
  proposal_id: string;
  path: string;
  /** The canonical hash of each write, in order. */
  hashes: string[];
  base: Record<CalendarDate, string | null>;
  limits_hash: string;
};

const KEYS = ["id", "kind", "created_at", "status", "base", "limits_hash", "writes", "summary", "rule_ids", "pr_url", "applied_at", "results"];
const ID_RE = /^P-\d{8}-[a-z_]+-\d+$/;

export function validateProposal(raw: unknown, where: string): Proposal {
  const errors: string[] = [];
  if (!isPlainObject(raw)) throw new CoachError("PROPOSAL_INVALID", `${where}: must be a mapping`);
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) errors.push(`${k}: unknown key`);
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) errors.push(`id must look like P-YYYYMMDD-<kind>-<n>, got ${JSON.stringify(raw.id)}`);
  if (typeof raw.kind !== "string" || raw.kind === "") errors.push("kind is required");
  try {
    parseInstant(raw.created_at, "created_at");
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (!["proposed", "approved", "applied"].includes(raw.status as string)) errors.push(`status must be proposed | approved | applied, got ${JSON.stringify(raw.status)}`);
  if (!isPlainObject(raw.base)) errors.push("base must be a mapping of date → version");
  else {
    for (const [d, v] of Object.entries(raw.base)) {
      if (!isCalendarDate(d)) errors.push(`base: bad date ${d}`);
      if (v !== null && typeof v !== "string") errors.push(`base.${d}: must be a version string or null`);
    }
  }
  if (typeof raw.limits_hash !== "string" || !/^[0-9a-f]{64}$/.test(raw.limits_hash)) errors.push("limits_hash must be a SHA-256 hex string");
  if (!Array.isArray(raw.writes) || raw.writes.length === 0) errors.push("writes must be a non-empty list");
  else raw.writes.forEach((w, i) => {
    if (!isPlainObject(w) || typeof w.tool !== "string" || !("input" in w)) errors.push(`writes[${i}] must be {tool, input}`);
  });
  if (typeof raw.summary !== "string") errors.push("summary is required");
  if (!Array.isArray(raw.rule_ids) || raw.rule_ids.some((r) => typeof r !== "string")) errors.push("rule_ids must be a list of rule IDs");
  if (errors.length > 0) throw new CoachError("PROPOSAL_INVALID", `${where} is invalid:\n  - ${errors.join("\n  - ")}`);
  return raw as unknown as Proposal;
}

/**
 * The canonical hash of a tool call: SHA-256 of engine/opid.ts canonicalToolCall (the
 * canonical JSON of {tool: <suffix>, args}). Operation IDs use its first 12 hex characters.
 */
export function toolCallHash(tool: string, args: unknown): string {
  return sha256Hex(canonicalToolCall({ tool, args }));
}

export function recordOf(p: Proposal, path: string): ApprovalRecord {
  return { proposal_id: p.id, path, hashes: p.writes.map((w) => toolCallHash(w.tool, w.input)), base: { ...p.base }, limits_hash: p.limits_hash };
}

// ---------- reading proposals ----------

/** The proposals in the working tree (any status). A malformed file throws. */
export function readProposals(root: string): { path: string; proposal: Proposal }[] {
  const dir = join(root, PROPOSALS_RELATIVE);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      const path = join(PROPOSALS_RELATIVE, f);
      return { path, proposal: validateProposal(readYamlFile(join(root, path), "PROPOSAL_INVALID"), path) };
    });
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export type ApprovalScan = { records: ApprovalRecord[]; rejected: { path: string; reason: string }[]; warnings: string[] };

/**
 * Approval records from `ref` (default main). Git failures give no records (fail closed)
 * and a warning.
 */
export function loadApprovals(root: string, opts: { ref?: string; env?: NodeJS.ProcessEnv } = {}): ApprovalScan {
  const ref = opts.ref ?? APPROVAL_REF;
  const out: ApprovalScan = { records: [], rejected: [], warnings: [] };
  let files: string[];
  try {
    files = git(root, ["ls-tree", "--name-only", `${ref}:${PROPOSALS_RELATIVE}`])
      .split("\n")
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => `${PROPOSALS_RELATIVE}/${f}`);
  } catch (e) {
    // No proposals folder on the ref is normal; a missing ref or no git is a warning.
    try {
      git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    } catch {
      out.warnings.push(`cannot read ${ref}: no approval records (${(e as Error).message.split("\n")[0]})`);
    }
    return out;
  }
  for (const path of files) {
    try {
      const text = git(root, ["show", `${ref}:${path}`]);
      const p = validateProposal(parse(text, { uniqueKeys: true }), `${ref}:${path}`);
      if (p.status !== "approved") continue;
      const why = remoteProvenanceProblem(root, path, p.id, text, opts.env ?? process.env);
      if (why) {
        out.rejected.push({ path, reason: why });
        continue;
      }
      out.records.push(recordOf(p, path));
    } catch (e) {
      out.rejected.push({ path, reason: (e as Error).message.split("\n")[0] });
    }
  }
  return out;
}

type PullRequest = { merged_at?: unknown; merge_commit_sha?: unknown; head?: { ref?: unknown }; base?: { ref?: unknown } };

/**
 * null when GitHub (REST, `gh api`) shows a merged pull request from
 * proposal/<id> into main whose merge commit is in the fetched origin/main, is a merge
 * commit (not a squash), and holds exactly main's copy of the file. Local merges never
 * count. Else the reason.
 */
export function remoteProvenanceProblem(root: string, path: string, id: string, text: string, env: NodeJS.ProcessEnv): string | null {
  let url: string;
  try {
    url = git(root, ["remote", "get-url", "origin"]).trim();
  } catch {
    return "origin is not set; approvals need the merged pull request on GitHub";
  }
  const repo = githubRepo(url);
  if (!repo) return `origin is not a GitHub repository (${url}); approvals need the merged pull request on GitHub`;
  const branch = `proposal/${id}`;
  const owner = repo.split("/")[0];
  let prs: PullRequest[];
  try {
    const out = execFileSync("gh", ["api", `repos/${repo}/pulls?state=closed&base=main&head=${owner}:${branch}&per_page=100`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed)) throw new Error("not a list");
    prs = parsed as PullRequest[];
  } catch (e) {
    return `cannot read the pull requests of ${repo} with gh (${(e as Error).message.split("\n")[0]})`;
  }
  const merged = prs.find((p) => typeof p.merged_at === "string" && p.head?.ref === branch && p.base?.ref === "main" && typeof p.merge_commit_sha === "string");
  if (!merged) return `no merged pull request from ${branch} into main on GitHub`;
  const sha = merged.merge_commit_sha as string;
  if (!/^[0-9a-f]{40}$/.test(sha)) return `the pull request's merge commit is not a SHA: ${JSON.stringify(sha)}`;
  try {
    git(root, ["merge-base", "--is-ancestor", sha, "origin/main"]);
  } catch {
    return `the pull request's merge commit ${sha.slice(0, 8)} is not in the fetched origin/main (run git fetch)`;
  }
  const parents = git(root, ["rev-list", "--parents", "-n", "1", sha]).trim().split(/\s+/).slice(1);
  if (parents.length < 2) return `the pull request's merge commit ${sha.slice(0, 8)} is not a merge commit (squash merges are not approvals)`;
  let atMerge: string;
  try {
    atMerge = git(root, ["show", `${sha}:${path}`]);
  } catch {
    return `the pull request's merge commit does not hold ${path}`;
  }
  if (atMerge !== text) return `main's copy of ${path} differs from the pull request's merge commit`;
  return null;
}

// ---------- matching ----------

export type ApprovalMatch = { record: ApprovalRecord | null; problems: string[] };

/**
 * An approval record matches when it holds the exact call's hash, every base version
 * equals the snapshot version (null: the date is empty), and its limits hash is the
 * current one.
 */
export function matchApproval(
  call: { tool: string; args: unknown },
  approvals: ApprovalRecord[],
  snap: Snapshot | null,
  limitsHash: string,
): ApprovalMatch {
  const h = toolCallHash(call.tool, call.args);
  const candidates = approvals.filter((a) => a.hashes.includes(h));
  if (candidates.length === 0) return { record: null, problems: ["no approved proposal holds this exact tool call"] };
  const problems: string[] = [];
  for (const a of candidates) {
    const mine: string[] = [];
    for (const [d, v] of Object.entries(a.base)) {
      const day = snap?.days[d];
      if (!day) mine.push(`${a.proposal_id}: ${d} is not in the snapshot`);
      else if (v === null ? day.found : !day.found || day.version !== v) {
        mine.push(`${a.proposal_id}: the base version of ${d} changed since the proposal`);
      }
    }
    if (a.limits_hash !== limitsHash) mine.push(`${a.proposal_id}: limits.yaml changed since the proposal`);
    if (mine.length === 0) return { record: a, problems: [] };
    problems.push(...mine);
  }
  return { record: null, problems };
}
