import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { lintPack, sourceKeys, weeklySetsPerMuscle, FALLBACK_PATTERNS } from "./lint-methods.ts";
import { parseRules, parseTemplate, scaledSets } from "./methods.ts";
import { sharedRuns, stripCitations, words } from "../scripts/overlap-check.ts";

const PACK = fileURLToPath(new URL("../methods/nine-adaptations", import.meta.url));
const NO_TAXONOMY = join(tmpdir(), "coach-harness-no-taxonomy.yaml"); // never created: fallback only

const SOURCES = `| key | title | URL | date | notes |
|---|---|---|---|---|
| S1 | A talk | https://example.com/talk | 2023-01-01 | test |
`;

const RULES = `pack: test
version: 1
rules:
  - id: NA-TST-001
    text: "Volume cap."
    kind: sourced
    severity: hard
    source: { ref: S1, at: "00:10:00", precision: exact }
    check: { type: weekly_volume_increase_max, value: 0.10 }
  - id: NA-TST-002
    text: "Sets per muscle."
    kind: sourced
    severity: soft
    source: { ref: S1, at: "00:20:00" }
    check: { type: weekly_sets_per_muscle_range, value: [10, 20] }
`;

const PROSE = "Cap volume [NA-TST-001]. Keep sets in range [NA-TST-002].\n";

// One day, chest only: 10 hypertrophy sets of horizontal_push (chest, triceps).
function template(sets: number, emphasis = "{}"): string {
  return `pack: test
version: 1
name: one-day
days: 1
week:
  - day: 1
    focus: "Push"
    slots:
      - { pattern: horizontal_push, adaptation: hypertrophy, sets: ${sets}, reps: [8, 12], rest_s: 120 }
emphasis:
  all-around: {}
  strength: {}
  hypertrophy: ${emphasis}
  endurance: {}
  general-health: { hypertrophy: 0.5 }
`;
}

function fixture(over: { rules?: string; prose?: string; sources?: string; tpl?: string; extraMd?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-"));
  mkdirSync(join(dir, "principles"));
  mkdirSync(join(dir, "templates"));
  writeFileSync(join(dir, "rules.yaml"), over.rules ?? RULES);
  writeFileSync(join(dir, "principles", "01-test.md"), over.prose ?? PROSE);
  writeFileSync(join(dir, "sources.md"), over.sources ?? SOURCES);
  writeFileSync(join(dir, "templates", "1-day.yaml"), over.tpl ?? template(12));
  if (over.extraMd) writeFileSync(join(dir, "METHOD.md"), over.extraMd);
  return dir;
}

function lint(dir: string) {
  try {
    return lintPack(dir, { taxonomyPath: NO_TAXONOMY });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the nine-adaptations pack passes the lint", () => {
  const res = lintPack(PACK);
  assert.deepEqual(res.errors, []);
});

test("the nine-adaptations pack has 30-55 rules with the required checks", () => {
  const res = lintPack(PACK);
  assert.equal(res.errors.length, 0);
  const rules = parseRules(parse(readFileSync(join(PACK, "rules.yaml"), "utf8")));
  assert.ok(rules.rules.length >= 30 && rules.rules.length <= 55, `got ${rules.rules.length}`);
  const byType = (t: string) => rules.rules.filter((r) => r.check?.type === t);
  assert.deepEqual(byType("weekly_volume_increase_max")[0].check!.value, 0.1);
  assert.equal(byType("weekly_volume_increase_max")[0].severity, "hard");
  assert.deepEqual(byType("weekly_sets_per_muscle_range")[0].check!.value, [10, 20]);
  assert.equal(byType("weekly_sets_per_muscle_range")[0].severity, "soft");
  assert.deepEqual(byType("deload_depth")[0].check!.value, { volume: 0.7, load: 0.7 });
  assert.equal(byType("deload_every_weeks").length, 1);
  assert.equal(byType("session_change_min_categories").length, 0, "retired with NA-REC-001");
  assert.equal(byType("program_change_min_categories")[0].check!.value, 3);
  assert.equal(byType("single_day_action")[0].check!.value, "note");
  assert.equal(byType("off_mornings_short_pattern")[0].check!.value, 3);
  assert.equal(byType("off_mornings_long_pattern")[0].check!.value, 7);
  assert.equal(byType("aversion_scale_max")[0].check!.value, 1);
  // A rule sourced without a checked timestamp says so: approximate, and no `at`.
  for (const r of rules.rules.filter((x) => x.source?.precision === "approximate")) assert.equal(r.source!.at, undefined, r.id);
  assert.equal(byType("session_minutes_max")[0].check!.value, 60);
  assert.equal(byType("top_set_jump_max").length, 1);
  assert.ok(byType("rep_range").some((r) => (r.check!.value as { adaptation: string }).adaptation === "strength"));
  assert.ok(byType("rest_range_s").some((r) => (r.check!.value as { adaptation: string }).adaptation === "strength"));
});

test("a valid fixture pack passes", () => {
  const res = lint(fixture());
  assert.deepEqual(res.errors, []);
});

test("an ID cited in prose but missing from rules.yaml is an error", () => {
  const res = lint(fixture({ prose: PROSE + "Also [NA-TST-099].\n" }));
  assert.ok(res.errors.some((e) => e.includes("NA-TST-099") && e.includes("not in rules.yaml")), res.errors.join("\n"));
});

test("an ID cited outside principles/ but missing from rules.yaml is an error", () => {
  const res = lint(fixture({ extraMd: "See [NA-TST-042].\n" }));
  assert.ok(res.errors.some((e) => e.startsWith("METHOD.md") && e.includes("NA-TST-042")), res.errors.join("\n"));
});

test("a rule never cited in principles/*.md is an error", () => {
  const res = lint(fixture({ prose: "Cap volume [NA-TST-001].\n" }));
  assert.ok(res.errors.some((e) => e.includes("NA-TST-002") && e.includes("not cited")), res.errors.join("\n"));
});

test("a sourced rule without a source is an error", () => {
  const rules = RULES.replace(`    source: { ref: S1, at: "00:20:00" }\n`, "");
  const res = lint(fixture({ rules }));
  assert.ok(res.errors.some((e) => e.includes("NA-TST-002") && e.includes("no source")), res.errors.join("\n"));
});

test("a policy rule without a source is fine", () => {
  const rules = RULES.replace(`    kind: sourced\n    severity: soft\n    source: { ref: S1, at: "00:20:00" }\n`, "    kind: policy\n    severity: soft\n");
  const res = lint(fixture({ rules }));
  assert.deepEqual(res.errors, []);
});

test("a source key missing from sources.md is an error", () => {
  const res = lint(fixture({ rules: RULES.replace("ref: S1, at: \"00:20:00\"", "ref: S9, at: \"00:20:00\"") }));
  assert.ok(res.errors.some((e) => e.includes("NA-TST-002") && e.includes("S9")), res.errors.join("\n"));
});

test("a source without an HH:MM:SS timestamp is rejected", () => {
  const res = lint(fixture({ rules: RULES.replace('at: "00:20:00"', 'at: "20 min"') }));
  assert.ok(res.errors.some((e) => e.includes("NA-TST-002") && e.includes("HH:MM:SS")), res.errors.join("\n"));
});

test("an unknown check type is an error", () => {
  const res = lint(fixture({ rules: RULES.replace("type: weekly_volume_increase_max", "type: monthly_vibes_max") }));
  assert.ok(res.errors.some((e) => e.includes("NA-TST-001") && e.includes("unknown check type monthly_vibes_max")), res.errors.join("\n"));
});

test("a known check type with a malformed value is an error", () => {
  const res = lint(fixture({ rules: RULES.replace("value: 0.10 }", "value: 10 }") }));
  assert.ok(res.errors.some((e) => e.includes("NA-TST-001") && e.includes("fraction")), res.errors.join("\n"));
});

test("template volume above the range under the hypertrophy emphasis is an error", () => {
  const res = lint(fixture({ tpl: template(12, "{ hypertrophy: 2 }") }));
  assert.ok(
    res.errors.some((e) => e.includes("[hypertrophy]") && e.includes("chest gets 24 sets") && e.includes("NA-TST-002")),
    res.errors.join("\n"),
  );
});

test("template volume below the range under the hypertrophy emphasis is an error", () => {
  const res = lint(fixture({ tpl: template(6) }));
  assert.ok(res.errors.some((e) => e.includes("[hypertrophy]") && e.includes("chest gets 6 sets")), res.errors.join("\n"));
});

test("template volume outside the range under other emphases is only a warning", () => {
  const res = lint(fixture({ tpl: template(12) })); // general-health halves it to 6
  assert.deepEqual(res.errors, []);
  assert.ok(res.warnings.some((w) => w.includes("[general-health]") && w.includes("chest gets 6 sets")), res.warnings.join("\n"));
});

test("an unknown pattern in a template is an error", () => {
  const res = lint(fixture({ tpl: template(12).replace("horizontal_push", "telekinesis") }));
  assert.ok(res.errors.some((e) => e.includes("unknown pattern telekinesis")), res.errors.join("\n"));
});

test("a taxonomy file overrides the fallback muscles", () => {
  const dir = fixture();
  const tax = join(dir, "movements.yaml");
  writeFileSync(tax, "version: 1\npatterns:\n  horizontal_push: { loads: [shoulder], muscles: [pecs] }\n");
  try {
    const res = lintPack(dir, { taxonomyPath: tax });
    const row = res.volume.find((v) => v.emphasis === "all-around")!;
    assert.deepEqual(row.sets, { pecs: 12 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scaledSets rounds to whole sets and keeps at least one", () => {
  const t = parseTemplate(parse(template(3, "{ hypertrophy: 1.5 }")));
  const slot = t.week[0].slots[0];
  assert.equal(scaledSets(slot, t, "hypertrophy"), 5); // 4.5 rounds up
  assert.equal(scaledSets(slot, t, "general-health"), 2); // 1.5 rounds up
  assert.equal(scaledSets(slot, t, "all-around"), 3);
});

test("only strength, hypertrophy and muscular endurance slots count toward weekly sets", () => {
  const t = parseTemplate(
    parse(
      template(10).replace(
        "    slots:\n",
        "    slots:\n      - { pattern: squat, adaptation: power, sets: 5, reps: 3, rest_s: 180 }\n",
      ),
    ),
  );
  const { sets } = weeklySetsPerMuscle(t, "all-around", FALLBACK_PATTERNS);
  assert.deepEqual(sets, { chest: 10, triceps: 10 });
});

test("sourceKeys reads the first column of the sources table", () => {
  assert.deepEqual([...sourceKeys(SOURCES)], ["S1"]);
});

test("overlap check finds an 8-word shared run and ignores shorter ones", () => {
  const ref = ["The quick brown fox jumps over the lazy dog every single morning."];
  const hit = sharedRuns({ "a.md": "Look: the quick brown fox jumps over the lazy dog every day." }, ref, 8);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].length, 10);
  const miss = sharedRuns({ "a.md": "A quick brown fox jumps over a lazy dog." }, ref, 8);
  assert.equal(miss.length, 0);
});

test("overlap check lowercases, strips punctuation and keeps numbers", () => {
  assert.deepEqual(words("Rest 3-5 min; don't STOP."), ["rest", "3", "5", "min", "dont", "stop"]);
});

test("overlap check skips URLs and the sources.md table, not other prose", () => {
  const md = "| E1 | A long episode title | https://x.com/a/b | 2023 | n |\nProse stays.\n";
  assert.equal(stripCitations("sources.md", md).trim(), "Prose stays.");
  assert.ok(stripCitations("METHOD.md", md).includes("A long episode title"));
  assert.ok(!stripCitations("METHOD.md", md).includes("https"));
});
