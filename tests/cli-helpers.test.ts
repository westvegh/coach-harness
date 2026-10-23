// Smoke tests for the helper and automation CLI commands (contracts §15): each runs as a real process
// and prints JSON. No network: gh is a fake on PATH. No real LaunchAgent: HOME is a temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const CLI = join(REPO, "engine/cli.ts");
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDE_CODE_REMOTE" && k !== "COACH_UNATTENDED"));

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: "utf8", env: { ...BASE_ENV, ...env } });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stderr: r.stderr };
}

function root(mode = "cloud"): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-e1-"));
  mkdirSync(join(dir, "athlete"), { recursive: true });
  writeFileSync(join(dir, "coach.yaml"), readFileSync(join(REPO, "coach.example.yaml"), "utf8").replace("mode: manual", `mode: ${mode}`));
  writeFileSync(join(dir, "athlete/limits.md"), readFileSync(join(REPO, "templates/athlete/limits.md")));
  return dir;
}

function writeJson(dir: string, name: string, value: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(value));
  return p;
}

const HASH = "b".repeat(64);

/** A fake claude executable for the launchd commands. */
/**
 * A fake claude: `claude mcp list` shows the servers in $FAKE_MCP (default: the claude.ai
 * Tally connector); `claude -p` prints stream-json with one call to the first allowed tool
 * and its result (an error when $FAKE_PROBE_FAIL is set). It logs its arguments to calls.log.
 */
function fakeClaude(dir = mkdtempSync(join(tmpdir(), "fake-claude-"))): string {
  writeFileSync(
    join(dir, "claude"),
    `#!/bin/sh
echo "$@" >> "${dir}/calls.log"
if [ "$1" = "mcp" ]; then printf '%s\\n' "\${FAKE_MCP:-claude.ai Tally Workout: https://mcp.tallyworkout.app/api/mcp - ✓ Connected}"; exit 0; fi
tool=""; next=0
for a in "$@"; do if [ $next = 1 ]; then tool="$a"; break; fi; [ "$a" = "--allowedTools" ] && next=1; done
err=false; [ -n "$FAKE_PROBE_FAIL" ] && err=true
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"'"$tool"'","input":{}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":'"$err"',"content":"ok"}]}}'
`,
  );
  chmodSync(join(dir, "claude"), 0o755);
  return join(dir, "claude");
}
const TALLY = "https://mcp.tallyworkout.app/api/mcp";

test("mode: interactive, and unattended under COACH_UNATTENDED=1 or CLAUDE_CODE_REMOTE", () => {
  assert.deepEqual(cli(["mode"]).json, { mode: "interactive" });
  assert.deepEqual(cli(["mode"], { COACH_UNATTENDED: "1" }).json, { mode: "unattended" });
  assert.deepEqual(cli(["mode"], { CLAUDE_CODE_REMOTE: "true" }).json, { mode: "unattended" });
});

test("opid --date --kind --input", () => {
  const dir = root();
  const call = writeJson(dir, "call.json", { tool: "mcp__tally__plan_workout_day", args: { date: "2026-10-12" } });
  const r = cli(["opid", "--date", "2026-10-12", "--kind", "trim_session", "--input", call]);
  assert.equal(r.code, 0);
  assert.match(r.json.opid, /^op-2026-10-12-trim_session-[0-9a-f]{12}$/);
  assert.equal(cli(["opid", "--date", "2026-10-12", "--kind", "bogus", "--input", call]).code, 1);
});

test("adjust --input: trim and recovery", () => {
  const dir = root();
  const day = { date: "2026-10-12", dayName: "Lower A", exercises: [{ name: "Back Squat", sets: Array.from({ length: 5 }, () => ({ weight: 200, reps: 5 })) }] };
  const t = cli(["adjust", "--root", dir, "--input", writeJson(dir, "a.json", { day, decision: "trim" })]);
  assert.equal(t.code, 0, t.stderr);
  assert.equal(t.json.day.exercises[0].sets.length, 4);
  assert.deepEqual(t.json.changes, ["Back Squat: 5 → 4 sets"]);
  const r = cli(["adjust", "--root", dir, "--input", writeJson(dir, "b.json", { day, decision: "recovery", planned_minutes: 40 })]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.day.dayName, "Recovery");
  assert.equal(r.json.day.exercises.reduce((s: number, e: any) => s + e.sets[0].duration_s, 0), 2400);
});

test("loads --input: from the given history", () => {
  const dir = root();
  const input = {
    exercises: [{ name: "Back Squat", sets: [{ reps: 5 }, { reps: 5 }] }],
    history: [{ date: "2026-10-05", exercises: [{ exerciseId: "sq", name: "Back Squat", muscle: "quads", sets: [{ weight: 200, reps: 5, rpe: 7 }] }] }],
  };
  const r = cli(["loads", "--root", dir, "--input", writeJson(dir, "l.json", input)]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.units, "lbs");
  assert.equal(r.json.suggestions[0].suggestedWeight, 210);
});

test("targets --input", () => {
  const dir = root();
  const block = {
    version: 1, id: "B1", method: "nine-adaptations", template: { days: 3, emphasis: "all-around" }, start: "2026-10-05",
    weeks: [{ week: 1, kind: "build", sessions: 3, targets: { quads: 10 } }, { week: 2, kind: "build", sessions: 3, targets: { quads: 11 } }],
    days: [{ day: "mon", focus: "lower", slots: [{ pattern: "squat", adaptation: "strength", sets: 4 }] }],
  };
  const r = cli(["targets", "--root", dir, "--input", writeJson(dir, "t.json", { block, logs: [], today: "2026-10-11", target_week: 2 })]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.targets.week, 2);
  assert.equal(cli(["targets", "--root", dir, "--input", writeJson(dir, "t2.json", { block, today: "2026-10-11" })]).code, 2);
});

function fakeGh(): { env: NodeJS.ProcessEnv; log: string } {
  const bin = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const log = join(bin, "argv.jsonl");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write(JSON.stringify({ html_url: "https://github.com/alex/coach/pull/3" }));\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return { env: { PATH: `${bin}${delimiter}${process.env.PATH}` }, log };
}

test("proposals are gone in v0.2: a change for the next live session is a plain line in the athlete log", () => {
  const r = cli(["proposals", "list"]);
  assert.equal(r.code, 2);
  assert.equal(r.json.error.code, "USAGE");
});

test("routine-body: from the API's connection list, Tally only", () => {
  const dir = root();
  const conns = writeJson(dir, "c.json", {
    trigger: {
      mcp_connections: [
        { connector_uuid: "g-1", name: "Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1" },
        { connector_uuid: "t-1", name: "Tally_Workout", url: TALLY },
      ],
    },
  });
  const r = cli(["routine-body", "--root", dir, "--kind", "daily", "--repo-url", "https://github.com/alex/coach", "--connections", conns, "--now", "2026-07-15T12:00:00Z", "--environment-id", "env_1"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.body.mcp_connections.map((c: any) => c.connector_uuid), ["t-1"]);
  assert.equal(r.json.body.cron_expression, "7 12-18 * * *");
  assert.equal(r.json.cron.cron, "7 12-18 * * *");
  const w = cli(["routine-body", "--root", dir, "--kind", "weekly", "--repo-url", "https://github.com/alex/coach", "--connector-uuid", "t-1", "--disabled", "--now", "2026-07-15T12:00:00Z"]);
  assert.equal(w.json.body.cron_expression, "7 0-1 * * 1");
  assert.equal(w.json.body.enabled, false);
  const d = cli(["routine-body", "--root", dir, "--kind", "daily", "--repo-url", "https://github.com/alex/coach", "--discover"]);
  assert.equal(d.code, 0, d.stderr);
  assert.equal(d.json.body.enabled, false);
  assert.equal(d.json.body.mcp_connections, undefined);
  const none = writeJson(dir, "n.json", [{ connector_uuid: "g-1", name: "Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1" }]);
  const n = cli(["routine-body", "--root", dir, "--kind", "daily", "--repo-url", "https://github.com/alex/coach", "--connections", none]);
  assert.equal(n.code, 1);
  assert.equal(n.json.error.code, "NO_TALLY_CONNECTOR");
});

test("launchd-plist", () => {
  const dir = root("mac");
  const claude = fakeClaude();
  const r = cli(["launchd-plist", "--root", dir, "--kind", "weekly", "--claude", claude]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.label, "dev.coach-harness.weekly");
  assert.match(r.json.plist, /<string>ANTHROPIC_API_KEY<\/string>/);
  assert.match(r.json.plist, /<string>COACH_UNATTENDED=1<\/string>/);
  assert.equal(r.json.claude, claude);
});

test("install-launchd: writes nothing without --yes; with --yes writes into HOME/Library/LaunchAgents only", () => {
  const dir = root("mac");
  const home = mkdtempSync(join(tmpdir(), "coach-home-"));
  const claude = fakeClaude();
  const dry = cli(["install-launchd", "--root", dir, "--kind", "both", "--claude", claude], { HOME: home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.json.dry_run, true);
  assert.equal(dry.json.agents.length, 2);
  assert.equal(existsSync(join(home, "Library")), false);
  const yes = cli(["install-launchd", "--root", dir, "--kind", "daily", "--yes", "--claude", claude], { HOME: home });
  assert.equal(yes.code, 0, yes.stderr);
  assert.deepEqual(readdirSync(join(home, "Library/LaunchAgents")), ["dev.coach-harness.daily.plist"]);
  assert.deepEqual(yes.json.loaded, []);
  assert.match(yes.json.next[0], /^launchctl bootstrap gui\/\$\(id -u\) /);
  assert.deepEqual(yes.json.warnings, []);
  const cloud = cli(["install-launchd", "--root", root("cloud"), "--kind", "daily", "--claude", claude], { HOME: home });
  assert.match(cloud.json.warnings[0], /not mac/);
});

test("install-launchd writes the absolute path of claude found on PATH (~/.local/bin)", () => {
  const dir = root("mac");
  const home = mkdtempSync(join(tmpdir(), "coach-home-"));
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  const claude = fakeClaude(join(home, ".local/bin"));
  const env = { HOME: home, PATH: `${join(home, ".local/bin")}${delimiter}/usr/bin${delimiter}/bin` };
  const r = cli(["install-launchd", "--root", dir, "--kind", "daily", "--yes"], env);
  assert.equal(r.code, 0, r.stderr);
  const plist = readFileSync(join(home, "Library/LaunchAgents/dev.coach-harness.daily.plist"), "utf8");
  const args = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.equal(args[args.indexOf("COACH_UNATTENDED=1") + 1], claude, "ProgramArguments holds the absolute path");
  assert.ok(!args.includes("claude"), "never the bare name");
  assert.match(plist, new RegExp(`<key>PATH</key>\\s*<string>${join(home, ".local/bin")}:`));
});

test("install-launchd refuses when claude is not on PATH, and writes nothing", () => {
  const dir = root("mac");
  const home = mkdtempSync(join(tmpdir(), "coach-home-"));
  const r = cli(["install-launchd", "--root", dir, "--kind", "daily", "--yes"], { HOME: home, PATH: `/usr/bin${delimiter}/bin` });
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, "CLAUDE_NOT_FOUND");
  assert.equal(existsSync(join(home, "Library")), false);
  const bad = cli(["install-launchd", "--root", dir, "--kind", "daily", "--yes", "--claude", join(home, "nope")], { HOME: home });
  assert.equal(bad.json.error.code, "CLAUDE_NOT_FOUND");
});

test("window-check: refuses outside the window in an unattended run (exit 4), passes interactively", () => {
  const dir = root();
  const out = cli(["window-check", "--root", dir, "--kind", "daily", "--now", "2026-01-15T12:07:00Z"], { COACH_UNATTENDED: "1" }); // 04:07 PST
  assert.equal(out.code, 4);
  assert.equal(out.json.inside, false);
  const ok = cli(["window-check", "--root", dir, "--kind", "daily", "--now", "2026-01-15T13:07:00Z"], { COACH_UNATTENDED: "1" }); // 05:07 PST
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json.inside, true);
  const wk = cli(["window-check", "--root", dir, "--kind", "weekly", "--now", "2026-11-02T00:07:00Z"], { CLAUDE_CODE_REMOTE: "true" }); // Sun 16:07 PST
  assert.equal(wk.code, 4);
  const inter = cli(["window-check", "--root", dir, "--kind", "daily", "--now", "2026-01-15T12:07:00Z"]);
  assert.equal(inter.code, 0);
  assert.equal(inter.json.enforced, false);
});

// ---------- launch review finding 7: the connected logger's exact tool names ----------

const FORMS = [
  ["tally: node /opt/tally/server.js - ✓ Connected", "mcp__tally__"],
  ["Tally_Workout: https://mcp.tallyworkout.app/api/mcp (HTTP) - ✓ Connected", "mcp__Tally_Workout__"],
  ["claude.ai Tally Workout: https://mcp.tallyworkout.app/api/mcp - ✓ Connected", "mcp__claude_ai_Tally_Workout__"],
] as const;

const allowed = (plist: string) => [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]).filter((s) => s.startsWith("mcp__"));

test("launch review finding 7: install-launchd discovers each Tally name form and writes it into the allowlist", () => {
  for (const [line, prefix] of FORMS) {
    const dir = root("mac");
    const home = mkdtempSync(join(tmpdir(), "coach-home-"));
    const claude = fakeClaude();
    const env = { HOME: home, FAKE_MCP: `Gmail: https://gmail.example/mcp - ✓ Connected\n${line}\nlinear: https://x - ✗ Failed to connect` };
    const dry = cli(["install-launchd", "--root", dir, "--kind", "daily", "--claude", claude], env);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(dry.json.tool_prefixes, [prefix]);
    assert.equal(dry.json.tool_prefix_source, "claude mcp list");
    const tools = allowed(dry.json.agents[0].plist);
    assert.equal(tools.length, 11);
    assert.ok(tools.every((t) => t.startsWith(prefix)), tools.join(","));
    // --yes runs the probe with exactly those names, then installs.
    const yes = cli(["install-launchd", "--root", dir, "--kind", "daily", "--yes", "--claude", claude], env);
    assert.equal(yes.code, 0, yes.stderr);
    assert.equal(yes.json.probe.ok, true);
    assert.equal(yes.json.probe.tool, `${prefix}get_training_context`);
    const calls = readFileSync(join(claude, "../calls.log"), "utf8");
    assert.match(calls, new RegExp(`--permission-mode dontAsk .*--allowedTools ${prefix}get_training_context`));
    assert.deepEqual(allowed(readFileSync(join(home, "Library/LaunchAgents/dev.coach-harness.daily.plist"), "utf8")), tools);
  }
});

test("launch review finding 7: --tool-prefix and coach.yaml automation.tool_prefix win over discovery; bad prefixes are refused", () => {
  const home = mkdtempSync(join(tmpdir(), "coach-home-"));
  const claude = fakeClaude();
  const flag = cli(["launchd-plist", "--root", root("mac"), "--kind", "daily", "--claude", claude, "--tool-prefix", "mcp__tally__"], { HOME: home });
  assert.equal(flag.code, 0, flag.stderr);
  assert.deepEqual(flag.json.tool_prefixes, ["mcp__tally__"]);
  const dir = root("mac");
  writeFileSync(join(dir, "coach.yaml"), readFileSync(join(dir, "coach.yaml"), "utf8").replace(/automation:\n/, "automation:\n  tool_prefix: mcp__Tally_Workout__\n"));
  const cfg = cli(["launchd-plist", "--root", dir, "--kind", "daily", "--claude", claude], { HOME: home });
  assert.equal(cfg.code, 0, cfg.stderr);
  assert.deepEqual(cfg.json.tool_prefixes, ["mcp__Tally_Workout__"]);
  assert.equal(cfg.json.tool_prefix_source, "coach.yaml");
  for (const bad of ["mcp__gmail__", "Bash", "mcp__tally"]) {
    assert.equal(cli(["launchd-plist", "--root", root("mac"), "--kind", "daily", "--claude", claude, "--tool-prefix", bad], { HOME: home }).json.error.code, "BAD_TOOL_PREFIX", bad);
  }
});

test("launch review finding 7: no connected Tally server, or a failed probe, installs nothing", () => {
  const dir = root("mac");
  const home = mkdtempSync(join(tmpdir(), "coach-home-"));
  const claude = fakeClaude();
  const none = cli(["install-launchd", "--root", dir, "--kind", "daily", "--yes", "--claude", claude], { HOME: home, FAKE_MCP: "Gmail: https://gmail.example/mcp - ✓ Connected" });
  assert.equal(none.json.error.code, "NO_LOGGER_TOOLS");
  const failed = cli(["install-launchd", "--root", dir, "--kind", "daily", "--yes", "--claude", claude], { HOME: home, FAKE_PROBE_FAIL: "1" });
  assert.equal(failed.json.error.code, "LOGGER_PROBE_FAILED");
  assert.equal(existsSync(join(home, "Library")), false);
});
