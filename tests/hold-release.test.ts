// P1 fix 2: accepted limits release a regional hold (hold clear --released-by-limits), and
// P1 fix 4: the read-only facts for the safety agent (limits schema, limits regions).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { clearHold, readHold, setHold } from "../engine/hold.ts";
import { validateLimits } from "../engine/limits.ts";
import { loadTaxonomy } from "../engine/taxonomy.ts";

const CLI = new URL("../engine/cli.ts", import.meta.url).pathname;
const NOW = "2026-10-14T07:00:00-07:00";
const PRESS = ["horizontal_push", "incline_push", "overhead_press"];
const tax = loadTaxonomy({ localPath: null });

const limit = (id: string, region: string, over: Record<string, unknown> = {}) => ({ id, region, rule: "cap", patterns: PRESS, max_sets_per_week: 4, source: "athlete", since: "2026-10-14", ...over });

function athleteRoot(limits: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "coach-release-"));
  mkdirSync(join(root, "athlete"));
  writeFileSync(join(root, "athlete/limits.yaml"), stringify({ version: 1, pain_threshold: 4, limits }));
  return root;
}

const env = {};
const release = (root: string) => clearHold(root, { approved: true, by: "user", now: NOW, env, releasedByLimits: true });
const shoulderHold = (root: string) => setHold(root, { reason: "left-shoulder right-shoulder 4/10 reported 2026-10-14", regions: ["left-shoulder", "right-shoulder"], now: NOW });

test("P1 fix 2: limits on both sides (or the parent region) release a shoulder hold", () => {
  for (const limits of [[limit("L-001", "left-shoulder"), limit("L-002", "right-shoulder")], [limit("L-001", "shoulder", { rule: "ban", max_sets_per_week: undefined })]]) {
    const root = athleteRoot(limits.map((l) => JSON.parse(JSON.stringify(l))));
    shoulderHold(root);
    const r = release(root);
    assert.equal(r.hold?.active, false);
    assert.equal(readHold(root)?.cleared_by, "user");
  }
});

test("P1 fix 2: the release is refused when a held region has no limit, or the limit restricts nothing there", () => {
  for (const limits of [[], [limit("L-001", "left-shoulder")], [limit("L-001", "left-shoulder"), limit("L-002", "right-shoulder", { patterns: ["squat"] })]]) {
    const root = athleteRoot(limits);
    shoulderHold(root);
    assert.throws(() => release(root), (e: Error & { code?: string }) => e.code === "HOLD_NOT_COVERED" && /right-shoulder/.test(e.message));
    assert.equal(readHold(root)?.active, true, "nothing changes");
  }
});

test("P1 fix 2: a systemic or urgent hold, or an urgent pending term, is never released by limits", () => {
  const both = [limit("L-001", "shoulder")];
  const systemic = athleteRoot(both);
  setHold(systemic, { reason: "dizziness reported 2026-10-14", now: NOW });
  assert.throws(() => release(systemic), /no regions/);
  const urgent = athleteRoot(both);
  setHold(urgent, { reason: "urgent warning sign reported 2026-10-14", regions: ["left-shoulder"], urgent: true, now: NOW });
  assert.throws(() => release(urgent), /urgent/);
  const pending = athleteRoot(both);
  shoulderHold(pending);
  writeFileSync(join(pending, "athlete/.safety-pending"), JSON.stringify({ at: NOW, terms: ["chest pain"], source: "prompt" }));
  assert.throws(() => release(pending), /urgent term is pending/);
  assert.equal(readHold(pending)?.active, true);
});

test("P1 fix 2: the CLI release still needs the interactive yes, and refuses with exit 1 when not covered", () => {
  const root = athleteRoot([limit("L-001", "left-shoulder")]);
  shoulderHold(root);
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDE_CODE_REMOTE" && k !== "COACH_UNATTENDED"));
    return spawnSync(process.execPath, [CLI, "hold", "clear", ...args, "--root", root], { encoding: "utf8", env: { ...clean, ...extraEnv } });
  };
  assert.equal(run(["--by", "user", "--released-by-limits"]).status, 3, "no --approved: exit 3");
  assert.equal(run(["--approved", "--by", "user", "--released-by-limits"], { COACH_UNATTENDED: "1" }).status, 3, "unattended: exit 3");
  const r = run(["--approved", "--by", "user", "--released-by-limits"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /HOLD_NOT_COVERED/);
  assert.equal(readHold(root)?.active, true);
});

test("P1 fix 4: limits schema gives one valid example per rule kind; limits regions lists regions and pattern loads", () => {
  const schema = JSON.parse(spawnSync(process.execPath, [CLI, "limits", "schema"], { encoding: "utf8" }).stdout);
  const examples = schema.examples as Record<string, unknown>[];
  validateLimits({ version: 1, pain_threshold: 4, limits: examples }, tax);
  assert.ok(examples.some((l) => l.rule === "ban"));
  assert.ok(examples.some((l) => l.rule === "cap" && typeof l.max_sets_per_week === "number"));
  assert.ok(examples.some((l) => l.rule === "cap" && typeof l.max_load === "object"));
  const regions = JSON.parse(spawnSync(process.execPath, [CLI, "limits", "regions", "--root", mkdtempSync(join(tmpdir(), "coach-regions-"))], { encoding: "utf8" }).stdout);
  assert.ok(regions.regions.includes("left-shoulder"));
  assert.deepEqual(regions.patterns.overhead_press.loads, ["shoulder", "elbow"]);
  assert.equal(regions.patterns.zone2_cardio.recovery, true);
  // The safety agent copies these facts; keep them in step with the engine.
  const agent = readFileSync(new URL("../.claude/agents/safety.md", import.meta.url), "utf8");
  for (const l of examples) assert.ok(agent.includes(`id: ${l.id}`) && agent.includes(`region: ${l.region}`), `the agent text shows ${l.id}`);
});

// ---------- P2 fixes 4 and 5 (the P1 review) ----------

test("P2 fix 4: a ban on an exercise covers a held region only when the exercise loads it", () => {
  const ban = (exercises: string[]) => [{ id: "L-001", region: "shoulder", rule: "ban", exercises, source: "athlete", since: "2026-10-14" }];
  for (const names of [["Leg Press"], ["No Such Exercise"]]) {
    const root = athleteRoot(ban(names));
    shoulderHold(root);
    assert.throws(() => release(root), (e: Error & { code?: string }) => e.code === "HOLD_NOT_COVERED" && /left-shoulder, right-shoulder/.test(e.message), names.join());
    assert.equal(readHold(root)?.active, true, "nothing changes");
  }
  const root = athleteRoot(ban(["Bench Press"]));
  shoulderHold(root);
  assert.equal(release(root).hold?.active, false);
});

test("P2 fix 5: the release refuses while any safety check is pending, and keeps the pending file and the hold", () => {
  const root = athleteRoot([limit("L-001", "shoulder", { rule: "ban", patterns: ["horizontal_push"], max_sets_per_week: undefined })]);
  shoulderHold(root);
  const pending = JSON.stringify({ at: NOW, terms: ["dizziness"], source: "prompt" });
  writeFileSync(join(root, "athlete/.safety-pending"), pending);
  assert.throws(() => release(root), (e: Error & { code?: string }) => e.code === "HOLD_NOT_COVERED" && /a safety check is pending .*dizziness/.test(e.message));
  assert.equal(readHold(root)?.active, true);
  assert.equal(readFileSync(join(root, "athlete/.safety-pending"), "utf8"), pending);
});

test("P2 fix 2: a hold with an unknown region id is never released by limits", () => {
  const root = athleteRoot([limit("L-001", "shoulder")]);
  writeFileSync(join(root, "athlete/hold.yaml"), "active: true\nset_at: '2026-10-14T07:00:00-07:00'\nreason: review fixture\nregions: [shoulders]\nset_by: safety-agent\n");
  assert.throws(() => release(root), /unknown region id \(shoulders\)/);
  assert.equal(readHold(root)?.active, true);
});
