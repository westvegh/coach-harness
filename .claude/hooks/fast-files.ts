// guard-files fast path (docs/contracts.md §20 item 27). Node built-ins only.
//
// In an athlete instance (coach.yaml present) the entry asks this module first. It returns
// "allow" only for a call that engine/protect.ts fileGuard also allows, so it never weakens
// a check; anything else (null) goes to the engine. That includes the read-only Bash
// allowlist (a single ls, cat, head, tail, wc, stat or grep whose arguments use only a
// strict character set, even when it names a protected path, because it cannot write), a
// simple engine CLI call, and a compound of these with no quotes or other shell syntax.
//
// An unattended run (CLAUDE_CODE_REMOTE or COACH_UNATTENDED set) never takes the fast path:
// the engine applies the unattended allowlist (launch review finding 1). A write of a file that node,
// npm, git or a hook could run (the EXECUTABLE_* lists) goes to the engine too.
//
// The protected lists mirror engine/protect.ts. A test keeps them equal and checks every
// fast "allow" against fileGuard. Paths match without regard to case, as in the engine:
// macOS volumes are case-insensitive by default, so ENGINE/x.ts is engine/x.ts there.
import { lstatSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export const PROTECTED_FILES = ["athlete/limits.yaml", "athlete/hold.yaml", "athlete/.safety-pending", "athlete/movements.local.yaml", "athlete/block.yaml", "template-manifest.json"];
export const PROTECTED_DIRS = ["athlete/.cache/", "athlete/signals/", "methods/", "engine/", ".claude/", "adapters/", "git-hooks/"];
export const PROPOSALS_DIR = "athlete/proposals/";
export const EXECUTABLE_EXTENSIONS = [".js", ".cjs", ".mjs", ".ts", ".cts", ".mts", ".sh"];
export const EXECUTABLE_FILES = ["package.json", "package-lock.json", ".npmrc"];
export const EXECUTABLE_DIRS = ["node_modules", ".husky", ".git", ".github/workflows"];

/** The same rule as engine/protect.ts unattendedMarker: any non-empty value counts. */
function unattended(): boolean {
  return (process.env.CLAUDE_CODE_REMOTE ?? "") !== "" || (process.env.COACH_UNATTENDED ?? "") !== "";
}

/** True when a write of `abs` could run code (as engine/protect.ts executableWrite). */
function executable(abs: string): boolean {
  const p = abs.split(sep).join("/").toLowerCase();
  const name = basename(p);
  if (EXECUTABLE_FILES.includes(name) || EXECUTABLE_EXTENSIONS.includes(extname(name))) return true;
  const segs = p.split("/");
  for (const d of EXECUTABLE_DIRS) {
    const ds = d.split("/");
    for (let i = 0; i + ds.length < segs.length; i++) if (ds.every((x, j) => segs[i + j] === x)) return true;
  }
  try {
    const st = statSync(abs);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/**
 * Lower-case substrings that send a Bash command to the engine. A superset of the
 * engine's protected-name tokens (BASH_TOKENS) and bare protected folder names.
 */
const BASH_NAMES = [
  "limits.yaml",
  "hold.yaml",
  ".safety-pending",
  "movements.local.yaml",
  "block.yaml",
  "signals",
  "snapshot.json",
  ".cache",
  "engine",
  "methods",
  "adapters",
  "git-hooks",
  ".claude",
  "coach.yaml",
  "template-manifest",
  "core.hookspath",
  ".git",
  "athlete",
];

const READ_ONLY = ["ls", "cat", "head", "tail", "wc", "stat", "grep"];

/**
 * The path with every symbolic link resolved, dangling links included (lstat and
 * readlink, one component at a time; ".." goes to the physical parent, on a path from
 * rawAbs). A missing component counts as a folder a write could create. So a link cannot
 * hide where a write lands. Throws after 40 links (a loop); the caller then asks the engine. As engine/protect.ts realish.
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
    if (++links > 40) throw new Error(`too many symbolic links in ${p}`);
    const target = readlinkSync(next);
    rest = [...target.split(sep).filter((c) => c !== "" && c !== "."), ...rest];
    if (isAbsolute(target)) cur = sep;
  }
  return cur;
}

/** `file` made absolute without normalizing it, so realish sees every `..` (as engine/protect.ts rawAbs). */
function rawAbs(root: string, file: string): string {
  return isAbsolute(file) ? file : `${resolve(root)}${sep}${file}`;
}

const outside = (rel: string) => rel.startsWith("..") || isAbsolute(rel);

/**
 * The path relative to the root (posix separators), or null outside the root (as
 * engine/protect.ts relToRoot). A case variant of the root counts as the root.
 */
function relToRoot(root: string, file: string): string | null {
  const abs = realish(rawAbs(root, file));
  const base = realish(root);
  let rel = relative(base, abs);
  if (outside(rel)) {
    const folded = relative(base.toLowerCase(), abs.toLowerCase());
    if (!outside(folded)) rel = folded;
  }
  if (rel === "" || outside(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * A single read-only command: ls, cat, head, tail, wc, stat or grep as the first word, then
 * words made only of letters, digits and . _ / - , + @ : * ? separated by spaces or tabs,
 * or a whole word in single or double quotes whose text holds only letters, digits, spaces
 * and . _ - : / @ , + . Anything else (parentheses, brackets, braces, $, =, ~, !, #,
 * backslash, a glob inside quotes, any shell operator or newline) goes to the full guard:
 * zsh runs commands from glob qualifiers such as x(e:cmd:) and from =(cmd). No xargs, tee,
 * sed, find, -exec or in-place flag either.
 */
export function isReadOnlyBash(command: string): boolean {
  const words: string[] = [];
  const re = /[ \t]*(?:'([A-Za-z0-9 ._:\/@,+-]*)'|"([A-Za-z0-9 ._:\/@,+-]*)"|([A-Za-z0-9._\/,+@:*?-]+))(?=[ \t]|$)/y;
  const s = command.replace(/[ \t]+$/, "");
  for (let i = 0; i < s.length; ) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return false;
    words.push(m[1] ?? m[2] ?? m[3]);
    i = re.lastIndex;
  }
  if (!READ_ONLY.includes(words[0])) return false;
  return !words.some((w) => /^(xargs|tee|sed|find)$/.test(w) || /^-(exec|execdir|ok|okdir|delete)$/.test(w) || w.startsWith("--in-place"));
}

/** Removes each backslash-newline outside single quotes, as the shell does (as engine/protect.ts joinContinuations). */
function joinContinuations(cmd: string): string {
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

/** Removes file-descriptor duplications (2>&1, >&2, 1>&2) from a command with no quotes, $, backtick or backslash. */
function withoutFdDup(command: string): string {
  if (/['"\\$`]/.test(command)) return command;
  return command.replace(/(^|[ \t])[0-9]?>&[0-9](?=[ \t;&|\n]|$)/g, "$1");
}

/**
 * True when the engine's Bash rules certainly allow the command: no quotes, backslash, $,
 * backtick or "/", no `git` or `gh` word, no protected name, and no "." or ".." operand.
 */
function isPlainBash(command: string): boolean {
  if (/['"\\$`/]/.test(command)) return false;
  const lower = command.toLowerCase();
  if (/\b(git|gh)\b/.test(lower)) return false;
  if (BASH_NAMES.some((n) => lower.includes(n))) return false;
  return !command.split(/[\s;&|<>()=]+/).some((w) => w === "." || w === "..");
}

const ENGINE_SCRIPTS = ["engine/cli.ts", "./engine/cli.ts", "engine/hold.ts", "./engine/hold.ts"];

/**
 * `node engine/cli.ts …` or `node engine/hold.ts …` that the engine allows: any command but
 * `hold`, and of `hold` only set, init and status (the word right after `hold`).
 */
function isEngineCall(command: string): boolean {
  const w = command.replace(/^[ \t]+|[ \t]+$/g, "").split(/[ \t]+/);
  // Plain words only: a glob such as updat? could expand to a restricted command.
  if (!w.every((x) => /^[A-Za-z0-9._\/:=@,+%-]+$/.test(x))) return false;
  if (w[0] !== "node" || !ENGINE_SCRIPTS.includes(w[1])) return false;
  const sub = w[1].endsWith("hold.ts") ? ["hold", ...w.slice(2)] : w.slice(2);
  // update (any arguments) always goes to the engine (contracts §24).
  if (sub[0] === "update") return false;
  return sub[0] !== "hold" || ["set", "init", "status"].includes(sub[1] ?? "");
}

/**
 * A compound of fast-allowed commands joined by ; & && | || or newlines. Only letters,
 * digits, . _ / - , + @ : * ? spaces and tabs besides the separators: no quotes, $,
 * backtick, backslash, parentheses, redirects, = or #, so the split is exact.
 */
function isFastCompound(command: string): boolean {
  if (!/^[A-Za-z0-9._\/,+@:*? \t;&|\n-]+$/.test(command)) return false;
  return command.split(/[;&|\n]+/).every((seg) => seg.trim() === "" || isReadOnlyBash(seg) || isPlainBash(seg) || isEngineCall(seg));
}

/** "allow" when the call is certainly allowed in an athlete instance; null: ask the engine. */
export function fastFileDecision(toolName: unknown, toolInput: unknown, root: string): "allow" | null {
  const args = toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput) ? (toolInput as Record<string, unknown>) : null;
  if (!args || unattended()) return null;
  if (toolName === "Bash") {
    if (typeof args.command !== "string") return null;
    const c = withoutFdDup(joinContinuations(args.command));
    return isReadOnlyBash(c) || isPlainBash(c) || isFastCompound(c) ? "allow" : null;
  }
  if (typeof toolName !== "string" || !WRITE_TOOLS.includes(toolName)) return null;
  const file = typeof args.file_path === "string" ? args.file_path : typeof args.notebook_path === "string" ? args.notebook_path : null;
  if (!file) return null;
  let rel: string | null;
  try {
    if (executable(realish(rawAbs(root, file)))) return null;
    rel = relToRoot(root, file);
  } catch {
    return null;
  }
  if (rel === null) return "allow";
  const key = rel.toLowerCase();
  if (key === "coach.yaml" || PROTECTED_FILES.includes(key) || key.startsWith(PROPOSALS_DIR)) return null;
  if (PROTECTED_DIRS.some((d) => key.startsWith(d))) return null;
  return "allow";
}
