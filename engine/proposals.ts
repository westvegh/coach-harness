// Proposals for big changes in unattended runs (contracts §14, §15; spike #14, #15).
//
// Flow (decided 2026-10-09):
//   1. On main: createProposal writes athlete/proposals/<id>.yaml with status: proposed.
//      Nothing in the engine ever writes "approved" on main.
//   2. On the branch proposal/<id>: approveOnBranch flips the copy to status: approved. It
//      refuses on any other branch. The run commits and pushes that branch.
//   3. openProposalPR opens the PR with the GitHub REST API (`gh api -X POST …/pulls`;
//      `gh pr create` uses GraphQL, which Claude Code sessions block) and records pr_url.
//   4. The athlete approves by merging with a merge commit. The guard (engine/approvals.ts)
//      checks that the approved file reached main through a merge of proposal/<id>.
//   5. The next run applies it, then markApplied sets status: applied, applied_at and results.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import { validateBlock } from "./block.ts";
import { ALL_KINDS } from "./config.ts";
import { isCalendarDate, isValidTimezone, localDate, parseInstant } from "./dates.ts";
import { CoachError } from "./errors.ts";
import { isPlainObject, readYamlFile } from "./yaml-file.ts";
import type { ChangeKind, Instant } from "./types.ts";

export const PROPOSALS_RELATIVE = "athlete/proposals";
export const PROPOSAL_ID_RE = /^P-(\d{8})-([a-z_]+)-(\d+)$/;

export type ProposalStatus = "proposed" | "approved" | "applied";
export type ProposalWrite = { tool: string; input: unknown };

/** athlete/proposals/<id>.yaml. Keys are written in this order. */
export type Proposal = {
  id: string;
  kind: ChangeKind;
  created_at: Instant;
  status: ProposalStatus;
  summary: string;
  /** Date → the day's version when the proposal was made; null: the date was empty (§17, §20 item 12). */
  base: Record<string, string | null>;
  limits_hash: string;
  rule_ids: string[];
  writes: ProposalWrite[];
  pr_url?: string;
  applied_at?: Instant;
  results?: unknown;
};

export type CreateProposalInput = {
  kind: ChangeKind;
  summary: string;
  writes: ProposalWrite[];
  /** null: the date must still be empty when the proposal is applied. */
  base: Record<string, string | null>;
  limits_hash: string;
  rule_ids: string[];
};

const KEY_ORDER: (keyof Proposal)[] = ["id", "kind", "created_at", "status", "summary", "base", "limits_hash", "rule_ids", "writes", "pr_url", "applied_at", "results"];
const STATUSES: ProposalStatus[] = ["proposed", "approved", "applied"];

function validateInput(input: CreateProposalInput): void {
  const e: string[] = [];
  if (!isPlainObject(input)) throw new CoachError("PROPOSAL_INVALID", "proposal input must be an object");
  if (!ALL_KINDS.includes(input.kind)) e.push(`kind: unknown change kind ${JSON.stringify(input.kind)}`);
  if (typeof input.summary !== "string" || input.summary.trim() === "") e.push("summary: must be a non-empty string");
  if (!Array.isArray(input.writes) || input.writes.length === 0) e.push("writes: must be a non-empty list of {tool, input}");
  else input.writes.forEach((w, i) => {
    if (!isPlainObject(w) || typeof w.tool !== "string" || w.tool === "" || !("input" in w)) e.push(`writes[${i}]: must be {tool, input}`);
  });
  if (!isPlainObject(input.base)) e.push("base: must map dates to versions (null for an empty date)");
  else for (const [d, v] of Object.entries(input.base)) {
    if (!isCalendarDate(d)) e.push(`base: ${d} is not a date`);
    if (v !== null && (typeof v !== "string" || v === "")) e.push(`base.${d}: must be a version string, or null for an empty date`);
  }
  if (typeof input.limits_hash !== "string" || !/^[0-9a-f]{64}$/.test(input.limits_hash)) e.push("limits_hash: must be a SHA-256 hex digest");
  if (!Array.isArray(input.rule_ids) || input.rule_ids.some((r) => typeof r !== "string")) e.push("rule_ids: must be a list of rule IDs");
  if (e.length > 0) throw new CoachError("PROPOSAL_INVALID", `proposal is invalid:\n  - ${e.join("\n  - ")}`);
}

function ordered(p: Proposal): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

function proposalPath(root: string, id: string): string {
  if (!PROPOSAL_ID_RE.test(id)) throw new CoachError("PROPOSAL_INVALID", `not a proposal ID: ${JSON.stringify(id)}`);
  return join(root, PROPOSALS_RELATIVE, `${id}.yaml`);
}

function writeProposal(path: string, p: Proposal, exclusive = false): void {
  writeFileSync(path, stringify(ordered(p), { lineWidth: 0 }), { encoding: "utf8", flag: exclusive ? "wx" : "w" });
}

/** The athlete's timezone from coach.yaml, or UTC when there is none. */
function rootTimezone(root: string): string {
  const p = join(root, "coach.yaml");
  if (!existsSync(p)) return "UTC";
  const raw = readYamlFile(p, "CONFIG_INVALID");
  const tz = isPlainObject(raw) && isPlainObject(raw.athlete) ? raw.athlete.timezone : undefined;
  return isValidTimezone(tz) ? tz : "UTC";
}

export function parseProposal(raw: unknown, where: string): Proposal {
  if (!isPlainObject(raw)) throw new CoachError("PROPOSAL_INVALID", `${where}: must be a mapping`);
  validateInput(raw as unknown as CreateProposalInput);
  if (typeof raw.id !== "string" || !PROPOSAL_ID_RE.test(raw.id)) throw new CoachError("PROPOSAL_INVALID", `${where}: id is invalid`);
  if (!STATUSES.includes(raw.status as ProposalStatus)) throw new CoachError("PROPOSAL_INVALID", `${where}: status must be ${STATUSES.join(" | ")}`);
  parseInstant(raw.created_at, `${where}: created_at`);
  return raw as unknown as Proposal;
}

export function readProposal(id: string, root = process.cwd()): Proposal {
  const path = proposalPath(root, id);
  if (!existsSync(path)) throw new CoachError("PROPOSAL_NOT_FOUND", `no proposal ${id} at ${path}`);
  const p = parseProposal(readYamlFile(path, "PROPOSAL_INVALID"), path);
  if (p.id !== id) throw new CoachError("PROPOSAL_INVALID", `${path}: id ${p.id} does not match the file name`);
  return p;
}

export function createProposal(input: CreateProposalInput, opts: { root?: string; now?: Instant; tz?: string } = {}): { id: string; path: string } {
  validateInput(input);
  const root = opts.root ?? process.cwd();
  const now = opts.now ?? new Date().toISOString();
  const day = localDate(now, opts.tz ?? rootTimezone(root)).replace(/-/g, "");
  const dir = join(root, PROPOSALS_RELATIVE);
  mkdirSync(dir, { recursive: true });
  const prefix = `P-${day}-${input.kind}-`;
  let n = 1;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(prefix) || !f.endsWith(".yaml")) continue;
    const k = Number(f.slice(prefix.length, -5));
    if (Number.isInteger(k) && k >= n) n = k + 1;
  }
  const id = `${prefix}${n}`;
  const path = join(dir, `${id}.yaml`);
  const p: Proposal = {
    id,
    kind: input.kind,
    created_at: now,
    status: "proposed",
    summary: input.summary.trim(),
    base: input.base,
    limits_hash: input.limits_hash,
    rule_ids: input.rule_ids,
    writes: input.writes,
  };
  writeProposal(path, p, true);
  return { id, path };
}

export function listProposals(root = process.cwd(), filter: { status?: ProposalStatus } = {}): Proposal[] {
  const dir = join(root, PROPOSALS_RELATIVE);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => readProposal(f.slice(0, -5), root))
    .filter((p) => !filter.status || p.status === filter.status);
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    throw new CoachError("GIT_ERROR", `git ${args.join(" ")} failed: ${(e as { stderr?: string }).stderr?.trim() || (e as Error).message}`);
  }
}

export function proposalBranch(id: string): string {
  return `proposal/${id}`;
}

/**
 * Writes the approved copy. Allowed only on the branch proposal/<id>, never on main or any
 * other branch: the athlete's merge of that branch is the approval.
 */
export function approveOnBranch(id: string, opts: { root?: string } = {}): { path: string; branch: string } {
  const root = opts.root ?? process.cwd();
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== proposalBranch(id)) {
    throw new CoachError("WRONG_BRANCH", `the approved copy of ${id} may only be written on ${proposalBranch(id)} (current branch: ${branch})`);
  }
  const p = readProposal(id, root);
  if (p.status !== "proposed") throw new CoachError("PROPOSAL_STATE", `${id} is ${p.status}, not proposed`);
  const path = proposalPath(root, id);
  writeProposal(path, { ...p, status: "approved" });
  return { path, branch };
}

/**
 * Writes a drafted block to athlete/block.yaml on the branch proposal/<id> (launch review finding 2).
 * athlete/block.yaml is protected: on main it changes only through setup or the block skill
 * with the user's yes (the guard asks), or through the merge of an approved proposal. This
 * is the unattended path: it refuses on any branch but proposal/<id>, and for a proposal
 * that is not a proposed new_block. A previous block with another id moves to
 * athlete/blocks/<old id>.yaml; a revision of the same block replaces the file.
 * It commits both files on the branch itself, so no uncommitted block can follow a later
 * `git switch` to main. When the commit fails, it restores the previous files and throws.
 */
export function writeBlockOnBranch(id: string, block: unknown, opts: { root?: string } = {}): { path: string; archived: string | null; branch: string; committed: true } {
  const root = opts.root ?? process.cwd();
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== proposalBranch(id)) {
    throw new CoachError("WRONG_BRANCH", `athlete/block.yaml may only be written by block write on ${proposalBranch(id)} (current branch: ${branch}); on main it needs the user's yes`);
  }
  const p = readProposal(id, root);
  if (p.kind !== "new_block") throw new CoachError("PROPOSAL_STATE", `${id} is a ${p.kind} proposal; block write needs a new_block proposal`);
  if (p.status !== "proposed") throw new CoachError("PROPOSAL_STATE", `${id} is ${p.status}, not proposed`);
  const next = validateBlock(block, "block write --input");
  const path = join(root, "athlete/block.yaml");
  const before = existsSync(path) ? readFileSync(path) : null;
  let archived: string | null = null;
  let archivedBefore: Buffer | null = null;
  if (existsSync(path)) {
    const old = readYamlFile(path, "BLOCK_INVALID");
    const oldId = isPlainObject(old) && typeof old.id === "string" && old.id !== "" ? old.id : null;
    if (oldId !== null && oldId !== next.id) {
      if (!/^[A-Za-z0-9._-]+$/.test(oldId)) throw new CoachError("BLOCK_INVALID", `the current block id ${JSON.stringify(oldId)} is not a file name`);
      mkdirSync(join(root, "athlete/blocks"), { recursive: true });
      archived = join(root, "athlete/blocks", `${oldId}.yaml`);
      archivedBefore = existsSync(archived) ? readFileSync(archived) : null;
      copyFileSync(path, archived);
    }
  }
  writeFileSync(path, stringify(next, { lineWidth: 0 }), "utf8");
  const paths = ["athlete/block.yaml", ...(archived ? [`athlete/blocks/${basename(archived)}`] : [])];
  try {
    git(root, ["add", "--", ...paths]);
    git(root, ["commit", "-q", "-m", `proposal ${id}: block ${next.id}`, "--", ...paths]);
  } catch (e) {
    // Put the previous files back, so a failed write leaves no uncommitted block behind.
    try {
      git(root, ["reset", "-q", "--", ...paths]);
    } catch {
      /* nothing staged */
    }
    if (before === null) rmSync(path, { force: true });
    else writeFileSync(path, before);
    if (archived) {
      if (archivedBefore === null) rmSync(archived, { force: true });
      else writeFileSync(archived, archivedBefore);
    }
    throw new CoachError("GIT_ERROR", `block write could not commit the block on ${branch}; the previous files are restored: ${(e as Error).message}`);
  }
  return { path, archived, branch, committed: true };
}

export function prBody(p: Proposal): string {
  const base = Object.entries(p.base).map(([d, v]) => (v === null ? `- ${d}: empty (nothing planned yet)` : `- ${d}: \`${v}\``));
  return [
    `## ${p.summary}`,
    "",
    `- Proposal: \`${p.id}\` (${p.kind})`,
    `- Rules: ${p.rule_ids.length > 0 ? p.rule_ids.join(", ") : "none"}`,
    `- Limits hash: \`${p.limits_hash.slice(0, 12)}\``,
    "",
    "### Base versions",
    ...(base.length > 0 ? base : ["- none"]),
    "",
    "### Writes",
    "```json",
    JSON.stringify(p.writes, null, 2),
    "```",
    "",
    "### How to decide",
    "- **Approve:** merge this PR with a **merge commit** (not squash, not rebase). The next scheduled run applies it.",
    "- The run applies it only if every day still has its base version and the limits are unchanged. Otherwise it does nothing and reports why.",
    "- **Reject:** close this PR.",
  ].join("\n");
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Opens the pull request with the REST API: `gh api -X POST repos/{owner}/{repo}/pulls`.
 * Never `gh pr create` (GraphQL is blocked in Claude Code sessions, spike #14). On success
 * the PR URL is recorded in the proposal file as pr_url. On failure the file is unchanged
 * and a CoachError PR_FAILED carries gh's error.
 */
export function openProposalPR(
  proposal: Proposal,
  opts: { owner: string; repo: string; branch: string; base?: string; root?: string; env?: NodeJS.ProcessEnv },
): { url: string } {
  const root = opts.root ?? process.cwd();
  if (!NAME_RE.test(opts.owner ?? "") || !NAME_RE.test(opts.repo ?? "")) throw new CoachError("USAGE", "owner and repo must be GitHub names");
  if (opts.branch !== proposalBranch(proposal.id)) throw new CoachError("WRONG_BRANCH", `the PR head must be ${proposalBranch(proposal.id)}, got ${opts.branch}`);
  if (proposal.status === "applied") throw new CoachError("PROPOSAL_STATE", `${proposal.id} is already applied`);
  const title = `Proposal ${proposal.id}: ${proposal.summary}`.slice(0, 120);
  const args = [
    "api", "-X", "POST", `repos/${opts.owner}/${opts.repo}/pulls`,
    "-f", `title=${title}`,
    "-f", `head=${opts.branch}`,
    "-f", `base=${opts.base ?? "main"}`,
    "-f", `body=${prBody(proposal)}`,
  ];
  let stdout: string;
  try {
    stdout = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: opts.env ?? process.env });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    const detail = [err.stderr?.trim(), err.stdout?.trim()].filter(Boolean).join(" | ") || err.message;
    throw new CoachError("PR_FAILED", `gh api POST repos/${opts.owner}/${opts.repo}/pulls failed; the proposal file is kept: ${detail}`);
  }
  let url: unknown;
  try {
    url = JSON.parse(stdout).html_url;
  } catch {
    url = undefined;
  }
  if (typeof url !== "string" || !url.startsWith("https://")) throw new CoachError("PR_FAILED", `gh api returned no html_url: ${stdout.slice(0, 200)}`);
  const current = readProposal(proposal.id, root);
  writeProposal(proposalPath(root, proposal.id), { ...current, pr_url: url });
  return { url };
}

/** Marks an approved proposal as applied, with the write results. */
export function markApplied(id: string, results: unknown, opts: { root?: string; now?: Instant } = {}): Proposal {
  const root = opts.root ?? process.cwd();
  const p = readProposal(id, root);
  if (p.status !== "approved") throw new CoachError("PROPOSAL_STATE", `${id} is ${p.status}; only an approved proposal can be marked applied`);
  const applied_at = opts.now ?? new Date().toISOString();
  parseInstant(applied_at, "applied_at");
  const out: Proposal = { ...p, status: "applied", applied_at, results: results ?? null };
  writeProposal(proposalPath(root, id), out);
  return out;
}
