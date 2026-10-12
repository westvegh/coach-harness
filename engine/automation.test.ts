import { test } from "node:test";
import assert from "node:assert/strict";
import { UNATTENDED_TOOLS, TALLY_CONNECTOR_URL, TALLY_TOOLS, dailyCron, launchdPlist, routineBody, weeklyCron, windowCheck } from "./automation.ts";
import { CoachError } from "./errors.ts";
import { zonedTimeToEpoch } from "./dates.ts";
import type { CoachConfig } from "./types.ts";

const cfg = (tz = "America/Los_Angeles", over: Partial<CoachConfig["automation"]> = {}): CoachConfig => ({
  version: 1,
  athlete: { name: "Alex", timezone: tz, units: "lbs" },
  method: "nine-adaptations",
  template: { days: 4, emphasis: "all-around" },
  signals: { wearable: "apple-health-shortcut", checkin: "shortcut" },
  logger: "tally",
  tally_mentioned: false,
  consent: { logger_health_notes: false },
  automation: { mode: "cloud", daily_window: { start: "05:07", end: "10:07" }, weekly: { day: "sun", time: "17:07" }, verified: false, ...over },
  approval: { auto: ["trim_session"], ask: ["new_exercise"] },
  thresholds: {},
});
const tally = { uuid: "aba48580-99bf-4898-87f0-4f8d511b31dd", name: "Tally_Workout", url: TALLY_CONNECTOR_URL };
const REPO = "https://github.com/alex/coach";
const CLAUDE = { claude: "/home/alex/.local/bin/claude" };
const JULY = Date.parse("2026-07-15T12:00:00Z");
const JAN = Date.parse("2026-01-15T12:00:00Z");
const BEFORE_FALL_BACK = Date.parse("2026-10-31T12:00:00Z"); // PDT
const AFTER_FALL_BACK = Date.parse("2026-11-02T12:00:00Z"); // PST

/** Every UTC hour a cron field "a-b,c" names. */
function hoursOf(field: string): number[] {
  return field.split(",").flatMap((p) => {
    const [a, b] = p.split("-").map(Number);
    return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
}

test("daily: the local window as UTC, covering both PDT and PST (Los Angeles)", () => {
  const { cron, offsets_min } = dailyCron(cfg(), JULY);
  assert.equal(cron, "7 12-18 * * *");
  assert.deepEqual(offsets_min, [-480, -420]);
  assert.equal(dailyCron(cfg(), JAN).cron, cron, "the same cron all year");
  // Every local run time 05:07..10:07, on a summer and a winter day, falls on a cron hour.
  const hours = hoursOf(cron.split(" ")[1]);
  for (const date of ["2026-07-15", "2026-01-15", "2026-10-31", "2026-11-02"]) {
    for (let h = 5; h <= 10; h++) {
      const utc = new Date(zonedTimeToEpoch(date, `${String(h).padStart(2, "0")}:07`, "America/Los_Angeles"));
      assert.equal(utc.getUTCMinutes(), 7);
      assert.ok(hours.includes(utc.getUTCHours()), `${date} ${h}:07 → ${utc.toISOString()}`);
    }
  }
});

test("daily: New York and a zone without DST", () => {
  assert.equal(dailyCron(cfg("America/New_York"), JULY).cron, "7 9-15 * * *");
  assert.equal(dailyCron(cfg("America/Phoenix"), JULY).cron, "7 12-17 * * *");
  assert.equal(dailyCron(cfg("Asia/Tokyo", { daily_window: { start: "06:30", end: "10:30" } }), JULY).cron, "30 0-1,21-23 * * *");
});

test("daily: the minimum interval is 1 hour (one minute value, distinct hours)", () => {
  for (const tz of ["America/Los_Angeles", "America/Chicago", "America/New_York", "Pacific/Honolulu", "America/Anchorage"]) {
    const [minute, hours, ...rest] = dailyCron(cfg(tz), JULY).cron.split(" ");
    assert.match(minute, /^\d{1,2}$/, tz);
    const hs = hoursOf(hours);
    assert.equal(new Set(hs).size, hs.length, tz);
    assert.deepEqual(rest, ["*", "*", "*"]);
  }
  assert.throws(() => dailyCron(cfg("America/Los_Angeles", { daily_window: { start: "10:00", end: "09:00" } }), JULY), CoachError);
});

test("weekly: both UTC offsets — Sunday 17:07 Los Angeles is Monday 00:07 (PDT) and 01:07 (PST) UTC", () => {
  assert.equal(weeklyCron(cfg(), BEFORE_FALL_BACK).cron, "7 0-1 * * 1");
  assert.equal(weeklyCron(cfg(), AFTER_FALL_BACK).cron, "7 0-1 * * 1", "the same cron on both sides of the change");
  assert.match(weeklyCron(cfg(), JULY).note, /window-check/);
  assert.equal(weeklyCron(cfg("America/New_York"), JULY).cron, "7 21-22 * * 0");
  assert.equal(weeklyCron(cfg("America/New_York", { weekly: { day: "mon", time: "21:30" } }), JAN).cron, "30 1-2 * * 2");
  assert.equal(weeklyCron(cfg("America/Phoenix"), JULY).cron, "7 0 * * 1");
  // An offset pair that lands on two UTC days: Sunday 23:30 in London is Sunday 22:30 (BST) and 23:30 (GMT) UTC.
  assert.equal(weeklyCron(cfg("Europe/London", { weekly: { day: "mon", time: "00:30" } }), JULY).cron, "30 0,23 * * 0-1");
});

test("routine body: mcp_connections holds exactly the Tally connector", () => {
  const body = routineBody("daily", cfg(), REPO, tally, { now: JULY, environment_id: "env_1" }) as any;
  assert.deepEqual(body.mcp_connections, [{ connector_uuid: tally.uuid, name: "Tally_Workout", url: TALLY_CONNECTOR_URL, permitted_tools: [...TALLY_TOOLS] }]);
  assert.throws(() => routineBody("daily", cfg(), REPO, { ...tally, url: "https://gmailmcp.googleapis.com/mcp/v1" }, { now: JULY }), (e: unknown) => e instanceof CoachError && e.code === "BAD_CONNECTOR");
  assert.throws(() => routineBody("daily", cfg(), REPO, { ...tally, uuid: "" }, { now: JULY }), CoachError);
});

test("routine body: allowed_tools is exact", () => {
  const body = routineBody("daily", cfg(), REPO, tally, { now: JULY }) as any;
  assert.deepEqual(body.job_config.ccr.session_context.allowed_tools, [
    ...UNATTENDED_TOOLS,
    "mcp__Tally_Workout__get_training_context",
    "mcp__Tally_Workout__get_workout_history",
    "mcp__Tally_Workout__get_planned_workout",
    "mcp__Tally_Workout__get_exercise_progress",
    "mcp__Tally_Workout__search_exercises",
    "mcp__Tally_Workout__plan_workout_day",
    "mcp__Tally_Workout__plan_workout_range",
    "mcp__Tally_Workout__update_planned_workout",
    "mcp__Tally_Workout__move_planned_workout",
    "mcp__Tally_Workout__skip_planned_workout",
    "mcp__Tally_Workout__delete_planned_workout",
  ]);
});

test("launch review finding 1: the unattended allowlist has no open Bash, Write or Edit", () => {
  for (const t of UNATTENDED_TOOLS) assert.ok(!["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(t), `${t} is open`);
  const bash = UNATTENDED_TOOLS.filter((t) => t.startsWith("Bash(")).map((t) => t.slice(5, -1));
  assert.deepEqual(bash, ["node engine/cli.ts:*", "npm ci", "git status:*", "git diff:*", "git log:*", "git add:*", "git commit:*", "git pull:*", "git switch:*", "gh api:*", "date:*", "printenv CLAUDE_CODE_REMOTE"]);
  const files = UNATTENDED_TOOLS.filter((t) => /^(Edit|Write)\(/.test(t)).map((t) => t.replace(/^(Edit|Write)\((.*)\)$/, "$2"));
  assert.deepEqual([...new Set(files)], ["athlete/log/**", ".tmp/coach/**"]);
  const plist = launchdPlist("daily", cfg(), "/home/alex/coach", CLAUDE);
  assert.doesNotMatch(plist, /<string>(Bash|Write|Edit)<\/string>/, "the plist has no open Bash, Write or Edit");
});

test("routine body: the prompt dispatches explicitly; cron, repo and options", () => {
  const daily = routineBody("daily", cfg(), REPO, tally, { now: JULY, environment_id: "env_1", model: "claude-sonnet-5-5" }) as any;
  const weekly = routineBody("weekly", cfg(), REPO, tally, { now: JULY }) as any;
  const content = (b: any) => b.job_config.ccr.events[0].data.message.content as string;
  assert.ok(content(daily).startsWith("First run: node engine/cli.ts window-check --kind daily. If it exits with a nonzero code, stop and do nothing else."));
  assert.match(content(daily), /read \.claude\/skills\/today\/SKILL\.md and follow it exactly\. Unattended run\./);
  assert.ok(content(weekly).startsWith("First run: node engine/cli.ts window-check --kind weekly."));
  assert.match(content(weekly), /read \.claude\/skills\/week\/SKILL\.md and follow it exactly\. Unattended run\./);
  assert.match(content(daily), /main branch/);
  assert.equal(daily.cron_expression, "7 12-18 * * *");
  assert.equal(weekly.cron_expression, "7 0-1 * * 1");
  assert.deepEqual(daily.job_config.ccr.session_context.sources, [{ git_repository: { url: REPO } }]);
  assert.equal(daily.job_config.ccr.environment_id, "env_1");
  assert.equal(daily.job_config.ccr.session_context.model, "claude-sonnet-5-5");
  assert.equal(weekly.job_config.ccr.environment_id, undefined);
  assert.equal(daily.enabled, true);
  assert.equal((routineBody("daily", cfg(), REPO, tally, { now: JULY, enabled: false }) as any).enabled, false);
  assert.equal(daily.persist_session, false);
  assert.deepEqual(routineBody("daily", cfg(), REPO, tally, { now: JULY, environment_id: "env_1", model: "claude-sonnet-5-5" }), daily, "stable");
  assert.match(daily.job_config.ccr.events[0].data.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => routineBody("daily", cfg(), "git@github.com:alex/coach.git", tally, { now: JULY }), CoachError);
});

test("launchd plist: unsets ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN, sets COACH_UNATTENDED=1", () => {
  const plist = launchdPlist("daily", cfg(), "/home/alex/coach", CLAUDE);
  const args = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const i = args.indexOf("/usr/bin/env");
  assert.deepEqual(args.slice(i, i + 8), ["/usr/bin/env", "-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", "COACH_UNATTENDED=1", "/home/alex/.local/bin/claude", "-p"]);
  assert.match(args[i + 8], /^First run: node engine\/cli\.ts window-check --kind daily\..*read \.claude\/skills\/today\/SKILL\.md and follow it exactly\. Unattended run\. This is a scheduled run on the Mac\./);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/home\/alex\/\.local\/bin:\/opt\/homebrew\/bin:/);
  assert.deepEqual(args.slice(i + 9, i + 12).slice(0, 2), ["--permission-mode", "dontAsk"]);
  assert.equal(args[i + 11], "--allowedTools");
  assert.deepEqual(args.slice(i + 12, i + 12 + UNATTENDED_TOOLS.length), [...UNATTENDED_TOOLS]);
  assert.equal(args[i + 12 + UNATTENDED_TOOLS.length], "mcp__claude_ai_Tally_Workout__get_training_context");
  assert.match(plist, /<key>COACH_UNATTENDED<\/key>\s*<string>1<\/string>/);
  assert.doesNotMatch(plist, /<key>ANTHROPIC_API_KEY<\/key>/);
  assert.match(plist, /<string>dev\.coach-harness\.daily<\/string>/);
  assert.match(plist, /<string>\/home\/alex\/coach<\/string>/);
  assert.equal((plist.match(/<key>Hour<\/key>/g) ?? []).length, 6); // 05:07 .. 10:07, local time
  assert.match(plist, /<key>Hour<\/key><integer>5<\/integer>\s*<key>Minute<\/key><integer>7<\/integer>/);
});

test("launchd plist: weekly runs Sunday (Weekday 0) in local time; bad input throws", () => {
  const plist = launchdPlist("weekly", cfg(), "/home/alex/coach", CLAUDE);
  assert.match(plist, /<key>Weekday<\/key><integer>0<\/integer>\s*<key>Hour<\/key><integer>17<\/integer>/);
  assert.match(plist, /skills\/week\/SKILL\.md/);
  assert.throws(() => launchdPlist("daily", cfg(), "relative/path", CLAUDE), CoachError);
  assert.throws(() => launchdPlist("daily", cfg(), "/home/alex/coach", { claude: "claude" }), (e: unknown) => e instanceof CoachError && e.code === "CLAUDE_NOT_FOUND");
  assert.match(launchdPlist("daily", cfg(), "/home/a&b", CLAUDE), /\/home\/a&amp;b/);
});

test("routine body: the discovery body has no connections and is disabled", () => {
  const body = routineBody("daily", cfg(), REPO, null, { now: JULY, enabled: true }) as any;
  assert.equal("mcp_connections" in body, false);
  assert.equal(body.enabled, false);
  assert.equal(body.job_config.ccr.session_context.allowed_tools.length, UNATTENDED_TOOLS.length + 11);
});

// ---------- the installed cron plus window-check, across DST ----------

/** Every UTC instant in [from, to) at which a 5-field cron "M H * * D" fires. */
function firings(cron: string, from: string, to: string): number[] {
  const [m, h, , , d] = cron.split(" ");
  const list = (f: string, max: number) => (f === "*" ? Array.from({ length: max }, (_, i) => i) : hoursOf(f));
  const mins = list(m, 60), hours = list(h, 24), dows = list(d, 7);
  const out: number[] = [];
  for (let t = Date.parse(from); t < Date.parse(to); t += 60_000) {
    const x = new Date(t);
    if (mins.includes(x.getUTCMinutes()) && hours.includes(x.getUTCHours()) && dows.includes(x.getUTCDay())) out.push(t);
  }
  return out;
}

const local = (t: number, tz = "America/Los_Angeles") =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);

test("the weekly cron made on 2026-10-31 still runs Sunday 17:07 local after DST ends", () => {
  const c = cfg();
  const { cron } = weeklyCron(c, BEFORE_FALL_BACK); // Review input: generated October 31, 2026
  for (const [from, to, want] of [
    ["2026-10-25T00:00:00Z", "2026-10-28T00:00:00Z", "Sun, 2026-10-25, 17:07"],
    ["2026-11-01T00:00:00Z", "2026-11-04T00:00:00Z", "Sun, 2026-11-01, 17:07"],
    ["2026-03-01T00:00:00Z", "2026-03-04T00:00:00Z", "Sun, 2026-03-01, 17:07"],
    ["2026-03-08T00:00:00Z", "2026-03-11T00:00:00Z", "Sun, 2026-03-08, 17:07"],
  ] as const) {
    const fired = firings(cron, from, to);
    const admitted = fired.filter((t) => windowCheck("weekly", c, t).inside);
    assert.deepEqual(admitted.map((t) => local(t)), [want], `${cron} ${from}: ${fired.map((t) => local(t)).join(" | ")}`);
  }
});

test("daily runs outside 05:07-10:07 local are refused; the window is never skipped", () => {
  const c = cfg();
  const { cron } = dailyCron(c, JULY);
  for (const day of ["2026-01-15", "2026-03-08", "2026-07-15", "2026-11-01"]) {
    const fired = firings(cron, `${day}T08:00:00Z`, `${day}T23:59:00Z`);
    const admitted = fired.filter((t) => windowCheck("daily", c, t).inside).map((t) => local(t).slice(-5));
    assert.deepEqual(admitted, ["05:07", "06:07", "07:07", "08:07", "09:07", "10:07"], day);
  }
  // Review inputs: 04:07 in winter and 11:07 in summer are fired by the cron but refused.
  const winter = Date.parse("2026-01-15T12:07:00Z");
  const summer = Date.parse("2026-07-15T18:07:00Z");
  assert.equal(local(winter).slice(-5), "04:07");
  assert.equal(local(summer).slice(-5), "11:07");
  assert.equal(windowCheck("daily", c, winter).inside, false);
  assert.equal(windowCheck("daily", c, summer).inside, false);
});

test("window-check: weekly needs the local day and time; a late start inside the grace counts", () => {
  const c = cfg();
  const at = (s: string) => Date.parse(s);
  assert.equal(windowCheck("weekly", c, at("2026-11-02T01:07:00Z")).inside, true); // Sun 17:07 PST
  assert.equal(windowCheck("weekly", c, at("2026-11-02T01:30:00Z")).inside, true); // 23 min late
  assert.equal(windowCheck("weekly", c, at("2026-11-02T00:07:00Z")).inside, false); // Sun 16:07
  assert.equal(windowCheck("weekly", c, at("2026-11-03T01:07:00Z")).inside, false); // Mon 17:07
  assert.match(windowCheck("weekly", c, at("2026-11-03T01:07:00Z")).reason, /mon/);
});

test("launch review finding 7: the routine allowlist uses the connected connector's own name, in each form", async () => {
  const { discoverToolPrefixes, toolPrefixFromServer } = await import("./automation.ts");
  for (const name of ["tally", "Tally_Workout", "claude_ai_Tally_Workout"]) {
    const body = routineBody("daily", cfg(), REPO, { ...tally, name }, { now: JULY }) as any;
    const tools = (body.job_config.ccr.session_context.allowed_tools as string[]).filter((t) => t.startsWith("mcp__"));
    assert.equal(tools.length, 11);
    assert.ok(tools.every((t) => t.startsWith(`mcp__${name}__`)), name);
  }
  assert.equal(toolPrefixFromServer("claude.ai Tally Workout"), "mcp__claude_ai_Tally_Workout__");
  assert.equal(toolPrefixFromServer("tally"), "mcp__tally__");
  assert.deepEqual(discoverToolPrefixes("tally: node s.js - ✓ Connected\nTally_Workout: https://x - ✗ Failed to connect\nGmail: https://g - ✓ Connected"), ["mcp__tally__"]);
  // The plist takes coach.yaml's prefix when no list is passed.
  const plist = launchdPlist("daily", cfg("America/Los_Angeles", { tool_prefix: "mcp__tally__" }), "/home/alex/coach", CLAUDE);
  assert.match(plist, /<string>mcp__tally__get_training_context<\/string>/);
  assert.doesNotMatch(plist, /mcp__claude_ai_Tally_Workout__/);
});
