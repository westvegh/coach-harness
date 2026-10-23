// Fails when a tracked file holds a token or a fingerprint of private text. Tracked athlete
// files are normal in an athlete's private copy, so that check runs only on the public
// export (tests/public-tree.test.ts; launch review finding 6). The scanner still reports them.
// The fingerprint list lives outside the repo; set COACH_PRIVACY_FINGERPRINTS to its path.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFingerprints, scanRepo } from "../engine/privacy.ts";

const REPO = new URL("..", import.meta.url).pathname;
const FINGERPRINTS = process.env.COACH_PRIVACY_FINGERPRINTS;

const show = (f: unknown) => JSON.stringify(f, null, 2);

describe("this repository", () => {
  test("no tokens are tracked (athlete files are checked on the public export only)", () => {
    const findings = scanRepo(REPO).filter((f) => f.kind !== "athlete-file");
    assert.deepEqual(findings, [], show(findings));
  });

  test(
    "no tracked file matches a private fingerprint",
    { skip: FINGERPRINTS ? false : "COACH_PRIVACY_FINGERPRINTS is unset: fingerprint check skipped" },
    () => {
      const findings = scanRepo(REPO, { fingerprints: readFingerprints(FINGERPRINTS!) }).filter((f) => f.kind === "fingerprint");
      assert.deepEqual(findings, [], show(findings));
    },
  );
});

describe("the scanner catches leaks in a fixture repo", () => {
  // Token-shaped strings are built at run time so this file does not trip the scan itself.
  const tokens: Record<string, string> = {
    ghp: "gh" + "p_" + "A1b2C3d4".repeat(5),
    pat: "github" + "_pat_" + "11ABCDEFG0" + "x".repeat(40),
    ant: "sk-" + "ant-" + "api03-" + "Z".repeat(30),
    bearer: "Authorization: " + "Bear" + "er " + "eyJhbGciOi".repeat(3),
    oura: "OURA_TOKEN=" + "ABCD2345EFGH6789".repeat(2),
  };

  function fixture(files: Record<string, string>, untracked: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "coach-privacy-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    for (const [rel, text] of Object.entries({ ...files, ...untracked })) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    execFileSync("git", ["add", "--", ...Object.keys(files)], { cwd: dir });
    return dir;
  }

  for (const [name, token] of Object.entries(tokens)) {
    test(`a tracked ${name} token fails`, () => {
      const dir = fixture({ "notes.md": `line one\n${token}\n` });
      const f = scanRepo(dir);
      assert.equal(f.length, 1, show(f));
      assert.equal(f[0].kind, "token");
      assert.equal(f[0].line, 2);
      assert.ok(!JSON.stringify(f).includes(token), "a finding must not echo the token");
    });
  }

  test("a tracked athlete/ file fails; templates/athlete/ is allowed", () => {
    const dir = fixture({ "athlete/brief.md": "# brief\n", "templates/athlete/brief.md": "# template\n" });
    const f = scanRepo(dir);
    assert.deepEqual(f.map((x) => [x.kind, x.file]), [["athlete-file", "athlete/brief.md"]]);
  });

  test("a fingerprint line fails, case-insensitive, without echoing it", () => {
    const fpFile = join(mkdtempSync(join(tmpdir(), "coach-fp-")), "fingerprints.txt");
    writeFileSync(fpFile, "# comment\n\nZorbonian Clinic Note\n");
    const dir = fixture({ "docs/x.md": "ok\nsee the zorbonian clinic note here\n" });
    const f = scanRepo(dir, { fingerprints: readFingerprints(fpFile) });
    assert.deepEqual(f.map((x) => [x.kind, x.line, x.detail]), [["fingerprint", 2, "matches fingerprint line 1"]]);
    assert.ok(!JSON.stringify(f).toLowerCase().includes("zorbonian"));
  });

  test("untracked files and clean text pass", () => {
    const dir = fixture({ "clean.md": "Bearer tokens go in .env, never here.\nsha: 3fa1c2d9e0b4\n" }, { "athlete/limits.md": "x", "secret.txt": tokens.ghp });
    assert.deepEqual(scanRepo(dir), []);
  });
});

describe("regressions", () => {
  const ghp = "gh" + "p_" + "A1b2C3d4".repeat(5);
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "coach-privacy-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    return dir;
  }

  test("A5: a staged token is found even when the working copy is clean", () => {
    const dir = repo();
    writeFileSync(join(dir, "notes.md"), `${ghp}\n`);
    execFileSync("git", ["add", "notes.md"], { cwd: dir });
    writeFileSync(join(dir, "notes.md"), "clean\n");
    assert.equal(scanRepo(dir).filter((f) => f.kind === "token").length, 1);
  });

  test("A5: a token next to a NUL byte is still found", () => {
    const dir = repo();
    writeFileSync(join(dir, "blob.bin"), Buffer.concat([Buffer.from(ghp), Buffer.from([0]), Buffer.from("tail")]));
    execFileSync("git", ["add", "blob.bin"], { cwd: dir });
    assert.equal(scanRepo(dir).filter((f) => f.kind === "token").length, 1);
  });

  test("A5: an athlete/ directory anywhere outside templates/ fails", () => {
    const dir = repo();
    mkdirSync(join(dir, "copy/athlete"), { recursive: true });
    writeFileSync(join(dir, "copy/athlete/brief.md"), "# brief\n");
    execFileSync("git", ["add", "copy/athlete/brief.md"], { cwd: dir });
    assert.deepEqual(scanRepo(dir).map((f) => [f.kind, f.file]), [["athlete-file", "copy/athlete/brief.md"]]);
  });

  test("A5: a commit can be scanned by ref", () => {
    const dir = repo();
    writeFileSync(join(dir, "notes.md"), `${ghp}\n`);
    execFileSync("git", ["add", "notes.md"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: dir });
    execFileSync("git", ["rm", "-q", "--cached", "notes.md"], { cwd: dir });
    assert.equal(scanRepo(dir).length, 0);
    assert.equal(scanRepo(dir, { ref: "HEAD" }).filter((f) => f.kind === "token").length, 1);
  });
});

describe("launch review finding 6: CI in user copies", () => {
  const { readFileSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const wf = readFileSync(join(REPO, ".github/workflows/test.yml"), "utf8");

  test("the workflow runs only on the template repository, or when the copy sets COACH_CI", () => {
    assert.match(wf, /^ {4}if: github\.repository == '[\w.-]+\/coach-harness' \|\| vars\.COACH_CI == 'true'$/m);
  });

  test("a private copy with tracked athlete files passes the repository checks", () => {
    const dir = mkdtempSync(join(tmpdir(), "coach-copy-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "athlete/log"), { recursive: true });
    writeFileSync(join(dir, "athlete/log/2026-10.md"), "## 2026-10-10 · no-change\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    assert.deepEqual(scanRepo(dir).filter((f) => f.kind !== "athlete-file"), [], "the repository test ignores athlete files");
    assert.equal(scanRepo(dir).filter((f) => f.kind === "athlete-file").length, 1, "the scanner still reports them for the export check");
  });

  test("the docs say how to turn CI on in a copy", () => {
    assert.match(readFileSync(join(REPO, "CONTRIBUTING.md"), "utf8"), /COACH_CI/);
  });
});
