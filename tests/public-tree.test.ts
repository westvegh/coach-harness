// The public tree: scripts/export-public.sh copies exactly scripts/public-tree.txt, the
// export holds no excluded path, and the scrub (scripts/public-scrub.ts) finds no private
// or internal text in it. Marker strings are built at run time, so this file passes the scrub.
import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { envFingerprints, scrubText, scrubTree } from "../scripts/public-scrub.ts";

const REPO = new URL("..", import.meta.url).pathname;
const SCRIPT = join(REPO, "scripts/export-public.sh");
const j = (...parts: string[]) => parts.join("");

const inGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: REPO }).status === 0;
const skip = inGit ? false : "not a git checkout: the export reads git ls-files";

/** Folders and files that must never ship. */
const EXCLUDED_PREFIXES = ["docs/build/", "docs/reviews/", "docs/explainers/", "node_modules/", "evals/results/", "athlete/", ".git/"];
const EXCLUDED_FILES = ["docs/design.md", "docs/backlog.md", "coach.yaml", ".claude/settings.local.json"];
/** Files the public repo needs. */
const REQUIRED = [
  "README.md", "LICENSE", "CLAUDE.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md", "coach.example.yaml",
  "package.json", "package-lock.json", ".nvmrc", "tsconfig.json", ".gitignore",
  "docs/how-it-works.md", "docs/safety.md", "docs/safety-and-privacy.md", "docs/contracts.md",
  "docs/adding-a-method.md", "docs/adding-a-logger-or-signal.md", "docs/tally.md",
  ".github/workflows/test.yml", "engine/cli.ts", ".claude/settings.json", "git-hooks/pre-push",
  "methods/nine-adaptations/rules.yaml", "templates/athlete/limits.yaml", "scripts/export-public.sh",
];

function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, root));
    else out.push(relative(root, full));
  }
  return out.sort();
}

function exportTree(): string {
  const dest = join(mkdtempSync(join(tmpdir(), "coach-public-")), "tree");
  execFileSync("bash", [SCRIPT, dest], { cwd: REPO, env: { ...process.env, ALLOW_DIRTY: "1" }, stdio: "pipe" });
  return dest;
}

/** The expected file list, computed independently of the shell script. */
function expectedFiles(): string[] {
  const rules = readFileSync(join(REPO, "scripts/public-tree.txt"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const inc = rules.filter((r) => !r.startsWith("!"));
  const exc = rules.filter((r) => r.startsWith("!")).map((r) => r.slice(1));
  const hit = (p: string, r: string) => (r.endsWith("/") ? p.startsWith(r) : p === r);
  const athlete = (p: string) => !p.startsWith("templates/athlete/") && p.split("/").includes("athlete");
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" }).split("\0").filter(Boolean);
  return tracked
    .filter((p) => inc.some((r) => hit(p, r)) && !exc.some((r) => hit(p, r)) && !athlete(p) && existsSync(join(REPO, p)))
    .concat(["template-manifest.json"]) // written by the export (contracts §24)
    .sort();
}

describe("the public export", { skip }, () => {
  let dest = "";
  let files: string[] = [];
  before(() => {
    dest = exportTree();
    files = walk(dest);
  });

  test("copies exactly the allowlist, with no git history", () => {
    assert.ok(!existsSync(join(dest, ".git")), "the export must not hold .git");
    assert.deepEqual(files, expectedFiles());
  });

  test("holds no excluded path", () => {
    const bad = files.filter(
      (f) => EXCLUDED_PREFIXES.some((p) => f.startsWith(p)) || EXCLUDED_FILES.includes(f) || (!f.startsWith("templates/athlete/") && f.split("/").includes("athlete")),
    );
    assert.deepEqual(bad, []);
  });

  test("holds zero athlete files and no token (launch review finding 6: the athlete-file check lives here)", () => {
    const athlete = files.filter((f) => !f.startsWith("templates/athlete/") && f.split("/").includes("athlete"));
    assert.deepEqual(athlete, []);
    assert.ok(!files.includes("coach.yaml"), "the export holds no coach.yaml");
  });

  test("writes template-manifest.json: every exported file with its git mode and blob id", () => {
    const m = JSON.parse(readFileSync(join(dest, "template-manifest.json"), "utf8"));
    assert.equal(m.version, 1);
    assert.equal(m.repo, j("https://github.com/", "west", "vegh/coach-harness"));
    assert.equal(m.release, JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version);
    assert.deepEqual(Object.keys(m.files), files.filter((f) => f !== "template-manifest.json"), "every file but the manifest, sorted");
    // git's own view of the exported bytes and modes.
    execFileSync("git", ["init", "-q"], { cwd: dest });
    execFileSync("git", ["add", "-A"], { cwd: dest });
    for (const line of execFileSync("git", ["ls-files", "-s"], { cwd: dest, encoding: "utf8" }).trim().split("\n")) {
      const [meta, path] = line.split("\t");
      const [mode, blob] = meta.split(" ");
      if (path === "template-manifest.json") continue;
      assert.deepEqual(m.files[path], { mode, blob }, path);
    }
    execFileSync("rm", ["-rf", join(dest, ".git")]);
    assert.equal(spawnSync(process.execPath, [join(REPO, "scripts/template-manifest.ts"), "--verify", dest]).status, 0);
  });

  test("holds every file the public repo needs", () => {
    assert.deepEqual(REQUIRED.filter((f) => !files.includes(f)), []);
  });

  test("keeps the executable bit on scripts and git hooks", () => {
    for (const f of ["git-hooks/pre-push", "scripts/export-public.sh"]) {
      assert.ok(statSync(join(dest, f)).mode & 0o100, `${f} must stay executable`);
    }
  });

  test("passes the scrub: no private paths, names, emails, build tool names or tokens", () => {
    const findings = scrubTree(dest, { fingerprints: envFingerprints() });
    assert.deepEqual(findings, [], JSON.stringify(findings, null, 2));
  });

  test("the script refuses a folder that is not empty", () => {
    const r = spawnSync("bash", [SCRIPT, dest], { cwd: REPO, env: { ...process.env, ALLOW_DIRTY: "1" }, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not empty/);
  });
});

describe("the scrub catches a planted marker", () => {
  const planted: Record<string, string> = {
    "home path": j("see /Us", "ers/alex/coach"),
    "private folder name": j("from ~/Fitness ", "& Health/notes"),
    "build tool name (lower)": j("run it in or", "ca"),
    "build tool name (upper)": j("the Or", "ca panel"),
    "build model name (lower)": j("as", "tra said so"),
    "build model name (upper)": j("As", "tra review"),
    "model id": j("gpt", "-6-preview"),
    "message type": j("send wor", "ker", "_done"),
    "owner handle": j("west", "vegh on a forum"),
    "email address": j("mail jane.doe", "@", "gmail.com"),
    "GitHub token": j("gh", "p_", "A1b2C3d4".repeat(5)),
    "AWS key": j("AK", "IA", "ABCDEFGHIJ234567"),
    "private key": j("-----BEGIN RSA PRI", "VATE KEY-----"),
    "design section": j("// see des", "ign §7"),
    "build brief": j("// from bri", "ef E3 step 2"),
    "review round": j("// Revi", "ew H #1: plural keywords"),
    "build agent": j("// the wor", "ker asked"),
  };

  for (const [name, text] of Object.entries(planted)) {
    test(name, () => {
      const f = scrubText("notes.md", `clean line\n${text}\n`);
      assert.equal(f.length >= 1, true, `not caught: ${name}`);
      assert.equal(f[0].line, 2);
      assert.ok(!JSON.stringify(f).includes(text), "a finding must not echo the match");
    });
  }

  test("allowed text passes", () => {
    const ok = [
      j("https://github.com/", "west", "vegh/coach-harness/issues"),
      "git config user.email eval@example.com",
      "git@github.com:alex/coach.git",
      "https://x-access-token:abc@github.com/alex/coach",
      "sha256: 3fa1c2d9e0b4, op-2026-10-12-trim_session-3fa1c2d9e0b4",
    ];
    assert.deepEqual(scrubText("README.md", ok.join("\n")), []);
    assert.deepEqual(scrubText("LICENSE", j("Copyright (c) 2026 ", "west", "vegh")), []);
    assert.equal(scrubText("README.md", j("Copyright (c) 2026 ", "west", "vegh")).length, 1, "only LICENSE may carry the copyright line");
  });

  test("the repo URL allowance is anchored: the private dev repo name is caught", () => {
    assert.deepEqual(scrubText("template-manifest.json", j('  "repo": "https://github.com/', "west", 'vegh/coach-harness",')), []);
    assert.equal(scrubText("README.md", j("https://github.com/", "west", "vegh/coach-harness-dev")).length >= 1, true);
    assert.equal(scrubText("README.md", j("see github.com/", "west", "vegh/coach-harness_x")).length >= 1, true);
  });

  test("plain words near the internal-ref patterns pass", () => {
    assert.deepEqual(scrubText("CLAUDE.md", "Never put brief text in a commit.\nReview last week.\nreview the plan"), []);
  });

  test("the internal-ref check covers the hooks like every other file", () => {
    const line = j("// revi", "ew B #4: an error read");
    assert.equal(scrubText(".claude/hooks/guard-writes.ts", line).length, 1);
    assert.equal(scrubText(".claude/skills/today/SKILL.md", line).length, 1);
    assert.equal(scrubText(".claude/hooks/x.ts", j("As", "tra")).length, 1, "the other markers apply to the hooks too");
  });

  test("a fingerprint line is caught, case-insensitive", () => {
    assert.equal(scrubText("x.md", "see the Zorbonian Clinic note", ["zorbonian clinic"]).length, 1);
  });

  test("a planted marker in an exported tree fails the scrub", { skip }, () => {
    const dest = exportTree();
    assert.deepEqual(scrubTree(dest), []);
    appendFileSync(join(dest, "docs/how-it-works.md"), j("\nAsk As", "tra.\n"));
    mkdirSync(join(dest, "notes"), { recursive: true });
    writeFileSync(join(dest, "notes", j("or", "ca.md")), "x\n");
    const kinds = scrubTree(dest).map((f) => `${f.file}:${f.kind}`);
    assert.ok(kinds.some((k) => k.startsWith("docs/how-it-works.md:build model name")), kinds.join(", "));
    assert.ok(kinds.some((k) => k.includes("path: build tool name")), kinds.join(", "));
  });
});
