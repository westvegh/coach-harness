import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { CoachError } from "./errors.ts";
import {
  compileTerms,
  detect,
  isMatch,
  loadSafetyTerms,
  scanSessionNotes,
  TERMS_PATH,
  tokenize,
  urgentTermsOf,
} from "./safety.ts";
import type { NotesHistoryEntry } from "./safety.ts";

// ---------- the matcher ----------

type Want = { urgent?: boolean; pain?: boolean; regions?: string[] };

// [text, expected]. `urgent`/`pain` false means "must not match"; regions are exact when given.
const CASES: [string, Want][] = [
  // urgent
  ["I have chest pain when I walk up stairs", { urgent: true }],
  ["there's a pressure in my chest", { urgent: true }],
  ["my chest feels tight and heavy right now", { urgent: true }],
  ["I fainted after the last set", { urgent: true }],
  ["nearly passed out on the rower", { urgent: true }],
  ["blacked out for a second", { urgent: true }],
  ["I'm short of breath just sitting here", { urgent: true }],
  ["can't breathe properly at rest", { urgent: true }],
  ["worst headache of my life, came on suddenly", { urgent: true }],
  ["my left arm went numb", { urgent: true }],
  ["sudden weakness in my right leg", { urgent: true }],
  ["my face is drooping on one side", { urgent: true }],
  ["wife says my speech was slurred", { urgent: true }],
  ["heart was skipping beats and I felt dizzy", { urgent: true }],
  ["heart racing and dizzy after warmup", { urgent: true }],
  ["palpitations since this morning", { urgent: true }],
  ["pee is dark like cola after the workout", { urgent: true }],
  ["coughing up blood", { urgent: true }],
  ["pain shooting down my arm into my jaw", { urgent: true }],
  // urgent ignores negations: a false alarm is cheap
  ["no chest pain, just tired", { urgent: true }],
  // pain, with regions
  ["my left knee hurts", { pain: true, regions: ["left-knee"] }],
  ["Right shoulder is killing me", { pain: true, regions: ["right-shoulder"] }],
  ["tweaked my lower back on deadlifts", { pain: true, regions: ["low-back"] }],
  ["think I strained something in my groin", { pain: true, regions: ["groin"] }],
  ["pulled a muscle", { pain: true }],
  ["felt a pop in my knee on the last rep", { pain: true, regions: ["knee"] }],
  ["ankle is swollen this morning", { pain: true, regions: ["ankle"] }],
  ["sharp twinge in the elbow", { pain: true, regions: ["elbow"] }],
  ["can't put weight on my right foot", { pain: true, regions: ["foot"] }],
  ["sore joints today", { pain: true }],
  ["my wrists are sore", { pain: true, regions: ["wrist"] }],
  ["hip feels stiff and achy", { pain: true, regions: ["hip"] }],
  ["knee clicking and gave out on the stairs", { pain: true, regions: ["knee"] }],
  ["rolled my ankle on a trail run", { pain: true, regions: ["ankle"] }],
  ["back went out picking up my kid", { pain: true, regions: ["low-back"] }],
  ["my neck is all jacked up since Tuesday", { pain: true, regions: ["neck"] }],
  ["both knees ache after running", { pain: true, regions: ["knee"] }],
  ["left and right wrists hurt on front squats", { pain: true, regions: ["left-wrist", "right-wrist"] }],
  ["ouch, my achilles", { pain: true, regions: ["ankle"] }],
  ["something feels off in my shoulder", { pain: true, regions: ["shoulder"] }],
  ["something feels weird in my shoulder", { pain: true, regions: ["shoulder"] }],
  ["tingling in my fingers on pull-ups", { pain: true, regions: ["hand"] }],
  ["pinched nerve in my neck", { pain: true, regions: ["neck"] }],
  ["I'm a bit lightheaded today", { pain: true }],
  ["Hurts.", { pain: true }],
  ["owww", { pain: true }],
  ["L knee niggle", { pain: true, regions: ["left-knee"] }],
  // negations
  ["No pain today, feeling great", { pain: false, urgent: false }],
  ["squats were pain-free", { pain: false }],
  ["it doesn't hurt anymore", { pain: false }],
  // conservative: a region word between "no" and "pain" keeps the pain
  ["no knee pain at all this week", { pain: true, regions: ["knee"] }],
  ["knee isn't sore anymore", { pain: false }],
  ["the pain is gone", { pain: false }],
  ["pain 0/10", { pain: false }],
  ["no pain no gain", { pain: false }],
  ["no pain in the knee but my right shoulder is killing me", { pain: true, regions: ["knee", "right-shoulder"] }],
  ["no pain. my right shoulder is killing me", { pain: true, regions: ["right-shoulder"] }],
  ["didn't hurt. but the hip pinched on the last set", { pain: true, regions: ["hip"] }],
  // negated resolution is still pain (finding 1)
  ["No improvement in pain", { pain: true }],
  ["The pain has not gone", { pain: true }],
  ["My knee is not pain-free", { pain: true, regions: ["knee"] }],
  ["not quite pain free yet", { pain: true }],
  ["the pain hasn't resolved", { pain: true }],
  // formatting punctuation does not split a region from its symptom (finding 2)
  ["Chest: pressure", { urgent: true }],
  ["My knee: sore", { pain: true, regions: ["knee"] }],
  ["left knee (sore)", { pain: true, regions: ["left-knee"] }],
  ["chest - tight", { urgent: true }],
  ["left knee, pretty sore today", { pain: true, regions: ["left-knee"] }],
  // "new weakness" is urgent (finding 3)
  ["New weakness in my left arm", { urgent: true }],
  ["newly weak grip in my right hand", { urgent: true }],
  // ordinary training talk: no match
  ["Read .claude/skills/today/SKILL.md and follow it exactly. Unattended run.", { pain: false, urgent: false, regions: [] }],
  ["Read .claude/skills/week/SKILL.md and follow it exactly. Unattended run.", { pain: false, urgent: false, regions: [] }],
  ["slept 7 hours, energy 4, ready to train", { pain: false, urgent: false }],
  ["quads are sore from yesterday's squats", { pain: false, urgent: false }],
  ["can we move Thursday's session to Friday?", { pain: false, urgent: false }],
  ["hit a PR on bench, 225 for 5", { pain: false, urgent: false }],
  ["rowing stroke rate felt good", { pain: false, urgent: false }],
  ["I'm fit and ready, let's get to the gym", { pain: false, urgent: false }],
];

for (const [text, want] of CASES) {
  test(`detect: ${JSON.stringify(text)}`, () => {
    const d = detect(text);
    if (want.urgent !== undefined) assert.equal(d.urgent.length > 0, want.urgent, `urgent ${JSON.stringify(d)}`);
    if (want.pain !== undefined) assert.equal(d.pain.length > 0, want.pain, `pain ${JSON.stringify(d)}`);
    if (want.regions !== undefined) assert.deepEqual(d.regions, [...want.regions].sort(), `regions ${JSON.stringify(d)}`);
  });
}

test("the case table has 40+ phrasings", () => {
  assert.ok(CASES.length >= 40);
});

test("tokenize removes apostrophes, splits clauses on sentence ends and 'but', not on formatting punctuation", () => {
  assert.deepEqual(tokenize("Doesn't hurt, but it’s pain-free"), ["doesnt", "hurt", "|", "its", "pain", "free"]);
  assert.deepEqual(tokenize("Knee: sore (left). Ok; fine!"), ["knee", "sore", "left", "|", "ok", "|", "fine", "|"]);
});

test("detect names terms, never the user's words", () => {
  const d = detect("my super-secret-word knee hurts");
  assert.deepEqual(d.pain, ["hurt"]);
  assert.ok(![...d.urgent, ...d.pain, ...d.regions].some((t) => t.includes("secret")));
  const both = detect("chest pain, left knee hurts");
  assert.deepEqual([...both.urgent, ...both.pain, ...both.regions], ["chest pain", "pain", "hurt", "chest", "left-knee"]);
});

test("every region id exists in engine/movements.yaml, with left-/right- variants for sides", () => {
  const terms = parse(readFileSync(TERMS_PATH, "utf8"));
  const tax = parse(readFileSync(new URL("./movements.yaml", import.meta.url), "utf8"));
  const known = new Set<string>(tax.regions);
  for (const id of Object.keys(terms.regions)) assert.ok(known.has(id), `unknown region ${id}`);
  for (const id of terms.sides) {
    assert.ok(known.has(`left-${id}`) && known.has(`right-${id}`), `side region ${id} needs left-/right- in movements.yaml`);
  }
});

test("the shipped term list compiles, and bad lists are rejected", () => {
  const t = loadSafetyTerms();
  assert.ok(t.urgent.length > 10 && t.pain.length > 20 && t.negations.length > 3);
  const base = parse(readFileSync(TERMS_PATH, "utf8"));
  assert.throws(() => compileTerms({ ...base, extra: 1 }), /unknown key extra/);
  assert.throws(() => compileTerms({ ...base, pain: ["~ pain"] }), /cannot start or end with ~/);
  assert.throws(() => compileTerms({ ...base, pain: ["pa!n"] }), /bad token/);
  assert.throws(() => compileTerms({ ...base, sides: ["tail"] }), /sides must list region ids/);
  assert.throws(() => compileTerms({ ...base, urgent: [{ term: "x", all: [], other: 1 }] }), CoachError);
});

// ---------- session notes ----------

const HISTORY: NotesHistoryEntry[] = [
  { date: "2026-10-10", notes: "Felt strong", exercises: [{ exerciseId: "Barbell_Squat", name: "Barbell Squat", notes: "left knee tweaked on set 3" }] },
  { date: "2026-10-08", notes: "chest tightness on the bike", exercises: [] },
  { date: "2026-10-11", notes: "[coach:hold] knee pain hold\nall good, no pain", exercises: [{ name: "Bench Press", notes: null }] },
  { date: "2026-10-09", exercises: [{ name: "Row", notes: "easy" }] },
];

test("scanSessionNotes returns matches with dates, oldest first, and scans coach lines too", () => {
  const m = scanSessionNotes(HISTORY);
  assert.deepEqual(
    m.map((x) => [x.date, x.where, x.name ?? null]),
    [
      ["2026-10-08", "session", null],
      ["2026-10-10", "exercise", "Barbell Squat"],
      ["2026-10-11", "session", null],
    ],
  );
  assert.ok(m[0].urgent.includes("chest pain"));
  assert.deepEqual(m[1].regions, ["left-knee"]);
  assert.equal(m[1].exerciseId, "Barbell_Squat");
});

test("scanSessionNotes honors since (inclusive)", () => {
  assert.deepEqual(
    scanSessionNotes(HISTORY, { since: "2026-10-10" }).map((x) => x.date),
    ["2026-10-10", "2026-10-11"],
  );
  assert.deepEqual(scanSessionNotes([]), []);
});

test("a [coach:…] prefix does not hide the athlete's words on the same line", () => {
  const m = scanSessionNotes([{ date: "2026-10-09", notes: "[coach:note] completed session; my knee hurts now" }]);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].regions, ["knee"]);
});

test("the clearance skip: an urgent term in a note on or before its latest clearance is dropped; a later note stops again", () => {
  const notes: NotesHistoryEntry[] = [
    { date: "2026-10-08", notes: "chest tightness on the bike", exercises: [] },
    { date: "2026-10-12", notes: "chest pain again on the bike", exercises: [] },
  ];
  assert.deepEqual(urgentTermsOf(scanSessionNotes(notes)), ["chest pain"]);
  const cleared = new Map([["chest pain", "2026-10-10"]]);
  const m = scanSessionNotes(notes, { cleared });
  assert.deepEqual(m.map((x) => [x.date, x.urgent]), [["2026-10-12", ["chest pain"]]]);
  // Cleared on the day of the last note: nothing urgent is left.
  assert.deepEqual(urgentTermsOf(scanSessionNotes(notes, { cleared: new Map([["chest pain", "2026-10-12"]]) })), []);
  // A clearance of another term does not skip this one.
  assert.deepEqual(urgentTermsOf(scanSessionNotes(notes, { cleared: new Map([["fainting", "2026-10-12"]]) })), ["chest pain"]);
});

test("isMatch is true only for urgent or pain terms", () => {
  assert.equal(isMatch({ urgent: [], pain: [], regions: ["knee"] }), false);
  assert.equal(isMatch({ urgent: [], pain: ["hurt"], regions: [] }), true);
});
