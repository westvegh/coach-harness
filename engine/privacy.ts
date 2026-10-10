// Privacy scan of tracked files. Findings never echo a secret or a
// fingerprint: they name the pattern and the line only.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CoachError } from "./errors.ts";

export type PrivacyFinding = { file: string; line?: number; kind: "token" | "athlete-file" | "fingerprint"; detail: string };

export const TOKEN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "GitHub token (ghp_ and similar)", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "GitHub fine-grained token (github_pat_)", re: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { name: "Anthropic key (sk-ant-)", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  // Oura personal access tokens: 32 uppercase letters and digits, with at least one of each.
  { name: "Oura token shape", re: /\b(?=[A-Z0-9]{32}\b)(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{32}\b/ },
];

export type TrackedEntry = { path: string; sha: string };

function git(dir: string, args: string[], input?: Buffer): Buffer {
  try {
    return execFileSync("git", args, { cwd: dir, input, maxBuffer: 1 << 30 });
  } catch (e) {
    throw new CoachError("PRIVACY_SCAN", `git ${args[0]} failed in ${dir}: ${(e as Error).message}`);
  }
}

/**
 * Blobs to scan: the index by default (what the next commit holds), or the tree of a
 * commit when `ref` is given. Submodules are skipped.
 */
export function trackedEntries(dir: string, ref?: string): TrackedEntry[] {
  const raw = ref ? git(dir, ["ls-tree", "-r", "-z", "--full-tree", ref]) : git(dir, ["ls-files", "-s", "-z"]);
  const out: TrackedEntry[] = [];
  for (const rec of raw.toString("utf8").split("\0").filter(Boolean)) {
    const tab = rec.indexOf("\t");
    const meta = rec.slice(0, tab).split(" ");
    const path = rec.slice(tab + 1);
    // ls-tree: "<mode> <type> <sha>"; ls-files -s: "<mode> <sha> <stage>".
    const [mode, sha] = ref ? [meta[0], meta[2]] : [meta[0], meta[1]];
    if (mode === "160000") continue;
    out.push({ path, sha });
  }
  return out;
}

/** Files tracked by git in `dir` (the index), relative paths. */
export function trackedFiles(dir: string): string[] {
  return trackedEntries(dir).map((e) => e.path);
}

/** Reads blob contents with one `git cat-file --batch` call. */
function readBlobs(dir: string, shas: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const unique = [...new Set(shas)];
  if (unique.length === 0) return out;
  const buf = git(dir, ["cat-file", "--batch"], Buffer.from(unique.join("\n") + "\n"));
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    const [sha, type, size] = buf.subarray(pos, nl).toString("utf8").split(" ");
    if (type === "missing") throw new CoachError("PRIVACY_SCAN", `blob ${sha} is missing`);
    const n = Number(size);
    out.set(sha, buf.subarray(nl + 1, nl + 1 + n));
    pos = nl + 1 + n + 1;
  }
  return out;
}

/** True for a path with an `athlete` directory anywhere, except under templates/athlete/. */
function isAthletePath(path: string): boolean {
  if (path.startsWith("templates/athlete/")) return false;
  return path.split("/").includes("athlete");
}

/** Fingerprint lines: trimmed, without blanks and # comments, at least 3 characters. */
export function readFingerprints(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new CoachError("PRIVACY_SCAN", `cannot read the fingerprint file: ${(e as Error).message}`);
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 3 && !l.startsWith("#"));
}

/**
 * Scans git blobs, not the working tree: a staged or committed secret is found even when
 * the working copy is clean. Binary blobs are scanned too.
 */
export function scanRepo(dir: string, opts: { fingerprints?: string[]; ref?: string } = {}): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const prints = (opts.fingerprints ?? []).map((f, i) => ({ n: i + 1, lower: f.toLowerCase() }));
  const entries = trackedEntries(dir, opts.ref);
  const blobs = readBlobs(dir, entries.map((e) => e.sha));
  for (const { path: file, sha } of entries) {
    if (isAthletePath(file)) {
      findings.push({ file, kind: "athlete-file", detail: "athlete data is tracked; only templates/athlete/ may be committed" });
    }
    const lines = blobs.get(sha)!.toString("utf8").split("\n");
    lines.forEach((text, i) => {
      for (const p of TOKEN_PATTERNS) {
        if (p.re.test(text)) findings.push({ file, line: i + 1, kind: "token", detail: p.name });
      }
      if (prints.length > 0) {
        const lower = text.toLowerCase();
        for (const fp of prints) {
          if (lower.includes(fp.lower)) findings.push({ file, line: i + 1, kind: "fingerprint", detail: `matches fingerprint line ${fp.n}` });
        }
      }
    });
  }
  return findings;
}
