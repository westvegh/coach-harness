// `update` (contracts §24): the plan table, path rules, the all-or-nothing apply, the
// guard and config-check. The fixtures are a template repository with two releases and a
// copy made from the first one (as GitHub's "Use this template" makes it: one commit, no
// link). The library takes the fetch source as a parameter; the CLI accepts only the
// manifest's GitHub URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { blobId, buildManifest, manifestJson, parseTreeRules, pathProblem, validateManifest, type Manifest } from "../engine/manifest.ts";
import { applyUpdate, planUpdate, prepareUpdate, type Entry } from "../engine/update.ts";
import { CoachError } from "../engine/errors.ts";

const REPO = new URL("..", import.meta.url).pathname;
const ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR"].includes(k))),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
// applyUpdate commits with the process environment.
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
delete process.env.COACH_UNATTENDED;
delete process.env.CLAUDE_CODE_REMOTE;

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: ENV }).trim();
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const GH = "https://github.com/alex/coach-harness";

const TREE = ["# fixture public tree", "CHANGELOG.md", "package.json", "package-lock.json", ".claude/", "files/", "git-hooks/", "scripts/", "templates/", "!athlete/", ""].join("\n");
const SETTINGS = (hook = ".claude/hooks/guard.ts") => JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node "$CLAUDE_PROJECT_DIR/${hook}"` }] }] } }, null, 2);

type Files = Record<string, string | { text: string; mode?: number; link?: boolean }>;

const RELEASE1: Files = {
  "scripts/public-tree.txt": TREE,
  "package.json": '{"version":"0.1.0"}\n',
  "package-lock.json": "{}\n",
  "CHANGELOG.md": "# Changelog\n\n## [0.1.0]\n\nFirst.\n",
  ".claude/settings.json": SETTINGS(),
  ".claude/hooks/guard.ts": "// guard v1\n",
  "git-hooks/pre-push": { text: "#!/bin/sh\nexit 0\n", mode: 0o755 },
  "templates/athlete/brief.md": "# brief\n",
  "files/same.txt": "same\n",
  "files/replace.txt": "v1\n",
  "files/already.txt": "v1\n",
  "files/conflict.txt": "v1\n",
  "files/mine.txt": "v1\n",
  "files/removed-by-user.txt": "v1\n",
  "files/removed-changed.txt": "v1\n",
  "files/dropped.txt": "v1\n",
  "files/dropped-mine.txt": "v1\n",
  "files/gone.txt": "v1\n",
};

function release2(): Files {
  const r: Files = { ...RELEASE1 };
  r["package.json"] = '{"version":"0.2.0"}\n';
  r["CHANGELOG.md"] = "# Changelog\n\n## [0.2.0]\n\nFixes for the week.\n\n## [0.1.0]\n\nFirst.\n";
  r["files/replace.txt"] = "v2\n";
  r["files/already.txt"] = "v2\n";
  r["files/conflict.txt"] = "v2\n";
  r["files/removed-changed.txt"] = "v2\n";
  delete r["files/dropped.txt"];
  delete r["files/dropped-mine.txt"];
  delete r["files/gone.txt"];
  r["files/new.txt"] = "new\n";
  r["files/new-same.txt"] = "new\n";
  r["files/new-collide.txt"] = "template\n";
  return r;
}

function writeFiles(dir: string, files: Files): void {
  for (const [p, v] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(dirname(full), { recursive: true });
    const f = typeof v === "string" ? { text: v } : v;
    if (f.link) symlinkSync(f.text, full);
    else {
      writeFileSync(full, f.text);
      chmodSync(full, f.mode ?? 0o644);
    }
  }
}

/** A staged export: the files plus a manifest built from them (as export-public.sh does). */
function staged(files: Files, release: string, edit?: (m: Manifest) => void): string {
  const dir = tmp("coach-stage-");
  writeFiles(dir, files);
  const m = buildManifest(dir, { repo: GH, release });
  edit?.(m);
  writeFileSync(join(dir, "template-manifest.json"), manifestJson(m));
  return dir;
}

/** The template repository: one commit per release. */
function templateRepo(...releases: string[]): string {
  const dir = tmp("coach-template-");
  git(dir, "init", "-q", "-b", "main");
  for (const s of releases) {
    for (const f of git(dir, "ls-files").split("\n").filter(Boolean)) rmSync(join(dir, f), { force: true });
    cpSync(s, dir, { recursive: true, verbatimSymlinks: true });
    // Reset the index, so a case-only rename is recorded under its new name on a case-insensitive disk.
    git(dir, "rm", "-r", "-q", "--cached", "--ignore-unmatch", ".");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "release");
  }
  return dir;
}

/** A copy made from a staged release: one commit, no link, plus the athlete's files. */
function copyOf(stage: string, edit?: (dir: string) => void): string {
  const dir = tmp("coach-copy-");
  cpSync(stage, dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "coach.yaml"), "version: 1\n");
  writeFileSync(join(dir, ".gitignore"), ".tmp/\n"); // as the template's own .gitignore
  mkdirSync(join(dir, "athlete/log"), { recursive: true });
  writeFileSync(join(dir, "athlete/brief.md"), "# my brief\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Initial commit");
  if (edit) {
    edit(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "my changes");
  }
  return dir;
}

/** The user's changes that exercise every row of the plan table. */
function userEdits(dir: string): void {
  writeFileSync(join(dir, "files/already.txt"), "v2\n");
  writeFileSync(join(dir, "files/conflict.txt"), "mine\n");
  writeFileSync(join(dir, "files/mine.txt"), "mine\n");
  rmSync(join(dir, "files/removed-by-user.txt"));
  rmSync(join(dir, "files/removed-changed.txt"));
  writeFileSync(join(dir, "files/dropped-mine.txt"), "mine\n");
  rmSync(join(dir, "files/gone.txt"));
  writeFileSync(join(dir, "files/new-same.txt"), "new\n");
  writeFileSync(join(dir, "files/new-collide.txt"), "mine\n");
}

function fixture() {
  const s1 = staged(RELEASE1, "0.1.0");
  const s2 = staged(release2(), "0.2.0");
  const source = templateRepo(s1, s2);
  const root = copyOf(s1, userEdits);
  return { source, root, s1, s2 };
}

const opts = (root: string, source: string, extra: Record<string, unknown> = {}) => ({ root, source, ref: "main", env: ENV, ...extra });

// ---------- the plan table ----------

test("the plan: every row of the table", () => {
  const A = { mode: "100644", blob: "a".repeat(40) };
  const B = { mode: "100644", blob: "b".repeat(40) };
  const C = { mode: "100644", blob: "c".repeat(40) };
  const Ax = { mode: "100755", blob: "a".repeat(40) };
  const rows: [string, Entry | undefined, Entry | undefined, Entry | undefined, string][] = [
    ["aaa", A, A, A, "unchanged"],
    ["aba", A, B, A, "replace"],
    ["abb", A, B, B, "unchanged"],
    ["abc", A, B, C, "conflict"],
    ["aac", A, A, C, "kept"],
    ["aa-", A, A, undefined, "kept"],
    ["ab-", A, B, undefined, "conflict"],
    ["a-a", A, undefined, A, "delete"],
    ["a-c", A, undefined, C, "kept"],
    ["a--", A, undefined, undefined, "nothing"],
    ["-b-", undefined, B, undefined, "add"],
    ["-bb", undefined, B, B, "unchanged"],
    ["-bc", undefined, B, C, "conflict"],
    ["mode", A, Ax, A, "replace"], // a mode change is a change
  ];
  for (const [name, o, n, l, want] of rows) {
    const p = planUpdate(o ? { [name]: o } : {}, n ? { [name]: n } : {}, new Map(l ? [[name, l]] : []));
    const got = p.replace.includes(name) ? "replace" : p.add.includes(name) ? "add" : p.delete.includes(name) ? "delete" : p.conflicts.some((c) => c.path === name) ? "conflict" : p.kept.includes(name) ? "kept" : p.unchanged === 1 ? "unchanged" : "nothing";
    assert.equal(got, want, name);
  }
  // A template path that differs only in case from a local file is a conflict.
  const twin = planUpdate({}, { "files/Readme.md": B }, new Map([["files/README.md", C]]));
  assert.equal(twin.conflicts[0]?.path, "files/Readme.md");
});

test("check: an end-to-end plan from a copy and a second release, with the changelog; nothing changes", () => {
  const { source, root } = fixture();
  const head = git(root, "rev-parse", "HEAD");
  const p = prepareUpdate(opts(root, source));
  assert.deepEqual(p.plan.replace, ["CHANGELOG.md", "files/replace.txt", "package.json"]);
  assert.deepEqual(p.plan.add, ["files/new.txt"]);
  assert.deepEqual(p.plan.delete, ["files/dropped.txt"]);
  assert.deepEqual(p.plan.conflicts.map((c) => c.path), ["files/conflict.txt", "files/new-collide.txt", "files/removed-changed.txt"]);
  assert.deepEqual(p.plan.kept.sort(), ["files/dropped-mine.txt", "files/mine.txt", "files/removed-by-user.txt"]);
  assert.equal(p.oldManifest.release, "0.1.0");
  assert.equal(p.newManifest.release, "0.2.0");
  assert.deepEqual(p.changelog.map((c) => c.heading), ["[0.2.0]"]);
  assert.match(p.changelog[0].text, /Fixes for the week/);
  assert.equal(p.to, git(source, "rev-parse", "HEAD"));
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(root, "status", "--porcelain"), "");
});

// ---------- apply ----------

test("apply: an unsettled conflict changes nothing; --keep-mine and --take-template settle them; one commit with the trailer; the next check has nothing left", () => {
  const { source, root } = fixture();
  const head = git(root, "rev-parse", "HEAD");
  const to = git(source, "rev-parse", "HEAD");
  assert.throws(() => applyUpdate(opts(root, source, { to })), (e: unknown) => e instanceof CoachError && e.code === "UPDATE_CONFLICT");
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(root, "status", "--porcelain"), "");

  const r = applyUpdate(opts(root, source, { to, keepMine: ["files/conflict.txt", "files/removed-changed.txt"], takeTemplate: ["files/new-collide.txt"] }));
  assert.equal(readFileSync(join(root, "files/replace.txt"), "utf8"), "v2\n");
  assert.equal(readFileSync(join(root, "files/new.txt"), "utf8"), "new\n");
  assert.equal(existsSync(join(root, "files/dropped.txt")), false);
  assert.equal(readFileSync(join(root, "files/conflict.txt"), "utf8"), "mine\n", "kept mine");
  assert.equal(existsSync(join(root, "files/removed-changed.txt")), false, "kept my removal");
  assert.equal(readFileSync(join(root, "files/new-collide.txt"), "utf8"), "template\n", "took the template");
  assert.equal(readFileSync(join(root, ".tmp/coach/update-backup/files/new-collide.txt"), "utf8"), "mine\n", "the backup exists");
  assert.equal(readFileSync(join(root, "files/mine.txt"), "utf8"), "mine\n");
  assert.equal(readFileSync(join(root, "athlete/brief.md"), "utf8"), "# my brief\n", "athlete files untouched");
  assert.equal(readFileSync(join(root, "coach.yaml"), "utf8"), "version: 1\n");
  assert.equal(git(root, "rev-list", "--count", `${head}..HEAD`), "1", "one commit");
  const msg = git(root, "log", "-1", "--format=%B");
  assert.match(msg, /^update: coach-harness 0\.1\.0 → 0\.2\.0 \([0-9a-f]{12}\)/);
  assert.match(msg, new RegExp(`Coach-Template-Commit: ${to}`));
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(JSON.parse(readFileSync(join(root, "template-manifest.json"), "utf8")).release, "0.2.0");
  assert.equal(r.npm_ci_needed, false);
  assert.equal(r.restart_claude_code, false);

  const again = prepareUpdate(opts(root, source));
  assert.equal(again.plan.replace.length + again.plan.add.length + again.plan.delete.length + again.plan.conflicts.length, 0, JSON.stringify(again.plan));
});

test("apply: a --to that differs from the fetched commit is refused", () => {
  const { source, root } = fixture();
  assert.throws(() => applyUpdate(opts(root, source, { to: "0".repeat(40), keepMine: [] })), (e: unknown) => e instanceof CoachError && e.code === "UPDATE_REFUSED" && /run update --check again/.test(e.message));
});

test("apply: a failure in the middle of the writes restores every file", () => {
  const s1 = staged(RELEASE1, "0.1.0");
  const s2 = staged(release2(), "0.2.0");
  const source = templateRepo(s1, s2);
  const root = copyOf(s1);
  const head = git(root, "rev-parse", "HEAD");
  let n = 0;
  assert.throws(
    () => applyUpdate(opts(root, source, { to: git(source, "rev-parse", "HEAD"), beforeWrite: () => { if (++n === 3) throw new Error("disk full"); } })),
    (e: unknown) => e instanceof CoachError && e.code === "UPDATE_FAILED" && /git reset --hard && git clean -fd/.test(e.message),
  );
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(root, "status", "--porcelain"), "", "every file is back, added files removed");
  assert.equal(readFileSync(join(root, "files/replace.txt"), "utf8"), "v1\n");
  assert.equal(existsSync(join(root, "files/dropped.txt")), true);
});

test("apply: flags for npm ci, git hooks and a restart", () => {
  const s1 = staged(RELEASE1, "0.1.0");
  const s2 = staged({ ...RELEASE1, "package.json": '{"version":"0.2.0"}\n', "package-lock.json": '{"x":1}\n', "git-hooks/pre-push": { text: "#!/bin/sh\nexit 1\n", mode: 0o755 }, ".claude/hooks/guard.ts": "// guard v2\n" }, "0.2.0");
  const source = templateRepo(s1, s2);
  const root = copyOf(s1);
  const r = applyUpdate(opts(root, source, { to: git(source, "rev-parse", "HEAD") }));
  assert.equal(r.npm_ci_needed, true);
  assert.equal(r.reinstall_git_hooks, true);
  assert.equal(r.restart_claude_code, true);
  assert.equal(git(root, "ls-files", "-s", "git-hooks/pre-push").split(" ")[0], "100755", "the mode is kept");
});

test("hook safety: a new settings file that points at a missing hook entry is refused, before any write", () => {
  const s1 = staged(RELEASE1, "0.1.0");
  const s2 = staged({ ...RELEASE1, ".claude/settings.json": SETTINGS(".claude/hooks/missing.ts") }, "0.2.0");
  const source = templateRepo(s1, s2);
  const root = copyOf(s1);
  assert.throws(() => applyUpdate(opts(root, source, { to: git(source, "rev-parse", "HEAD") })), (e: unknown) => e instanceof CoachError && /missing\.ts/.test(e.message));
  assert.equal(git(root, "status", "--porcelain"), "");
  // A release that deletes the hook file the current settings name is refused too.
  const s3files = { ...RELEASE1 };
  delete s3files[".claude/hooks/guard.ts"];
  const s3 = staged(s3files, "0.3.0");
  const source3 = templateRepo(s1, s3);
  const root3 = copyOf(s1);
  assert.throws(() => applyUpdate(opts(root3, source3, { to: git(source3, "rev-parse", "HEAD") })), (e: unknown) => e instanceof CoachError && /guard\.ts/.test(e.message));
});

// ---------- refusals and path rules ----------

test("refusals: unattended, a dirty tree, another branch, a copy without a manifest, a github.com insteadOf", () => {
  const { source, root } = fixture();
  assert.throws(() => prepareUpdate({ ...opts(root, source), env: { ...ENV, COACH_UNATTENDED: "1" } }), (e: unknown) => e instanceof CoachError && e.code === "UNATTENDED");
  writeFileSync(join(root, "files/same.txt"), "dirty\n");
  assert.throws(() => prepareUpdate(opts(root, source)), /uncommitted/);
  git(root, "checkout", "-q", "--", "files/same.txt");
  git(root, "switch", "-q", "-c", "other");
  assert.throws(() => prepareUpdate(opts(root, source)), /runs on main/);
  git(root, "switch", "-q", "main");
  git(root, "config", "url.https://evil.example/.insteadOf", "https://github.com/");
  assert.throws(() => prepareUpdate(opts(root, source)), /insteadOf/);
  git(root, "config", "--unset", "url.https://evil.example/.insteadOf");
  git(root, "config", "protocol.file.allow", "always");
  assert.throws(() => prepareUpdate(opts(root, source)), /protocol\.file\.allow/);
  git(root, "config", "--unset", "protocol.file.allow");
  assert.throws(() => prepareUpdate({ ...opts(root, source), ref: "--upload-pack=x" }), (e: unknown) => e instanceof CoachError && e.code === "USAGE");
  assert.throws(() => prepareUpdate({ ...opts(root, source), ref: "a..b" }), (e: unknown) => e instanceof CoachError && e.code === "USAGE");
  // A copy made before updates existed.
  const old = tmp("coach-old-");
  writeFiles(old, RELEASE1);
  git(old, "init", "-q", "-b", "main");
  git(old, "add", "-A");
  git(old, "commit", "-q", "-m", "x");
  assert.throws(() => prepareUpdate(opts(old, source)), (e: unknown) => e instanceof CoachError && e.code === "NO_MANIFEST" && /move athlete\/ and coach\.yaml/.test(e.message));
});

test("path rules: invalid paths in either manifest are refused before any write", () => {
  const rules = parseTreeRules(TREE);
  for (const bad of ["files/athlete/x", "files/ATHLETE/x", "athlete/x", "../x", "files/../x", "files//x", "./files/x", "coach.yaml", ".git/hooks/x", "files/.git/x", "node_modules/x", "files/node_modules/x", ".husky/x", ".claude/settings.local.json", "template-manifest.json", "/etc/x", "docs/x", "files\\x"]) {
    assert.notEqual(pathProblem(bad, rules), null, bad);
  }
  for (const ok of ["files/x.txt", "templates/athlete/brief.md", ".claude/hooks/guard.ts"]) assert.equal(pathProblem(ok, rules), null, ok);
  const entry = { mode: "100644", blob: "a".repeat(40) };
  assert.throws(() => validateManifest({ version: 1, repo: GH, release: "1", files: { "files/a.txt": entry, "files/A.txt": entry } }, rules, "m"), /differ only in case/);
  assert.throws(() => validateManifest({ version: 1, repo: "https://evil.example/x", release: "1", files: {} }, rules, "m"), /repo must be/);

  // End to end: a fetched manifest with an athlete path refuses the update; nothing changes.
  const s1 = staged(RELEASE1, "0.1.0");
  const s2 = staged(release2(), "0.2.0", (m) => (m.files["files/athlete/x.md"] = entry as never));
  const source = templateRepo(s1, s2);
  const root = copyOf(s1);
  assert.throws(() => prepareUpdate(opts(root, source)), (e: unknown) => e instanceof CoachError && e.code === "MANIFEST_INVALID");
  // A tampered local manifest is refused the same way.
  const root2 = copyOf(s1, (d) => {
    const m = JSON.parse(readFileSync(join(d, "template-manifest.json"), "utf8"));
    m.files["coach.yaml"] = entry;
    writeFileSync(join(d, "template-manifest.json"), JSON.stringify(m));
  });
  assert.throws(() => prepareUpdate(opts(root2, templateRepo(s1, staged(release2(), "0.2.0")))), (e: unknown) => e instanceof CoachError && e.code === "MANIFEST_INVALID" && /local/.test(e.message));
});

test("the fetched tree: a symlink or a mode or blob that differs from the manifest is refused", () => {
  const s1 = staged(RELEASE1, "0.1.0");
  // files/link.txt is a symlink in the tree; the manifest says it is a plain file.
  const s2 = staged(release2(), "0.2.0", (m) => (m.files["files/link.txt"] = { mode: "100644", blob: blobId(Buffer.from("../coach.yaml")) }));
  writeFiles(s2, { "files/link.txt": { text: "../coach.yaml", link: true } });
  const root = copyOf(s1);
  assert.throws(() => prepareUpdate(opts(root, templateRepo(s1, s2))), (e: unknown) => e instanceof CoachError && /symlink/.test(e.message));
  const s3 = staged(release2(), "0.2.0", (m) => (m.files["files/new.txt"] = { mode: "100644", blob: "f".repeat(40) }));
  assert.throws(() => prepareUpdate(opts(copyOf(s1), templateRepo(s1, s3))), (e: unknown) => e instanceof CoachError && /differs from its manifest/.test(e.message));
});

// ---------- the CLI, the guard and config-check ----------

function cli(root: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), ...args, "--root", root], { cwd: root, encoding: "utf8", env: { ...ENV, ...env } });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json };
}

test("the CLI: --check and --yes together, unattended, no manifest, and only the manifest's GitHub URL as the source", () => {
  const { root, s1 } = fixture();
  assert.equal(cli(root, ["update", "--check", "--yes"]).json?.error?.code, "USAGE");
  assert.equal(cli(root, ["update", "--check"], { COACH_UNATTENDED: "1" }).json?.error?.code, "UNATTENDED");
  assert.equal(cli(root, ["update", "--yes", "--to", "abc"]).json?.error?.code, "USAGE");
  const plain = tmp("coach-plain-");
  git(plain, "init", "-q", "-b", "main");
  writeFileSync(join(plain, "x"), "x");
  git(plain, "add", "-A");
  git(plain, "commit", "-q", "-m", "x");
  assert.equal(cli(plain, ["update", "--check"]).json?.error?.code, "NO_MANIFEST");
  const local = copyOf(s1, (d) => {
    const m = JSON.parse(readFileSync(join(d, "template-manifest.json"), "utf8"));
    m.repo = "/tmp/elsewhere";
    writeFileSync(join(d, "template-manifest.json"), JSON.stringify(m));
  });
  assert.equal(cli(local, ["update", "--check"]).json?.error?.code, "MANIFEST_INVALID");
});

test("config-check reports a missing required key, and passes a valid coach.yaml", () => {
  const root = tmp("coach-config-");
  const example = readFileSync(join(REPO, "coach.example.yaml"), "utf8");
  writeFileSync(join(root, "coach.yaml"), example);
  mkdirSync(join(root, ".claude"));
  cpSync(join(REPO, ".claude/settings.json"), join(root, ".claude/settings.json"));
  const ok = cli(root, ["config-check"]);
  assert.equal(ok.code, 0);
  assert.equal(ok.json.ok, true);
  writeFileSync(join(root, "coach.yaml"), example.replace(/^method: .*$/m, ""));
  const bad = cli(root, ["config-check"]);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.ok, false);
  assert.ok(bad.json.problems.some((p: string) => /method/.test(p)), JSON.stringify(bad.json.problems));
});

// ---------- V1b fix 3: the urgent gate stays registered after any update ----------

const GATE_ENTRY = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf8")).hooks.PreToolUse.find((e: { hooks: { command: string }[] }) => e.hooks.some((h) => h.command.includes("urgent-gate.ts")));
const GATED = (extra: unknown[] = []) => JSON.stringify({ hooks: { PreToolUse: [GATE_ENTRY, ...extra] } }, null, 2);
const BASH_HOOK = { matcher: "Bash", hooks: [{ type: "command", command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.ts"` }] };

/** Release 2 registers the urgent gate (the v0.2 settings shape). */
function gatedFixture(edit?: (dir: string) => void) {
  const r2 = release2();
  r2[".claude/settings.json"] = GATED([BASH_HOOK]);
  r2[".claude/hooks/urgent-gate.ts"] = "// gate\n";
  const s1 = staged(RELEASE1, "0.1.0");
  const s2 = staged(r2, "0.2.0");
  return { source: templateRepo(s1, s2), root: copyOf(s1, (d) => { userEdits(d); edit?.(d); }) };
}
const settled = { keepMine: ["files/conflict.txt", "files/removed-changed.txt", "files/new-collide.txt"] };
const gateProblems = async (root: string) => (await import("../engine/settings-gate.ts")).urgentGateProblems(readFileSync(join(root, ".claude/settings.json"), "utf8"));

test("V1b fix 3: a stock settings file takes the template's, with the urgent gate; nothing is merged", async () => {
  const { source, root } = gatedFixture();
  const p = prepareUpdate(opts(root, source));
  const r = applyUpdate(opts(root, source, { to: p.to, ...settled }));
  assert.equal(r.settings_merged, false);
  assert.ok(r.written.includes(".claude/settings.json"));
  assert.deepEqual(await gateProblems(root), []);
  assert.equal(cli(root, ["config-check"]).json.problems.some((x: string) => /urgent-gate/.test(x)), false);
});

test("V1b fix 3: a customized settings file the athlete keeps gets the urgent-gate entry merged in; their other hooks stay", async () => {
  const mine = { matcher: "Read", hooks: [{ type: "command", command: "echo mine" }] };
  const { source, root } = gatedFixture((d) => writeFileSync(join(d, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [BASH_HOOK, mine] }, env: { MINE: "1" } }, null, 2)));
  const before = cli(root, ["config-check"]);
  assert.ok(before.json.problems.some((x: string) => /does not register the urgent-gate hook/.test(x)), JSON.stringify(before.json));
  const p = prepareUpdate(opts(root, source));
  assert.ok(p.plan.conflicts.some((c) => c.path === ".claude/settings.json"));
  const r = applyUpdate(opts(root, source, { to: p.to, keepMine: [...settled.keepMine, ".claude/settings.json"] }));
  assert.equal(r.settings_merged, true);
  assert.equal(r.restart_claude_code, true);
  const after = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  assert.deepEqual(after.env, { MINE: "1" });
  assert.equal(after.hooks.PreToolUse.length, 3);
  assert.deepEqual(after.hooks.PreToolUse.slice(0, 2), [BASH_HOOK, mine]);
  assert.deepEqual(await gateProblems(root), []);
  assert.equal(git(root, "status", "--porcelain"), "", "the merged file is committed with the update");
  // A stale urgent-gate entry (onFailure changed) is replaced, not doubled.
  const stale = structuredClone(GATE_ENTRY);
  stale.hooks[0].onFailure = "continue";
  const { mergeUrgentGate } = await import("../engine/settings-gate.ts");
  const fixed = JSON.parse(mergeUrgentGate(JSON.stringify({ hooks: { PreToolUse: [stale] } }), GATED())!);
  assert.deepEqual(fixed.hooks.PreToolUse, [GATE_ENTRY]);
  writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [stale] } }));
  assert.ok(cli(root, ["config-check"]).json.problems.some((x: string) => /onFailure/.test(x)));
});

test("V1b fix 3: hooks in settings.local.json that point at the guard stubs are reported, not refused", () => {
  const { source, root } = gatedFixture();
  writeFileSync(join(root, ".claude/settings.local.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-files.ts"` }] }] } }));
  // settings.local.json is ignored (Claude Code's own convention), so the tree stays clean.
  writeFileSync(join(root, ".gitignore"), ".tmp/\n.claude/settings.local.json\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-q", "-m", "ignore local settings");
  const p = prepareUpdate(opts(root, source));
  const r = applyUpdate(opts(root, source, { to: p.to, ...settled }));
  assert.deepEqual(r.local_guard_hooks, [`node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-files.ts"`]);
  const cc = cli(root, ["config-check"]);
  assert.match(cc.json.notes.join(" "), /settings\.local\.json still runs the v0\.1 guard stubs/);
  assert.equal(cc.json.problems.some((x: string) => /guard/.test(x)), false);
});

test("V1b fix 3: config-check reports a missing settings file", () => {
  const root = tmp("coach-config-");
  writeFileSync(join(root, "coach.yaml"), readFileSync(join(REPO, "coach.example.yaml"), "utf8"));
  const r = cli(root, ["config-check"]);
  assert.equal(r.code, 1);
  assert.ok(r.json.problems.some((x: string) => /settings\.json is missing/.test(x)));
});

// ---------- U2: the fix round after the review (each fails on the first update version) ----------

import { commandPaths, hookPaths } from "../engine/update.ts";
import { readdirSync as readdir } from "node:fs";

const SHA = "a".repeat(40);

test("U2 fix 2: a symlink at the backup path, or in a backup parent folder, refuses before any write", () => {
  for (const where of ["file", "parent"] as const) {
    const { source, root } = fixture();
    const head = git(root, "rev-parse", "HEAD");
    const brief = readFileSync(join(root, "athlete/brief.md"), "utf8");
    if (where === "file") {
      mkdirSync(join(root, ".tmp/coach/update-backup/files"), { recursive: true });
      symlinkSync(join(root, "athlete/brief.md"), join(root, ".tmp/coach/update-backup/files/new-collide.txt"));
    } else {
      mkdirSync(join(root, ".tmp/coach/update-backup"), { recursive: true });
      symlinkSync(join(root, "athlete"), join(root, ".tmp/coach/update-backup/files"));
    }
    assert.throws(
      () => applyUpdate(opts(root, source, { to: git(source, "rev-parse", "HEAD"), keepMine: ["files/conflict.txt", "files/removed-changed.txt"], takeTemplate: ["files/new-collide.txt"] })),
      (e: unknown) => e instanceof CoachError && /symbolic link/.test(e.message),
      where,
    );
    assert.equal(readFileSync(join(root, "athlete/brief.md"), "utf8"), brief, `${where}: athlete file untouched`);
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(root, "files/new-collide.txt"), "utf8"), "mine\n");
  }
});

test("U2 fix 3: a case collision with a kept file is a keep-mine-only conflict; a wrong settlement is refused; the repeat check is clean", () => {
  const A = { mode: "100644", blob: "a".repeat(40) };
  const B = { mode: "100644", blob: "b".repeat(40) };
  const C = { mode: "100644", blob: "c".repeat(40) };
  const p = planUpdate({ "files/Foo": A }, { "files/foo": B }, new Map([["files/Foo", C]]));
  assert.deepEqual(p.add, []);
  assert.deepEqual(p.kept, ["files/Foo"]);
  assert.deepEqual(p.conflicts.map((c) => [c.path, c.fixes]), [["files/foo", ["--keep-mine files/foo"]]]);
  // A clean case-only rename is not a conflict (the old name is deleted first).
  const r = planUpdate({ "files/Foo": A }, { "files/foo": A }, new Map([["files/Foo", A]]));
  assert.deepEqual([r.delete, r.add, r.conflicts.length], [["files/Foo"], ["files/foo"], 0]);

  // End to end on a real repository.
  const r1: Files = { ...RELEASE1, "files/Foo": "A\n" };
  const r2: Files = { ...RELEASE1, "package.json": '{"version":"0.2.0"}\n', "files/foo": "B\n" };
  const s1 = staged(r1, "0.1.0");
  const source = templateRepo(s1, staged(r2, "0.2.0"));
  const root = copyOf(s1, (d) => writeFileSync(join(d, "files/Foo"), "C\n"));
  const to = git(source, "rev-parse", "HEAD");
  assert.deepEqual(prepareUpdate(opts(root, source)).plan.conflicts.map((c) => c.path), ["files/foo"]);
  assert.throws(() => applyUpdate(opts(root, source, { to, takeTemplate: ["files/foo"] })), (e: unknown) => e instanceof CoachError && e.code === "USAGE" && /only fix offered/.test(e.message));
  applyUpdate(opts(root, source, { to, keepMine: ["files/foo"] }));
  assert.equal(readFileSync(join(root, "files/Foo"), "utf8"), "C\n", "the kept edit is still there");
  assert.equal(prepareUpdate(opts(root, source)).plan.conflicts.length, 0, "the repeat check reports no conflict");
});

test("U2 fix 4: an ignored file at an added path is a conflict and is never overwritten; other ignored files are fine", () => {
  const { source, root } = fixture();
  writeFileSync(join(root, ".gitignore"), ".tmp/\nfiles/new.txt\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-q", "-m", "ignore");
  writeFileSync(join(root, "files/new.txt"), "ignored user data\n");
  mkdirSync(join(root, ".tmp/coach"), { recursive: true });
  writeFileSync(join(root, ".tmp/coach/scratch.json"), "{}");
  const plan = prepareUpdate(opts(root, source)).plan;
  const c = plan.conflicts.find((x) => x.path === "files/new.txt");
  assert.ok(c, "a conflict");
  assert.deepEqual(c.fixes, ["--keep-mine files/new.txt", "--take-template files/new.txt"]);
  const to = git(source, "rev-parse", "HEAD");
  const settle = { keepMine: ["files/conflict.txt", "files/removed-changed.txt"], takeTemplate: ["files/new-collide.txt"] };
  assert.throws(() => applyUpdate(opts(root, source, { to, ...settle })), (e: unknown) => e instanceof CoachError && e.code === "UPDATE_CONFLICT");
  applyUpdate(opts(root, source, { to, keepMine: [...settle.keepMine, "files/new.txt"], takeTemplate: settle.takeTemplate }));
  assert.equal(readFileSync(join(root, "files/new.txt"), "utf8"), "ignored user data\n");
});

test("U2 fix 5: an empty insteadOf prefix refuses", () => {
  const { source, root } = fixture();
  git(root, "config", "url.https://example.invalid/.insteadOf", "");
  assert.throws(() => prepareUpdate(opts(root, source)), (e: unknown) => e instanceof CoachError && /insteadOf/.test(e.message));
});

test("U2 fix 6: rollback keeps the original of a case-only rename, and leaves no temp file after a rename failure", () => {
  const r1: Files = { ...RELEASE1, "files/Foo": "original\n" };
  const r2: Files = { ...RELEASE1, "package.json": '{"version":"0.2.0"}\n', "files/foo": "original\n", "files/z.txt": "z\n" };
  const s1 = staged(r1, "0.1.0");
  const source = templateRepo(s1, staged(r2, "0.2.0"));
  const root = copyOf(s1);
  const to = git(source, "rev-parse", "HEAD");
  assert.throws(
    () => applyUpdate(opts(root, source, { to, beforeWrite: (p: string) => { if (p === "files/z.txt") throw new Error("injected"); } })),
    (e: unknown) => e instanceof CoachError && e.code === "UPDATE_FAILED" && /every file was restored/.test(e.message),
  );
  assert.ok(readdir(join(root, "files")).includes("Foo"), "files/Foo is back under its own name");
  assert.equal(readFileSync(join(root, "files/Foo"), "utf8"), "original\n");
  assert.equal(git(root, "status", "--porcelain"), "");

  // Without a failure, the commit records the new name.
  const ok = copyOf(s1);
  applyUpdate(opts(ok, source, { to }));
  assert.match(git(ok, "ls-files", "files"), /^files\/foo$/m);
  assert.doesNotMatch(git(ok, "ls-files", "files"), /^files\/Foo$/m);
  assert.equal(prepareUpdate(opts(ok, source)).plan.kept.length, 0, "nothing left behind under the old name");

  const root2 = copyOf(s1);
  let n = 0;
  assert.throws(() => applyUpdate(opts(root2, source, { to, beforeRename: () => { if (++n === 2) throw new Error("rename failed"); } })), (e: unknown) => e instanceof CoachError && e.code === "UPDATE_FAILED");
  const walk = (d: string): string[] => readdir(d, { withFileTypes: true }).flatMap((e) => (e.name === ".git" ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  assert.deepEqual(walk(root2).filter((f) => f.includes(".coach-update-")), []);
  assert.equal(git(root2, "status", "--porcelain"), "");
});

test("U2 fix 7: a glob or a leading colon in a manifest path is refused; git commands use literal pathspecs", () => {
  const rules = parseTreeRules(TREE);
  for (const bad of ["files/*", "files/?.txt", "files/[ab].txt", ":files/x", "files/x]"]) assert.notEqual(pathProblem(bad, rules), null, bad);
  const s1 = staged(RELEASE1, "0.1.0");
  const entry = { mode: "100644", blob: "a".repeat(40) };
  const source = templateRepo(s1, staged(release2(), "0.2.0", (m) => (m.files["files/*"] = entry as never)));
  assert.throws(() => prepareUpdate(opts(copyOf(s1), source)), (e: unknown) => e instanceof CoachError && e.code === "MANIFEST_INVALID");
  const src = readFileSync(join(REPO, "engine/update.ts"), "utf8");
  for (const m of src.matchAll(/git\(root, \[([^\]]*"(?:add|reset|checkout)"[^\]]*)\]/g)) assert.match(m[1], /"--literal-pathspecs"/, m[1]);
});

test("U2 fix 8: every project path in a hook command is checked; unparseable commands refuse", () => {
  assert.deepEqual(commandPaths("node .claude/hooks/missing.ts"), [".claude/hooks/missing.ts"]);
  assert.deepEqual(commandPaths('node "$CLAUDE_PROJECT_DIR/.claude/hooks/a.ts" && node "$CLAUDE_PROJECT_DIR/.claude/hooks/missing.ts"'), [".claude/hooks/a.ts", ".claude/hooks/missing.ts"]);
  assert.deepEqual(commandPaths("node $CLAUDE_PROJECT_DIR/.claude/hooks/a.ts; node ./.claude/hooks/b.ts"), [".claude/hooks/a.ts", ".claude/hooks/b.ts"]);
  assert.deepEqual(commandPaths('node "${CLAUDE_PROJECT_DIR}/.claude/hooks/c.ts"'), [".claude/hooks/c.ts"]);
  for (const bad of ["node $(echo x).ts", "node `x`", "node .claude/hooks/a.ts | tee x", "node $HOME/x.ts", "node x.ts > out", "node ../outside.ts"]) {
    assert.throws(() => commandPaths(bad), (e: unknown) => e instanceof CoachError && e.code === "UPDATE_REFUSED", bad);
  }
  assert.deepEqual(hookPaths(readFileSync(join(REPO, ".claude/settings.json"), "utf8")).sort().slice(0, 2), [".claude/hooks/capture-reads.ts", ".claude/hooks/commit-check.ts"]);
  // End to end: a new settings file with a relative hook path to a missing file refuses.
  const s1 = staged(RELEASE1, "0.1.0");
  const settings = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node .claude/hooks/missing.ts" }] }] } });
  const source = templateRepo(s1, staged({ ...RELEASE1, ".claude/settings.json": settings }, "0.2.0"));
  const root = copyOf(s1);
  assert.throws(() => applyUpdate(opts(root, source, { to: git(source, "rev-parse", "HEAD") })), (e: unknown) => e instanceof CoachError && /missing\.ts/.test(e.message));
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("U2 fix 9: protocol.ext.allow=always with an origin refuses before any fetch", () => {
  const { source, root } = fixture();
  const marker = join(tmp("coach-u2-ext-"), "fetched");
  git(root, "remote", "add", "origin", `ext::sh -c touch% ${marker}`);
  git(root, "config", "protocol.ext.allow", "always");
  assert.throws(() => prepareUpdate(opts(root, source)), (e: unknown) => e instanceof CoachError && /protocol\.ext\.allow/.test(e.message));
  assert.equal(existsSync(marker), false, "no fetch ran");
});

test("U2 fix 10: the behind check fetches origin's main explicitly; an unknown state refuses", () => {
  const { source, root } = fixture();
  const bare = join(tmp("coach-u2-origin-"), "origin.git");
  git(root, "clone", "-q", "--bare", root, bare);
  // Another clone moves origin's main ahead.
  const other = join(tmp("coach-u2-other-"), "w");
  git(dirname(other), "clone", "-q", bare, other);
  writeFileSync(join(other, "files/same.txt"), "ahead\n");
  git(other, "commit", "-q", "-am", "ahead");
  git(other, "push", "-q", "origin", "main");
  git(root, "remote", "add", "origin", bare);
  // The fetch rules omit main: a plain `git fetch origin` would never see it.
  git(root, "config", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/other");
  assert.throws(() => prepareUpdate(opts(root, source)), (e: unknown) => e instanceof CoachError && /behind origin\/main/.test(e.message));
  // An origin with no main at all refuses too (never "0 behind").
  const empty = join(tmp("coach-u2-empty-"), "empty.git");
  execFileSync("git", ["init", "-q", "--bare", empty]);
  git(root, "remote", "set-url", "origin", empty);
  assert.throws(() => prepareUpdate(opts(root, source)), (e: unknown) => e instanceof CoachError && /cannot read origin's main/.test(e.message));
});

// ---------- final fold: rollback honesty and modes, hook command paths ----------

import { statSync as statOf } from "node:fs";

function simpleRelease(extra: Files): { source: string; s1: string } {
  const s1 = staged(RELEASE1, "0.1.0");
  const source = templateRepo(s1, staged({ ...RELEASE1, "package.json": '{"version":"0.2.0"}\n', ...extra }, "0.2.0"));
  return { source, s1 };
}

test("fold fix 3a: a failed commit and a failed reset report that restoring did not finish; staged additions leave the index", () => {
  const { source, s1 } = simpleRelease({ "files/a.txt": "new\n" });
  const root = copyOf(s1);
  const head = git(root, "rev-parse", "HEAD");
  assert.throws(
    () => applyUpdate(opts(root, source, { to: git(source, "rev-parse", "HEAD"), beforeGit: (args: string[]) => { if (args.includes("commit") || args.includes("reset")) throw new Error(`injected ${args.includes("commit") ? "commit" : "reset"} failure`); } })),
    (e: unknown) => e instanceof CoachError && e.code === "UPDATE_FAILED" && /restoring did not finish/.test(e.message) && /reset the index/.test(e.message) && !/every file was restored/.test(e.message),
  );
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(root, "status", "--porcelain"), "", "the staged addition left the index and the disk");
});

test("fold fix 3b: a replaced ignored file (0755) and an earlier backup (0600) keep their bytes and modes after a failure", () => {
  const { source, s1 } = simpleRelease({ "files/a.txt": "template\n", "files/z.txt": "z\n" });
  const root = copyOf(s1, (d) => writeFileSync(join(d, ".gitignore"), ".tmp/\nfiles/a.txt\n"));
  writeFileSync(join(root, "files/a.txt"), "mine\n");
  chmodSync(join(root, "files/a.txt"), 0o755);
  mkdirSync(join(root, ".tmp/coach/update-backup/files"), { recursive: true });
  writeFileSync(join(root, ".tmp/coach/update-backup/files/a.txt"), "old backup\n");
  chmodSync(join(root, ".tmp/coach/update-backup/files/a.txt"), 0o600);
  assert.throws(
    () => applyUpdate(opts(root, source, { to: git(source, "rev-parse", "HEAD"), takeTemplate: ["files/a.txt"], beforeWrite: (p: string) => { if (p === "files/z.txt") throw new Error("injected"); } })),
    (e: unknown) => e instanceof CoachError && e.code === "UPDATE_FAILED" && /every file was restored/.test(e.message),
  );
  assert.equal(readFileSync(join(root, "files/a.txt"), "utf8"), "mine\n");
  assert.equal(statOf(join(root, "files/a.txt")).mode & 0o777, 0o755);
  assert.equal(readFileSync(join(root, ".tmp/coach/update-backup/files/a.txt"), "utf8"), "old backup\n");
  assert.equal(statOf(join(root, ".tmp/coach/update-backup/files/a.txt")).mode & 0o777, 0o600);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("fold fix 4: project-local absolute paths and path options are checked; a plain relative hook still passes", () => {
  const root = "/review";
  assert.deepEqual(commandPaths("node /review/.claude/hooks/missing.ts", root), [".claude/hooks/missing.ts"]);
  assert.deepEqual(commandPaths("node --import=./.claude/hooks/missing.ts", root), [".claude/hooks/missing.ts"]);
  assert.deepEqual(commandPaths("node --require ./.claude/hooks/r.ts -r tsx .claude/hooks/a.ts", root), [".claude/hooks/r.ts", ".claude/hooks/a.ts"]);
  assert.deepEqual(commandPaths("node --loader=$CLAUDE_PROJECT_DIR/x/loader.mjs .claude/hooks/a.ts", root), ["x/loader.mjs", ".claude/hooks/a.ts"]);
  assert.deepEqual(commandPaths("/usr/local/bin/node .claude/hooks/a.ts", root), [".claude/hooks/a.ts"], "a system node is not a template file");
  for (const bad of ["node --import", "node /abs/x.ts"]) {
    assert.throws(() => commandPaths(bad), (e: unknown) => e instanceof CoachError && e.code === "UPDATE_REFUSED", bad);
  }

  // End to end: both reviewer inputs refuse when the file is missing.
  const s1 = staged(RELEASE1, "0.1.0");
  for (const make of [(r: string) => `node ${r}/.claude/hooks/missing.ts`, () => "node --import=./.claude/hooks/missing.ts"]) {
    const copy = copyOf(s1);
    const settings = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: make(copy) }] }] } });
    const source = templateRepo(s1, staged({ ...RELEASE1, "package.json": '{"version":"0.2.0"}\n', ".claude/settings.json": settings }, "0.2.0"));
    assert.throws(() => applyUpdate(opts(copy, source, { to: git(source, "rev-parse", "HEAD") })), (e: unknown) => e instanceof CoachError && /missing\.ts/.test(e.message), make(copy));
    assert.equal(git(copy, "status", "--porcelain"), "");
  }
  const copy = copyOf(s1);
  const settings = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node .claude/hooks/guard.ts" }] }] } });
  const source = templateRepo(s1, staged({ ...RELEASE1, "package.json": '{"version":"0.2.0"}\n', ".claude/settings.json": settings }, "0.2.0"));
  applyUpdate(opts(copy, source, { to: git(source, "rev-parse", "HEAD") }));
  assert.equal(JSON.parse(readFileSync(join(copy, "template-manifest.json"), "utf8")).release, "0.2.0");
});

// ---------- V2b fix 8: a copy in a worktree, both layouts ----------

/** The update skill's worktree sequence, through the engine: commit, ff-main, main-checkout, update there, ff-branch, remove-temp. */
function worktreeUpdate(wt: string, source: string) {
  const step = (args: string[]) => {
    const r = cli(wt, args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${JSON.stringify(r.json)}`);
    return r.json;
  };
  step(["commit", "--message", "coach: before the update"]);
  step(["worktree", "ff-main"]);
  const mc = step(["worktree", "main-checkout"]);
  const p = prepareUpdate(opts(mc.path, source));
  applyUpdate(opts(mc.path, source, { to: p.to }));
  step(["worktree", "ff-branch"]);
  const rm = step(["worktree", "remove-temp"]);
  return { mc, rm };
}

function worktreeCopy(): { source: string; main: string; wt: string } {
  const s1 = staged(RELEASE1, "0.1.0");
  const source = templateRepo(s1, staged(release2(), "0.2.0"));
  const main = copyOf(s1);
  const wt = join(tmp("coach-wt-"), "wt");
  git(main, "worktree", "add", "-q", "-b", "coach", wt);
  // The athlete coached in the worktree: a commit main lacks, and an uncommitted log line.
  mkdirSync(join(wt, "athlete/log"), { recursive: true });
  writeFileSync(join(wt, "athlete/log/2026-10.md"), "## 2026-10-12\n");
  git(wt, "add", "athlete");
  git(wt, "commit", "-q", "-m", "coach: log");
  writeFileSync(join(wt, "athlete/log/2026-10.md"), "## 2026-10-12\n- more\n");
  return { source, main, wt };
}

test("V2b fix 8: worktree update when main is checked out in the main checkout: the update runs there, then the branch catches up", () => {
  const { source, main, wt } = worktreeCopy();
  const { mc, rm } = worktreeUpdate(wt, source);
  assert.equal(mc.path, main);
  assert.equal(mc.temporary, false);
  assert.equal(rm.removed, false, "no temporary checkout to remove");
  assert.equal(readFileSync(join(wt, "files/replace.txt"), "utf8"), "v2\n", "the worktree has the update");
  assert.equal(readFileSync(join(main, "files/replace.txt"), "utf8"), "v2\n");
  assert.equal(git(wt, "rev-parse", "HEAD"), git(main, "rev-parse", "main"));
  assert.equal(readFileSync(join(wt, "athlete/log/2026-10.md"), "utf8"), "## 2026-10-12\n- more\n", "the athlete's log is kept");
  assert.match(git(wt, "log", "-1", "--format=%B"), /Coach-Template-Commit:/);
});

test("V2b fix 8: worktree update when main is checked out nowhere: a temporary checkout in .tmp/coach, updated, then removed; no other checkout touched", () => {
  const { source, main, wt } = worktreeCopy();
  git(main, "switch", "-q", "-c", "other");
  writeFileSync(join(main, "work-in-progress.txt"), "mine\n");
  const { mc, rm } = worktreeUpdate(wt, source);
  assert.equal(mc.temporary, true);
  assert.equal(mc.path, join(wt, ".tmp/coach/main-checkout"));
  assert.equal(rm.removed, true);
  assert.equal(existsSync(join(wt, ".tmp/coach/main-checkout")), false);
  assert.equal(readFileSync(join(wt, "files/replace.txt"), "utf8"), "v2\n");
  assert.equal(git(wt, "rev-parse", "HEAD"), git(main, "rev-parse", "main"));
  // The main checkout stays on its branch with its own work.
  assert.equal(git(main, "rev-parse", "--abbrev-ref", "HEAD"), "other");
  assert.equal(readFileSync(join(main, "work-in-progress.txt"), "utf8"), "mine\n");
  assert.equal(readFileSync(join(main, "files/replace.txt"), "utf8"), "v1\n");
  // remove-temp never forces: a temporary checkout with changes is kept.
  const again = cli(wt, ["worktree", "main-checkout"]);
  writeFileSync(join(again.json.path, "files/replace.txt"), "edited\n");
  const refused = cli(wt, ["worktree", "remove-temp"]);
  assert.equal(refused.code, 1);
  assert.ok(existsSync(join(again.json.path, "files/replace.txt")));
});
