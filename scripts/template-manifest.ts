// The template manifest of an exported tree (contracts §24):
//   node scripts/template-manifest.ts <export dir>            writes template-manifest.json
//   node scripts/template-manifest.ts --verify <export dir>   exit 1 when it does not match the files
// The repo URL and the release come from package.json in the export.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, MANIFEST, manifestJson, templateRepoUrl } from "../engine/manifest.ts";

const verify = process.argv[2] === "--verify";
const dir = verify ? process.argv[3] : process.argv[2];
if (!dir) {
  process.stderr.write("usage: node scripts/template-manifest.ts [--verify] <export dir>\n");
  process.exit(2);
}
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const repo = templateRepoUrl(typeof pkg.repository === "string" ? pkg.repository : String(pkg.repository?.url ?? ""));
if (!repo || typeof pkg.version !== "string") {
  process.stderr.write("template-manifest: package.json needs a GitHub repository url and a version\n");
  process.exit(1);
}
const m = manifestJson(buildManifest(dir, { repo, release: pkg.version }));
if (verify) {
  const ok = existsSync(join(dir, MANIFEST)) && readFileSync(join(dir, MANIFEST), "utf8") === m;
  process.stderr.write(ok ? "template-manifest: matches the files\n" : "template-manifest: does NOT match the files\n");
  process.exit(ok ? 0 : 1);
}
writeFileSync(join(dir, MANIFEST), m);
process.stderr.write(`template-manifest: ${Object.keys(JSON.parse(m).files).length} files, release ${pkg.version}\n`);
