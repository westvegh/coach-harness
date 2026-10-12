// The safety term matcher (contracts §10).
//
// `detect` is trusted code: the `safety-detect` hook runs it on every user message (urgent
// terms only make it act), and the `today` and `week` skills run it on logged session notes
// (`scanSessionNotes`). An urgent match writes the urgent stop (engine/urgent.ts). Pain
// matches are reported for the coach's own judgment; no file is written for them. Only
// matched term names are stored, never the user's text.
import { CoachError } from "./errors.ts";
import { isPlainObject, readYamlFile } from "./yaml-file.ts";
import type { CalendarDate } from "./types.ts";

export const TERMS_PATH = new URL("./safety-terms.yaml", import.meta.url).pathname;

// ---------- the term list ----------

type Alt = { word: string; prefix: boolean };
type Tok = { kind: "word"; alts: Alt[] } | { kind: "gap" };
type Phrase = Tok[];
type Element = { kind: "phrase"; phrase: Phrase } | { kind: "region"; joint: boolean };
type Entry = { term: string; all: Element[] };

export type SafetyTerms = {
  sides: Set<string>;
  joints: Set<string>;
  regions: { id: string; phrase: Phrase }[];
  urgent: Entry[];
  pain: Entry[];
  negations: Phrase[];
};

export type Detection = { urgent: string[]; pain: string[]; regions: string[] };

const BOUNDARY = "|";
const MASKED = "∅";
const GAP_MAX = 2;
const BOUNDARY_WORDS = new Set(["but", "though", "although", "however", "except"]);
const SIDE_WORDS: Record<string, "left" | "right"> = { left: "left", l: "left", lt: "left", right: "right", r: "right", rt: "right" };
const SIDE_FILLER = new Set(["my", "the", "and", "or", "of", "both", "side", "upper", "lower", "inner", "outer", "inside", "outside", "front"]);
const WORD_RE = /^[a-z0-9]+$/;

/**
 * Lowercase tokens. Sentence ends (. ; ! ? and new lines) and the clause words become BOUNDARY
 * tokens. Formatting punctuation (commas, colons, brackets, dashes, quotes) is only a space, so
 * "Chest: pressure" and "My knee (sore)" stay in one clause.
 */
export function tokenize(text: string): string[] {
  const s = text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/['‘’`´]/g, "")
    .replace(/[.;!?\n\r]+/g, ` ${BOUNDARY} `)
    .replace(/[^a-z0-9|]+/g, " ");
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (BOUNDARY_WORDS.has(t) ? BOUNDARY : t));
}

function compilePhrase(src: unknown, where: string): Phrase {
  if (typeof src !== "string" || src.trim() === "") throw new CoachError("TERMS_INVALID", `${where}: must be a non-empty phrase`);
  const raw = src.toLowerCase().replace(/['’]/g, "").replace(/-/g, " ").trim().split(/\s+/);
  const phrase: Phrase = raw.map((t) => {
    if (t === "~") return { kind: "gap" };
    const alts = t.split("|").map((a) => {
      const prefix = a.endsWith("*");
      const word = prefix ? a.slice(0, -1) : a;
      if (!WORD_RE.test(word)) throw new CoachError("TERMS_INVALID", `${where}: bad token ${JSON.stringify(t)} in ${JSON.stringify(src)}`);
      return { word, prefix };
    });
    return { kind: "word", alts };
  });
  if (phrase[0].kind === "gap" || phrase[phrase.length - 1].kind === "gap") {
    throw new CoachError("TERMS_INVALID", `${where}: a phrase cannot start or end with ~ (${JSON.stringify(src)})`);
  }
  return phrase;
}

function compileEntry(raw: unknown, where: string): Entry {
  if (typeof raw === "string") {
    const phrase = compilePhrase(raw, where);
    const term = phrase.flatMap((t) => (t.kind === "word" ? [t.alts[0].word] : [])).join(" ");
    return { term, all: [{ kind: "phrase", phrase }] };
  }
  if (!isPlainObject(raw)) throw new CoachError("TERMS_INVALID", `${where}: must be a phrase or {term, all}`);
  for (const k of Object.keys(raw)) if (k !== "term" && k !== "all") throw new CoachError("TERMS_INVALID", `${where}: unknown key ${k}`);
  if (typeof raw.term !== "string" || raw.term.trim() === "") throw new CoachError("TERMS_INVALID", `${where}: term must be a non-empty string`);
  if (!Array.isArray(raw.all) || raw.all.length === 0) throw new CoachError("TERMS_INVALID", `${where}: all must be a non-empty list`);
  const all: Element[] = raw.all.map((el, i) => {
    if (el === "@region" || el === "@joint") return { kind: "region", joint: el === "@joint" };
    return { kind: "phrase", phrase: compilePhrase(el, `${where}.all[${i}]`) };
  });
  return { term: raw.term, all };
}

/** Parses and validates a term file's content. */
export function compileTerms(raw: unknown, where = "safety-terms.yaml"): SafetyTerms {
  if (!isPlainObject(raw)) throw new CoachError("TERMS_INVALID", `${where} must be a mapping`);
  const KEYS = ["version", "sides", "joints", "regions", "urgent", "pain", "negations"];
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) throw new CoachError("TERMS_INVALID", `${where}: unknown key ${k}`);
  if (raw.version !== 1) throw new CoachError("TERMS_INVALID", `${where}: version must be 1`);
  if (!isPlainObject(raw.regions)) throw new CoachError("TERMS_INVALID", `${where}: regions must be a mapping`);
  const regions: SafetyTerms["regions"] = [];
  for (const [id, phrases] of Object.entries(raw.regions)) {
    if (!Array.isArray(phrases)) throw new CoachError("TERMS_INVALID", `${where}: regions.${id} must be a list`);
    phrases.forEach((p, i) => regions.push({ id, phrase: compilePhrase(p, `regions.${id}[${i}]`) }));
  }
  const ids = new Set(Object.keys(raw.regions));
  const idList = (k: "sides" | "joints") => {
    const v = raw[k];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !ids.has(x))) {
      throw new CoachError("TERMS_INVALID", `${where}: ${k} must list region ids from regions`);
    }
    return new Set(v as string[]);
  };
  const list = (k: "urgent" | "pain" | "negations") => {
    const v = raw[k];
    if (!Array.isArray(v) || v.length === 0) throw new CoachError("TERMS_INVALID", `${where}: ${k} must be a non-empty list`);
    return v;
  };
  return {
    sides: idList("sides"),
    joints: idList("joints"),
    regions,
    urgent: list("urgent").map((e, i) => compileEntry(e, `urgent[${i}]`)),
    pain: list("pain").map((e, i) => compileEntry(e, `pain[${i}]`)),
    negations: list("negations").map((p, i) => compilePhrase(p, `negations[${i}]`)),
  };
}

let cached: SafetyTerms | null = null;

/** The shipped term list (cached). */
export function loadSafetyTerms(path?: string): SafetyTerms {
  if (path) return compileTerms(readYamlFile(path, "TERMS_INVALID"), path);
  cached ??= compileTerms(readYamlFile(TERMS_PATH, "TERMS_INVALID"), TERMS_PATH);
  return cached;
}

// ---------- matching ----------

function wordMatches(tok: string, alts: Alt[]): boolean {
  return alts.some((a) => (a.prefix ? tok.startsWith(a.word) : tok === a.word));
}

/** The end index of `phrase` matched at `start` in a clause, or -1. */
function matchAt(clause: string[], phrase: Phrase, start: number): number {
  const go = (ti: number, pi: number): number => {
    if (pi === phrase.length) return ti;
    const p = phrase[pi];
    if (p.kind === "gap") {
      for (let skip = 0; skip <= GAP_MAX && ti + skip <= clause.length; skip++) {
        const end = go(ti + skip, pi + 1);
        if (end >= 0) return end;
      }
      return -1;
    }
    if (ti >= clause.length || !wordMatches(clause[ti], p.alts)) return -1;
    return go(ti + 1, pi + 1);
  };
  return go(start, 0);
}

function spans(clause: string[], phrase: Phrase): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < clause.length; i++) {
    const end = matchAt(clause, phrase, i);
    if (end > i) out.push([i, end]);
  }
  return out;
}

type RegionHit = { id: string; base: string };

/** Region words in one clause, longest first, with left/right read from the words before. */
function clauseRegions(clause: string[], terms: SafetyTerms): RegionHit[] {
  const found: { id: string; s: number; e: number }[] = [];
  for (const r of terms.regions) for (const [s, e] of spans(clause, r.phrase)) found.push({ id: r.id, s, e });
  found.sort((a, b) => b.e - b.s - (a.e - a.s) || a.s - b.s);
  const used = new Array<boolean>(clause.length).fill(false);
  const hits: RegionHit[] = [];
  for (const f of found) {
    if (used.slice(f.s, f.e).some(Boolean)) continue;
    for (let i = f.s; i < f.e; i++) used[i] = true;
    const sides = new Set<string>();
    for (let i = f.s - 1; i >= 0; i--) {
      const side = SIDE_WORDS[clause[i]];
      if (side) sides.add(side);
      else if (!SIDE_FILLER.has(clause[i])) break;
    }
    if (sides.size > 0 && terms.sides.has(f.id)) for (const side of sides) hits.push({ id: `${side}-${f.id}`, base: f.id });
    else hits.push({ id: f.id, base: f.id });
  }
  return hits;
}

function entryMatches(entry: Entry, clause: string[], regions: RegionHit[], terms: SafetyTerms): boolean {
  return entry.all.every((el) =>
    el.kind === "region" ? regions.some((r) => !el.joint || terms.joints.has(r.base)) : spans(clause, el.phrase).length > 0,
  );
}

function splitClauses(tokens: string[]): string[][] {
  const out: string[][] = [[]];
  for (const t of tokens) {
    if (t === BOUNDARY) out.push([]);
    else out[out.length - 1].push(t);
  }
  return out.filter((c) => c.length > 0);
}

// Words that turn a negation around: "not pain-free", "never quite pain free".
const NEGATORS = new Set([
  "not", "no", "never", "nor", "isnt", "wasnt", "arent", "werent", "aint", "hasnt", "havent", "hadnt",
  "doesnt", "dont", "didnt", "wont", "cant", "cannot", "hardly", "barely", "scarcely", "nowhere", "far",
]);
const NEGATOR_LOOKBACK = 2;

/**
 * Removes negated spans, unless a negator in the 2 words before turns the negation around
 *. When in doubt, the pain stays.
 */
function mask(clause: string[], negations: Phrase[]): string[] {
  const masked = [...clause];
  for (const n of negations) {
    for (const [s, e] of spans(clause, n)) {
      if (clause.slice(Math.max(0, s - NEGATOR_LOOKBACK), s).some((t) => NEGATORS.has(t))) continue;
      for (let i = s; i < e; i++) masked[i] = MASKED;
    }
  }
  return masked;
}

/**
 * Matches text against the term list. `urgent` ignores negations ("no chest pain" still
 * counts: a false alarm is cheap). `pain` and `regions` are read after negated spans are
 * removed. A side region drops its parent ("left knee ... knee" → left-knee only).
 */
export function detect(text: string, terms: SafetyTerms = loadSafetyTerms()): Detection {
  const urgent = new Set<string>();
  const pain = new Set<string>();
  const regionIds = new Set<string>();
  for (const clause of splitClauses(tokenize(text ?? ""))) {
    const regions = clauseRegions(clause, terms);
    for (const e of terms.urgent) if (entryMatches(e, clause, regions, terms)) urgent.add(e.term);
    const masked = mask(clause, terms.negations);
    const maskedRegions = clauseRegions(masked, terms);
    for (const e of terms.pain) if (entryMatches(e, masked, maskedRegions, terms)) pain.add(e.term);
    for (const r of maskedRegions) regionIds.add(r.id);
  }
  for (const id of [...regionIds]) {
    if (terms.sides.has(id) && (regionIds.has(`left-${id}`) || regionIds.has(`right-${id}`))) regionIds.delete(id);
  }
  return { urgent: [...urgent], pain: [...pain], regions: [...regionIds].sort() };
}

export function isMatch(d: Detection): boolean {
  return d.urgent.length > 0 || d.pain.length > 0;
}

// ---------- session notes ----------

/** A logged session as the snapshot history holds it, with the notes Tally returns. */
export type NotesHistoryEntry = {
  date: CalendarDate;
  notes?: string | null;
  exercises?: { exerciseId?: string | null; name?: string; notes?: string | null }[];
};

export type NotesMatch = Detection & { date: CalendarDate; where: "session" | "exercise"; exerciseId?: string | null; name?: string };

/**
 * Runs the matcher over logged session notes and exercise notes. Returns one match per note
 * with urgent or pain terms, oldest first. `since` (inclusive) limits the dates scanned.
 * `cleared` maps an urgent term to the latest clearance date (engine/urgent.ts): an urgent
 * term in a note dated on or before it is dropped, so a cleared event does not stop again.
 * Every word of a note is scanned, `[coach:…]` lines included: a text prefix cannot show who
 * wrote the rest of the line.
 */
export function scanSessionNotes(history: NotesHistoryEntry[], opts: { since?: CalendarDate; terms?: SafetyTerms; cleared?: Map<string, CalendarDate> } = {}): NotesMatch[] {
  const terms = opts.terms ?? loadSafetyTerms();
  const out: NotesMatch[] = [];
  const sorted = [...(history ?? [])].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const live = (d: Detection, date: CalendarDate): Detection => {
    if (!opts.cleared) return d;
    return { ...d, urgent: d.urgent.filter((t) => !(opts.cleared!.has(t) && date <= (opts.cleared!.get(t) as string))) };
  };
  for (const s of sorted) {
    if (opts.since && s.date < opts.since) continue;
    if (typeof s.notes === "string") {
      const d = live(detect(s.notes, terms), s.date);
      if (isMatch(d)) out.push({ date: s.date, where: "session", ...d });
    }
    for (const ex of s.exercises ?? []) {
      if (typeof ex.notes !== "string") continue;
      const d = live(detect(ex.notes, terms), s.date);
      if (isMatch(d)) out.push({ date: s.date, where: "exercise", exerciseId: ex.exerciseId ?? null, name: ex.name, ...d });
    }
  }
  return out;
}

/** The urgent terms of the matches (for the urgent stop). */
export function urgentTermsOf(matches: NotesMatch[]): string[] {
  return [...new Set(matches.flatMap((m) => m.urgent))];
}
