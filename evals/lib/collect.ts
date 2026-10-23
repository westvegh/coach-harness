// Collects what a run left behind: the mock state, git, the log, the
// hook-written files, the fake gh calls and the guard verdicts.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readState } from "../mock-tally/client.ts";
import { git, type Instance } from "./instance.ts";

export const DEFAULT_WATCH = ["coach.yaml", "athlete/limits.md", "athlete/limits.yaml", "athlete/.urgent-stop", "athlete/block.yaml", "athlete/brief.md", "athlete/movements.local.yaml"];
const WATCH_DIRS = ["athlete/log", "athlete/signals", "plans"];

function listFiles(root: string, rel: string): string[] {
  const dir = join(root, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(root, `${rel}/${e.name}`) : [`${rel}/${e.name}`]));
}

/** The watched files' contents (null when absent). */
export function snapshotFiles(root: string, extra: string[] = []): Record<string, string | null> {
  const paths = new Set([...DEFAULT_WATCH, ...extra, ...WATCH_DIRS.flatMap((d) => listFiles(root, d))]);
  const out: Record<string, string | null> = {};
  for (const p of [...paths].sort()) out[p] = existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null;
  return out;
}

export function collectGit(inst: Instance, sinceSha: string) {
  const shas = git(inst.root, "rev-list", "--all", `^${sinceSha}`).split("\n").filter(Boolean);
  const commits = shas.map((sha) => {
    const subject = git(inst.root, "log", "-1", "--format=%s", sha).trim();
    const files = git(inst.root, "show", "--name-only", "--format=", sha).split("\n").filter(Boolean);
    return { sha, subject, files };
  });
  const branches = git(inst.root, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);
  let pushedMain: string[] = [];
  try {
    pushedMain = execFileSync("git", ["--git-dir", join(inst.dir, "remote.git"), "rev-list", "main", `^${sinceSha}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
  } catch {
    pushedMain = [];
  }
  return { commits, branches, pushedMain };
}

export function collectGh(inst: Instance): string[][] {
  return readFileSync(inst.ghLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as string[];
      } catch {
        return [l];
      }
    });
}

export function collectVerdicts(root: string): any[] {
  return listFiles(root, "athlete/.cache/verdicts")
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(root, f), "utf8"));
      } catch {
        return { unreadable: f };
      }
    });
}

export function collectMock(inst: Instance) {
  return readState(inst.statePath);
}
