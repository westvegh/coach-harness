// Copied-expression check for a method pack.
//
//   node scripts/overlap-check.ts <packDir> <referenceDir> [--min 8]
//
// Reports every run of 8 or more consecutive words that appears both in the
// pack (*.md, *.yaml) and in any text file under the reference folder. Words
// are lowercased with punctuation stripped; numbers are kept. Exits 1 when a
// shared run exists. Nothing from the reference folder is written to disk;
// the report prints only the pack's own words and file names.
//
// Citations are not prose: URLs are dropped everywhere, and the source table
// rows in the pack's sources.md (episode titles must match the source) are
// skipped. Pass --include-citations to check them too.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXT = /\.(md|markdown|txt|ya?ml)$/i;

const URL = /\bhttps?:\/\/\S+/g;

// Removes citation metadata from a pack file: URLs, and the rows of the
// markdown table in sources.md.
export function stripCitations(file: string, text: string): string {
  let out = text.replace(URL, " ");
  if (/(^|\/)sources\.md$/.test(file)) {
    out = out
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("|"))
      .join("\n");
  }
  return out;
}

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (TEXT_EXT.test(name)) out.push(p);
  }
  return out;
}

export type SharedRun = { file: string; start: number; length: number; text: string };

export function sharedRuns(packTexts: Record<string, string>, referenceTexts: string[], n = 8): SharedRun[] {
  const grams = new Set<string>();
  for (const t of referenceTexts) {
    const w = words(t);
    for (let i = 0; i + n <= w.length; i++) grams.add(w.slice(i, i + n).join(" "));
  }
  const runs: SharedRun[] = [];
  for (const [file, t] of Object.entries(packTexts)) {
    const w = words(t);
    let i = 0;
    while (i + n <= w.length) {
      if (!grams.has(w.slice(i, i + n).join(" "))) {
        i++;
        continue;
      }
      // Extend the run while each next n-gram is also shared.
      let end = i + n;
      while (end < w.length && grams.has(w.slice(end - n + 1, end + 1).join(" "))) end++;
      runs.push({ file, start: i, length: end - i, text: w.slice(i, end).join(" ") });
      i = end;
    }
  }
  return runs;
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  const mi = args.indexOf("--min");
  const includeCitations = args.includes("--include-citations");
  const n = mi >= 0 ? Number(args[mi + 1]) : 8;
  const [packDir, refDir] = args.filter((a, i) => !a.startsWith("--") && (mi < 0 || i !== mi + 1));
  if (!packDir || !refDir || !Number.isInteger(n) || n < 2) {
    console.error("usage: node scripts/overlap-check.ts <packDir> <referenceDir> [--min 8] [--include-citations]");
    return 2;
  }
  const pack: Record<string, string> = {};
  for (const f of files(packDir)) {
    const rel = relative(packDir, f);
    const text = readFileSync(f, "utf8");
    pack[rel] = includeCitations ? text : stripCitations(rel, text);
  }
  const refFiles = files(refDir);
  const runs = sharedRuns(pack, refFiles.map((f) => readFileSync(f, "utf8")), n);
  for (const r of runs) console.log(`${r.file} @word ${r.start}: ${r.length} words: "${r.text}"`);
  console.log(
    `${runs.length} shared runs of ${n}+ words (${Object.keys(pack).length} pack files vs ${refFiles.length} reference files` +
      `${includeCitations ? "" : "; URLs and the sources.md table skipped"})`,
  );
  return runs.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv);
}
