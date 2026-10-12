// Startup bench for engine/cli.ts (perf item). Runs each command as a real
// process and prints the median and the slowest wall-clock time in milliseconds.
// Give several checkouts with --repo to compare them; their runs are interleaved, so a
// change in machine load hits them all alike.
//
//   node scripts/bench-cli.ts [--runs 11] [--repo <checkout> ...]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HERE = new URL("..", import.meta.url).pathname;
const argv = process.argv.slice(2);
const flag = (name: string) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const RUNS = Number(flag("--runs")[0] ?? 11);
const REPOS = flag("--repo").map((r) => resolve(r));
if (REPOS.length === 0) REPOS.push(HERE);

const root = mkdtempSync(join(tmpdir(), "coach-bench-"));
mkdirSync(join(root, "athlete/.cache"), { recursive: true });
writeFileSync(join(root, "coach.yaml"), readFileSync(join(HERE, "coach.example.yaml")));
symlinkSync(join(HERE, "methods"), join(root, "methods"));
writeFileSync(join(root, "athlete/limits.yaml"), readFileSync(join(HERE, "templates/athlete/limits.yaml")));
// 50 mornings of Oura records, so `readiness --date` scores a full baseline and the morning pattern.
mkdirSync(join(root, "athlete/.cache/signals"), { recursive: true });
const oura = Array.from({ length: 50 }, (_, i) => {
  const date = new Date(Date.UTC(2026, 9, 14 - (49 - i))).toISOString().slice(0, 10);
  const prev = new Date(Date.UTC(2026, 9, 13 - (49 - i))).toISOString().slice(0, 10);
  return { date, source: "oura", observed_at: `${date}T06:30:00-07:00`, complete: true, sleep: { duration_min: 450 + (i % 7) * 5, start_at: `${prev}T23:00:00-07:00`, end_at: `${date}T06:30:00-07:00` }, hrv: { value_ms: 50 + (i % 5) * 2, method: "rmssd" }, rhr: { bpm: 54 + (i % 3) } };
});
writeFileSync(join(root, "athlete/.cache/signals/oura.json"), JSON.stringify(oura));
const CASES: [string, string[]][] = [
  ["--help", ["--help"]],
  ["mode", ["mode"]],
  ["urgent status", ["urgent", "status", "--root", root]],
  ["limits-hash", ["limits-hash", "--root", root]],
  ["ids next", ["ids", "next", "--kind", "block", "--root", root]],
  ["weeks", ["weeks", "--from", "2026-10-05", "--to", "2026-10-18", "--root", root]],
  ["signals refresh", ["signals", "refresh", "--root", root]],
  ["readiness --date", ["readiness", "--date", "2026-10-14", "--now", "2026-10-14T07:00:00-07:00", "--root", root]],
  ["block draft", ["block", "draft", "--weeks", "6", "--root", root]],
  ["lint-methods", ["lint-methods", "--root", root]],
  ["oplog done", ["oplog", "done", "--date", "2026-10-15", "--kind", "trim_session", "--root", root]],
  ["limits schema", ["limits", "schema"]],
];

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (args: string[], cwd: string) => {
  const t = process.hrtime.bigint();
  spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
  return Number(process.hrtime.bigint() - t) / 1e6;
};

console.log(`node ${process.version}, ${RUNS} runs each; columns: ${REPOS.map((r, i) => `[${i + 1}] ${r}`).join("  ")}`);
const bare: number[] = [];
for (let r = 0; r < RUNS; r++) bare.push(time(["-e", "0"], HERE));
console.log(`${"bare node -e 0".padEnd(18)} median ${median(bare).toFixed(0).padStart(4)} ms`);
for (const [name, args] of CASES) {
  const times: number[][] = REPOS.map(() => []);
  for (let r = 0; r < RUNS; r++) REPOS.forEach((repo, i) => times[i].push(time([join(repo, "engine/cli.ts"), ...args], repo)));
  const cells = times.map((t, i) => `[${i + 1}] median ${median(t).toFixed(0).padStart(4)} ms, max ${Math.max(...t).toFixed(0).padStart(4)}`);
  console.log(`${name.padEnd(18)} ${cells.join("   ")}`);
}
rmSync(root, { recursive: true, force: true });
