// Shared helpers for the engine-helper tests: a temporary athlete instance and the CLI.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO = new URL("../..", import.meta.url).pathname;
export const CLI = join(REPO, "engine/cli.ts");
// No unattended markers, and no session id: a test that needs one passes it.
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_CODE_SESSION_ID"].includes(k)));

export function cli(args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: opts.cwd ?? REPO, encoding: "utf8", input: opts.input ?? "", env: { ...BASE_ENV, ...(opts.env ?? {}) } });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

/** A temp instance: coach.yaml (from the example, with edits), methods/ linked, athlete/. */
export function instance(edit: (yaml: string) => string = (y) => y): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-e3-"));
  mkdirSync(join(dir, "athlete/.cache"), { recursive: true });
  writeFileSync(join(dir, "coach.yaml"), edit(readFileSync(join(REPO, "coach.example.yaml"), "utf8")));
  symlinkSync(join(REPO, "methods"), join(dir, "methods"));
  return dir;
}

export function writeJson(dir: string, rel: string, value: unknown): string {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(value, null, 2));
  return p;
}
