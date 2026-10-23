// W3 (0.3.0): limits in plain words. The carriers (the session-context hook and today-brief pre),
// the pain threshold and its legacy read order, load-under, and the 0.3.0 migration
// (migrate-limits): every state, every failure, and the converter field by field.
// Made-up data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { limitsBody, limitsCarry, LIMITS_INTRO, MARKER_RE, painThreshold, sha256 } from "../engine/limits-text.ts";
import { BACKUP_FILE, COMMIT_MESSAGE, expectedConfig, expectedLimitsMd, holdsConversion, marker, migrateLimits, renderBullets, movementWords, parseOldLimits, patternMembers, renderLimit, type MigrateStep } from "../engine/migrate-limits.ts";
import { classify, normalizeName } from "../engine/taxonomy.ts";
import { postForSave } from "../engine/today-run.ts";
import { loadUnder } from "../engine/loads.ts";
import { changedSince } from "../engine/today-run.ts";
import { loadTaxonomy } from "../engine/taxonomy.ts";
import { validateConfig } from "../engine/config.ts";
import { cli, instance, writeJson } from "./e3/helpers.ts";
import { GIT_ENV, git, REPO } from "./v7-helpers.ts";

const TAX = loadTaxonomy({ localPath: null });
const TEMPLATE = readFileSync(join(REPO, "templates/athlete/limits.md"), "utf8");
const NOW = "2026-10-14T15:00:00.000Z"; // 08:00 in Los Angeles, inside the daily window
const TODAY = "2026-10-14";
const SESSION = "s-w3";
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_REMOTE", "COACH_UNATTENDED", "CLAUDE_PROJECT_DIR", "COACH_NOW"].includes(k)));
const NO_THRESHOLD = (y: string) => y.replace(/^thresholds:[^\n]*\n(  [^\n]*\n)*/m, "thresholds: {}\n");

function hook(root: string, env: Record<string, string> = {}): string {
  const r = spawnSync(process.execPath, [join(REPO, ".claude/hooks/session-context.ts")], {
    input: JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart", source: "startup" }),
    encoding: "utf8",
    env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: root, COACH_NOW: NOW, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
}
const pre = (dir: string, env: Record<string, string> = {}) => cli(["today-brief", "--stage", "pre", "--now", NOW, "--root", dir], { env: { CLAUDE_CODE_SESSION_ID: SESSION, ...env } });
const md = (body: string) => `${TEMPLATE.replace("None yet.\n", "")}${body}`;

// ---------- the old file (made-up 0.2.x content) ----------

const BAN = `  - id: L-001
    region: left-shoulder
    rule: ban
    patterns: [overhead_press, vertical_push]
    exercises: [Arnold Press]
    allow: []
    note: no pressing overhead for now
    source: athlete
    since: 2026-09-02
`;
const CAP_LONG = `  - id: L-002
    region: right-knee
    rule: cap
    patterns: [squat, lunge, leg_press]
    exercises: []
    allow: [Box Squat, Barbell_Box_Squat, Spanish Squat, Wall Sit, Terminal Knee Extension, Step Down, Belt Squat]
    max_sets_per_week: 8
    build_back: true
    note: stop a set when the knee aches
    source: athlete
    since: 2026-09-10
`;
const BOTH = `  - id: L-003
    region: low-back
    rule: ban
    patterns: [hinge]
    exercises: [Good Morning]
    allow: [Good Morning, Cable Pull Through]
    source: athlete
    since: 2026-09-15
`;
const LOAD_KG = `  - id: L-004
    region: low-back
    rule: cap
    patterns: [hinge]
    exercises: []
    allow: []
    max_load: { value: 60, unit: kg }
    source: clinician-reported
    since: 2026-08-30
`;
const NO_NOTE = `  - id: L-005
    region: right-elbow
    rule: ban
    exercises: [Skull Crusher, Close Grip Chin-Up]
    source: athlete
    since: 2026-10-01
`;
const oldYaml = (pt: number, ...limits: string[]) => `# The athlete's limits (contracts §2). The coach follows them in every plan.\nversion: 1\npain_threshold: ${pt}\nlimits:${limits.length ? `\n${limits.join("")}` : " []\n"}`;

/** A committed 0.2.x athlete repo: coach.yaml (no pain_threshold), athlete/limits.yaml and a brief. */
function repo(yaml: string | null, o: { limitsMd?: string; cfg?: (y: string) => string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "w3-migrate-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ".tmp/\nathlete/.cache/\n");
  writeFileSync(join(dir, "coach.yaml"), (o.cfg ?? NO_THRESHOLD)(readFileSync(join(REPO, "coach.example.yaml"), "utf8")));
  mkdirSync(join(dir, "athlete/log"), { recursive: true });
  writeFileSync(join(dir, "athlete/brief.md"), "# Brief\n\n## Preferences\n- likes front squats\n");
  if (yaml !== null) writeFileSync(join(dir, "athlete/limits.yaml"), yaml);
  if (o.limitsMd !== undefined) writeFileSync(join(dir, "athlete/limits.md"), o.limitsMd);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "0.2.x copy");
  return dir;
}
const migrate = (dir: string, failAt?: MigrateStep) => migrateLimits({ root: dir, env: {}, ...(failAt ? { failAt } : {}) });
const status = (dir: string) => git(dir, "status", "--porcelain", "--untracked-files=all");
const headTree = (dir: string) => git(dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n");

// ---------- the template and the carriers ----------

test("the template: a heading, the intro line and None yet; nothing else", () => {
  assert.equal(TEMPLATE, `# Injuries and limits\n\n${LIMITS_INTRO}\n\nNone yet.\n`);
  assert.equal(limitsBody(TEMPLATE), "None yet.");
  assert.equal(existsSync(join(REPO, "templates/athlete/limits.yaml")), false);
});

test("the carriers: the text after the heading, as written (bullets with their continuation lines); no comments; the same in the hook and pre", async () => {
  const dir = instance();
  const body = "- Left shoulder (AC joint): no bench press or dips. Light pressing only,\n  building back slowly. (since 2026-10-12)\n- Low back: deadlifts at 135 lb or less. (since 2026-10-01)";
  writeFileSync(join(dir, "athlete/limits.md"), md(`<!-- a note to self -->\n${body}\n`));
  const c = await limitsCarry(dir);
  const { fingerprint, ...rest } = c;
  assert.deepEqual(rest, { file: "athlete/limits.md", exists: true, text: body, truncated: false, chars: Array.from(body).length, sources: ["athlete/limits.md"] });
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(hook(dir).includes(`Limits (athlete/limits.md; follow every line in every plan):\n${body}\n`));
  const p = pre(dir).json;
  assert.equal(p.limits_text, body);
  assert.equal(p.limits_text_truncated, false);
  assert.deepEqual(p.limits_file, { path: "athlete/limits.md", exists: true, chars: Array.from(body).length });
  assert.equal(p.limits_legacy, undefined);
});

test("the carriers: cut at 2,000 characters, then say so; the conflicting line after the cut is not carried", () => {
  const dir = instance();
  const lines = Array.from({ length: 30 }, (_, i) => `- Region ${String(i).padStart(2, "0")}: a long made-up limit line that keeps going so the file grows past the cut. (since 2026-10-01)`);
  lines.push("- Left knee: no lunges at all.");
  writeFileSync(join(dir, "athlete/limits.md"), md(`${lines.join("\n")}\n`));
  const p = pre(dir).json;
  assert.equal(Array.from(p.limits_text as string).length, 2000);
  assert.equal(p.limits_text_truncated, true);
  assert.ok(p.limits_file.chars > 2000);
  assert.ok(!(p.limits_text as string).includes("no lunges"));
  const ctx = hook(dir);
  assert.match(ctx, /Limits cut at 2,000 characters: Read athlete\/limits\.md in full before any plan\./);
  assert.ok(!ctx.includes("no lunges"));
});

test("the carriers: a missing file is said; the session context never claims none", () => {
  const dir = instance();
  const ctx = hook(dir);
  assert.match(ctx, /Limits: athlete\/limits\.md is missing\. Read it before any plan/);
  const p = pre(dir).json;
  assert.equal(p.limits_text, "");
  assert.equal(p.limits_file.exists, false);
});

test("the carriers before the migration: the old file's limits as the converter writes them, and the migrate line; a scheduled run carries them too", () => {
  const dir = instance(NO_THRESHOLD);
  const yaml = oldYaml(3, BAN, LOAD_KG);
  writeFileSync(join(dir, "athlete/limits.yaml"), yaml);
  const bullets = [renderLimit(parseOldLimits(yaml).limits[0], TAX), renderLimit(parseOldLimits(yaml).limits[1], TAX)].join("\n");
  const ctx = hook(dir);
  assert.match(ctx, /still has the old limits file \(athlete\/limits\.yaml\)\. In a live session, run `node engine\/cli\.ts migrate-limits` before any plan/);
  assert.ok(ctx.includes(`From your old limits file (not converted yet):\n${bullets}`), ctx);
  assert.match(ctx, /Pain threshold: 3 \(from athlete\/limits\.yaml\)/);
  const p = pre(dir, { COACH_UNATTENDED: "1" }).json;
  assert.equal(p.mode, "unattended");
  assert.ok((p.limits_text as string).includes(bullets));
  assert.deepEqual(p.limits_legacy, { file: "athlete/limits.yaml", migrate: "node engine/cli.ts migrate-limits", ok: true });
  assert.deepEqual(p.pain_threshold, { value: 3, source: "athlete/limits.yaml" });
  // With limits.md beside it (the athlete's own lines), both are carried.
  writeFileSync(join(dir, "athlete/limits.md"), md("- Neck: no shrugs. (since 2026-10-10)\n"));
  const both = pre(dir).json.limits_text as string;
  assert.ok(both.startsWith("- Neck: no shrugs. (since 2026-10-10)\n\nFrom your old limits file (not converted yet):\n"), both);
  // limits.md that already holds this file's conversion (an interrupted migration): no second copy.
  writeFileSync(join(dir, "athlete/limits.md"), expectedLimitsMd(null, parseOldLimits(yaml), sha256(yaml), TAX));
  const once = pre(dir).json.limits_text as string;
  assert.equal(once, bullets);
});

test("the carriers: an old file it cannot convert is never None yet: its raw text, the problem, and the fix", () => {
  const dir = instance(NO_THRESHOLD);
  const bad = "version: 1\npain_threshold: 4\nlimits:\n  - { id: L-1, region: knee, rule: block, since: yesterday }\n";
  writeFileSync(join(dir, "athlete/limits.yaml"), bad);
  writeFileSync(join(dir, "athlete/limits.md"), TEMPLATE);
  const ctx = hook(dir);
  assert.match(ctx, /Your old limits file \(athlete\/limits\.yaml\) cannot be converted \(.*limits\[0\]\.id: must look like L-001.*\)\. Follow it as written below, and ask the athlete to fix it\./);
  assert.ok(ctx.includes(`Your old limits file (athlete/limits.yaml) as written:\n${bad.trim()}`));
  const p = pre(dir).json;
  assert.equal(p.limits_legacy.ok, false);
  assert.ok((p.limits_text as string).includes("rule: block"));
  // A long one is cut, and the hook says to read it in full.
  writeFileSync(join(dir, "athlete/limits.yaml"), `${bad}${"# padding line for a long file\n".repeat(80)}`);
  assert.match(hook(dir), /Limits cut at 2,000 characters: Read athlete\/limits\.md and athlete\/limits\.yaml in full before any plan\./);
});

test("freshness: a change to limits.md or coach.yaml after post means post again", () => {
  const dir = instance();
  writeFileSync(join(dir, "athlete/limits.md"), TEMPLATE);
  const before = Date.now() - 60_000;
  assert.deepEqual(changedSince(dir, TODAY, before).sort(), ["athlete/limits.md", "coach.yaml"]);
  assert.deepEqual(changedSince(dir, TODAY, Date.now() + 60_000), []);
});

// ---------- the pain threshold ----------

test("pain_threshold in coach.yaml: absent is 4; a custom value; 0 is allowed; 11 and \"high\" are refused", () => {
  const raw = (th: unknown) => ({ ...(parse(readFileSync(join(REPO, "coach.example.yaml"), "utf8")) as Record<string, unknown>), thresholds: th });
  assert.deepEqual(painThreshold("/nonexistent", validateConfig(raw({}))), { value: 4, source: "default" });
  assert.deepEqual(painThreshold("/nonexistent", validateConfig(raw({ pain_threshold: 3 }))), { value: 3, source: "coach.yaml" });
  assert.deepEqual(painThreshold("/nonexistent", validateConfig(raw({ pain_threshold: 0 }))), { value: 0, source: "coach.yaml" });
  assert.throws(() => validateConfig(raw({ pain_threshold: 11 })), /thresholds\.pain_threshold: must be a number at least 0 and at most 10, got 11/);
  assert.throws(() => validateConfig(raw({ pain_threshold: "high" })), /thresholds\.pain_threshold: must be a number/);
  // config-check says the same for a coach.yaml on disk.
  const dir = instance((y) => y.replace("pain_threshold: 4", "pain_threshold: 11"));
  const r = cli(["config-check", "--root", dir]);
  assert.equal(r.code, 1);
  assert.match(JSON.stringify(r.json), /pain_threshold/);
});

test("the legacy read order: coach.yaml, else the old limits.yaml (0 to 10), else 4", () => {
  const dir = instance(NO_THRESHOLD);
  const cfgOf = (th: Record<string, unknown>) => ({ thresholds: th }) as never;
  writeFileSync(join(dir, "athlete/limits.yaml"), oldYaml(3));
  assert.deepEqual(painThreshold(dir, cfgOf({})), { value: 3, source: "athlete/limits.yaml" });
  assert.deepEqual(painThreshold(dir, cfgOf({ pain_threshold: 5 })), { value: 5, source: "coach.yaml" });
  writeFileSync(join(dir, "athlete/limits.yaml"), oldYaml(0));
  assert.deepEqual(painThreshold(dir, cfgOf({})), { value: 0, source: "athlete/limits.yaml" });
  writeFileSync(join(dir, "athlete/limits.yaml"), "version: 1\npain_threshold: 12\nlimits: []\n");
  assert.deepEqual(painThreshold(dir, cfgOf({})), { value: 4, source: "default" });
  rmSync(join(dir, "athlete/limits.yaml"));
  assert.deepEqual(painThreshold(dir, cfgOf({})), { value: 4, source: "default" });
});

test("pain routing, reader 1 (the check-in): checkin prints the threshold and the pain entries at or above it", () => {
  const dir = instance((y) => y.replace("pain_threshold: 4", "pain_threshold: 3"));
  const r = cli(["checkin", "--date", TODAY, "--now", NOW, "--pain", "left-knee:3,elbow:2", "--root", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.pain_threshold, { value: 3, source: "coach.yaml" });
  assert.deepEqual(r.json.pain_to_safety, [{ region: "left-knee", score: 3 }]);
  const d = instance();
  const q = cli(["checkin", "--date", TODAY, "--now", NOW, "--pain", "left-knee:3", "--root", d]);
  assert.deepEqual(q.json.pain_to_safety, [], "the default 4: a 3 is noted, not routed");
  // Before the migration: the old file's 3 routes a 3.
  const old = instance(NO_THRESHOLD);
  writeFileSync(join(old, "athlete/limits.yaml"), oldYaml(3));
  assert.deepEqual(cli(["checkin", "--date", TODAY, "--now", NOW, "--pain", "left-knee:3", "--root", old]).json.pain_to_safety, [{ region: "left-knee", score: 3 }]);
});

test("pain routing, reader 2 (today): an unattended pre on a copy that updated but has not migrated: the old file's threshold of 3 routes a 3, as 0.2.8 did", () => {
  const dir = instance(NO_THRESHOLD);
  writeFileSync(join(dir, "athlete/limits.yaml"), oldYaml(3, BAN));
  writeJson(dir, `athlete/signals/${TODAY}.json`, { version: 1, date: TODAY, source: "chat", submitted_at: "2026-10-14T06:41:00-07:00", checkin: { overall: 3, pain: [{ region: "left-knee", score: 3 }, { region: "elbow", score: 2 }] } });
  const p = pre(dir, { COACH_UNATTENDED: "1" });
  assert.equal(p.code, 0, p.stderr);
  assert.deepEqual(p.json.checkin_pain.map((x: any) => [x.region, x.score]), [["left-knee", 3]]);
  assert.deepEqual(p.json.pain_threshold, { value: 3, source: "athlete/limits.yaml" });
  // After the migration, coach.yaml holds the same 3.
  const r = repo(oldYaml(3, BAN));
  writeJson(r, `athlete/signals/${TODAY}.json`, { version: 1, date: TODAY, source: "chat", submitted_at: "2026-10-14T06:41:00-07:00", checkin: { overall: 3, pain: [{ region: "left-knee", score: 3 }] } });
  git(r, "add", "athlete/signals");
  git(r, "commit", "-q", "-m", "check-in");
  symlinkMethods(r);
  migrate(r);
  const q = pre(r, { COACH_UNATTENDED: "1" }).json;
  assert.deepEqual(q.pain_threshold, { value: 3, source: "coach.yaml" });
  assert.deepEqual(q.checkin_pain.map((x: any) => [x.region, x.score]), [["left-knee", 3]]);
});
function symlinkMethods(dir: string): void {
  spawnSync("ln", ["-s", join(REPO, "methods"), join(dir, "methods")]);
}

// ---------- load-under ----------

test("load-under: converts without rounding, then rounds down to the plate step; never above the limit's load", () => {
  assert.deepEqual(loadUnder("50", "lbs", "kg"), { weight: 22.5, unit: "kg", step: 2.5 }); // 22.68 kg
  assert.deepEqual(loadUnder("22.5", "kg", "lbs"), { weight: 45, unit: "lbs", step: 5 }); // 49.6 lb
  assert.deepEqual(loadUnder("3", "lbs", "lbs"), { weight: 0, unit: "lbs", step: 5 }, "below one step: body weight only");
  assert.deepEqual(loadUnder("0", "kg", "kg"), { weight: 0, unit: "kg", step: 2.5 });
  assert.deepEqual(loadUnder("135", "lbs", "lbs"), { weight: 135, unit: "lbs", step: 5 }, "already on a step");
  assert.deepEqual(loadUnder("60", "kg", "kg"), { weight: 60, unit: "kg", step: 2.5 });
  assert.deepEqual(loadUnder("100", "kg", "lbs"), { weight: 220, unit: "lbs", step: 5 }); // 220.46 lb
  for (const [w, u, t] of [["-5", "lbs", "kg"], ["heavy", "lbs", "kg"], ["50", "pounds", "kg"], ["50", "lbs", "stone"]]) assert.throws(() => loadUnder(w, u, t), /usage: load-under/);
  const r = cli(["load-under", "--weight", "50", "--unit", "lbs", "--to", "kg"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { weight: 22.5, unit: "kg", step: 2.5 });
  assert.equal(cli(["load-under", "--weight", "50", "--unit", "lbs"]).code, 2);
});

// ---------- the converter, field by field ----------

test("the converter keeps every field: region, rule, movements (whole scope), named exercises, exceptions with their ids, precedence, numbers, building back, source, date, note", () => {
  const old = parseOldLimits(oldYaml(4, BAN, CAP_LONG, BOTH, LOAD_KG, NO_NOTE));
  const [ban, cap, both, kg, nonote] = old.limits.map((l) => renderLimit(l, TAX));
  const has = (line: string, ...parts: string[]) => parts.forEach((p) => assert.ok(line.includes(p), `${p}\n  in: ${line}`));
  has(ban, "- Left shoulder: avoid for now: overhead pressing (any exercise like these: ", "; and dips (any exercise like these: ", "Also avoid these exercises: Arnold Press.", "Note: no pressing overhead for now.", "(since 2026-09-02; you set it)");
  has(cap, "- Right knee: at most 8 sets a week of squats (any exercise like these: ", "lunges (any exercise like these: ", "leg presses (any exercise like these: ", "counted together (warm-up sets do not count).", "Building back slowly.", "These exact exercises do not count: Box Squat, Barbell_Box_Squat (exercise id), Spanish Squat, Wall Sit, Terminal Knee Extension, Step Down and Belt Squat.", "Only these exact exercises: another exercise with the same name that loads squats, lunges and leg presses still counts.", "Note: stop a set when the knee aches.", "(since 2026-09-10; you set it)");
  has(both, "- Low back: avoid for now: hinges (any exercise like these: ", "Also avoid these exercises: Good Morning.", "These exact exercises do not count: Good Morning and Cable Pull Through.", "An exercise this limit names (Good Morning) still counts, even when this list also names it, by the same name, another name or its exercise id.");
  has(kg, "- Low back: at most 60 kg on every set of hinges (any exercise like these: ", "warm-ups included.", "(since 2026-08-30; from your clinician)");
  assert.equal(nonote, "- Right elbow: avoid these exercises for now: Skull Crusher and Close Grip Chin-Up. (since 2026-10-01; you set it)");
  // A cap with both numbers keeps both.
  const two = parseOldLimits(oldYaml(4, "  - { id: L-006, region: shoulder, rule: cap, patterns: [horizontal_push], max_sets_per_week: 6, max_load: { value: 95, unit: lbs }, source: athlete, since: 2026-10-02 }\n")).limits[0];
  has(renderLimit(two, TAX), "- Shoulder: at most 6 sets a week of flat pressing (any exercise like these: ", "counted together (warm-up sets do not count). Every set of these at most 95 lbs, warm-ups included.");
  // Deterministic: the same yaml, the same text.
  const y = oldYaml(4, BAN, CAP_LONG);
  assert.equal(expectedLimitsMd(null, parseOldLimits(y), sha256(y), TAX), expectedLimitsMd(null, parseOldLimits(y), sha256(y), TAX));
  const file = expectedLimitsMd(null, parseOldLimits(y), sha256(y), TAX);
  assert.equal(MARKER_RE.exec(file)?.[1], sha256(y));
  assert.match(file, /\(old ids L-001, L-002\) -->/);
  assert.equal(limitsBody(file), [ban, cap].join("\n"));
});

// ---------- migrate-limits: states ----------

test("migrate: yaml only → limits.md in plain words, pain_threshold in coach.yaml, the yaml removed, one commit; the backup kept; a second run does nothing", () => {
  const yaml = oldYaml(3, BAN, CAP_LONG, BOTH, LOAD_KG, NO_NOTE);
  const dir = repo(yaml);
  const head = git(dir, "rev-parse", "HEAD");
  const r = migrate(dir);
  assert.equal(r.status, "migrated");
  assert.equal(r.limits, 5);
  assert.deepEqual(r.pain_threshold, { value: 3, old: 3 });
  assert.equal(git(dir, "rev-list", "--count", `${head}..HEAD`), "1", "one commit");
  assert.equal(git(dir, "log", "-1", "--format=%s"), COMMIT_MESSAGE);
  assert.deepEqual(git(dir, "show", "--name-status", "--format=", "HEAD").split("\n").sort(), ["A\tathlete/limits.md", "D\tathlete/limits.yaml", "M\tcoach.yaml"]);
  assert.equal(existsSync(join(dir, "athlete/limits.yaml")), false);
  assert.equal(readFileSync(join(dir, BACKUP_FILE), "utf8"), yaml);
  assert.equal(status(dir), "", "a clean tree");
  const text = readFileSync(join(dir, "athlete/limits.md"), "utf8");
  assert.equal(text, expectedLimitsMd(null, parseOldLimits(yaml), sha256(yaml), TAX));
  assert.match(readFileSync(join(dir, "coach.yaml"), "utf8"), /^thresholds:\n  pain_threshold: 3$/m);
  assert.equal(validateConfig(parse(readFileSync(join(dir, "coach.yaml"), "utf8"))).thresholds.pain_threshold, 3);
  assert.equal(r.text, limitsBody(text));
  // A second run: nothing to do, nothing written.
  const again = migrate(dir);
  assert.equal(again.status, "nothing_to_do");
  assert.equal(git(dir, "rev-list", "--count", `${head}..HEAD`), "1");
});

test("migrate: an empty old list gives None yet; pain_threshold 0 is kept as 0", () => {
  const dir = repo(oldYaml(0));
  migrate(dir);
  assert.equal(limitsBody(readFileSync(join(dir, "athlete/limits.md"), "utf8")), "None yet.");
  assert.match(readFileSync(join(dir, "coach.yaml"), "utf8"), /pain_threshold: 0/);
});

test("migrate: coach.yaml already has a different pain_threshold: it is kept, and the commit message records the old one", () => {
  const dir = repo(oldYaml(3, BAN), { cfg: (y) => y });
  const r = migrate(dir);
  assert.deepEqual(r.pain_threshold, { value: 4, old: 3, kept_coach_yaml: 4 });
  assert.match(git(dir, "log", "-1", "--format=%B"), /coach\.yaml thresholds\.pain_threshold 4 kept; the old limits file had 3\./);
  assert.deepEqual(git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["athlete/limits.md", "athlete/limits.yaml"]);
});

test("migrate: limits.md the athlete wrote (no marker) keeps every line; the converted lines go under From your old limits file", () => {
  const own = md("- Neck: no shrugs. (since 2026-10-10)\n");
  const yaml = oldYaml(4, LOAD_KG);
  const dir = repo(yaml, { limitsMd: own });
  migrate(dir);
  const text = readFileSync(join(dir, "athlete/limits.md"), "utf8");
  assert.ok(text.startsWith(own.trimEnd()), text);
  assert.ok(text.includes(`\n\n## From your old limits file\n\n<!-- coach: converted from athlete/limits.yaml sha256:${sha256(yaml)} (old ids L-004) -->\n${renderLimit(parseOldLimits(yaml).limits[0], TAX)}\n`), text);
  assert.equal(status(dir), "");
});

test("migrate: limits.md only → nothing to do", () => {
  const dir = repo(null, { limitsMd: TEMPLATE });
  assert.equal(migrate(dir).status, "nothing_to_do");
  assert.equal(status(dir), "");
});

test("migrate: a malformed yaml stops with an error that names the problem; the file is kept; nothing is written", () => {
  const bad = "version: 1\npain_threshold: 4\nlimits:\n  - { id: L-001, region: knee, rule: cap, patterns: [squat], source: athlete, since: 2026-10-01 }\n";
  const dir = repo(bad);
  assert.throws(() => migrate(dir), /LIMITS_INVALID|cannot be converted:\n  - limits\[0\]: a cap needs max_load or max_sets_per_week/);
  assert.equal(readFileSync(join(dir, "athlete/limits.yaml"), "utf8"), bad);
  assert.equal(existsSync(join(dir, "athlete/limits.md")), false);
  assert.equal(status(dir), "");
  const r = cli(["migrate-limits", "--root", dir]);
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, "LIMITS_INVALID");
});

test("migrate: a dirty athlete/ or coach.yaml that is not its own is refused, with the files named; nothing is written", () => {
  const dir = repo(oldYaml(4, BAN));
  writeFileSync(join(dir, "athlete/brief.md"), "# Brief\n\nchanged\n");
  assert.throws(() => migrate(dir), /MIGRATE_REFUSED|uncommitted changes in athlete\/brief\.md/);
  assert.equal(existsSync(join(dir, "athlete/limits.md")), false);
  git(dir, "checkout", "--", "athlete/brief.md");
  writeFileSync(join(dir, "athlete/limits.yaml"), oldYaml(4, BAN, NO_NOTE));
  assert.throws(() => migrate(dir), /uncommitted changes in athlete\/limits\.yaml/);
  git(dir, "checkout", "--", "athlete/limits.yaml");
  writeFileSync(join(dir, "coach.yaml"), readFileSync(join(dir, "coach.yaml"), "utf8").replace("units: lbs", "units: kg"));
  assert.throws(() => migrate(dir), /uncommitted changes in coach\.yaml/);
  git(dir, "checkout", "--", "coach.yaml");
  assert.equal(migrate(dir).status, "migrated");
});

test("migrate: unattended runs never migrate", () => {
  const dir = repo(oldYaml(4, BAN));
  assert.throws(() => migrateLimits({ root: dir, env: { COACH_UNATTENDED: "1" } }), /live session only/);
  const r = cli(["migrate-limits", "--root", dir], { env: { CLAUDE_CODE_REMOTE: "true" } });
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, "UNATTENDED");
  assert.equal(status(dir), "");
});

// ---------- migrate-limits: interrupted runs and failures ----------

test("migrate: an interrupted run resumes: limits.md written (its marker, its content) and coach.yaml changed, the yaml still there → finish", () => {
  const yaml = oldYaml(3, BAN, CAP_LONG);
  const dir = repo(yaml);
  // What a run killed after its writes leaves behind.
  writeFileSync(join(dir, "athlete/limits.md"), expectedLimitsMd(null, parseOldLimits(yaml), sha256(yaml), TAX));
  writeFileSync(join(dir, "coach.yaml"), expectedConfig(readFileSync(join(dir, "coach.yaml"), "utf8"), 3).text);
  const r = migrate(dir);
  assert.equal(r.status, "migrated");
  assert.equal(status(dir), "");
  assert.equal(existsSync(join(dir, "athlete/limits.yaml")), false);
  // Killed after `git rm --cached` was staged: the yaml is staged out, HEAD still has it.
  const d2 = repo(yaml);
  writeFileSync(join(d2, "athlete/limits.md"), expectedLimitsMd(null, parseOldLimits(yaml), sha256(yaml), TAX));
  git(d2, "rm", "-q", "--cached", "athlete/limits.yaml");
  rmSync(join(d2, "athlete/limits.yaml"));
  assert.equal(migrate(d2).status, "migrated");
  assert.ok(!headTree(d2).includes("athlete/limits.yaml"));
  // Killed after the commit, before the file left the disk.
  const d3 = repo(yaml);
  migrate(d3);
  writeFileSync(join(d3, "athlete/limits.yaml"), yaml);
  const r3 = migrate(d3);
  assert.equal(r3.status, "migrated");
  assert.match(r3.reason ?? "", /earlier run committed/);
  assert.equal(existsSync(join(d3, "athlete/limits.yaml")), false);
  assert.equal(status(d3), "");
});

test("migrate: limits.md with the marker but other content is not its own: refused", () => {
  const yaml = oldYaml(3, BAN);
  const dir = repo(yaml);
  writeFileSync(join(dir, "athlete/limits.md"), `${expectedLimitsMd(null, parseOldLimits(yaml), sha256(yaml), TAX)}- an extra line\n`);
  assert.throws(() => migrate(dir), /uncommitted changes in athlete\/limits\.md/);
});

for (const step of ["backup", "write-limits", "rename-limits", "write-config", "rename-config", "stage", "commit"] as MigrateStep[]) {
  test(`migrate: a failure at ${step} leaves the tree as HEAD has it (the yaml back, no new limits.md, coach.yaml unchanged); the next run succeeds`, () => {
    const yaml = oldYaml(3, BAN, LOAD_KG);
    for (const own of [false, true]) {
      const dir = repo(yaml, own ? { limitsMd: md("- Neck: no shrugs. (since 2026-10-10)\n") } : {});
      const head = git(dir, "rev-parse", "HEAD");
      const mdBefore = own ? readFileSync(join(dir, "athlete/limits.md"), "utf8") : null;
      assert.throws(() => migrate(dir, step), step === "backup" ? /test failure at backup/ : /MIGRATE_FAILED|did not finish/);
      assert.equal(git(dir, "rev-parse", "HEAD"), head, "no commit");
      assert.equal(readFileSync(join(dir, "athlete/limits.yaml"), "utf8"), yaml);
      assert.equal(existsSync(join(dir, "athlete/limits.md")) ? readFileSync(join(dir, "athlete/limits.md"), "utf8") : null, mdBefore);
      assert.equal(status(dir), "", `${step}: a clean tree (own: ${own})`);
      assert.equal(migrate(dir).status, "migrated");
      assert.equal(status(dir), "");
    }
  });
}

test("migrate: a commit that git refuses (a failing pre-commit hook) rolls back, says why, and keeps the backup", () => {
  const yaml = oldYaml(3, BAN);
  const dir = repo(yaml);
  mkdirSync(join(dir, ".git/hooks"), { recursive: true });
  writeFileSync(join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\necho 'refused by a test hook' >&2\nexit 1\n", { mode: 0o755 });
  assert.throws(() => migrate(dir), /did not finish \(.*refused by a test hook.*\); your old limits file is back as it was/);
  assert.equal(readFileSync(join(dir, "athlete/limits.yaml"), "utf8"), yaml);
  assert.equal(existsSync(join(dir, "athlete/limits.md")), false);
  assert.equal(status(dir), "");
  assert.equal(readFileSync(join(dir, BACKUP_FILE), "utf8"), yaml);
  rmSync(join(dir, ".git/hooks/pre-commit"));
  assert.equal(migrate(dir).status, "migrated");
});

test("migrate-limits through the CLI: JSON with the new text; init-athlete starts limits.md; no limits.yaml left in the starting files", () => {
  const dir = repo(oldYaml(4, NO_NOTE));
  const r = spawnSync(process.execPath, [join(REPO, "engine/cli.ts"), "migrate-limits", "--root", dir], { encoding: "utf8", env: { ...CLEAN_ENV, ...GIT_ENV } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.status, "migrated");
  assert.equal(j.text, "- Right elbow: avoid these exercises for now: Skull Crusher and Close Grip Chin-Up. (since 2026-10-01; you set it)");
  assert.deepEqual(readdirSync(join(REPO, "templates/athlete")).sort(), ["baselines.json", "block.yaml", "brief.md", "limits.md"]);
});

// ---------- the language rule ----------

/** The engine's limit terms the athlete never hears (unless the athlete said them). */
const ENGINE_TERMS = /\b(hard sets?|caps?|capped|allow list|patterns?|build_back|max_load|max_sets_per_week)\b|\bL-\d{3}\b/i;

/** The quoted text a skill gives the athlete: report lines, questions and option labels. Log lines, commit messages and code are not. */
function athleteQuotes(text: string): string[] {
  return [...text.matchAll(/"([^"\n]{3,})"/g)]
    .map((m) => m[1])
    .filter((q) => !q.startsWith("- ") && !/^<[^>]+>$/.test(q) && !/`|node engine|--[a-z]|^[a-z_-]+:\s|<[a-z_ ]+>:/.test(q))
    .filter((q) => !ENGINE_TERMS.test(q) || q.replace(ENGINE_TERMS, "").trim() !== "" );
}

test("the language rule: no quoted report or question text in a skill uses an engine limit term; the converter's lines never do", () => {
  const dir = join(REPO, ".claude/skills");
  const found: string[] = [];
  let n = 0;
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---/, "");
    for (const q of athleteQuotes(text)) {
      n++;
      if (ENGINE_TERMS.test(q)) found.push(`${name}: "${q}"`);
    }
  }
  assert.ok(n > 100, `quoted strings checked: ${n}`);
  assert.deepEqual(found, []);
  // The converter: every fixture shape, in plain words.
  for (const l of parseOldLimits(oldYaml(4, BAN, CAP_LONG, BOTH, LOAD_KG, NO_NOTE)).limits) assert.doesNotMatch(renderLimit(l, TAX), ENGINE_TERMS, l.id);
  // The template and the carriers.
  assert.doesNotMatch(TEMPLATE, ENGINE_TERMS);
});

// ---------- fix round W3b (the cross-model diff review: 6 P1, 1 P2) ----------

test("W3b 1: a cut text names every file it came from; a cut old yaml says Read athlete/limits.yaml in full", () => {
  // Only the old file, long enough that a ban comes after the cut.
  const many = Array.from({ length: 6 }, (_, i) => `  - { id: L-00${i + 1}, region: hip, rule: cap, patterns: [hip_thrust, hip_abduction], max_sets_per_week: ${i + 4}, source: athlete, since: 2026-09-0${i + 1} }\n`);
  const late = "  - { id: L-009, region: right-shoulder, rule: ban, patterns: [overhead_press], source: athlete, since: 2026-10-01 }\n";
  const dir = instance(NO_THRESHOLD);
  writeFileSync(join(dir, "athlete/limits.yaml"), oldYaml(4, ...many, late));
  const p = pre(dir).json;
  assert.equal(p.limits_text_truncated, true);
  assert.deepEqual(p.limits_sources, ["athlete/limits.yaml"]);
  assert.ok(!(p.limits_text as string).includes("(since 2026-10-01; you set it)"), "the late ban is after the cut");
  assert.match(hook(dir), /Limits cut at 2,000 characters: Read athlete\/limits\.yaml in full before any plan\./);
  // Both files: both named.
  writeFileSync(join(dir, "athlete/limits.md"), md("- Neck: no shrugs. (since 2026-10-10)\n"));
  assert.deepEqual(pre(dir).json.limits_sources, ["athlete/limits.md", "athlete/limits.yaml"]);
  assert.match(hook(dir), /Read athlete\/limits\.md and athlete\/limits\.yaml in full before any plan\./);
});

test("W3b 2: the legacy pain threshold is read as YAML: flow style, 3e0, a comment; the same order and the 0 to 10 range", () => {
  const dir = instance(NO_THRESHOLD);
  const cfgOf = (th: Record<string, unknown>) => ({ thresholds: th }) as never;
  for (const [text, want] of [["{version: 1, pain_threshold: 3, limits: []}\n", 3], ["version: 1\npain_threshold: 3e0\nlimits: []\n", 3], ["version: 1\npain_threshold: 2.5 # lower\nlimits: []\n", 2.5], ['{"version": 1, "pain_threshold": 0, "limits": []}\n', 0]] as const) {
    writeFileSync(join(dir, "athlete/limits.yaml"), text);
    assert.deepEqual(painThreshold(dir, cfgOf({})), { value: want, source: "athlete/limits.yaml" }, text);
    assert.deepEqual(painThreshold(dir, cfgOf({ pain_threshold: 6 })), { value: 6, source: "coach.yaml" });
  }
  for (const text of ["{version: 1, pain_threshold: 11, limits: []}\n", "version: 1\npain_threshold: high\n", "limits: [\n"]) {
    writeFileSync(join(dir, "athlete/limits.yaml"), text);
    assert.deepEqual(painThreshold(dir, cfgOf({})), { value: 4, source: "default" }, text);
  }
  // Both pain readers: the check-in and today's pre.
  writeFileSync(join(dir, "athlete/limits.yaml"), "{version: 1, pain_threshold: 3, limits: []}\n");
  assert.deepEqual(cli(["checkin", "--date", TODAY, "--now", NOW, "--pain", "left-knee:3", "--root", dir]).json.pain_to_safety, [{ region: "left-knee", score: 3 }]);
  assert.deepEqual(pre(dir).json.pain_threshold, { value: 3, source: "athlete/limits.yaml" });
});

test("W3b 3: each movement's words hold every taxonomy member of its pattern (jumps and throws cover medicine ball slams; trunk flexion covers hanging leg raises)", () => {
  for (const p of Object.keys(TAX.patterns)) {
    const words = movementWords(p, TAX);
    for (const m of patternMembers(p, TAX)) assert.ok(words.includes(m), `${p}: ${m}`);
    for (const [k, ps] of Object.entries(TAX.keywords)) if (ps.includes(p)) assert.ok(words.includes(k), `${p}: keyword ${k}`);
    for (const [k, ps] of Object.entries(TAX.exercises)) if (ps.includes(p)) assert.ok(words.includes(k), `${p}: exercise ${k}`);
  }
  for (const [name, pattern] of [["Medicine Ball Slam", "plyometric"], ["Hanging Leg Raise", "loaded_spinal_flexion"]] as const) {
    assert.ok(classify({ name }, TAX).patterns.includes(pattern), `${name} is ${pattern} in the taxonomy`);
    const line = renderLimit(parseOldLimits(oldYaml(4, `  - { id: L-001, region: low-back, rule: ban, patterns: [${pattern}], source: athlete, since: 2026-10-01 }\n`)).limits[0], TAX);
    const hit = Object.keys(TAX.keywords).filter((k) => TAX.keywords[k].includes(pattern) && normalizeName(name).includes(k));
    assert.ok(hit.length > 0 && hit.every((k) => line.includes(k)), `${name}: ${hit.join(", ")} in ${line.slice(0, 200)}`);
  }
});

test("W3b 4: the explicit-exercise rule is said whenever the limit names exercises and has exceptions, across names and ids", () => {
  const l = parseOldLimits(oldYaml(4, "  - { id: L-001, region: chest, rule: ban, patterns: [horizontal_push], exercises: [Bench Press], allow: [barbell_bench_press, Push Up], source: athlete, since: 2026-10-01 }\n")).limits[0];
  const line = renderLimit(l, TAX);
  assert.ok(line.includes("An exercise this limit names (Bench Press) still counts, even when this list also names it, by the same name, another name or its exercise id."), line);
  assert.ok(line.includes("These exact exercises do not count: barbell_bench_press (exercise id) and Push Up."), line);
});

test("W3b 5: a marker never hides or deletes the old limits unless limits.md holds exactly their converted bullets", async () => {
  const yaml = oldYaml(4, "  - { id: L-001, region: knee, rule: ban, patterns: [squat], source: athlete, since: 2026-10-01 }\n");
  const old = parseOldLimits(yaml);
  const fake = `${md("")}${marker(sha256(yaml), old)}\nNone yet.\n`;
  // The carriers: the old ban is still carried.
  const dir = instance(NO_THRESHOLD);
  writeFileSync(join(dir, "athlete/limits.yaml"), yaml);
  writeFileSync(join(dir, "athlete/limits.md"), fake);
  const c = await limitsCarry(dir);
  assert.ok(c.text.includes("From your old limits file (not converted yet):") && c.text.includes("(since 2026-10-01; you set it)"), c.text);
  assert.deepEqual(c.sources, ["athlete/limits.md", "athlete/limits.yaml"]);
  // The real conversion does hide it.
  writeFileSync(join(dir, "athlete/limits.md"), expectedLimitsMd(null, old, sha256(yaml), TAX));
  assert.deepEqual((await limitsCarry(dir)).sources, ["athlete/limits.md"]);
  // The migration: a committed limits.md with only the marker is the athlete's file: the bullets are added, the yaml is removed only in that commit.
  const r = repo(yaml, { limitsMd: fake });
  assert.equal(migrate(r).status, "migrated");
  assert.ok(readFileSync(join(r, "athlete/limits.md"), "utf8").includes(renderLimit(old.limits[0], TAX)));
  // A committed fake marker and the yaml left on disk (untracked): never deleted, refused.
  const u = repo(null, { limitsMd: fake });
  writeFileSync(join(u, "athlete/limits.yaml"), yaml);
  assert.throws(() => migrate(u), /uncommitted changes in athlete\/limits\.yaml/);
  assert.equal(readFileSync(join(u, "athlete/limits.yaml"), "utf8"), yaml);
});

test("W3b 6: post and save compare the limits with what pre carried: a change means a full reread, and save refuses a change after post", () => {
  const dir = instance(NO_THRESHOLD);
  writeFileSync(join(dir, "athlete/limits.md"), md("- Neck: no shrugs. (since 2026-10-10)\n"));
  // Every file older than the fixed run time, so only the content check can see a change.
  const past = new Date(Date.parse(NOW) - 3_600_000);
  const age = () => ["athlete/limits.md", "athlete/limits.yaml", "coach.yaml"].forEach((f) => existsSync(join(dir, f)) && utimesSync(join(dir, f), past, past));
  age();
  const p = pre(dir).json;
  assert.match(p.limits_fingerprint, /^[0-9a-f]{64}$/);
  const post = () => cli(["today-brief", "--stage", "post", "--now", NOW, "--root", dir], { env: { CLAUDE_CODE_SESSION_ID: SESSION } }).json;
  assert.deepEqual(post().limits_freshness, { fingerprint: p.limits_fingerprint, changed_since_pre: false });
  // The old file appears after pre (no mtime check covers it): post says reread both.
  writeFileSync(join(dir, "athlete/limits.yaml"), oldYaml(4, "  - { id: L-001, region: knee, rule: ban, patterns: [squat], source: athlete, since: 2026-10-01 }\n"));
  age();
  const q = post().limits_freshness;
  assert.equal(q.changed_since_pre, true);
  assert.deepEqual(q.reread, ["athlete/limits.md", "athlete/limits.yaml"]);
  // Save: post saw the new sources; a change after post refuses.
  const opts = { now: NOW, timezone: "America/Los_Angeles", session_id: SESSION };
  assert.doesNotThrow(() => postForSave(dir, p.run_id, opts));
  writeFileSync(join(dir, "athlete/limits.yaml"), oldYaml(4));
  age();
  assert.throws(() => postForSave(dir, p.run_id, opts), /the limits changed after the post result/);
});

test("W3b 7: a failed rename inside the atomic write leaves no temp file; rollback is complete and the retry succeeds", () => {
  for (const step of ["rename-limits", "rename-config"] as MigrateStep[]) {
    const dir = repo(oldYaml(3, BAN));
    assert.throws(() => migrate(dir, step), /did not finish \(test failure at the rename of/);
    const tmp = (rel: string) => readdirSync(join(dir, rel)).filter((f) => f.includes(".tmp-"));
    assert.deepEqual([...tmp("athlete"), ...tmp(".")], [], step);
    assert.equal(status(dir), "", step);
    assert.equal(migrate(dir).status, "migrated", step);
  }
});

test("W3b 7b: a real rename failure (fs mocked, no test hook) inside the atomic write leaves no temp file and rolls back", async () => {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const dir = repo(oldYaml(3, BAN));
  const real = fs.renameSync;
  fs.renameSync = ((a: string, b: string) => {
    if (String(b).endsWith("athlete/limits.md")) throw new Error("simulated rename failure");
    return real(a, b);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => migrate(dir), /did not finish \(simulated rename failure\)/);
  } finally {
    fs.renameSync = real;
    syncBuiltinESMExports();
  }
  assert.deepEqual(readdirSync(join(dir, "athlete")).filter((f) => f.includes(".tmp-")), []);
  assert.equal(status(dir), "");
  assert.equal(migrate(dir).status, "migrated");
});

test("W3b confirmation 1: the converted bullets above the heading do not count; the old limits are still carried and the yaml is kept", async () => {
  const yaml = oldYaml(4, "  - { id: L-001, region: knee, rule: ban, patterns: [squat], source: athlete, since: 2026-10-01 }\n");
  const old = parseOldLimits(yaml);
  const above = `${marker(sha256(yaml), old)}\n${renderBullets(old, TAX)}\n${md("None yet.\n")}`;
  assert.equal(holdsConversion(above, old, sha256(yaml), TAX), false);
  const dir = instance(NO_THRESHOLD);
  writeFileSync(join(dir, "athlete/limits.yaml"), yaml);
  writeFileSync(join(dir, "athlete/limits.md"), above);
  const c = await limitsCarry(dir);
  assert.ok(c.text.includes("(since 2026-10-01; you set it)"), c.text);
  // The migration adds the bullets after the heading; the ban is in the carried text after it.
  const r = repo(yaml, { limitsMd: above });
  assert.equal(migrate(r).status, "migrated");
  assert.ok((await limitsCarry(r)).text.includes("(since 2026-10-01; you set it)"));
});

test("W3b confirmation 2: an untracked old file with a threshold coach.yaml does not have is refused and kept, never deleted", () => {
  const yaml = "{version: 1, pain_threshold: 3, limits: []}\n";
  const u = repo(null, { limitsMd: md("- Left knee: go easy. (since 2026-10-01)\n") });
  writeFileSync(join(u, "athlete/limits.yaml"), yaml);
  assert.throws(() => migrate(u), /uncommitted changes in athlete\/limits\.yaml/);
  assert.equal(readFileSync(join(u, "athlete/limits.yaml"), "utf8"), yaml);
  assert.equal(painThreshold(u, null).value, 3);
});

test("W3b confirmation 3: the old file deleted on disk but still in HEAD, its limits not in limits.md: refused with the restore command, never nothing_to_do", () => {
  const yaml = oldYaml(4, "  - { id: L-001, region: knee, rule: ban, patterns: [squat], source: athlete, since: 2026-10-01 }\n");
  const old = parseOldLimits(yaml);
  const r = repo(yaml, { limitsMd: `${md("")}${marker(sha256(yaml), old)}\nNone yet.\n` });
  rmSync(join(r, "athlete/limits.yaml"));
  assert.throws(() => migrate(r), /deleted on disk but its limits are not in athlete\/limits\.md: put it back with git checkout HEAD -- athlete\/limits\.yaml/);
  // Also with no limits.md at all.
  const n = repo(yaml);
  rmSync(join(n, "athlete/limits.yaml"));
  assert.throws(() => migrate(n), /deleted on disk/);
});
