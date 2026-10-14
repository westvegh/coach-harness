// V7: the history capture contract (contracts §9a). The history range is read as date windows
// that tile it, each `limit: 10`, each following its own `nextCursor`. Only capture-reads (through
// engine/snapshot.ts mergeResponse) writes the windows; the coverage functions read them.
//
// - A window is `get_workout_history` with an inclusive `since`/`until`. Its key is `<since>..<until>`.
// - A first page (no cursor) starts a new generation of its window: the window's sessions from an
//   older generation leave the history, unless another window also returned them.
// - A later page counts only when its cursor is the `nextCursor` of a page in the same window's
//   current chain (a repeated page replaces the chain from that point). Any other cursor page is
//   an orphan: it counts for nothing and its sessions are not kept.
// - Sessions are merged by identity (snapshot.ts sessionKey), so a session that two windows
//   return (a boundary, an overlap) counts once.
// - A window is complete when its chain ended with no `nextCursor`. More than 10 pages, an error,
//   a malformed page or a saved-file notice (a page too large for the hook, V4 F5) is `failed`.
// - Coverage of a range is complete when complete, fresh (15 minutes) windows cover every date.
import { addDays, diffDays, parseInstant } from "./dates.ts";
import type { CalendarDate, HistoryWindow, Instant, Snapshot, SnapshotSession } from "./types.ts";

export const HISTORY_PAGE_LIMIT = 10;
/** More pages than this in one window is a failed read: split the window. */
export const MAX_WINDOW_PAGES = 10;
/** The default history range: 8 weeks before today to today (classify's new-exercise window, contracts §9a). */
export const HISTORY_RANGE_DAYS = 56;
export const FRESH_MIN = 15;

export type ReadArgs = { since: CalendarDate; until: CalendarDate; limit: number; cursor?: string };
export type CoverageStatus = "complete" | "missing" | "failed" | "stale";
export type HistoryCoverage = {
  status: CoverageStatus;
  since: CalendarDate;
  until: CalendarDate;
  reason?: string;
  /** Date runs that no complete, fresh window covers. */
  gaps: { since: CalendarDate; until: CalendarDate }[];
  /** The get_workout_history reads that would close the gaps. */
  need: ReadArgs[];
};

const LOW = "0000-01-01";
const HIGH = "9999-12-31";

export function windowKey(since: string | undefined, until: string | undefined): string {
  return `${since ?? ""}..${until ?? ""}`;
}

const lo = (w: { since?: string }) => w.since ?? LOW;
const hi = (w: { until?: string }) => w.until ?? HIGH;

const ageMin = (at: Instant, nowMs: number) => (nowMs - parseInstant(at, "captured_at")) / 60_000;
/** The oldest page of the window's chain. */
const oldestPage = (w: HistoryWindow): Instant | null => (w.pages.length === 0 ? null : w.pages.reduce((a, p) => (p.captured_at < a ? p.captured_at : a), w.pages[0].captured_at));
const newestPage = (w: HistoryWindow): Instant | null => (w.pages.length === 0 ? (w.failed?.at ?? null) : w.pages.reduce((a, p) => (p.captured_at > a ? p.captured_at : a), w.pages[0].captured_at));
const isFresh = (w: HistoryWindow, nowMs: number) => {
  const o = oldestPage(w);
  return o !== null && ageMin(o, nowMs) <= FRESH_MIN;
};
const isDone = (w: HistoryWindow) => w.complete && !w.failed && w.pages.length > 0;

/** True when a tool response is Claude Code's "saved to a file" notice for a result too large for the hook (V4 F5). */
export function isSavedFileNotice(response: unknown): boolean {
  const texts: string[] = [];
  const walk = (x: unknown) => {
    if (typeof x === "string") texts.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") for (const v of Object.values(x as Record<string, unknown>)) walk(v);
  };
  walk(response);
  return texts.some((t) => /exceeds maximum allowed tokens|has been saved to/i.test(t));
}

/**
 * The window a cursor page continues, or null (an orphan). With `since`/`until` in the read, only
 * that window; without them, the one window whose chain returned the cursor.
 */
export function chainOf(windows: Record<string, HistoryWindow>, since: string | undefined, until: string | undefined, cursor: string): string | null {
  const continues = (w: HistoryWindow) => w.pages.some((p) => p.next === cursor);
  if (since !== undefined || until !== undefined) {
    const k = windowKey(since, until);
    return windows[k] && continues(windows[k]) ? k : null;
  }
  const hits = Object.keys(windows).filter((k) => continues(windows[k]));
  return hits.length === 1 ? hits[0] : null;
}

/** Removes tags from the history (all of a window's, or one generation's pages from `fromIndex` on); a session no page holds any more leaves it. */
function dropTags(snap: Snapshot, key: string, page?: { gen: number; fromIndex: number }): void {
  const prefix = `${key}#`;
  const gone = (t: string) => {
    if (!t.startsWith(prefix)) return false;
    if (!page) return true;
    const [, gen, idx] = t.slice(key.length).split("#");
    return Number(gen) === page.gen && Number(idx) >= page.fromIndex;
  };
  snap.history = snap.history.filter((s) => {
    if (!s.windows) return true;
    s.windows = s.windows.filter((t) => !gone(t));
    return s.windows.length > 0;
  });
}

/**
 * The window fields of a history read, and `batch`: the assistant message that sent the request
 * (from the transcript, V7b finding 2), null or absent when it is not known.
 */
/** The split windows (one response with a nextCursor) that strictly hold this window's range. */
function splitParents(windows: Record<string, HistoryWindow>, key: string, input: { since?: string; until?: string }): string[] {
  const s0 = input.since ?? LOW;
  const u0 = input.until ?? HIGH;
  return Object.entries(windows)
    .filter(([k, w]) => k !== key && w.pages.length === 1 && w.pages[0].cursor === null && w.pages[0].next !== null && w.since !== undefined && w.until !== undefined)
    .filter(([, w]) => lo(w) <= s0 && hi(w) >= u0 && (lo(w) !== s0 || hi(w) !== u0))
    .map(([k]) => k);
}

/** Removes a window's tags from the sessions dated inside [since, until]; a session no page holds any more leaves. */
function dropTagsInRange(snap: Snapshot, key: string, since: string, until: string): void {
  const prefix = `${key}#`;
  snap.history = snap.history.filter((s) => {
    if (!s.windows || s.date < since || s.date > until) return true;
    s.windows = s.windows.filter((t) => !t.startsWith(prefix));
    return s.windows.length > 0;
  });
}

export type PageInput = {
  since?: CalendarDate;
  until?: CalendarDate;
  cursor?: string;
  batch?: string | null;
  /** V7c: the request's tool use id, kept so a message not yet in the transcript can be found later. */
  tool_use_id?: string | null;
  /** V7c: finds the message of a tool use id now (the transcript may have been written since). */
  resolve?: (toolUseId: string) => string | null;
};

/**
 * Merges one valid history page into the snapshot (in place). `sessions` are the page's sessions,
 * already parsed; `keyOf` is the session identity. Returns the window key, or null for an orphan.
 * Each session carries a tag per page that returned it (`<key>#<generation>#<page index>`), so a
 * page that is replaced or cut from the chain takes its sessions with it (V7 review finding 7).
 */
export function mergeHistoryPage(
  snap: Snapshot,
  input: PageInput,
  page: { sessions: SnapshotSession[]; next: string | null },
  now: Instant,
  keyOf: (s: SnapshotSession) => string,
): string | null {
  const windows = (snap.history_windows ??= {});
  let key: string;
  let index: number;
  let suspect = false;
  if (input.cursor === undefined) {
    key = windowKey(input.since, input.until);
    const old = windows[key];
    const gen = (old?.generation ?? 0) + 1;
    // A continuation of the old chain may still be in flight (V7 review finding 2, V7b finding 2): its
    // cursor is remembered with the message that sent this refresh. A request in that same message
    // was sent before this page's cursor existed, so it is the old read.
    const tail = old && !old.complete && !old.failed?.overflow && old.pages.length > 0 ? old.pages[old.pages.length - 1].next : null;
    dropTags(snap, key);
    // V7c, V7d: a split window's parts replace it, each only inside its own range and only when its
    // own response is whole (no nextCursor). Outside the ranges whole parts cover, the split window's
    // sessions stay as data (not coverage), so a note there (an urgent one included) is still scanned
    // when a sibling part fails. The split window goes once whole parts cover all its dates.
    if (page.next === null) {
      for (const parent of splitParents(windows, key, input)) dropTagsInRange(snap, parent, input.since ?? LOW, input.until ?? HIGH);
    }
    windows[key] = {
      ...(input.since ? { since: input.since } : {}),
      ...(input.until ? { until: input.until } : {}),
      generation: gen,
      pages: [{ cursor: null, next: page.next, captured_at: now }],
      complete: page.next === null,
      // V7d: a new first page after an ambiguous chain is a restart; the count stays for the session.
      ...(old?.ambiguous || old?.restarts ? { restarts: (old.restarts ?? 0) + (old.ambiguous ? 1 : 0) } : {}),
      ...(tail ? { superseded: [{ cursor: tail, batch: input.batch ?? null, ...(input.tool_use_id ? { tool_use_id: input.tool_use_id } : {}) }] } : {}),
    };
    index = 0;
  } else {
    const k = chainOf(windows, input.since, input.until, input.cursor);
    if (k === null) {
      snap.history_orphans = (snap.history_orphans ?? 0) + 1;
      recomputeHistoryCoverage(snap, now);
      return null;
    }
    key = k;
    const w = windows[key];
    const sup = w.superseded?.find((x) => x.cursor === input.cursor);
    if (sup) {
      // V7c: a message not in the transcript when the refresh was captured may be there now.
      if (sup.batch === null && sup.tool_use_id && input.resolve) sup.batch = input.resolve(sup.tool_use_id);
      const mine = input.batch ?? null;
      if (mine !== null && sup.batch !== null && mine === sup.batch) {
        // Sent with the refresh, so from the old generation: it counts for nothing, in either arrival order.
        snap.history_orphans = (snap.history_orphans ?? 0) + 1;
        recomputeHistoryCoverage(snap, now);
        return null;
      }
      // Sent in a known later message: this generation's page. The cursor stays remembered for the
      // whole generation, so an old read that lands after it is still dropped (either arrival order).
      // The message is not known: data, not coverage; the chain is ambiguous until a new first page.
      if (mine === null || sup.batch === null) suspect = true;
    }
    // V7d: a continuation whose own message is not known (the hook found no binding) is never
    // coverage, in the first generation too: the chain is ambiguous until a restart.
    if (!sup && input.batch === null) suspect = true;
    const i = w.pages.findIndex((p) => p.next === input.cursor);
    index = i + 1;
    // The pages from this position on are replaced: their sessions go unless another page holds them.
    dropTags(snap, key, { gen: w.generation, fromIndex: index });
    w.pages = [...w.pages.slice(0, index), { cursor: input.cursor, next: page.next, captured_at: now, ...(suspect ? { suspect: true } : {}) }];
    // A chain past 10 pages is failed, a terminal page included (V7 review finding 10). Only a new
    // first page clears it: a replay of an earlier page does not (V7b finding 12).
    if (suspect) w.ambiguous = true;
    if (w.pages.length > MAX_WINDOW_PAGES || w.failed?.overflow) {
      w.complete = false;
      w.failed = { at: w.failed?.overflow ? w.failed.at : now, reason: `more than ${MAX_WINDOW_PAGES} pages: read smaller windows`, overflow: true };
    } else if (w.ambiguous || w.failed) {
      // V7c: a chain with a failure or an unknown binding stays incomplete until a new first page.
      w.complete = false;
    } else {
      delete w.failed;
      w.complete = page.next === null && !w.pages.some((p) => p.suspect);
    }
  }
  const tag = `${key}#${windows[key].generation}#${index}`;
  // V4b: a 0.2.1 snapshot's sessions have no id, start time or server; one on a page's date is the
  // same session read again under the old rule, so it goes (a new capture always has a server).
  const pageDates = new Set(page.sessions.map((x) => x.date));
  snap.history = snap.history.filter((x) => !(pageDates.has(x.date) && !x.id && !x.startedAt && !x.server && !x.windows));
  const byKey = new Map(snap.history.map((s) => [keyOf(s), s]));
  for (const s of page.sessions) {
    const k = keyOf(s);
    const old = byKey.get(k);
    const tags = [...new Set([...(old?.windows ?? []), tag])];
    byKey.set(k, { ...s, windows: tags });
  }
  snap.history = [...byKey.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // V7d: a split window whose dates whole parts now all cover is gone, with its remaining tags.
  if (input.cursor === undefined && page.next === null) {
    for (const parent of splitParents(windows, key, input)) {
      const w = windows[parent];
      const parts = Object.entries(windows).filter(([k, x]) => k !== parent && x.pages.length === 1 && x.pages[0].cursor === null && x.pages[0].next === null && !x.failed && lo(x) >= lo(w) && hi(x) <= hi(w));
      let all = true;
      for (let d = lo(w); d <= hi(w) && all; d = addDays(d, 1)) if (!parts.some(([, x]) => lo(x) <= d && d <= hi(x))) all = false;
      if (all) {
        dropTags(snap, parent);
        delete windows[parent];
      }
    }
  }
  recomputeHistoryCoverage(snap, now);
  return key;
}

/**
 * A failed history read (an error, a malformed page, a saved-file notice): the window it names is
 * failed. V7c: the window keeps its generation, pages, `superseded` and overflow until a real first
 * page resets it; a failed page bound to the refresh's own message is the old read and changes
 * nothing; a failed continuation whose message is not known marks the chain ambiguous (only a new
 * first page clears it).
 */
export function markHistoryFailed(snap: Snapshot, input: PageInput, now: Instant, reason: string, oversized = false): void {
  const windows = (snap.history_windows ??= {});
  const key = input.cursor === undefined ? windowKey(input.since, input.until) : chainOf(windows, input.since, input.until, input.cursor);
  if (key === null) {
    // A failed page of no known chain: nothing it would have refreshed is known.
    snap.history_orphans = (snap.history_orphans ?? 0) + 1;
    recomputeHistoryCoverage(snap, now);
    return;
  }
  const old = windows[key];
  if (old && input.cursor !== undefined) {
    const sup = old.superseded?.find((x) => x.cursor === input.cursor);
    if (sup) {
      if (sup.batch === null && sup.tool_use_id && input.resolve) sup.batch = input.resolve(sup.tool_use_id);
      const mine = input.batch ?? null;
      if (mine !== null && sup.batch !== null && mine === sup.batch) {
        snap.history_orphans = (snap.history_orphans ?? 0) + 1;
        recomputeHistoryCoverage(snap, now);
        return;
      }
    }
    // A failed later page: the chain is ambiguous until a new first page restarts it.
    old.ambiguous = true;
  }
  windows[key] = {
    ...(old ?? {}),
    ...(input.since ?? old?.since ? { since: input.since ?? old?.since } : {}),
    ...(input.until ?? old?.until ? { until: input.until ?? old?.until } : {}),
    generation: old?.generation ?? 1,
    pages: old?.pages ?? [],
    complete: false,
    failed: { at: now, reason, ...(oversized ? { oversized: true } : {}), ...(old?.failed?.overflow ? { overflow: true } : {}), ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) },
  };
  recomputeHistoryCoverage(snap, now);
}

type Interval = { since: string; until: string; at: Instant };

/** Unions intervals that touch or overlap (inclusive dates). Each union keeps its oldest capture time. */
function union(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
  const out: Interval[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    const touches = last && (last.until === HIGH || x.since === LOW || x.since <= addDays(last.until, 1));
    if (last && touches) {
      if (x.until > last.until) last.until = x.until;
      if (x.at < last.at) last.at = x.at;
    } else out.push({ ...x });
  }
  return out;
}

/**
 * The summary the older consumers read (`history_coverage`: readiness, weeks): the union of the
 * complete windows fresh at `now` that reaches furthest forward, with the oldest page's time. With
 * no complete window: incomplete, with the reason when the latest read failed.
 */
export function recomputeHistoryCoverage(snap: Snapshot, now: Instant): void {
  const all = Object.values(snap.history_windows ?? {});
  if (all.length === 0) return;
  const nowMs = parseInstant(now, "now");
  const done = all.filter(isDone);
  const freshDone = done.filter((w) => isFresh(w, nowMs));
  const use = freshDone.length > 0 ? freshDone : done;
  if (use.length === 0) {
    const latest = all.reduce((a, w) => ((newestPage(w) ?? "") > (newestPage(a) ?? "") ? w : a), all[0]);
    snap.history_coverage = {
      captured_at: newestPage(latest) ?? now,
      complete: false,
      ...(latest.since ? { since: latest.since } : {}),
      ...(latest.until ? { until: latest.until } : {}),
      ...(latest.failed ? { reason: `the history read failed (${latest.failed.reason})` } : {}),
    };
    return;
  }
  const spans = union(use.map((w) => ({ since: lo(w), until: hi(w), at: oldestPage(w) as Instant })));
  const best = spans.reduce((a, s) => (s.until > a.until ? s : a), spans[0]);
  snap.history_coverage = {
    captured_at: best.at,
    complete: true,
    ...(best.since !== LOW ? { since: best.since } : {}),
    ...(best.until !== HIGH ? { until: best.until } : {}),
  };
}

/** Window length for the read plan: shorter windows for more sessions a week, so a window fits in one page of 10. */
export function windowDaysFor(sessionsPerWeek: number | undefined): number {
  return (sessionsPerWeek ?? 4) >= 5 ? 10 : 14;
}

/**
 * The windows that tile [since, until], newest first, each `windowDays` long; a remainder shorter
 * than half a window joins the oldest window. Each is a first-page read with `limit: 10`.
 */
export function planWindows(since: CalendarDate, until: CalendarDate, windowDays: number): ReadArgs[] {
  const out: ReadArgs[] = [];
  let end = until;
  while (end >= since) {
    let start = addDays(end, -(windowDays - 1));
    if (start < since) start = since;
    // A short remainder joins this window.
    if (start > since && diffDays(since, start) < Math.ceil(windowDays / 2)) start = since;
    out.push({ since: start, until: end, limit: HISTORY_PAGE_LIMIT });
    end = addDays(start, -1);
  }
  return out;
}

/** The legacy single-chain coverage (a snapshot with no windows: the files logger, or one captured before V7). */
function legacyCoverage(snap: Snapshot, since: CalendarDate, until: CalendarDate, nowMs: number, windowDays: number): HistoryCoverage {
  const cov = snap.history_coverage;
  const need = planWindows(since, until, windowDays);
  const whole = [{ since, until }];
  if (!cov) return { status: "missing", since, until, reason: "no workout history read in this session", gaps: whole, need };
  if (!cov.complete) {
    if (snap.warnings?.length) return { status: "failed", since, until, reason: `the plans files have rows the engine cannot read (${snap.warnings[0]})`, gaps: whole, need: [] };
    return { status: "missing", since, until, reason: cov.reason ?? "the history read is incomplete (more pages remain)", gaps: whole, need };
  }
  if (ageMin(cov.captured_at, nowMs) > FRESH_MIN) return { status: "stale", since, until, reason: `the history was read ${Math.round(ageMin(cov.captured_at, nowMs))} minutes ago (limit ${FRESH_MIN})`, gaps: whole, need };
  if ((cov.since ?? LOW) > since || (cov.until ?? HIGH) < until) {
    return { status: "missing", since, until, reason: `the history read covers ${cov.since ?? "the start"} to ${cov.until ?? "now"}, not ${since} to ${until}`, gaps: whole, need };
  }
  return { status: "complete", since, until, gaps: [], need: [] };
}

/**
 * Whether the history covers [since, until] (inclusive): every date in a complete window whose
 * every page is fresh. Otherwise the gaps, why, and the reads that would close them:
 * - a window with a page left: the next page (its own `since`, `until` and `cursor`);
 * - a failed window: read it again; a saved-file notice: two half windows;
 * - a stale window: read it again; a date no window names: the planned windows over the gap.
 * `failed` wins over `stale`, and `stale` over `missing`. A snapshot from another session is missing.
 */
export function historyCoverage(snap: Snapshot | null, since: CalendarDate, until: CalendarDate, nowMs: number, opts: { session_id?: string | null; windowDays?: number } = {}): HistoryCoverage {
  const windowDays = opts.windowDays ?? 14;
  const whole = [{ since, until }];
  if (!snap) return { status: "missing", since, until, reason: "no workout history read in this session", gaps: whole, need: planWindows(since, until, windowDays) };
  if (opts.session_id && snap.session_id !== opts.session_id) {
    return { status: "missing", since, until, reason: "the history was read in another session", gaps: whole, need: planWindows(since, until, windowDays) };
  }
  const windows = snap.history_windows;
  if (!windows || Object.keys(windows).length === 0) return legacyCoverage(snap, since, until, nowMs, windowDays);
  const good = Object.values(windows).filter((w) => isDone(w) && isFresh(w, nowMs));
  const gaps: { since: CalendarDate; until: CalendarDate }[] = [];
  for (let d = since; d <= until; d = addDays(d, 1)) {
    if (good.some((w) => lo(w) <= d && d <= hi(w))) continue;
    const last = gaps[gaps.length - 1];
    if (last && addDays(last.until, 1) === d) last.until = d;
    else gaps.push({ since: d, until: d });
  }
  if (gaps.length === 0) return { status: "complete", since, until, gaps: [], need: [] };
  const need: ReadArgs[] = [];
  const reasons: string[] = [];
  let failed = false;
  let stale = false;
  const seen = new Set<string>();
  const push = (r: ReadArgs) => {
    const k = JSON.stringify(r);
    if (!seen.has(k)) (seen.add(k), need.push(r));
  };
  for (const g of gaps) {
    const over = Object.values(windows).filter((w) => lo(w) <= g.until && hi(w) >= g.since);
    let handled = false;
    for (const w of over) {
      const s = w.since ?? g.since;
      const u = w.until ?? g.until;
      if (w.failed) {
        failed = true;
        reasons.push(`${s} to ${u}: ${w.failed.reason}`);
        if (w.failed.oversized && s < u) {
          const mid = addDays(s, Math.floor(diffDays(s, u) / 2));
          push({ since: s, until: mid, limit: HISTORY_PAGE_LIMIT });
          push({ since: addDays(mid, 1), until: u, limit: HISTORY_PAGE_LIMIT });
        } else push({ since: s, until: u, limit: HISTORY_PAGE_LIMIT });
        handled = true;
      } else if (!isFresh(w, nowMs) && w.pages.length > 0) {
        stale = true;
        reasons.push(`${s} to ${u}: read more than ${FRESH_MIN} minutes ago`);
        push({ since: s, until: u, limit: HISTORY_PAGE_LIMIT });
        handled = true;
      } else if (!w.complete && w.pages.length > 0) {
        if ((w.ambiguous || w.pages.some((p) => p.suspect)) && (w.restarts ?? 0) >= 1) {
          // V7d: one restart only, for every consumer of the chain: then the read is given up (unknown).
          failed = true;
          reasons.push(`${s} to ${u}: restarted once and still ambiguous: given up (unknown)`);
        } else if (w.ambiguous || w.pages.some((p) => p.suspect)) {
          // V7c: a chain with an unknown binding or a failure restarts from a new first page.
          reasons.push(`${s} to ${u}: a page may be from an older read; read the window again from its first page`);
          push({ since: s, until: u, limit: HISTORY_PAGE_LIMIT });
        } else {
          const next = w.pages[w.pages.length - 1].next;
          reasons.push(`${s} to ${u}: more pages remain`);
          if (next !== null) push({ since: s, until: u, limit: HISTORY_PAGE_LIMIT, cursor: next });
        }
        handled = true;
      }
    }
    if (!handled) {
      reasons.push(`${g.since} to ${g.until}: not read`);
      for (const r of planWindows(g.since, g.until, windowDays)) push(r);
    }
  }
  const status: CoverageStatus = failed ? "failed" : stale ? "stale" : "missing";
  return { status, since, until, reason: reasons.join("; "), gaps, need };
}

// ---------- V7c: atomic windows (the daily run) ----------

/**
 * The daily run's window: 7 days. At up to 9 sessions a week a window fits one page of 10, so it
 * needs no split; at 2 sessions every day a week splits once (into 4 and 3 days).
 */
export const ATOMIC_WINDOW_DAYS = 7;

/** A window read as one request and one response (no continuation page). */
const atomic = (w: HistoryWindow) => w.pages.length === 1 && w.pages[0].cursor === null;

/**
 * The daily run's coverage (contracts §9a, V7c). A window is one request and one response; a
 * response with a `nextCursor` is never continued: the window is `split` into two halves by date
 * (down to one day; one day that still has a `nextCursor` is `failed`, safety unknown). Complete
 * when windows whose single response has no `nextCursor`, fresh, tile every date. `need` names the
 * reads: the halves of a split window, the window again when it failed or is stale, the planned
 * windows over a date no window names. Continuation pages count for nothing here.
 */
export function atomicCoverage(snap: Snapshot | null, since: CalendarDate, until: CalendarDate, nowMs: number, opts: { session_id?: string | null; windowDays?: number } = {}): HistoryCoverage & { split: { since: CalendarDate; until: CalendarDate }[] } {
  const windowDays = opts.windowDays ?? ATOMIC_WINDOW_DAYS;
  const whole = [{ since, until }];
  const none = { split: [] as { since: CalendarDate; until: CalendarDate }[] };
  if (!snap) return { status: "missing", since, until, reason: "no workout history read in this session", gaps: whole, need: planWindows(since, until, windowDays), ...none };
  if (opts.session_id && snap.session_id !== opts.session_id) return { status: "missing", since, until, reason: "the history was read in another session", gaps: whole, need: planWindows(since, until, windowDays), ...none };
  const windows = Object.values(snap.history_windows ?? {}).filter((w) => w.pages.length === 0 || atomic(w));
  const fresh = (w: HistoryWindow) => w.pages.length === 1 && ageMin(w.pages[0].captured_at, nowMs) <= FRESH_MIN;
  const good = windows.filter((w) => !w.failed && w.pages.length === 1 && w.pages[0].next === null && fresh(w));
  const gaps: { since: CalendarDate; until: CalendarDate }[] = [];
  for (let d = since; d <= until; d = addDays(d, 1)) {
    if (good.some((w) => lo(w) <= d && d <= hi(w))) continue;
    const last = gaps[gaps.length - 1];
    if (last && addDays(last.until, 1) === d) last.until = d;
    else gaps.push({ since: d, until: d });
  }
  if (gaps.length === 0) return { status: "complete", since, until, gaps: [], need: [], ...none };
  const need: ReadArgs[] = [];
  const split: { since: CalendarDate; until: CalendarDate }[] = [];
  const reasons: string[] = [];
  let failed = false;
  let stale = false;
  const seen = new Set<string>();
  const push = (r: ReadArgs) => {
    const k = `${r.since}..${r.until}`;
    if (!seen.has(k)) (seen.add(k), need.push(r));
  };
  const halves = (s: CalendarDate, u: CalendarDate) => {
    const mid = addDays(s, Math.floor(diffDays(s, u) / 2));
    push({ since: s, until: mid, limit: HISTORY_PAGE_LIMIT });
    push({ since: addDays(mid, 1), until: u, limit: HISTORY_PAGE_LIMIT });
  };
  for (const g of gaps) {
    // The smallest windows over the gap first: a split window's halves stand for it.
    const over = windows.filter((w) => w.since && w.until && lo(w) <= g.until && hi(w) >= g.since).sort((a, b) => diffDays(lo(a), hi(a)) - diffDays(lo(b), hi(b)));
    const covered = new Set<string>();
    for (const w of over) {
      const s = w.since!;
      const u = w.until!;
      // Dates a smaller window over this gap already speaks for.
      const dates: string[] = [];
      for (let d = s > g.since ? s : g.since; d <= (u < g.until ? u : g.until); d = addDays(d, 1)) if (!covered.has(d)) dates.push(d);
      if (dates.length === 0) continue;
      for (let d = s; d <= u; d = addDays(d, 1)) covered.add(d);
      if (w.failed && !w.failed.oversized) {
        failed = true;
        reasons.push(`${s} to ${u}: ${w.failed.reason}`);
        push({ since: s, until: u, limit: HISTORY_PAGE_LIMIT });
      } else if (w.failed?.oversized || (w.pages.length === 1 && w.pages[0].next !== null)) {
        if (s === u) {
          failed = true;
          reasons.push(`${s}: one day has more sessions than one page holds (${HISTORY_PAGE_LIMIT}); it cannot be split`);
        } else {
          split.push({ since: s, until: u });
          reasons.push(`${s} to ${u}: more than one page: read it as two halves`);
          halves(s, u);
        }
      } else if (w.pages.length === 1 && !fresh(w)) {
        stale = true;
        reasons.push(`${s} to ${u}: read more than ${FRESH_MIN} minutes ago`);
        push({ since: s, until: u, limit: HISTORY_PAGE_LIMIT });
      }
    }
    // Dates of the gap no window names: the planned windows over them.
    let run: { since: CalendarDate; until: CalendarDate } | null = null;
    const flush = () => {
      if (run) {
        reasons.push(`${run.since} to ${run.until}: not read`);
        for (const r of planWindows(run.since, run.until, windowDays)) push(r);
      }
      run = null;
    };
    for (let d = g.since; d <= g.until; d = addDays(d, 1)) {
      if (covered.has(d)) {
        flush();
        continue;
      }
      if (run && addDays((run as { until: CalendarDate }).until, 1) === d) (run as { until: CalendarDate }).until = d;
      else {
        flush();
        run = { since: d, until: d };
      }
    }
    flush();
  }
  const status: CoverageStatus = failed ? "failed" : stale ? "stale" : "missing";
  return { status, since, until, reason: reasons.join("; "), gaps, need, split };
}
