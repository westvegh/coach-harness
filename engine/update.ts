// `update` (contracts §24): bring the template's later fixes into a copy made with GitHub's
// "Use this template". The copy has no link to the template, so the update compares three
// states per template file: the local manifest (what the last release shipped), the
// fetched manifest (what the new release ships) and HEAD (what the copy holds now). It
// writes only template files, never coach.yaml or an athlete/ file, and only on the user's
// interactive yes.
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CoachError } from "./errors.ts";
import { unattendedMarker } from "./hold.ts";
import { blobId, MANIFEST, manifestJson, parseTreeRules, validateManifest, type Manifest } from "./manifest.ts";

export type Entry = { mode: string; blob: string };
export type Action = "replace" | "add" | "delete" | "conflict";
export type Conflict = { path: string; why: string; fixes: string[] };
export type Plan = {
  replace: string[];
  add: string[];
  delete: string[];
  conflicts: Conflict[];
  unchanged: number;
  kept: string[];
};

export type UpdateOptions = {
  root: string;
  /** The fetch source: the manifest's GitHub URL in the CLI; a local path in tests. */
  source: string;
  ref: string;
  /** apply needs the commit `check` reported. */
  to?: string;
  keepMine?: string[];
  takeTemplate?: string[];
  env?: NodeJS.ProcessEnv;
  /** Test seams for the failure path: called before each file write, and before each rename. */
  beforeWrite?: (path: string) => void;
  beforeRename?: (path: string) => void;
  /** Test seam: called before each git command of the apply and the rollback. */
  beforeGit?: (args: string[]) => void;
};

type Saved = { rel: string; before: Buffer | null; mode: number | null };

const same = (a: Entry | undefined, b: Entry | undefined) => !!a && !!b && a.mode === b.mode && a.blob === b.blob;

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new CoachError("GIT_ERROR", `git ${args.join(" ")} failed: ${(err.stderr ?? err.message).trim().split("\n").slice(-2).join(" | ")}`);
  }
}

function gitBytes(root: string, args: string[]): Buffer {
  try {
    return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new CoachError("GIT_ERROR", `git ${args.join(" ")} failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

/** path → {mode, blob, type} of a tree (`git ls-tree -r -z`). */
export function lsTree(root: string, rev: string): Map<string, Entry & { type: string }> {
  const out = new Map<string, Entry & { type: string }>();
  for (const rec of git(root, ["ls-tree", "-r", "-z", rev]).split("\0").filter(Boolean)) {
    const tab = rec.indexOf("\t");
    const [mode, type, blob] = rec.slice(0, tab).split(" ");
    out.set(rec.slice(tab + 1), { mode, type, blob });
  }
  return out;
}

/** The plan (contracts §24 table). old: the local manifest; neu: the fetched one; local: HEAD. */
export function planUpdate(old: Record<string, Entry>, neu: Record<string, Entry>, local: Map<string, Entry>): Plan {
  const plan: Plan = { replace: [], add: [], delete: [], conflicts: [], unchanged: 0, kept: [] };
  const paths = [...new Set([...Object.keys(old), ...Object.keys(neu)])].sort();
  for (const p of paths) {
    const o = old[p];
    const n = neu[p];
    const l = local.get(p);
    if (o && n) {
      if (same(o, n)) {
        if (same(l, o)) plan.unchanged++;
        else plan.kept.push(p); // the template did not change it: the user's version (or removal) stays
      } else if (same(l, o)) plan.replace.push(p);
      else if (same(l, n)) plan.unchanged++;
      else if (l) plan.conflicts.push({ path: p, why: `you changed ${p}, and the template changed it too`, fixes: [`--keep-mine ${p}`, `--take-template ${p}`] });
      else plan.conflicts.push({ path: p, why: `you removed ${p}, and the template changed it`, fixes: [`--keep-mine ${p}`, `--take-template ${p}`] });
    } else if (o && !n) {
      if (same(l, o)) plan.delete.push(p);
      else if (l) plan.kept.push(p); // now a user file
    } else if (!o && n) {
      if (!l) plan.add.push(p);
      else if (same(l, n)) plan.unchanged++;
      else plan.conflicts.push({ path: p, why: `the template adds ${p}, and you have a different file there`, fixes: [`--keep-mine ${p}`, `--take-template ${p}`] });
    }
  }
  // Case collisions: a template write must never land on another local path that stays
  // (on a case-insensitive disk, files/foo and files/Foo are one file). Only --keep-mine.
  const deleted = new Set(plan.delete);
  const stays = new Map<string, string[]>();
  for (const q of local.keys()) if (!deleted.has(q)) stays.set(q.toLowerCase(), [...(stays.get(q.toLowerCase()) ?? []), q]);
  const twinOf = (p: string) => (stays.get(p.toLowerCase()) ?? []).find((q) => q !== p);
  for (const list of [plan.replace, plan.add]) {
    for (const p of [...list]) {
      const twin = twinOf(p);
      if (twin === undefined) continue;
      list.splice(list.indexOf(p), 1);
      plan.conflicts.push({ path: p, why: `the template writes ${p}, and your file ${twin} differs only in case (one file on this disk)`, fixes: [`--keep-mine ${p}`] });
    }
  }
  for (const c of plan.conflicts) {
    const twin = twinOf(c.path);
    if (twin !== undefined && c.fixes.length > 1) {
      c.why = `${c.why}; your file ${twin} differs only in case`;
      c.fixes = [`--keep-mine ${c.path}`];
    }
  }
  plan.conflicts.sort((a, b) => (a.path < b.path ? -1 : 1));
  return plan;
}

/**
 * The name on disk at `rel`, or a name in the same folder that differs only in case, or
 * null. A tracked file never reaches here for an added path; so a hit is an ignored or
 * untracked file that the update must not overwrite.
 */
function onDisk(root: string, rel: string): string | null {
  // The real names in the folder: on a case-insensitive disk, lstat("files/foo") also finds
  // files/Foo, so the listing tells which name is there.
  const dir = dirname(rel);
  const base = rel.slice(dir === "." ? 0 : dir.length + 1);
  let names: string[];
  try {
    names = readdirSync(join(root, dir === "." ? "" : dir));
  } catch {
    return null;
  }
  const hit = names.includes(base) ? base : names.find((n) => n.toLowerCase() === base.toLowerCase());
  return hit === undefined ? null : dir === "." ? hit : `${dir}/${hit}`;
}

/** Adds whose destination already exists on disk outside HEAD (an ignored or untracked file) become conflicts. */
function diskConflicts(root: string, plan: Plan, local: Map<string, Entry>): void {
  for (const p of [...plan.add]) {
    const hit = onDisk(root, p);
    if (hit === null || local.has(hit)) continue;
    plan.add.splice(plan.add.indexOf(p), 1);
    plan.conflicts.push({ path: p, why: `the template adds ${p}, and ${hit} already exists on disk (an ignored or untracked file)`, fixes: [`--keep-mine ${p}`, `--take-template ${p}`] });
  }
  plan.conflicts.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The `## ` headings (with their text) in `next` that `prev` does not have. */
export function newChangelogSections(prev: string, next: string): { heading: string; text: string }[] {
  const split = (t: string) => {
    const out: { heading: string; text: string }[] = [];
    for (const part of `\n${t}`.split(/\n(?=## )/).slice(1)) {
      const [heading, ...rest] = part.split("\n");
      out.push({ heading: heading.replace(/^## /, "").trim(), text: rest.join("\n").trim() });
    }
    return out;
  };
  const have = new Set(split(prev).map((s) => s.heading));
  return split(next).filter((s) => !have.has(s.heading));
}

/**
 * Refuses a fetch that git would redirect: a url.<base>.insteadOf whose prefix matches the
 * source, or all of https://github.com/ (git rewrites a URL that starts with the prefix).
 * The message never prints the setting: a base URL can hold a credential.
 */
function refuseRedirects(root: string, source: string, env?: NodeJS.ProcessEnv): void {
  let urls = "";
  try {
    // -z: each entry is "<key>\n<value>\0", so an empty or spaced value is read exactly.
    urls = execFileSync("git", ["config", "-z", "--get-regexp", "^url\\..*\\.insteadof$"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: env ?? process.env });
  } catch {
    urls = ""; // no match
  }
  for (const entry of urls.split("\0").filter((e) => e !== "")) {
    const nl = entry.indexOf("\n");
    // An empty prefix (or a key with no value) matches every URL.
    const prefix = nl < 0 ? "" : entry.slice(nl + 1);
    if (prefix === "" || source.startsWith(prefix) || "https://github.com/".startsWith(prefix)) {
      throw new CoachError("UPDATE_REFUSED", "a git url.<x>.insteadOf setting rewrites the template's github.com URL; remove it before you update");
    }
  }
  for (const key of ["protocol.ext.allow", "protocol.file.allow"]) {
    let v = "";
    try {
      v = execFileSync("git", ["config", "--get", key], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: env ?? process.env }).trim();
    } catch {
      v = "";
    }
    if (v === "always") throw new CoachError("UPDATE_REFUSED", `git config ${key}=always is set; unset it before you update`);
  }
}

/** Refusals before any fetch (step 1). The protocol and redirect checks run before the first fetch of any remote. */
function preconditions(root: string, source: string, env: NodeJS.ProcessEnv): void {
  const marker = unattendedMarker(env);
  if (marker) throw new CoachError("UNATTENDED", `update never runs unattended (${marker} is set); it needs the athlete's yes`);
  if (git(root, ["status", "--porcelain"], env).trim() !== "") throw new CoachError("UPDATE_REFUSED", "the working tree has uncommitted or untracked changes: commit them first");
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"], env).trim();
  if (branch !== "main") throw new CoachError("UPDATE_REFUSED", `update runs on main, not ${branch}`);
  refuseRedirects(root, source, env);
  let hasOrigin = true;
  try {
    git(root, ["remote", "get-url", "origin"], env);
  } catch {
    hasOrigin = false;
  }
  if (hasOrigin) {
    // origin's main, fetched explicitly (the remote's fetch rules may omit it). A state that
    // cannot be read refuses: a git error is never "0 behind".
    const ref = "refs/coach-upstream/origin-main";
    try {
      git(root, ["fetch", "--no-tags", "-q", "origin", `+refs/heads/main:${ref}`], env);
    } catch (e) {
      throw new CoachError("UPDATE_REFUSED", `cannot read origin's main, so update cannot check that this copy is current: ${(e as Error).message}`);
    }
    let behind: string;
    try {
      behind = git(root, ["rev-list", "--count", `main..${ref}`], env).trim();
    } catch (e) {
      throw new CoachError("UPDATE_REFUSED", `cannot compare main with origin's main: ${(e as Error).message}`);
    }
    if (!/^\d+$/.test(behind)) throw new CoachError("UPDATE_REFUSED", "cannot compare main with origin's main");
    if (behind !== "0") throw new CoachError("UPDATE_REFUSED", `main is ${behind} commit(s) behind origin/main: run git pull --rebase first`);
  }
}

function fetchRef(root: string, source: string, ref: string, env: NodeJS.ProcessEnv): string {
  if (typeof ref !== "string" || ref.startsWith("-")) throw new CoachError("USAGE", `bad --ref ${JSON.stringify(ref)}`);
  try {
    execFileSync("git", ["check-ref-format", "--branch", ref], { cwd: root, stdio: "ignore" });
  } catch {
    throw new CoachError("USAGE", `--ref ${JSON.stringify(ref)} is not a valid branch or tag name`);
  }
  refuseRedirects(root, source, env); // again, right before the template fetch
  const local = `refs/coach-upstream/${ref}`;
  git(root, ["fetch", "--no-tags", "-q", "--", source, `+${ref}:${local}`], env);
  return git(root, ["rev-parse", `${local}^{commit}`], env).trim();
}

function readJsonAt(root: string, rev: string, path: string, what: string): unknown {
  let text: string;
  try {
    text = git(root, ["show", `${rev}:${path}`]);
  } catch {
    throw new CoachError("MANIFEST_MISSING", `${what} has no ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CoachError("MANIFEST_INVALID", `${what} ${path} is not JSON: ${(e as Error).message}`);
  }
}

function textAt(root: string, rev: string, path: string): string {
  try {
    return git(root, ["show", `${rev}:${path}`]);
  } catch {
    return "";
  }
}

export type Prepared = {
  source: string;
  ref: string;
  to: string;
  oldManifest: Manifest;
  newManifest: Manifest;
  plan: Plan;
  changelog: { heading: string; text: string }[];
};

/** Steps 1 to 4: refusals, fetch, validation of both manifests and the fetched tree, and the plan. */
export function prepareUpdate(opts: UpdateOptions): Prepared {
  const env = opts.env ?? process.env;
  const root = opts.root;
  preconditions(root, opts.source, env);
  const to = fetchRef(root, opts.source, opts.ref, env);
  if (opts.to !== undefined && opts.to !== to) throw new CoachError("UPDATE_REFUSED", `${opts.ref} is now at ${to}, not ${opts.to}: run update --check again`);

  let oldRaw: unknown;
  try {
    oldRaw = readJsonAt(root, "HEAD", MANIFEST, "this copy");
  } catch (e) {
    if (e instanceof CoachError && e.code === "MANIFEST_MISSING") {
      throw new CoachError(
        "NO_MANIFEST",
        "this copy has no template-manifest.json (it was made before updates existed), so it cannot be updated safely. Compare the files by hand, or start a new copy from the template and move athlete/ and coach.yaml into it.",
      );
    }
    throw e;
  }
  const oldManifest = validateManifest(oldRaw, parseTreeRules(textAt(root, "HEAD", "scripts/public-tree.txt")), "the local template-manifest.json");
  const newManifest = validateManifest(readJsonAt(root, to, MANIFEST, `the template at ${to.slice(0, 12)}`), parseTreeRules(textAt(root, to, "scripts/public-tree.txt")), "the fetched template-manifest.json");

  // The fetched tree must hold exactly what its manifest says: no symlink, no submodule.
  const tree = lsTree(root, to);
  for (const [p, e] of Object.entries(newManifest.files)) {
    const t = tree.get(p);
    if (!t) throw new CoachError("MANIFEST_INVALID", `the fetched tree has no ${p}, which its manifest lists`);
    if (t.mode === "120000" || t.mode === "160000") throw new CoachError("MANIFEST_INVALID", `${p} is a symlink or a submodule in the fetched tree`);
    if (t.mode !== e.mode || t.blob !== e.blob) throw new CoachError("MANIFEST_INVALID", `${p} in the fetched tree differs from its manifest (mode or blob)`);
  }

  const local = new Map<string, Entry>([...lsTree(root, "HEAD")].map(([p, e]) => [p, { mode: e.mode, blob: e.blob }]));
  const plan = planUpdate(oldManifest.files, newManifest.files, local);
  diskConflicts(root, plan, local);
  return { source: opts.source, ref: opts.ref, to, oldManifest, newManifest, plan, changelog: newChangelogSections(textAt(root, "HEAD", "CHANGELOG.md"), textAt(root, to, "CHANGELOG.md")) };
}

export function checkReport(p: Prepared): Record<string, unknown> {
  return {
    source: p.source,
    ref: p.ref,
    to: p.to,
    release_from: p.oldManifest.release,
    release_to: p.newManifest.release,
    changelog: p.changelog,
    plan: {
      counts: { replace: p.plan.replace.length, add: p.plan.add.length, delete: p.plan.delete.length, conflicts: p.plan.conflicts.length, unchanged: p.plan.unchanged, kept_yours: p.plan.kept.length },
      replace: p.plan.replace,
      add: p.plan.add,
      delete: p.plan.delete,
      kept_yours: p.plan.kept,
    },
    conflicts: p.plan.conflicts,
    up_to_date: p.plan.replace.length + p.plan.add.length + p.plan.delete.length + p.plan.conflicts.length === 0,
  };
}

const PROJECT = "\u0001";
const SCRIPT_EXT = /\.(ts|js|mjs|cjs|mts|cts|sh)$/;

/**
 * The project files one hook command names: every word that is a path inside the project
 * ($CLAUDE_PROJECT_DIR/<path>, in or out of quotes, or a relative path with a "/" or a
 * script extension), in each command joined by && or ;. Throws UPDATE_REFUSED when the
 * command uses any other shell syntax: its paths cannot be checked reliably.
 */
/** Node options whose value is a module path (`--import=x`, or `--import x` as the next word). */
const PATH_OPTIONS = ["--import", "--require", "-r", "--loader", "--experimental-loader", "--env-file", "--env-file-if-exists"];

export function commandPaths(command: string, root?: string): string[] {
  const refuse = (why: string) => new CoachError("UPDATE_REFUSED", `a hook command in .claude/settings.json cannot be checked (${why}): ${JSON.stringify(command)}`);
  const text = command.replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR\b/g, PROJECT);
  const out: string[] = [];
  let word = "";
  let has = false;
  let valueNext = false;
  const base = root === undefined ? null : root.endsWith("/") ? root : `${root}/`;
  /** One word (or an option's value) that may name a project file. */
  const consider = (w: string, forced: boolean) => {
    if (w.includes(PROJECT)) {
      if (!w.startsWith(`${PROJECT}/`) || w.indexOf(PROJECT, 1) >= 0) throw refuse("$CLAUDE_PROJECT_DIR inside a word");
      out.push(w.slice(2));
    } else if (w.startsWith("/")) {
      // A project-local absolute path is checked as a relative one; a path outside the
      // project (a system node) is not a template file.
      if (base !== null && w.startsWith(base)) out.push(w.slice(base.length));
      else if (base === null) throw refuse("an absolute path, with no project root to compare");
    } else if (w.startsWith("-")) {
      throw refuse(`the option-like value ${w}`);
    } else if (forced ? w.includes("/") || SCRIPT_EXT.test(w) || w.startsWith(".") : w.includes("/") || SCRIPT_EXT.test(w)) out.push(w);
  };
  const end = () => {
    if (has) {
      if (valueNext) {
        valueNext = false;
        consider(word, true);
      } else if (word.startsWith("-")) {
        const eq = word.indexOf("=");
        const name = eq < 0 ? word : word.slice(0, eq);
        if (eq >= 0) {
          const value = word.slice(eq + 1);
          // A value that is a path (a known path option, or any value with a / or a project marker) is checked.
          if (PATH_OPTIONS.includes(name) || value.includes("/") || value.includes(PROJECT)) consider(value, PATH_OPTIONS.includes(name));
        } else if (PATH_OPTIONS.includes(name)) valueNext = true;
      } else consider(word, false);
    }
    word = "";
    has = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " " || ch === "\t") end();
    else if (ch === ";" || (ch === "&" && text[i + 1] === "&")) {
      end();
      if (ch === "&") i++;
    } else if (ch === "'" || ch === '"') {
      const close = text.indexOf(ch, i + 1);
      if (close < 0) throw refuse("an unclosed quote");
      const part = text.slice(i + 1, close);
      if (/[$`\\\n]/.test(part)) throw refuse("$, a backtick, a backslash or a newline in quotes");
      word += part;
      has = true;
      i = close;
    } else if (/[A-Za-z0-9._\/:=@,+%\-\u0001]/.test(ch)) {
      word += ch;
      has = true;
    } else throw refuse(`the character ${JSON.stringify(ch)}`);
  }
  end();
  if (valueNext) throw refuse("a path option with no value");
  return out.map((p) => p.replace(/^(\.\/)+/, "")).map((p) => {
    if (p.split("/").some((s) => s === "" || s === "." || s === "..")) throw refuse(`the path ${p}`);
    return p;
  });
}

/** Every project file the hook commands in a settings.json name. */
export function hookPaths(settingsText: string, root?: string): string[] {
  let raw: any;
  try {
    raw = JSON.parse(settingsText);
  } catch {
    throw new CoachError("UPDATE_REFUSED", ".claude/settings.json after the update is not JSON");
  }
  const out: string[] = [];
  for (const list of Object.values(raw?.hooks ?? {}) as any[]) {
    for (const group of Array.isArray(list) ? list : []) {
      for (const h of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (h?.type !== undefined && h.type !== "command") continue;
        out.push(...commandPaths(String(h?.command ?? ""), root));
      }
    }
  }
  return [...new Set(out)];
}

/** Refuses a symlink or a path outside the root in any existing part of `rel`. */
function safeParts(root: string, rel: string): void {
  const segs = rel.split("/");
  if (rel.startsWith("/") || segs.some((s) => s === "" || s === "." || s === "..")) throw new CoachError("UPDATE_REFUSED", `${rel}: a path outside the repository`);
  let cur = root;
  for (const s of segs) {
    cur = join(cur, s);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return; // nothing below a missing part exists
    }
    if (st.isSymbolicLink()) throw new CoachError("UPDATE_REFUSED", `${rel}: ${cur.slice(root.length + 1)} is a symbolic link`);
  }
}

/** The checked writer: lstat every existing part (no symlink), a temp file in the same folder, the mode, then rename. Temp files are tracked in `temps` until renamed. */
function writeAtomic(root: string, rel: string, bytes: Buffer, mode: string | number, temps: Set<string>, beforeRename?: (p: string) => void): void {
  safeParts(root, rel);
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  safeParts(root, rel);
  const tmp = join(dirname(full), `.coach-update-${process.pid}-${Math.random().toString(36).slice(2)}`);
  temps.add(tmp);
  writeFileSync(tmp, bytes, { flag: "wx" });
  chmodSync(tmp, typeof mode === "number" ? mode : mode === "100755" ? 0o755 : 0o644);
  beforeRename?.(rel);
  renameSync(tmp, full);
  temps.delete(tmp);
}

export type ApplyResult = {
  committed: string;
  release_from: string;
  release_to: string;
  to: string;
  written: string[];
  deleted: string[];
  kept_mine: string[];
  took_template: { path: string; backup: string | null }[];
  npm_ci_needed: boolean;
  reinstall_git_hooks: boolean;
  restart_claude_code: boolean;
};

const MANUAL_FIX = "To undo by hand, run `git reset --hard && git clean -fd` in a terminal outside Claude Code.";

/** Step 6: apply a prepared plan, all or nothing, and commit once on main. */
export function applyUpdate(opts: UpdateOptions): ApplyResult {
  if (!opts.to) throw new CoachError("USAGE", "update --yes needs --to <sha> from update --check");
  const p = prepareUpdate(opts);
  const root = opts.root;
  const keep = new Set(opts.keepMine ?? []);
  const take = new Set(opts.takeTemplate ?? []);
  const conflictPaths = new Set(p.plan.conflicts.map((c) => c.path));
  for (const x of [...keep, ...take]) if (!conflictPaths.has(x)) throw new CoachError("USAGE", `${x} is not a conflict; --keep-mine and --take-template settle conflicts only`);
  for (const x of keep) if (take.has(x)) throw new CoachError("USAGE", `${x}: choose --keep-mine or --take-template, not both`);
  for (const c of p.plan.conflicts) {
    if (take.has(c.path) && !c.fixes.includes(`--take-template ${c.path}`)) throw new CoachError("USAGE", `${c.path}: the only fix offered is ${c.fixes.join(" or ")}`);
    if (keep.has(c.path) && !c.fixes.includes(`--keep-mine ${c.path}`)) throw new CoachError("USAGE", `${c.path}: the only fix offered is ${c.fixes.join(" or ")}`);
  }
  const open = p.plan.conflicts.filter((c) => !keep.has(c.path) && !take.has(c.path));
  if (open.length > 0) {
    throw new CoachError("UPDATE_CONFLICT", `nothing changed: settle each conflict with --keep-mine <path> or --take-template <path>: ${open.map((c) => c.path).join(", ")}`);
  }

  // Read every new blob first, and check each against the new manifest.
  const files = p.newManifest.files;
  const writes = [...p.plan.replace, ...p.plan.add, ...[...take]].sort();
  const algo = (b: string) => (b.length === 64 ? "sha256" : "sha1") as "sha1" | "sha256";
  const bytes = new Map<string, Buffer>();
  for (const w of writes) {
    const e = files[w];
    const b = gitBytes(root, ["cat-file", "blob", e.blob]);
    if (blobId(b, algo(e.blob)) !== e.blob) throw new CoachError("UPDATE_REFUSED", `${w}: the fetched bytes do not match the manifest`);
    bytes.set(w, b);
  }

  // Hook safety: every hook entry file the settings name must exist after the update.
  const deletes = new Set(p.plan.delete);
  const settingsText = bytes.get(".claude/settings.json")?.toString("utf8") ?? (existsSync(join(root, ".claude/settings.json")) ? readFileSync(join(root, ".claude/settings.json"), "utf8") : "{}");
  for (const h of hookPaths(settingsText, root)) {
    const after = bytes.has(h) || (!deletes.has(h) && existsSync(join(root, h)));
    if (!after) throw new CoachError("UPDATE_REFUSED", `.claude/settings.json would point at ${h}, which would be missing after the update`);
  }

  const head = new Set(lsTree(root, "HEAD").keys());
  const temps = new Set<string>();
  const touched: string[] = [];
  const backups: Saved[] = [];
  const permissions = (full: string) => statSync(full).mode & 0o777;
  const gitApply = (args: string[]) => {
    opts.beforeGit?.(args);
    return git(root, args);
  };
  // A file on disk that is not in HEAD (an ignored file the user chose to replace) comes back on rollback.
  for (const w of writes) {
    const full = join(root, w);
    if (!head.has(w) && existsSync(full) && lstatSync(full).isFile()) backups.push({ rel: w, before: readFileSync(full), mode: permissions(full) });
  }
  const tookTemplate: { path: string; backup: string | null }[] = [];
  const fail = (what: string, e: unknown, earlier: string[] = []): never => {
    const problems = [...earlier, ...restore(root, touched, head, temps, backups, gitApply)];
    const status = problems.length === 0 ? "every file was restored" : `restoring did not finish (${problems.join("; ")})`;
    throw new CoachError("UPDATE_FAILED", `${what}, and ${status}: ${(e as Error).message}. ${MANUAL_FIX}`);
  };
  try {
    // Backups for --take-template (the local file, when there is one), through the checked writer.
    for (const t of [...take].sort()) {
      let backup: string | null = null;
      const src = join(root, t);
      if (existsSync(src)) {
        safeParts(root, t);
        backup = `.tmp/coach/update-backup/${t}`;
        safeParts(root, backup);
        const full = join(root, backup);
        const had = existsSync(full) && !lstatSync(full).isSymbolicLink();
        backups.push({ rel: backup, before: had ? readFileSync(full) : null, mode: had ? permissions(full) : null });
        writeAtomic(root, backup, readFileSync(src), "100644", temps, opts.beforeRename);
      }
      tookTemplate.push({ path: t, backup });
    }
    for (const d of [...deletes].sort()) {
      safeParts(root, d);
      touched.push(d);
      rmSync(join(root, d), { force: true });
    }
    for (const w of writes) {
      opts.beforeWrite?.(w);
      touched.push(w);
      writeAtomic(root, w, bytes.get(w)!, files[w].mode, temps, opts.beforeRename);
    }
    touched.push(MANIFEST);
    writeAtomic(root, MANIFEST, Buffer.from(manifestJson(p.newManifest)), "100644", temps, opts.beforeRename);
  } catch (e) {
    fail("the update failed", e);
  }

  const short = p.to.slice(0, 12);
  const paths = [...writes, ...deletes, MANIFEST];
  try {
    // Literal pathspecs: a manifest path is a file name, never a pattern. Deletions leave
    // the index first, so a case-only rename is recorded under its new name on a
    // case-insensitive disk (git would otherwise keep the old index name).
    if (deletes.size > 0) gitApply(["--literal-pathspecs", "rm", "-q", "--cached", "--ignore-unmatch", "--", ...deletes]);
    gitApply(["--literal-pathspecs", "add", "-f", "-A", "--", ...writes, MANIFEST]);
    gitApply(["commit", "-q", "-m", `update: coach-harness ${p.oldManifest.release} → ${p.newManifest.release} (${short})`, "-m", `Coach-Template-Commit: ${p.to}`]);
  } catch (e) {
    // Every rollback step counts: a failed reset is reported, never swallowed.
    const earlier: string[] = [];
    try {
      gitApply(["--literal-pathspecs", "reset", "-q", "--", ...paths]);
    } catch (r) {
      earlier.push(`reset the index: ${(r as Error).message.split("\n")[0]}`);
    }
    fail("the update could not be committed", e, earlier);
  }
  const changed = [...writes, ...deletes];
  return {
    committed: git(root, ["rev-parse", "HEAD"]).trim(),
    release_from: p.oldManifest.release,
    release_to: p.newManifest.release,
    to: p.to,
    written: writes,
    deleted: [...deletes].sort(),
    kept_mine: [...keep].sort(),
    took_template: tookTemplate,
    npm_ci_needed: changed.includes("package-lock.json"),
    reinstall_git_hooks: changed.some((c) => c.startsWith("git-hooks/")),
    restart_claude_code: changed.some((c) => c.startsWith(".claude/")),
  };
}

/**
 * Rollback, in an order that is safe on a case-insensitive disk: temp files, then every
 * added path (files/foo may be the same file as files/Foo), then every original from HEAD,
 * then the backups. Returns what could not be undone (empty when all of it was).
 */
function restore(root: string, touched: string[], head: Set<string>, temps: Set<string>, backups: Saved[], gitRun: (args: string[]) => string): string[] {
  const problems: string[] = [];
  const attempt = (what: string, f: () => void) => {
    try {
      f();
    } catch (e) {
      problems.push(`${what}: ${(e as Error).message.split("\n")[0]}`);
    }
  };
  for (const t of temps) attempt(`remove ${t}`, () => rmSync(t, { force: true }));
  const added = touched.filter((x) => !head.has(x));
  for (const t of added) attempt(`remove ${t}`, () => rmSync(join(root, t), { force: true }));
  // Staged additions leave the index too.
  if (added.length > 0) attempt(`unstage ${added.join(", ")}`, () => gitRun(["--literal-pathspecs", "rm", "-q", "--cached", "--ignore-unmatch", "--", ...added]));
  const originals = touched.filter((x) => head.has(x));
  // An added path can share a file with an original that differs only in case: restore that too.
  const lowerHead = new Map([...head].map((h) => [h.toLowerCase(), h]));
  for (const t of added) {
    const twin = lowerHead.get(t.toLowerCase());
    if (twin !== undefined && !originals.includes(twin)) originals.push(twin);
  }
  if (originals.length > 0) attempt(`restore ${originals.join(", ")}`, () => gitRun(["--literal-pathspecs", "checkout", "-q", "HEAD", "--", ...originals]));
  // Backups and replaced ignored files: bytes and mode, through the checked writer.
  const tmp = new Set<string>();
  for (const b of backups) {
    attempt(`restore ${b.rel}`, () => {
      if (b.before === null) rmSync(join(root, b.rel), { force: true });
      else writeAtomic(root, b.rel, b.before, b.mode ?? 0o644, tmp);
    });
  }
  for (const t of tmp) attempt(`remove ${t}`, () => rmSync(t, { force: true }));
  return problems;
}
