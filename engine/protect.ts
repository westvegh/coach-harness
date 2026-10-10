// Protected files (contracts §0, §10, §17). Edit, Write and Bash
// on a protected path: `ask` in an interactive session, deny in an unattended run.
//
// Active only in an athlete instance, which has coach.yaml at the root (decided
// 2026-10-09). The template and development repo has only coach.example.yaml,
// so development is unaffected; guard-writes denies every logger write without
// coach.yaml, so deleting it never opens a path.
//
// Protected paths match without regard to case: macOS volumes are case-insensitive by
// default, so ENGINE/x.ts and Athlete/Limits.yaml name protected files there. Over-
// protecting on a case-sensitive volume is harmless.
//
// Bash is matched on the paths in the command string. This is best effort:
// the server-side backstop (Tally T3) is the real defense against a determined shell.
//
// Unattended runs (launch review finding 1) get a narrow allowlist instead: Bash only for the engine
// CLI, a few git subcommands, `gh api` on the repo and its pulls, and the date and mode
// probes the skills run; Edit and Write only under UNATTENDED_WRITE_DIRS. In every mode, a
// write of a file that node, npm, git or a hook could run (EXECUTABLE_*) needs the user.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { canonicalJson } from "./canonical.ts";
import { githubRepo } from "./prepush.ts";
import { isPlainObject } from "./yaml-file.ts";

export type FileDecision = { decision: "allow" | "ask" | "deny"; reason: string };

/** Exact protected files, relative to the root. */
export const PROTECTED_FILES = ["athlete/limits.yaml", "athlete/hold.yaml", "athlete/.safety-pending", "athlete/movements.local.yaml", "athlete/block.yaml", "template-manifest.json"];
/** Protected folders (every file under them). */
export const PROTECTED_DIRS = ["athlete/.cache/", "athlete/signals/", "methods/", "engine/", ".claude/", "adapters/", "git-hooks/"];
export const PROPOSALS_DIR = "athlete/proposals/";
/** coach.yaml keys only `ask`/deny may change. */
export const PROTECTED_CONFIG_KEYS = ["approval", "thresholds"];

const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** The only folders an unattended run may Edit or Write (launch review finding 1; .tmp/coach/ holds the engine inputs). */
export const UNATTENDED_WRITE_DIRS = ["athlete/log/", "athlete/proposals/", ".tmp/coach/"];
/** Files that node, npm, git or a hook could run: a write needs the user in every mode (launch review finding 1). */
export const EXECUTABLE_EXTENSIONS = [".js", ".cjs", ".mjs", ".ts", ".cts", ".mts", ".sh"];
export const EXECUTABLE_FILES = ["package.json", "package-lock.json", ".npmrc"];
/** Folders whose files a package script, git or a hook runs (path segments, anywhere in the path). */
export const EXECUTABLE_DIRS = ["node_modules", ".husky", ".git", ".github/workflows"];

export type FileGuardInput = {
  tool_name: string;
  tool_input: unknown;
  mode: "interactive" | "unattended";
  root: string;
  /** The current branch; default: read from git (failure counts as main). */
  branch?: string;
  /** Proposal files on main; default: read from git (failure counts every proposal as merged). */
  proposalsOnMain?: string[] | null;
};

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function currentBranch(root: string): string {
  try {
    return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return "main";
  }
}

function mainProposals(root: string): string[] | null {
  try {
    return git(root, ["ls-tree", "-r", "--name-only", "main", "--", PROPOSALS_DIR]).split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/** More links than this in one path is a loop. */
const MAX_LINKS = 40;
export class PathLoop extends Error {
  constructor(p: string) {
    super(`too many symbolic links in ${p}`);
  }
}

/**
 * The path with every symbolic link resolved, dangling links included (lstat and
 * readlink, one component at a time; ".." goes to the physical parent). The caller passes
 * the path unnormalized (rawAbs), so `link/..` is the parent of the link's target, as the
 * operating system reads it. A missing component counts as a folder a write could create.
 * So a link cannot hide where a write lands. Throws after MAX_LINKS links (a loop).
 */
function realish(p: string): string {
  let rest = p.split(sep).filter((c) => c !== "" && c !== ".");
  let cur: string = sep;
  let links = 0;
  // Components below a missing one: they are missing too, so no lstat until `..` climbs out.
  let missing = 0;
  while (rest.length > 0) {
    const name = rest.shift()!;
    if (name === "..") {
      cur = dirname(cur);
      if (missing > 0) missing--;
      continue;
    }
    const next = cur === sep ? `${sep}${name}` : `${cur}${sep}${name}`;
    if (missing > 0) {
      missing++;
      cur = next;
      continue;
    }
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(next, { throwIfNoEntry: false });
    } catch {
      st = undefined; // ENOTDIR and the like: nothing there either
    }
    // Missing: walk on as if a write made it a folder, so a later `..` and link still resolve.
    if (st === undefined) {
      missing = 1;
      cur = next;
      continue;
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    if (++links > MAX_LINKS) throw new PathLoop(p);
    const target = readlinkSync(next);
    rest = [...target.split(sep).filter((c) => c !== "" && c !== "."), ...rest];
    if (isAbsolute(target)) cur = sep;
  }
  return cur;
}

/**
 * `file` made absolute without normalizing it: resolve() would remove `link/..` before
 * realish can give `..` its physical meaning (the parent of the link's target).
 */
function rawAbs(root: string, file: string): string {
  return isAbsolute(file) ? file : `${resolve(root)}${sep}${file}`;
}

const outside = (rel: string) => rel.startsWith("..") || isAbsolute(rel);

/** `abs` relative to the real root; a case variant of the root counts as the root. */
function relFromRoot(root: string, abs: string): string {
  const base = realish(root);
  const rel = relative(base, abs);
  if (!outside(rel)) return rel;
  const folded = relative(base.toLowerCase(), abs.toLowerCase());
  return outside(folded) ? rel : folded;
}

/** The path relative to the root (posix separators), or null when it is outside the root. */
export function relToRoot(root: string, file: string): string | null {
  const rel = relFromRoot(root, realish(rawAbs(root, file)));
  if (rel === "" || outside(rel)) return null;
  return rel.split(sep).join("/");
}

function protectedPath(rel: string, ctx: { onMain: boolean; proposalsOnMain: string[] | null }): string | null {
  const key = rel.toLowerCase();
  if (PROTECTED_FILES.includes(key)) return `${rel} is protected`;
  for (const d of PROTECTED_DIRS) if (key.startsWith(d)) return `${rel} is protected (${d}**)`;
  if (key.startsWith(PROPOSALS_DIR)) {
    if (ctx.onMain) return `${rel}: proposals on main change only through a merged pull request (contracts §17)`;
    if (ctx.proposalsOnMain === null || ctx.proposalsOnMain.some((p) => p.toLowerCase() === key)) return `${rel} is a merged proposal`;
  }
  return null;
}

function protectedConfigView(text: string): string | null {
  try {
    const raw = parse(text);
    if (!isPlainObject(raw)) return null;
    return canonicalJson(Object.fromEntries(PROTECTED_CONFIG_KEYS.map((k) => [k, raw[k] ?? null])));
  } catch {
    return null;
  }
}

/** The file content after an Edit, Write or MultiEdit, or null when it cannot be computed. */
function contentAfter(tool: string, input: Record<string, unknown>, current: string): string | null {
  const apply = (text: string, e: Record<string, unknown>): string | null => {
    if (typeof e.old_string !== "string" || typeof e.new_string !== "string") return null;
    if (e.old_string === "") return null;
    return e.replace_all === true ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string as string);
  };
  if (tool === "Write") return typeof input.content === "string" ? input.content : null;
  if (tool === "Edit") return apply(current, input);
  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    let text: string | null = current;
    for (const e of input.edits) {
      if (text === null || !isPlainObject(e)) return null;
      text = apply(text, e);
    }
    return text;
  }
  return null;
}

/**
 * Why a write of `abs` could run code (a name in EXECUTABLE_*, or an existing file with an
 * execute bit), or null. Matched without regard to case, inside or outside the root.
 */
export function executableWrite(abs: string): string | null {
  const p = abs.split(sep).join("/").toLowerCase();
  const name = basename(p);
  if (EXECUTABLE_FILES.includes(name)) return `${name} runs package scripts`;
  if (EXECUTABLE_EXTENSIONS.includes(extname(name))) return `${name} is a script that node or a shell can run`;
  const segs = p.split("/");
  for (const d of EXECUTABLE_DIRS) {
    const ds = d.split("/");
    for (let i = 0; i + ds.length < segs.length; i++) if (ds.every((x, j) => segs[i + j] === x)) return `${d}/ holds files that git, npm or a hook runs`;
  }
  try {
    const st = statSync(abs);
    if (st.isFile() && (st.mode & 0o111) !== 0) return `${name} is an executable file`;
  } catch {
    /* a new file */
  }
  return null;
}

// ---------- Bash ----------

/**
 * Splits a command into words when it is one simple command: no unquoted ; & | < > ( ),
 * newline or comment, and no $ or backtick anywhere outside single quotes. Otherwise null.
 */
export function simpleWords(cmd: string): string[] | null {
  const words: string[] = [];
  let cur = "";
  let has = false;
  let q: "'" | '"' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q === "'") {
      if (ch === "'") q = null;
      else cur += ch;
      continue;
    }
    if (ch === "$" || ch === "`") return null;
    // A # that starts a word is a comment: the shell ignores the quotes after it.
    if (ch === "#" && !q && !has && !cur) return null;
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === "\\" && i + 1 < cmd.length) cur += cmd[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      has = true;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < cmd.length) {
        cur += cmd[++i];
        has = true;
      }
      continue;
    }
    if (";&|<>()\n\r".includes(ch)) return null;
    if (ch === " " || ch === "\t") {
      if (has || cur) words.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (q) return null;
  if (has || cur) words.push(cur);
  return words;
}

const ENGINE_SCRIPTS = ["engine/cli.ts", "./engine/cli.ts", "engine/hold.ts", "./engine/hold.ts"];

/**
 * The engine CLI call, when the command is exactly `node engine/cli.ts …` or `node engine/hold.ts …`
 * and every word is plain or safely quoted (strictWords: no backslash, so no continuation,
 * no glob, no $ or backtick). Any other form is not an engine call: the shell could turn
 * `upda\<newline>te` or `updat?` into `update`, so the protected-name rule decides.
 */
function engineCall(cmd: string): { script: string; args: string[] } | null {
  const w = strictWords(cmd.trim());
  if (!w || w.length < 2 || w[0] !== "node" || !ENGINE_SCRIPTS.includes(w[1])) return null;
  return { script: w[1].replace(/^\.\//, ""), args: w.slice(2) };
}

/** `hold` subcommands that only read, or that the safety flow trusts (contracts §10). */
const HOLD_TRUSTED = ["set", "init", "status"];

/**
 * The decision for an engine CLI call. The hold subcommand is the word right after `hold`:
 * set, init and status pass; clear, clear-pending and anything else (an option first, no
 * subcommand) need an interactive yes.
 */
function engineCallDecision(call: { script: string; args: string[] }, ask: (r: string) => FileDecision): FileDecision {
  const sub = call.script === "engine/hold.ts" ? ["hold", ...call.args] : call.args;
  // update replaces template files, the engine and the hooks included (contracts §24):
  // only --check passes; anything that can write needs the user's yes.
  if (sub[0] === "update") {
    const writes = sub.some((a) => /^--(yes|keep-mine|take-template)(=|$)/.test(a));
    return sub.includes("--check") && !writes ? { decision: "allow", reason: "" } : ask("update replaces the coach's code and needs your yes (contracts §24)");
  }
  if (sub[0] !== "hold") return { decision: "allow", reason: "" };
  if (HOLD_TRUSTED.includes(sub[1] ?? "")) return { decision: "allow", reason: "" };
  return ask(`hold ${sub[1] ?? ""} can clear a hold and needs an interactive yes (contracts §10)`);
}

/**
 * Splits a command at unquoted ; & && | || and newlines and returns the raw segments.
 * Null when it cannot be split reliably: unbalanced quotes, $( or a backtick, $' quoting,
 * a here-doc, an unquoted ( or ) (subshells, process substitution, zsh glob qualifiers
 * and =(…)), or a comment. A & next to < or > is part of a redirect, not a separator.
 */
export function splitCommand(cmd: string): string[] | null {
  return splitWithSeparators(cmd)?.segs ?? null;
}

/**
 * splitCommand with each separator kept: `seps[i]` ends `segs[i]` (";", "\n", "|", "||",
 * "&&" or "&"). A single "&" puts the command before it in the background, also at the end.
 */
export function splitWithSeparators(cmd: string): { segs: string[]; seps: string[] } | null {
  const segs: string[] = [];
  const seps: string[] = [];
  let start = 0;
  let q: "'" | '"' | null = null;
  let wordStart = true;
  const cut = (end: number, next: number) => {
    segs.push(cmd.slice(start, end));
    seps.push(cmd.slice(end, next));
    start = next;
    wordStart = true;
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q === "'") {
      if (ch === "'") q = null;
      continue;
    }
    if (ch === "`" || (ch === "$" && "('\"".includes(cmd[i + 1] ?? ""))) return null;
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === "\\") i++;
      continue;
    }
    const atWordStart = wordStart;
    wordStart = " \t<>&|;\n\r".includes(ch);
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === "\\") i++;
    else if (ch === "#" && atWordStart) return null;
    else if (ch === "(" || ch === ")") return null;
    else if (ch === "<" && cmd[i + 1] === "<") return null;
    else if (ch === ";" || ch === "\n" || ch === "\r") cut(i, i + 1);
    else if (ch === "|") cmd[i + 1] === "|" ? cut(i, ++i + 1) : cut(i, i + 1);
    else if (ch === "&") {
      if (cmd[i - 1] === ">" || cmd[i - 1] === "<" || cmd[i + 1] === ">") continue;
      if (cmd[i + 1] === "&") cut(i, ++i + 1);
      else cut(i, i + 1);
    }
  }
  if (q) return null;
  segs.push(cmd.slice(start));
  seps.push("");
  return { segs, seps };
}

/** True for `git add …` or `git commit …` as one simple command (no git options, no redirect). */
function gitAddOrCommit(seg: string): boolean {
  const w = simpleWords(seg.trim());
  return w !== null && w[0] === "git" && (w[1] === "add" || w[1] === "commit");
}

/**
 * A single read-only command: ls, cat, head, tail, wc, stat or grep, then words made only
 * of letters, digits and . _ / - , + @ : * ?, or a whole word in single or double quotes
 * whose text holds only letters, digits, spaces and . _ - : / @ , + (no $, backtick,
 * backslash, glob or nested quote). The same rule as .claude/hooks/fast-files.ts; a test
 * keeps them equal. It cannot write, so it may name a protected path.
 */
export function isReadOnlyBash(command: string): boolean {
  const words = readOnlyWords(command);
  if (words === null || !["ls", "cat", "head", "tail", "wc", "stat", "grep"].includes(words[0])) return false;
  return !words.some((w) => /^(xargs|tee|sed|find)$/.test(w) || /^-(exec|execdir|ok|okdir|delete)$/.test(w) || w.startsWith("--in-place"));
}

/** The words of a read-only command (quotes removed), or null when a word breaks the character rule. */
function readOnlyWords(command: string): string[] | null {
  const words: string[] = [];
  const re = /[ \t]*(?:'([A-Za-z0-9 ._:\/@,+-]*)'|"([A-Za-z0-9 ._:\/@,+-]*)"|([A-Za-z0-9._\/,+@:*?-]+))(?=[ \t]|$)/y;
  const s = command.replace(/[ \t]+$/, "");
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return null;
    words.push(m[1] ?? m[2] ?? m[3]);
    i = re.lastIndex;
  }
  return words.length > 0 ? words : null;
}

/** File-descriptor duplication (2>&1, >&2, 1>&2): it names no file. */
const FD_DUP = /^[0-9]?>&[0-9]$/;

/**
 * A segment with its file-descriptor duplications removed, and the target of one final
 * `>` or `>>` redirect (a plain word), or null. Quotes are respected. `cmd` is the segment
 * unchanged when another redirect or shell syntax makes this unclear (the strict rules apply).
 */
export function normalizeSegment(seg: string): { cmd: string; redirect: string | null } {
  // Unquoted words with their spans.
  const spans: { start: number; end: number; text: string; quoted: boolean }[] = [];
  let q: "'" | '"' | null = null;
  let start = -1;
  let quoted = false;
  for (let i = 0; i <= seg.length; i++) {
    const ch = seg[i];
    if (i < seg.length && q) {
      if (ch === q) q = null;
      else if (q === '"' && ch === "\\") i++;
      continue;
    }
    if (i === seg.length || ch === " " || ch === "\t") {
      if (start >= 0) spans.push({ start, end: i, text: seg.slice(start, i), quoted });
      start = -1;
      quoted = false;
      continue;
    }
    if (start < 0) start = i;
    if (ch === "'" || ch === '"') {
      q = ch;
      quoted = true;
    } else if (ch === "\\") {
      i++;
      quoted = true;
    }
  }
  if (q) return { cmd: seg, redirect: null };
  const keep = spans.filter((w) => w.quoted || !FD_DUP.test(w.text));
  let redirect: string | null = null;
  let words = keep;
  const last = keep.at(-1);
  const prev = keep.at(-2);
  if (prev && last && !prev.quoted && !last.quoted && /^1?>>?$/.test(prev.text) && /^[A-Za-z0-9._\/-]+$/.test(last.text)) {
    redirect = last.text;
    words = keep.slice(0, -2);
  } else if (last && !last.quoted && /^1?>>?[A-Za-z0-9._\/-]+$/.test(last.text)) {
    redirect = last.text.replace(/^1?>>?/, "");
    words = keep.slice(0, -1);
  }
  const cmd = words.map((w) => w.text).join(" ");
  // Any other unquoted redirect: keep the segment as it is.
  if (words.some((w) => !w.quoted && /[<>]/.test(w.text))) return { cmd: seg, redirect: null };
  return { cmd, redirect };
}

/** True when `target` is a file under .tmp/coach/ (the engine's scratch folder) that runs no code. */
function scratchTarget(root: string, target: string): boolean {
  const abs = realish(rawAbs(root, target));
  const rel = relToRoot(root, abs);
  return rel !== null && rel.toLowerCase().startsWith(".tmp/coach/") && executableWrite(abs) === null;
}

// ---------- the unattended Bash allowlist (launch review finding 1) ----------

/** Engine subcommands an unattended run never runs (checkin refuses itself too). */
const UNATTENDED_ENGINE_DENY = ["install-launchd", "checkin", "update"];
/** Branch, remote and ref names: no option, no refspec colon or plus. */
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._\/-]*$/;
/**
 * The read subcommands' allowed options (an allowlist: a denylist misses what the shell or
 * git expands). `-<N>` and `-n <N>` for log are handled in unattendedGit.
 */
const GIT_READ_OPTS: Record<string, { flags: string[]; prefixed: string[] }> = {
  status: { flags: ["--porcelain", "--short", "-s", "--branch", "-b"], prefixed: [] },
  diff: { flags: ["--stat", "--name-only", "--cached", "--staged", "--quiet", "--exit-code", "--"], prefixed: [] },
  log: { flags: ["--oneline", "--stat", "--name-only", "--"], prefixed: ["--format=", "--since="] },
};
/**
 * For each write subcommand: its allowed options, and which take a value. There is no push:
 * an unattended run pushes only through `node engine/cli.ts push`, which checks first.
 */
const GIT_OPTS: Record<string, { flags: string[]; valued: string[] }> = {
  add: { flags: ["-A", "--all", "-u", "--update", "-v", "--verbose", "--"], valued: [] },
  commit: { flags: ["-a", "--all", "-q", "--quiet", "--allow-empty", "-v", "--verbose"], valued: ["-m", "--message", "-am"] },
  pull: { flags: ["--rebase", "-r", "--ff-only", "--no-edit", "-q", "--quiet", "--autostash"], valued: [] },
  switch: { flags: ["-c", "--create"], valued: [] },
};

/**
 * The words of one unattended command, quotes removed, or null. Each word is made of plain
 * parts ([A-Za-z0-9._/:=@,+%-]) and quoted parts whose text holds no $, backtick,
 * backslash or newline. So nothing is left for the shell to expand: no { } * ? [ ] ~ ! #,
 * no backslash (also not a backslash-newline continuation), no $ even in quotes. With
 * `newlines`, a newline inside quotes is kept and the word's index goes into the set (the
 * caller allows it only in a git commit message); without it, such a word is null.
 */
export function strictWords(cmd: string, newlines?: Set<number>): string[] | null {
  const words: string[] = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === " " || ch === "\t") {
      if (has) words.push(cur);
      cur = "";
      has = false;
    } else if (ch === "'" || ch === '"') {
      const end = cmd.indexOf(ch, i + 1);
      if (end < 0) return null;
      const text = cmd.slice(i + 1, end);
      if (/[$`\\\r]/.test(text)) return null;
      if (text.includes("\n")) {
        if (!newlines) return null;
        newlines.add(words.length);
      }
      cur += text;
      has = true;
      i = end;
    } else if (/[A-Za-z0-9._\/:=@,+%-]/.test(ch)) {
      cur += ch;
      has = true;
    } else return null;
  }
  if (has) words.push(cur);
  return words;
}

/** Null when one simple command is on the unattended allowlist; otherwise why not. */
function unattendedSegment(words: string[], root?: string): string | null {
  const [w0, w1] = words;
  if (w0 === "node" && ENGINE_SCRIPTS.includes(w1 ?? "")) {
    const sub = w1.endsWith("hold.ts") ? "hold" : words[2];
    return UNATTENDED_ENGINE_DENY.includes(sub ?? "") ? `node engine/cli.ts ${sub} never runs unattended` : null;
  }
  if (w0 === "printenv") return words.length === 2 && ["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED"].includes(w1) ? null : "printenv reads only CLAUDE_CODE_REMOTE or COACH_UNATTENDED";
  const date = /^TZ=[A-Za-z0-9_+\/-]+$/.test(w0 ?? "") ? words.slice(1) : words;
  if (date[0] === "date") {
    // Only +FORMAT operands and -u: a bare operand such as 100914302026 sets the clock.
    return date.slice(1).every((w) => w === "-u" || /^\+[%A-Za-z0-9:_.,\/ -]*$/.test(w)) ? null : "date takes only +FORMAT operands and -u";
  }
  if (w0 === "git") return unattendedGit(words.slice(1), root);
  if (w0 === "gh") return unattendedGh(words.slice(1), root);
  return `${w0 ?? "an empty command"} is not on the unattended allowlist`;
}

function unattendedGit(w: string[], root?: string): string | null {
  const sub = w[0] ?? "";
  const rest = w.slice(1);
  const read = GIT_READ_OPTS[sub];
  if (read) {
    let afterDd = false;
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i];
      if (afterDd || !x.startsWith("-")) continue; // a path or ref operand (plain words only)
      if (x === "--") afterDd = true;
      else if (sub === "log" && /^-[0-9]+$/.test(x)) continue;
      else if (sub === "log" && x === "-n" && /^[0-9]+$/.test(rest[i + 1] ?? "")) i++;
      else if (!read.flags.includes(x) && !read.prefixed.some((p) => x.startsWith(p))) return `git ${sub} ${x} is not allowed unattended`;
    }
    return null;
  }
  if (sub === "push") return "git push does not run unattended: use node engine/cli.ts push (it installs the hook and checks the destination first)";
  const spec = GIT_OPTS[sub];
  if (!spec) return `git ${sub || "with an option first"} is not on the unattended allowlist (status, diff, log, add, commit, pull, push, switch)`;
  const operands: string[] = [];
  let afterDd = false;
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    if (afterDd || !x.startsWith("-")) operands.push(x);
    else if (x === "--" ) afterDd = true;
    else if (spec.valued.includes(x)) i++;
    else if (spec.valued.some((v) => v.startsWith("--") && x.startsWith(`${v}=`))) continue;
    else if (!spec.flags.includes(x)) return `git ${sub} ${x} is not allowed unattended`;
  }
  // A pull of another branch would merge it locally: a drafted block on proposal/<id>
  // would then reach main's working tree without the athlete's merge.
  if (sub === "pull" && operands.length > 0) return "git pull takes no remote or branch unattended (it pulls the current branch)";
  if (sub === "switch" && root !== undefined) {
    const dirty = uncommittedBlock(root);
    if (dirty) return dirty;
  }
  if (sub === "switch" && (operands.length !== 1 || !REF_RE.test(operands[0]))) return "git switch takes one branch name";
  return null;
}

/**
 * Why an unattended `git switch` must wait, or null: switch carries uncommitted changes to
 * the next branch, so a block written on proposal/<id> but not committed would land in
 * main's working tree, where the guard reads the approved block.
 */
function uncommittedBlock(root: string): string | null {
  try {
    const out = execFileSync("git", ["-C", root, "status", "--porcelain", "--", "athlete/block.yaml"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() === "" ? null : "athlete/block.yaml has uncommitted changes: commit it on this branch before git switch";
  } catch {
    return "git status failed, so git switch cannot be checked";
  }
}

/** owner/repo of the origin remote when it is on GitHub, else null. */
function originRepo(root: string): string | null {
  try {
    return githubRepo(execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return null;
  }
}

/**
 * `gh api` on this repository (origin's owner/repo, case-insensitive) or its pulls: GET, or
 * POST to create a pull request. The effective method is -X/--method when given, else POST
 * when any field is passed (as gh does), else GET.
 */
function unattendedGh(w: string[], root?: string): string | null {
  if (w[0] !== "api") return `gh ${w[0] ?? ""} is not on the unattended allowlist (gh api only)`;
  let explicit: string | null = null;
  let fields = false;
  let endpoint: string | null = null;
  for (let i = 1; i < w.length; i++) {
    const x = w[i];
    if (x === "-X" || x === "--method") explicit = (w[++i] ?? "").toUpperCase();
    else if (x === "-f" || x === "--raw-field") {
      fields = true;
      i++;
    } else if (x === "--jq" || x === "-q") i++;
    else if (x === "-F" || x === "--field") {
      if ((w[i + 1] ?? "").includes("=@")) return "gh api -F k=@file reads a file; not allowed unattended";
      fields = true;
      i++;
    } else if (x === "--paginate" || x === "--silent") continue;
    else if (x.startsWith("-")) return `gh api ${x} is not allowed unattended`;
    else if (endpoint === null) endpoint = x;
    else return "gh api takes one endpoint";
  }
  const m = endpoint === null ? null : /^\/?repos\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)(\/pulls(\/\d+)?)?(\?[A-Za-z0-9_=&.-]*)?$/.exec(endpoint);
  if (!m) return "gh api reaches only repos/<owner>/<repo> and its pulls";
  const origin = root === undefined ? null : originRepo(root);
  if (origin === null) return "gh api needs a GitHub origin remote to check the repository";
  if (m[1].toLowerCase() !== origin.toLowerCase()) return `gh api reaches only this repository (${origin}), not ${m[1]}`;
  const method = explicit ?? (fields ? "POST" : "GET");
  if (method === "GET") return null;
  if (method === "POST" && m[2] === "/pulls") return null;
  return `gh api ${method} ${m[2] ?? ""} is not allowed unattended`;
}

/** The indices of the -m, --message and -am values of `git commit` (and of --message=…). */
function commitMessages(words: string[]): Set<number> {
  const out = new Set<number>();
  if (words[0] !== "git" || words[1] !== "commit") return out;
  for (let i = 2; i < words.length; i++) {
    const x = words[i];
    if (x === "--") break;
    if (["-m", "--message", "-am"].includes(x)) out.add(++i);
    else if (x.startsWith("--message=")) out.add(i);
  }
  return out;
}

/** Null when every segment of `cmd` is on the unattended allowlist; otherwise why not. */
export function unattendedBash(cmd: string, root?: string): string | null {
  const split = splitWithSeparators(cmd);
  if (split === null) return "the command uses shell syntax the allowlist does not accept";
  // A single & runs the command before it in the background: it runs on after the guard's
  // check (as run_in_background), so branch checks, writes and commits could overlap.
  if (split.seps.includes("&")) return "a single & runs a command in the background; an unattended command runs in the foreground";
  let any = false;
  const parts = split.segs.filter((s) => s.trim() !== "");
  for (const raw of parts) {
    const n = normalizeSegment(raw);
    const newlines = new Set<number>();
    const words = strictWords(n.cmd.trim(), newlines);
    if (words === null) return "a word holds shell syntax (an unquoted { } * ? [ ] ~ ! #, a backslash, or $ or a backtick in quotes); an unattended command uses plain words only";
    // A quoted newline is allowed only in a git commit message (a body and a trailer).
    const messages = commitMessages(words);
    if ([...newlines].some((k) => !messages.has(k))) return "a line break inside quotes is allowed only in the git commit -m or --message value";
    if (n.redirect !== null && !(words[0] === "node" && ENGINE_SCRIPTS.includes(words[1] ?? "") && root !== undefined && scratchTarget(root, n.redirect))) {
      return "a redirect goes only from the engine CLI into .tmp/coach/";
    }
    // git switch carries the working tree to another branch: it runs alone, after the
    // command before it has finished (the block check sees the real state).
    if (words[0] === "git" && words[1] === "switch" && parts.length > 1) return "git switch must be the whole command unattended";
    const why = unattendedSegment(words, root);
    if (why) return why;
    any = true;
  }
  return any ? null : "an empty command";
}

const PR_MERGE = [/\bgh\s+pr\s+merge\b/, /\bgh\s+api\b[^\n]*\bpulls\/\d+\/merge\b/];

/** Words in a Bash command that point at a protected path (best effort). */
const BASH_TOKENS: [RegExp, string][] = [
  [/(^|[\s'"=/])limits\.yaml\b/i, "athlete/limits.yaml"],
  [/(^|[\s'"=/])hold\.yaml\b/i, "athlete/hold.yaml"],
  [/\.safety-pending\b/i, "athlete/.safety-pending"],
  [/movements\.local\.yaml\b/i, "athlete/movements.local.yaml"],
  [/(^|[\s'"=/])block\.yaml\b/i, "athlete/block.yaml"],
  [/(^|[\s'"=/])signals(\/|\b)/i, "athlete/signals/"],
  [/snapshot\.json\b/i, "athlete/.cache/snapshot.json"],
  [/(^|[\s'"=/])\.cache\b/i, "athlete/.cache/"],
  [/(^|[\s'"=])(\.\/)?(engine|methods|adapters|git-hooks)(\/|\b)/i, "engine/, methods/, adapters/ or git-hooks/"],
  [/(^|[\s'"=/])\.claude\b/i, ".claude/"],
  [/(^|[\s'"=/])coach\.yaml\b/i, "coach.yaml"],
  [/template-manifest\.json\b/i, "template-manifest.json"],
  [/\bcore\.hooksPath\b|\.git\/hooks\b/i, "git hooks"],
];

/** Splits a command at unquoted ; & | and newlines, then into words with quotes removed (best effort). */
export function shellSegments(cmd: string): string[][] {
  const segs: string[][] = [];
  let words: string[] = [];
  let cur = "";
  let has = false;
  let q: "'" | '"' | null = null;
  const endWord = () => {
    if (has || cur) words.push(cur);
    cur = "";
    has = false;
  };
  const endSeg = () => {
    endWord();
    if (words.length) segs.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (";&|\n\r()".includes(ch)) endSeg();
    else if (ch === " " || ch === "\t" || ch === "<" || ch === ">") endWord();
    else cur += ch;
  }
  endSeg();
  return segs;
}

/** The repo-relative path an operand names ("" for the root), or null when it is not a path inside the root. */
function operandRel(root: string, word: string): string | null {
  let w = word.includes("=") && !word.startsWith("/") ? word.slice(word.indexOf("=") + 1) : word;
  w = w.replace(/^\$\{?CLAUDE_PROJECT_DIR\}?/, root).replace(/^\$\{?PWD\}?/, root);
  if (w === "" || w.startsWith("-")) return null;
  const bare = PROTECTED_DIRS.map((d) => d.slice(0, -1));
  const lw = w.toLowerCase();
  if (!(w.includes("/") || w === "." || w === ".." || bare.includes(lw) || lw === "coach.yaml")) return null;
  const rel = relFromRoot(root, realish(rawAbs(root, w)));
  if (outside(rel)) return null;
  return rel.split(sep).join("/");
}

/** True for a protected path, a protected folder itself, coach.yaml or the git hooks. */
function isProtectedRel(rel: string, ctx: { onMain: boolean; proposalsOnMain: string[] | null }): boolean {
  const key = rel.toLowerCase();
  if (key === "coach.yaml" || key === ".git/hooks" || key.startsWith(".git/hooks/")) return true;
  if (PROTECTED_DIRS.some((d) => key === d.slice(0, -1))) return true;
  return protectedPath(rel, ctx) !== null;
}

/** True when a protected path lies at or under `rel` ("" is the root). */
function coversProtected(rel: string, ctx: { onMain: boolean; proposalsOnMain: string[] | null }): boolean {
  if (rel === "" || isProtectedRel(rel, ctx)) return true;
  const pre = `${rel.toLowerCase()}/`;
  return [...PROTECTED_FILES, ...PROTECTED_DIRS, "coach.yaml", ".git/hooks"].some((p) => p.startsWith(pre));
}

const RESTORES = ["checkout", "restore", "reset", "stash", "clean"];
const GIT_VALUE_OPTS = ["-C", "-c", "--git-dir", "--work-tree", "--namespace"];

/**
 * a git checkout, restore, reset, stash or clean is broad when it names ".",
 * a protected path (or a folder holding one), or no path at all. Null when it is not broad.
 */
function broadRestore(root: string, words: string[], ctx: { onMain: boolean; proposalsOnMain: string[] | null }): string | null {
  if (words[0] !== "git") return null;
  let k = 1;
  while (k < words.length && words[k].startsWith("-")) k += GIT_VALUE_OPTS.includes(words[k]) ? 2 : 1;
  const sub = words[k];
  if (!RESTORES.includes(sub)) return null;
  const rest = words.slice(k + 1);
  if (sub === "stash") return ["list", "show"].includes(rest[0]) ? null : "git stash";
  const valueOpts = sub === "restore" ? ["-s", "--source"] : sub === "checkout" ? ["-b", "-B", "--orphan"] : sub === "clean" ? ["-e", "--exclude"] : [];
  const dd = rest.indexOf("--");
  const before = dd >= 0 ? rest.slice(0, dd) : rest;
  const operands: string[] = [];
  for (let j = 0; j < before.length; j++) {
    if (valueOpts.includes(before[j])) j++;
    else if (!before[j].startsWith("-")) operands.push(before[j]);
  }
  let paths: string[];
  if (dd >= 0) paths = rest.slice(dd + 1);
  else if (sub === "checkout") {
    // checkout -b <name> with no start point leaves the work tree alone.
    if (before.some((w) => ["-b", "-B", "--orphan"].includes(w)) && operands.length === 0) return null;
    paths = operands.slice(1);
  } else if (sub === "reset") {
    if (before.some((w) => ["--hard", "--merge", "--keep"].includes(w))) return `git reset ${before.find((w) => w.startsWith("--"))}`;
    paths = operands.filter((w) => existsSync(rawAbs(root, w)));
  } else paths = operands;
  if (paths.length === 0) return `git ${sub} with no path`;
  for (const p of paths) {
    const rel = operandRel(root, p.includes("/") || p === "." || p === ".." ? p : `./${p}`);
    if (rel !== null && coversProtected(rel, ctx)) return `git ${sub} ${p}`;
  }
  return null;
}

/**
 * The command with each backslash-newline outside single quotes removed, as the shell does
 * before it splits words (a line continuation): `node en\<newline>gine/cli.ts` is judged as
 * `node engine/cli.ts`.
 */
export function joinContinuations(cmd: string): string {
  let out = "";
  let q: "'" | '"' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q === "'") {
      if (ch === "'") q = null;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      if (cmd[i + 1] === "\n") {
        i++;
        continue;
      }
      out += ch;
      if (i + 1 < cmd.length) out += cmd[++i];
      continue;
    }
    if (ch === "'" && q === null) q = "'";
    else if (ch === '"') q = q === '"' ? null : '"';
    out += ch;
  }
  return out;
}

/** True for a segment that runs node with a word the strict rule refuses (a backslash, a glob, $ or a backtick). */
function obscuredNode(seg: string): boolean {
  const first = shellSegments(seg)[0]?.[0] ?? "";
  return (first === "node" || first.endsWith("/node")) && strictWords(seg.trim()) === null;
}

function bashDecision(cmd: string, ask: (r: string) => FileDecision, mode: FileGuardInput["mode"], root: string, ctx: { onMain: boolean; proposalsOnMain: string[] | null }): FileDecision {
  // a local git merge is never an approval, and an unattended run never merges.
  const gitMerge = shellSegments(cmd).some((w) => {
    if (w[0] !== "git") return false;
    let k = 1;
    while (k < w.length && w[k].startsWith("-")) k += GIT_VALUE_OPTS.includes(w[k]) ? 2 : 1;
    return w[k] === "merge";
  });
  if (gitMerge || PR_MERGE.some((re) => re.test(cmd))) {
    return mode === "unattended"
      ? { decision: "deny", reason: "guard-files: merging a pull request is the user's approval; an unattended run never merges (contracts §17)" }
      : ask("merging a pull request approves a proposal (contracts §17)");
  }
  if (mode === "unattended") {
    const why = unattendedBash(cmd, root);
    if (why) return { decision: "deny", reason: `guard-files: ${why}; an unattended run may use only the engine CLI (node engine/cli.ts push for pushes), git status|diff|log|add|commit|pull|switch and gh api on this repository, with plain words (contracts §23)` };
  }
  const segs = splitCommand(cmd);
  if (segs === null) return strictDecision(cmd, ask, root, ctx);
  // Each segment on its own; the command passes only when every segment passes. A file-
  // descriptor duplication (2>&1) names no file, and engine output may go to .tmp/coach/.
  for (const raw of segs) {
    if (raw.trim() === "") continue;
    const n = normalizeSegment(raw);
    const seg = n.redirect === null ? n.cmd : raw;
    // A node command the strict word rule cannot read never falls through to allow: the
    // shell could still build engine/cli.ts update from it (contracts §24).
    if (obscuredNode(n.cmd)) return ask("a node command with shell syntax (a backslash, a glob, $ or a backtick) cannot be checked");
    const call = engineCall(n.cmd);
    const d = call && (n.redirect === null || scratchTarget(root, n.redirect))
      ? engineCallDecision(call, ask)
      : isReadOnlyBash(seg) || gitAddOrCommit(seg)
        ? { decision: "allow" as const, reason: "" }
        : namesProtected(seg, 0, ask, root, ctx);
    if (d.decision !== "allow") return d;
  }
  return { decision: "allow", reason: "" };
}

/** A command that cannot be split reliably: one engine call, or no protected path anywhere. */
function strictDecision(cmd: string, ask: (r: string) => FileDecision, root: string, ctx: { onMain: boolean; proposalsOnMain: string[] | null }): FileDecision {
  const call = engineCall(cmd);
  if (call) return engineCallDecision(call, ask);
  if (shellSegments(cmd).some((w) => w[0] === "node" || (w[0] ?? "").endsWith("/node"))) return ask("a node command with shell syntax that cannot be split reliably");
  return namesProtected(cmd, 1, ask, root, ctx);
}

/**
 * Ask when the command holds a broad git restore, a protected path operand (from word
 * `first` on in each segment) or a protected name; otherwise allow.
 */
function namesProtected(cmd: string, first: number, ask: (r: string) => FileDecision, root: string, ctx: { onMain: boolean; proposalsOnMain: string[] | null }): FileDecision {
  for (const words of shellSegments(cmd)) {
    const broad = broadRestore(root, words, ctx);
    if (broad) return ask(`a broad git restore (${broad}) can replace protected files`);
    for (const w of words.slice(first)) {
      const rel = operandRel(root, w);
      if (rel !== null && rel !== "" && isProtectedRel(rel, ctx)) return ask(`the command names a protected path (${rel})`);
    }
  }
  const hits = BASH_TOKENS.filter(([re]) => re.test(cmd)).map(([, what]) => what);
  if (hits.length > 0) return ask(`the command names a protected path (${[...new Set(hits)].join("; ")})`);
  return { decision: "allow", reason: "" };
}

// ---------- the decision ----------

export function fileGuard(input: FileGuardInput): FileDecision {
  try {
    return fileGuardInner(input);
  } catch (e) {
    if (!(e instanceof PathLoop)) throw e;
    const why = `guard-files: ${e.message}`;
    return input.mode === "unattended" ? { decision: "deny", reason: why } : { decision: "ask", reason: `${why}; confirm with the user` };
  }
}

function fileGuardInner(input: FileGuardInput): FileDecision {
  const { root, mode } = input;
  if (!existsSync(resolve(root, "coach.yaml"))) return { decision: "allow", reason: "" };
  const ask = (why: string): FileDecision =>
    mode === "unattended"
      ? { decision: "deny", reason: `guard-files: ${why}; denied in an unattended run` }
      : { decision: "ask", reason: `guard-files: ${why}; confirm with the user` };
  const args = isPlainObject(input.tool_input) ? input.tool_input : {};

  if (input.tool_name === "Bash") {
    if (typeof args.command !== "string") return ask("a Bash call without a command string");
    // A background command runs on after the guard's check; unattended, nothing waits for it.
    if (mode === "unattended" && args.run_in_background === true) return { decision: "deny", reason: "guard-files: an unattended run never runs Bash in the background (contracts §23)" };
    // Proposal files are guarded for Edit and Write only (§17): the proposal flow commits them with Bash.
    // Line continuations first, as the shell joins them before it reads any word.
    return bashDecision(joinContinuations(args.command), ask, mode, root, { onMain: false, proposalsOnMain: [] });
  }
  if (!WRITE_TOOLS.includes(input.tool_name)) return { decision: "allow", reason: "" };

  const file = typeof args.file_path === "string" ? args.file_path : typeof args.notebook_path === "string" ? args.notebook_path : null;
  if (!file) return ask(`${input.tool_name} without a file path`);
  const exec = executableWrite(realish(rawAbs(root, file)));
  if (exec) return ask(`${exec} (contracts §23)`);
  const rel = relToRoot(root, file);
  if (mode === "unattended" && (rel === null || !UNATTENDED_WRITE_DIRS.some((d) => rel.toLowerCase().startsWith(d)))) {
    return { decision: "deny", reason: `guard-files: an unattended run writes only under ${UNATTENDED_WRITE_DIRS.join(", ")}, not ${rel ?? file} (contracts §23)` };
  }
  if (rel === null) return { decision: "allow", reason: "" };

  if (rel.toLowerCase() === "coach.yaml") {
    let current = "";
    try {
      current = readFileSync(resolve(root, rel), "utf8");
    } catch {
      return ask("coach.yaml cannot be read to check the protected keys");
    }
    const next = contentAfter(input.tool_name, args, current);
    if (next === null) return ask("the coach.yaml change cannot be checked");
    const before = protectedConfigView(current);
    const after = protectedConfigView(next);
    if (before === null || after === null || before !== after) return ask(`coach.yaml keys ${PROTECTED_CONFIG_KEYS.join(" and ")} are protected`);
    return { decision: "allow", reason: "" };
  }

  // The branch and main's proposals matter only for a proposal file: no git lookup otherwise.
  const proposal = rel.toLowerCase().startsWith(PROPOSALS_DIR);
  const ctx = {
    onMain: proposal ? (input.branch ?? currentBranch(root)) === "main" : false,
    proposalsOnMain: input.proposalsOnMain !== undefined ? input.proposalsOnMain : proposal ? mainProposals(root) : [],
  };
  const why = protectedPath(rel, ctx);
  return why ? ask(why) : { decision: "allow", reason: "" };
}
