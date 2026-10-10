// The Tally matcher port, and its property test: for every exercise in
// engine/movements.yaml and every pattern the method templates use, the compiled rules
// match on the server exactly what the local guard's limits match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { compileServerRules } from "./limits-compile.ts";
import { loadTemplates } from "./methods.ts";
import { maskField, norm, occurs, ruleMatches } from "./server-match.ts";
import type { ServerRule } from "./server-match.ts";
import { classify, loadTaxonomy } from "./taxonomy.ts";
import { limitMatch } from "./validate.ts";
import type { ExerciseEntry, Limit, Taxonomy } from "./types.ts";

const rule = (over: Partial<ServerRule>): ServerRule => ({ id: "L-001", label: "Knee", kind: "ban", exerciseIds: [], keywords: [], exceptKeywords: [], allow: [], ...over });

test("a keyword occurs at a word start only", () => {
  assert.ok(occurs("seated row", "row"));
  assert.ok(!occurs("rowing", "row"));
  assert.ok(!occurs("medicine ball throw", "row"));
  assert.ok(occurs("front squat", "squat"));
  assert.ok(!occurs("", "squat"));
});

test("masking: the union of except spans (with plurals), any order", () => {
  assert.equal(maskField("bulgarian split squat", ["split squat"]).trim(), "bulgarian");
  assert.equal(maskField("back squat split squat", ["split squat"]).trim(), "back squat");
  assert.equal(maskField("split squats", ["split squat"]).trim(), "");
  for (const order of [["bulgarian split", "split squat"], ["split squat", "bulgarian split"]]) {
    assert.equal(maskField("bulgarian split squat", order).trim(), "", order.join(" + "));
  }
});

test("fields are checked separately: an except phrase in the id cannot cancel a banned name", () => {
  const r = rule({ keywords: ["squat"], exceptKeywords: ["split squat"] });
  assert.ok(ruleMatches(r, { exerciseId: "split_squat", name: "Back Squat" }));
  assert.ok(ruleMatches(r, { exerciseId: "x", name: "Back Squat Split Squat" }));
  assert.ok(!ruleMatches(r, { exerciseId: "bulgarian_split_squat", name: "Bulgarian Split Squat" }));
  assert.ok(ruleMatches(r, { exerciseId: "x", name: "Back-Squat" }));
  assert.ok(ruleMatches(r, { exerciseId: "x", name: "ＢＡＣＫ　ＳＱＵＡＴ" }));
});

test("allow needs both the exerciseId and the name; exerciseIds compare in norm() form", () => {
  const r = rule({ exerciseIds: ["Barbell_Squat"], keywords: ["squat"], allow: [{ exerciseId: "box_squat", name: "Box Squat" }] });
  assert.ok(!ruleMatches(r, { exerciseId: "box_squat", name: "box squat" }));
  assert.ok(ruleMatches(r, { exerciseId: "box_squat", name: "Pause Squat" }));
  assert.ok(ruleMatches(r, { exerciseId: "barbell-squat", name: "Leg Day" }));
  assert.ok(!ruleMatches(rule({ keywords: ["row"] }), { exerciseId: null, name: null }));
});

// ---------- property test ----------

const tax: Taxonomy = loadTaxonomy({ localPath: null });
const templates = loadTemplates(join(import.meta.dirname, "..", "methods", "nine-adaptations"));
const slots = Object.entries(templates).flatMap(([name, t]) => t.week.flatMap((d) => d.slots.map((s, i) => ({ where: `${name} day ${d.day} slot ${i + 1}`, pattern: s.pattern, sets: s.sets }))));
const templatePatterns = [...new Set(slots.map((s) => s.pattern))].sort();

const title = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const snake = (s: string) => s.replace(/ /g, "_");
const entry = (exerciseId: string | null, name: string, sets = 1) => ({ exerciseId, name, suggestedSets: sets, sets: [] }) as unknown as ExerciseEntry;

/** Every exercise the taxonomy names, as Tally could store it: name and id, name only, id only. */
function universe(t: Taxonomy): ExerciseEntry[] {
  const out: ExerciseEntry[] = [];
  for (const k of Object.keys(t.keywords)) out.push(entry(snake(k), title(k)), entry(null, title(k)), entry(snake(k), ""));
  for (const k of Object.keys(t.exercises)) out.push(k.includes("_") ? entry(k, k.replace(/_/g, " ")) : entry(snake(k), k));
  return out;
}

/** Plural and suffix variants: "Back Squats", "Squatting Stretch", "Rowers". */
function variants(t: Taxonomy): ExerciseEntry[] {
  const out: ExerciseEntry[] = [];
  for (const k of Object.keys(t.keywords)) {
    for (const v of [`${k}s`, `${k}es`, `${k}ing`, `${k}ing stretch`, `${k}er`, `barbell ${k}`, `${k} machine`]) out.push(entry(snake(v), title(v)));
  }
  return out;
}

/** A name from one keyword and an id from another. */
function mixed(t: Taxonomy): ExerciseEntry[] {
  const ks = Object.keys(t.keywords);
  return ks.map((k, i) => entry(snake(ks[(i * 7 + 3) % ks.length]), title(k)));
}

function limitsFor(t: Taxonomy): Limit[] {
  const base = { region: "knee", exercises: [], allow: [], source: "athlete" as const, since: "2026-10-09" };
  const out: Limit[] = [];
  let n = 0;
  const id = () => `L-${String(++n).padStart(3, "0")}`;
  // One ban and one set cap per pattern (the template patterns are among them).
  for (const p of Object.keys(t.patterns)) {
    out.push({ ...base, id: id(), rule: "ban", patterns: [p] });
    out.push({ ...base, id: id(), rule: "cap", patterns: [p], max_sets_per_week: 6 });
  }
  // Every pair of template patterns in one limit, as a ban and as a cap.
  for (let i = 0; i < templatePatterns.length; i++) {
    for (let j = i + 1; j < templatePatterns.length; j++) {
      out.push({ ...base, id: id(), rule: "ban", patterns: [templatePatterns[i], templatePatterns[j]] });
      out.push({ ...base, id: id(), rule: "cap", patterns: [templatePatterns[i], templatePatterns[j]], max_sets_per_week: 10 });
    }
  }
  // The contracts §2 example: exercises and allow entries.
  out.push({ ...base, id: id(), region: "left-knee", rule: "ban", patterns: ["loaded_deep_knee_flexion"], exercises: ["Barbell Back Squat"], allow: ["Box Squat"] });
  out.push({ ...base, id: id(), region: "low-back", rule: "cap", patterns: ["hinge"], max_sets_per_week: 6, max_load: { value: 135, unit: "lbs" } });
  return out;
}

const RESOLVED = {
  "Barbell Back Squat": { exerciseId: "barbell_back_squat", name: "Barbell Back Squat" },
  "Box Squat": { exerciseId: "box_squat", name: "Box Squat" },
};

/** Tally holds at most 50 rules, so each test limit compiles in its own document. */
function compileEach(limits: Limit[]): { rules: ServerRule[]; skipped: { id: string; reason: string }[] } {
  const results = limits.map((l) => compileServerRules({ version: 1, pain_threshold: 4, limits: [l] }, tax, RESOLVED));
  return { rules: results.flatMap((r) => r.rules), skipped: results.flatMap((r) => r.skipped) };
}

const LIMITS = limitsFor(tax);
const COMPILED = compileEach(LIMITS);
const ruleOf = (l: Limit) => COMPILED.rules.find((x) => x.id === l.id)!;

// classify() is the slow part: cache it per exercise. A limit without exercises or allow
// entries matches by pattern only (validate.ts limitMatch), so the cache gives the answer.
const classified = new Map<string, ReturnType<typeof classify>>();
const cls = (e: ExerciseEntry) => {
  const k = `${e.exerciseId ?? ""}\u0000${e.name ?? ""}`;
  let c = classified.get(k);
  if (!c) classified.set(k, (c = classify(e, tax)));
  return c;
};
const localMatch = (l: Limit, e: ExerciseEntry) =>
  l.exercises.length === 0 && l.allow.length === 0 ? cls(e).patterns.some((p) => l.patterns.includes(p)) : limitMatch(l, e, tax).matches;

/** The local guard: a limit match, or an unclassified exercise while any limit is active. */
const localDenies = (l: Limit, e: ExerciseEntry) => cls(e).source === "none" || localMatch(l, e);

function compare(exercises: ExerciseEntry[]): { serverOnly: string[]; localOnly: string[]; checked: number } {
  const serverOnly: string[] = [];
  const localOnly: string[] = [];
  let checked = 0;
  for (const l of LIMITS) {
    const r = ruleOf(l);
    for (const ex of exercises) {
      const local = localDenies(l, ex);
      const server = ruleMatches(r, ex);
      const what = `${l.id} [${l.patterns.join(", ")}] ${JSON.stringify({ exerciseId: ex.exerciseId, name: ex.name })}`;
      if (server && !local) serverOnly.push(what);
      if (local && !server && cls(ex).source !== "none") localOnly.push(what);
      checked++;
    }
  }
  return { serverOnly, localOnly, checked };
}

test("property: the server matches exactly what the local guard's limits match, for every taxonomy exercise and template pattern", () => {
  const exercises = universe(tax);
  for (const p of templatePatterns) {
    assert.ok(p in tax.patterns, `template pattern ${p} is in the taxonomy`);
    assert.ok(exercises.some((e) => classify(e, tax).patterns.includes(p)), `the taxonomy names an exercise for template pattern ${p}`);
  }
  assert.deepEqual(COMPILED.skipped, [], "every test limit compiles");
  const r = compare(exercises);
  assert.ok(r.checked > 100_000, `checked ${r.checked} pairs`);
  assert.deepEqual(r.serverOnly, [], "exercises the server would refuse that the local guard allows");
  assert.deepEqual(r.localOnly, [], "exercises the local guard bans that the server would let through");
});

test("property: plural and suffix variants — the server refuses nothing the local guard allows", () => {
  const r = compare(variants(tax));
  assert.deepEqual(r.serverOnly, [], "plural and suffix variants the server would refuse that the local guard allows");
  // Spot checks of the reviewer's case.
  const squat = LIMITS.find((l) => l.rule === "ban" && l.patterns.join() === "squat")!;
  assert.ok(!ruleMatches(ruleOf(squat), entry("x", "Squatting Stretch")));
  assert.ok(!localDenies(squat, entry("x", "Squatting Stretch")));
  assert.ok(ruleMatches(ruleOf(squat), entry("x", "Back Squats")));
});

test("property: differing names and ids — the server refuses more only on an identity conflict", () => {
  // Tally checks the name and the id separately (spec §4.1). The local guard classifies
  // one of them: an exact taxonomy entry first (id, then name), else the name's keywords.
  // A server-only refusal must therefore be an identity conflict: the name alone or the
  // id alone is limited locally.
  const r = compare(mixed(tax));
  const unexplained = r.serverOnly.filter((w) => {
    const { exerciseId, name } = JSON.parse(w.slice(w.indexOf("{")));
    const l = LIMITS.find((x) => w.startsWith(`${x.id} `))!;
    return !localDenies(l, entry(exerciseId, "")) && !localDenies(l, entry(null, name));
  });
  assert.deepEqual(unexplained, []);
  assert.deepEqual(r.localOnly, [], "the local guard bans by name; the server reads the name too");
});

test("property: every template slot, with its real set count, counts the same sets for every cap", () => {
  const exercises = [...universe(tax), ...variants(tax)].filter((e) => cls(e).source !== "none");
  const caps = LIMITS.filter((l) => l.rule === "cap");
  const mismatches: string[] = [];
  for (const slot of slots) {
    const filled = exercises.filter((e) => cls(e).patterns.includes(slot.pattern)).map((e) => ({ ...e, suggestedSets: slot.sets }));
    assert.ok(filled.length > 0, `${slot.where}: an exercise for ${slot.pattern}`);
    for (const l of caps) {
      const r = ruleOf(l);
      const local = filled.filter((e) => localMatch(l, e)).reduce((n) => n + slot.sets, 0);
      const server = filled.filter((e) => ruleMatches(r, e)).reduce((n, e) => n + (e as unknown as { suggestedSets: number }).suggestedSets, 0);
      if (local !== server) mismatches.push(`${slot.where} [${slot.pattern}, ${slot.sets} sets] ${l.id} [${l.patterns.join(", ")}]: local ${local}, server ${server}`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test("norm() of every compiled keyword is itself (spec §3.2)", () => {
  for (const r of COMPILED.rules) for (const k of [...r.keywords, ...r.exceptKeywords]) assert.equal(norm(k), k);
});

// ---------- whole-word and plural matching ----------

test("v3.2: keywords match whole words with a plural s or es, like the taxonomy", () => {
  const r = rule({ keywords: ["squat", "row", "press"] });
  assert.ok(ruleMatches(r, { exerciseId: "x", name: "Back Squats" }));
  assert.ok(ruleMatches(r, { exerciseId: "x", name: "Bench Presses" }));
  assert.ok(!ruleMatches(r, { exerciseId: "x", name: "Squatting Stretch" }), "plural and suffix rule");
  assert.ok(!ruleMatches(r, { exerciseId: "rowing", name: "Rowing" }));
  assert.ok(!ruleMatches(r, { exerciseId: "x", name: "Rowers" }));
  assert.ok(!occurs("squatting", "squat"));
  assert.ok(occurs("seated rows", "row"));
  // An except span covers its plural suffix only, not the rest of the word.
  assert.equal(maskField("split squats", ["split squat"]).trim(), "");
  assert.equal(maskField("split squatter", ["split squat"]), "split squatter");
});

test("v3.2: norm() deletes zero-width and format characters before NFKC", () => {
  assert.equal(norm("sq​uat"), "squat");
  assert.equal(norm("Back Sq­uat"), "back squat");
  assert.equal(norm("﻿Squat⁠"), "squat");
  assert.equal(norm("squ͏at ‪Row‬"), "squat row");
  for (const c of ["؜", "ᅟ", "ᅠ", "឴", "឵", "᠋", "᠏", "‏", "‮", "⁯", "ㅤ", "︀", "️", "ﾠ"]) {
    assert.equal(norm(`sq${c}uat`), "squat", `U+${c.charCodeAt(0).toString(16)}`);
  }
  assert.ok(ruleMatches(rule({ keywords: ["squat"] }), { exerciseId: "x", name: "Back Sq​uat" }));
});

test("v3.2: each field is read to its first 200 characters", () => {
  const r = rule({ keywords: ["squat"] });
  const at = (n: number) => `${"x".repeat(n)} squat`;
  assert.equal(norm(at(194)).length, 200);
  assert.ok(ruleMatches(r, { exerciseId: "x", name: at(194) }), "the keyword ends at character 200");
  assert.ok(!ruleMatches(r, { exerciseId: "x", name: at(195) }), "the keyword ends at character 201");
  assert.ok(!ruleMatches(r, { exerciseId: "x", name: `${"x".repeat(200)} squat` }));
});
