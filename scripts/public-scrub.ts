// Scrub check for the public tree: private paths, personal names, email addresses, build
// tool names, internal build references, tokens and private fingerprints. Findings name the file, the line and the
// kind; they never echo the matched text.
//
//   node scripts/public-scrub.ts <dir>     (exit 1 on any finding)
//
// The marker words are built at run time, so this file does not match itself.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readFingerprints, TOKEN_PATTERNS } from "../engine/privacy.ts";

export type ScrubFinding = { file: string; line: number; kind: string };

const j = (...parts: string[]) => parts.join("");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const OWNER = j("west", "vegh");
/** The repository URL may name the owner. */
// Anchored: github.com/<owner>/coach-harness-dev (the private dev repo) is not allowed.
const REPO_URL = new RegExp(`${esc(j("github.com/", OWNER, "/coach-harness"))}(?![A-Za-z0-9_-])`, "gi");

/** Words and paths that must never ship. Case-insensitive. */
export const MARKERS: { kind: string; re: RegExp }[] = [
  { kind: "home path", re: new RegExp(esc(j("/Us", "ers/")), "i") },
  { kind: "private folder name", re: new RegExp(esc(j("Fitness ", "& Health")), "i") },
  { kind: "build tool name", re: new RegExp(j("or", "ca"), "i") },
  { kind: "build model name", re: new RegExp(j("as", "tra"), "i") },
  { kind: "build model name", re: new RegExp(esc(j("gpt", "-6")), "i") },
  { kind: "build message type", re: new RegExp(j("wor", "ker", "_done"), "i") },
  { kind: "owner handle", re: new RegExp(OWNER, "i") },
];

/**
 * Internal build references: design-doc sections, build briefs, review rounds and
 * build agents. None of these documents ship, so a public file must not point at them.
 * Case-sensitive on the letter after "brief" and "review", so "brief text" and
 * "review last week" pass.
 */
export const INTERNAL_REFS: { kind: string; re: RegExp }[] = [
  { kind: "internal ref: design section", re: new RegExp(j("des", "ign §")) },
  { kind: "internal ref: build brief", re: new RegExp(j("\\b[Bb]ri", "ef [A-Z]")) },
  { kind: "internal ref: review round", re: new RegExp(j("\\b[Rr]evi", "ew [A-Z]")) },
  { kind: "internal ref: build agent", re: new RegExp(j("\\b[Ww]or", "ker")) },
];

/** Extra token shapes, on top of engine/privacy.ts TOKEN_PATTERNS. */
export const EXTRA_TOKENS: { name: string; re: RegExp }[] = [
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "secret key (sk-)", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "JSON web token", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
];

const EMAIL = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
/** Reserved example domains (RFC 2606) are not real addresses. */
const EXAMPLE_DOMAIN = /^(?:.+\.)?example\.(?:com|org|net)$/i;

function emailHits(text: string): number {
  let n = 0;
  for (const m of text.matchAll(EMAIL)) {
    const [, local, domain] = m;
    const before = text[m.index! - 1] ?? "";
    if (EXAMPLE_DOMAIN.test(domain)) continue;
    // The SSH remote form (git@github.com:owner/repo) and URL credentials (https://x:y@host).
    if (local === "git" && domain.toLowerCase() === "github.com") continue;
    if (before === ":" || before === "/") continue;
    n++;
  }
  return n;
}

/** The CI gate names the template repository (launch review finding 6). */
const CI_GATE = new RegExp(esc(j("github.repository == '", OWNER, "/coach-harness'")), "g");

/** Removes the allowed owner mentions: the repo URL anywhere, the LICENSE copyright line and the CI gate. */
function withoutAllowed(file: string, line: string): string {
  if (file === "LICENSE" && /^Copyright\b/.test(line)) return "";
  if (file === ".github/workflows/test.yml") line = line.replace(CI_GATE, "");
  return line.replace(REPO_URL, "");
}

export function scrubText(file: string, text: string, fingerprints: string[] = []): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  const prints = fingerprints.map((f) => f.toLowerCase());
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const text = withoutAllowed(file, raw);
    for (const m of MARKERS) if (m.re.test(text)) out.push({ file, line, kind: m.kind });
    for (const m of INTERNAL_REFS) if (m.re.test(raw)) out.push({ file, line, kind: m.kind });
    if (emailHits(text) > 0) out.push({ file, line, kind: "email address" });
    for (const t of [...TOKEN_PATTERNS, ...EXTRA_TOKENS]) if (t.re.test(raw)) out.push({ file, line, kind: `token: ${t.name}` });
    const lower = raw.toLowerCase();
    prints.forEach((p, n) => {
      if (lower.includes(p)) out.push({ file, line, kind: `fingerprint line ${n + 1}` });
    });
  });
  return out;
}

function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, root));
    else out.push(relative(root, full));
  }
  return out.sort();
}

/** Scans every file under `dir`. Also flags a path (file name) that holds a marker. */
export function scrubTree(dir: string, opts: { fingerprints?: string[] } = {}): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  for (const file of walk(dir)) {
    for (const m of MARKERS) if (m.re.test(file)) out.push({ file, line: 0, kind: `path: ${m.kind}` });
    out.push(...scrubText(file, readFileSync(join(dir, file), "utf8"), opts.fingerprints));
  }
  return out;
}

/** Fingerprints from COACH_PRIVACY_FINGERPRINTS (a file path), or none. */
export function envFingerprints(): string[] {
  const path = process.env.COACH_PRIVACY_FINGERPRINTS;
  return path ? readFingerprints(path) : [];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/public-scrub.ts <dir>");
    process.exit(2);
  }
  const findings = scrubTree(dir, { fingerprints: envFingerprints() });
  console.log(JSON.stringify({ dir, fingerprints: Boolean(process.env.COACH_PRIVACY_FINGERPRINTS), findings }, null, 2));
  process.exit(findings.length > 0 ? 1 : 0);
}
