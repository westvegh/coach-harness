// The template manifest (contracts §24): the files the public template ships, each with its
// git mode and blob id. scripts/export-public.sh writes it at the export root; `update`
// reads the local copy and the fetched one to plan an update.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CoachError } from "./errors.ts";

export const MANIFEST = "template-manifest.json";

export type ManifestEntry = { mode: "100644" | "100755"; blob: string };
export type Manifest = { version: 1; repo: string; release: string; files: Record<string, ManifestEntry> };

/** The git blob id of `bytes` (sha1, as `git hash-object`; sha256 when `algo` says so). */
export function blobId(bytes: Buffer, algo: "sha1" | "sha256" = "sha1"): string {
  return createHash(algo).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** https://github.com/<owner>/<repo> from a package.json repository URL, or null. */
export function templateRepoUrl(url: string): string | null {
  const m = /^(?:git\+)?https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** True for https://github.com/<owner>/<repo>, with an optional .git: the only accepted source. */
export function isGithubSource(url: unknown): url is string {
  return typeof url === "string" && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?$/.test(url) && !url.includes("..");
}

function walk(dir: string, root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (lstatSync(full).isDirectory()) out.push(...walk(full, root));
    else out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/** The manifest of an exported tree: every file but the manifest, sorted by path. */
export function buildManifest(dir: string, info: { repo: string; release: string }): Manifest {
  const files: Record<string, ManifestEntry> = {};
  for (const p of walk(dir, dir).filter((p) => p !== MANIFEST).sort()) {
    const full = join(dir, p);
    if (lstatSync(full).isSymbolicLink()) throw new CoachError("MANIFEST_INVALID", `${p} is a symbolic link; a template ships plain files only`);
    files[p] = { mode: (statSync(full).mode & 0o100) !== 0 ? "100755" : "100644", blob: blobId(readFileSync(full)) };
  }
  return { version: 1, repo: info.repo, release: info.release, files };
}

export function manifestJson(m: Manifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}

// ---------- path rules ----------

export type TreeRules = { includes: string[]; excludes: string[] };

/** The rules of scripts/public-tree.txt (the shipped paths). */
export function parseTreeRules(text: string): TreeRules {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  return { includes: lines.filter((l) => !l.startsWith("!")), excludes: lines.filter((l) => l.startsWith("!")).map((l) => l.slice(1)) };
}

const hit = (p: string, r: string) => (r.endsWith("/") ? p.startsWith(r) : p === r);
const FORBIDDEN_SEGMENTS = [".git", "node_modules", ".husky"];
const FORBIDDEN_FILES = ["coach.yaml", ".npmrc", ".claude/settings.local.json", MANIFEST];

/**
 * Why `p` cannot be a template path, or null. A template path is a shipped path (the
 * public-tree rules), relative, with no empty, "." or ".." segment, and (by segment,
 * without regard to case) no athlete segment outside templates/athlete/, no .git,
 * node_modules or .husky segment; and it is not a user or local file.
 */
export function pathProblem(p: string, rules: TreeRules): string | null {
  if (typeof p !== "string" || p === "") return "an empty path";
  if (p.startsWith("/") || p.includes("\\")) return `${p}: not a relative posix path`;
  // A git pathspec could read these as a pattern or magic: a template path is a plain name.
  if (/[*?[\]]/.test(p) || p.startsWith(":")) return `${p}: a glob character or a leading ":"`;
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return `${p}: an empty, . or .. segment`;
  const lower = segs.map((s) => s.toLowerCase());
  const templateAthlete = lower[0] === "templates" && lower[1] === "athlete";
  if (lower.some((s, i) => s === "athlete" && !(templateAthlete && i === 1))) return `${p}: an athlete folder holds user files`;
  if (lower.some((s) => FORBIDDEN_SEGMENTS.includes(s))) return `${p}: a .git, node_modules or .husky folder`;
  if (FORBIDDEN_FILES.includes(lower.join("/"))) return `${p}: a user or local file`;
  if (!rules.includes.some((r) => hit(p, r)) || rules.excludes.some((r) => hit(p, r))) return `${p}: not a shipped path (scripts/public-tree.txt)`;
  return null;
}

/** Parses and checks a manifest: shape, sources, modes, blob ids and every path. Throws MANIFEST_INVALID. */
export function validateManifest(raw: unknown, rules: TreeRules, where: string): Manifest {
  const errors: string[] = [];
  const m = raw as Record<string, unknown>;
  if (typeof m !== "object" || m === null || Array.isArray(m)) throw new CoachError("MANIFEST_INVALID", `${where}: must be a JSON object`);
  if (m.version !== 1) errors.push("version must be 1");
  if (!isGithubSource(m.repo)) errors.push(`repo must be https://github.com/<owner>/<repo>, got ${JSON.stringify(m.repo)}`);
  if (typeof m.release !== "string" || m.release === "") errors.push("release is required");
  const files = m.files as Record<string, unknown>;
  if (typeof files !== "object" || files === null || Array.isArray(files)) errors.push("files must be a mapping");
  else {
    const seen = new Map<string, string>();
    for (const [p, e] of Object.entries(files)) {
      const why = pathProblem(p, rules);
      if (why) errors.push(why);
      const key = p.toLowerCase();
      if (seen.has(key)) errors.push(`${p} and ${seen.get(key)} differ only in case`);
      seen.set(key, p);
      const entry = e as Record<string, unknown>;
      if (typeof entry !== "object" || entry === null || !["100644", "100755"].includes(entry.mode as string)) errors.push(`${p}: mode must be 100644 or 100755`);
      else if (typeof entry.blob !== "string" || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.blob)) errors.push(`${p}: blob must be a git object id`);
    }
  }
  if (errors.length > 0) throw new CoachError("MANIFEST_INVALID", `${where} is invalid:\n  - ${errors.join("\n  - ")}`);
  return m as unknown as Manifest;
}
