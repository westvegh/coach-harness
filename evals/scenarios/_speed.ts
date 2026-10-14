// V7 speed checks, shared by scenarios 34 and 35: main-thread API calls in the turn, the initial
// Tally reads in one assistant message, post after them, and the evidence behind the speed. Speed
// never comes from skipped work (V7b finding 13): every read pre named was made and answered, post
// saw complete coverage, each engine command succeeded, a write (35) was prepared with its opId,
// sent and read back before save, and save published the run's log entry.
import { check } from "../lib/checks.ts";
import type { Check, RunArtifacts, ToolUse } from "../lib/types.ts";

const isRead = (t: ToolUse, tool: string) => t.name.endsWith(`__${tool}`);
const bash = (t: ToolUse, re: RegExp) => t.name === "Bash" && re.test(String(t.input?.command ?? ""));
const json = (t: ToolUse | undefined): any => {
  try {
    return t?.result && !t.result.isError ? JSON.parse(t.result.text) : null;
  } catch {
    return null;
  }
};
/** Every key of `want` is in `got` with the same value. */
const sub = (want: Record<string, unknown>, got: Record<string, unknown> | undefined) => !!got && Object.entries(want).every(([k, v]) => JSON.stringify(got[k]) === JSON.stringify(v));
const okResult = (t: ToolUse) => !!t.result && !t.result.isError && !/"error"\s*:/.test(t.result.text.slice(0, 200));

/** Main-thread calls of the first turn (the runner counts one per assistant message id). */
export function mainCallsOf(a: RunArtifacts): number | null {
  return a.turns?.[0]?.mainCalls ?? null;
}

/** The first assistant message that reads the history, and the tool uses it holds. */
export function firstReadBatch(a: RunArtifacts): ToolUse[] {
  const first = a.tools.find((t) => isRead(t, "get_workout_history"));
  if (!first?.messageId) return first ? [first] : [];
  return a.tools.filter((t) => t.messageId === first.messageId);
}

/** The pieces of a run the speed checks read: pre, the last post, save, and their indexes. */
export function speedPieces(a: RunArtifacts) {
  const preTool = a.tools.find((t) => bash(t, /today-brief --stage pre/));
  const posts = a.tools.filter((t) => bash(t, /today-brief --stage post/));
  const saveTool = [...a.tools].reverse().find((t) => bash(t, /node engine\/cli\.ts save --run r-\d{8}-\d{4}-[0-9a-f]{4}/) && !/--part /.test(String(t.input?.command)));
  return { pre: json(preTool), preTool, post: json(posts[posts.length - 1]), posts, save: json(saveTool), saveTool, saveAt: saveTool ? a.tools.indexOf(saveTool) : -1 };
}

export function speedChecks(a: RunArtifacts, budget: number, opts: { write?: boolean } = {}): Check[] {
  const calls = mainCallsOf(a);
  const batch = firstReadBatch(a);
  const { pre, post, posts, save, saveTool, saveAt } = speedPieces(a);
  const expected: { tool: string; args: Record<string, unknown> }[] = Array.isArray(pre?.reads) ? pre.reads : [];
  const made = expected.map((r) => a.tools.find((t) => isRead(t, r.tool) && sub(r.args, t.input) && okResult(t)));
  const missingReads = expected.filter((_, i) => !made[i]).map((r) => `${r.tool} ${JSON.stringify(r.args)}`);
  const inBatch = made.filter((t) => t && batch.includes(t)).length;
  const lastOfBatch = batch.length ? Math.max(...batch.map((t) => a.tools.indexOf(t))) : -1;
  const postAt = posts.length ? a.tools.indexOf(posts[0]) : -1;
  const cov = post?.coverage;
  const coverageOk = !!cov && cov.history?.status === "complete" && cov.safety_notes === "complete" && Object.values(cov.days ?? {}).every((d) => d === "complete") && Array.isArray(post?.need_reads) && post.need_reads.length === 0;
  let snap: any = null;
  try {
    snap = JSON.parse(a.after["athlete/.cache/snapshot.json"] ?? "null");
  } catch {
    snap = null;
  }
  const dayReads = expected.filter((r) => r.tool === "get_planned_workout").map((r) => String(r.args.date));
  const windowReads = expected.filter((r) => r.tool === "get_workout_history").map((r) => `${r.args.since ?? ""}..${r.args.until ?? ""}`);
  const windows = snap?.history_windows ?? {};
  const snapOk = !!snap && dayReads.every((d) => snap.days?.[d]) && windowReads.length > 0 && windowReads.every((k) => windows[k]?.complete === true) && !!snap.planned;
  const commandsOk = !!pre && !pre.error && posts.length > 0 && posts.every((t) => okResult(t)) && !!save && save.outcome === "published";
  const entry = runEntry(a, pre?.run_id);
  const out: Check[] = [
    check(`at most ${budget} main-thread calls in the turn`, calls !== null && calls <= budget, `${calls} calls; wall ${a.turns?.[0]?.durationMs ?? a.result.durationMs} ms`),
    check("every read pre named was made and answered (today, the context, each past date, each window)", expected.length >= 6 && missingReads.length === 0 && expected.some((r) => r.tool === "get_training_context"), `${expected.length} named; missing ${JSON.stringify(missingReads)}`),
    check("the initial reads in one message", expected.length > 0 && inBatch === expected.length, `${inBatch} of ${expected.length} in the first read message`),
    check("post runs after the reads and sees complete coverage, nothing left to read", postAt > lastOfBatch && lastOfBatch >= 0 && coverageOk, JSON.stringify(cov ?? null).slice(0, 200)),
    check("the snapshot holds every day pre named, the context and complete windows", snapOk, `${Object.keys(windows).length} windows; days ${dayReads.filter((d) => snap?.days?.[d]).length}/${dayReads.length}`),
    check("pre, post and save succeeded; save published", commandsOk, JSON.stringify({ pre: !!pre, posts: posts.length, outcome: save?.outcome ?? null })),
    // V7c item 3: safety before writes: no plan write before post's note scan.
    check("no plan write before post's note scan", (() => {
      const firstWrite = a.tools.findIndex((t) => /__(update_planned_workout|plan_workout_day|plan_workout_range|move_planned_workout|skip_planned_workout|delete_planned_workout)$/.test(t.name) || bash(t, /node engine\/cli\.ts plans write/));
      return firstWrite === -1 || (postAt >= 0 && firstWrite > postAt);
    })(), `post at ${postAt}`),
    check("the commit reached the remote's main", a.pushedMain.length > 0 && a.commits.some((c) => c.files.some((f) => f.startsWith("athlete/log/")) && a.pushedMain.includes(c.sha)), `${a.pushedMain.length} pushed`),
  ];
  if (!opts.write) out.push(check("the run's no-change entry was saved with its run line and the readiness line", entry !== null && /· no-change\n/.test(entry) && /\n- readiness: wearable \w+ \(/.test(entry) && /→ none\n/.test(entry) && /\n- change: none \(/.test(entry), (entry ?? "").slice(0, 300)));
  if (opts.write) {
    const prepTool = [...a.tools].reverse().find((t) => bash(t, /node engine\/cli\.ts today-write-prep --input/) && okResult(t));
    const prep = json(prepTool);
    const opIds = [prep?.write?.plain?.args?.opId, prep?.write?.approved?.args?.opId].filter((x) => typeof x === "string");
    const writeTool = a.tools.find((t) => /__(update_planned_workout|plan_workout_day)$/.test(t.name));
    const writeAt = writeTool ? a.tools.indexOf(writeTool) : -1;
    const readBack = a.tools.find((t, i) => i > writeAt && writeAt >= 0 && isRead(t, "get_planned_workout") && t.input?.date === a.today && okResult(t) && /"found"\s*:\s*true/.test(t.result!.text));
    const readBackAt = readBack ? a.tools.indexOf(readBack) : -1;
    const logged = writeEntry(a, writeTool?.input?.opId);
    out.push(
      check("the write's log entry: its opId and a successful result", logged !== null && /\n- result: (written|updated)\b/.test(logged), (logged ?? "").slice(0, 200)),
      check("today-write-prep succeeded, with an opId", !!prepTool && opIds.length > 0 && a.tools.indexOf(prepTool) < writeAt, `opIds ${opIds.length}`),
      check("the write sent the prepared opId and succeeded", !!writeTool && opIds.includes(writeTool.input?.opId) && okResult(writeTool), JSON.stringify(writeTool?.input?.opId ?? null)),
      check("a successful read-back of today after the write, before save", readBackAt > writeAt && writeAt >= 0 && readBackAt < saveAt, `write ${writeAt}, read-back ${readBackAt}, save ${saveAt}`),
    );
  }
  void saveTool;
  return out;
}

/** The log entry (new in this run) that ends with this run's line, or null. */
export function runEntry(a: RunArtifacts, runId: unknown): string | null {
  if (typeof runId !== "string") return null;
  for (const [p, text] of Object.entries(a.after)) {
    if (!p.startsWith("athlete/log/") || !p.endsWith(".md") || text === null) continue;
    const before = a.before[p] ?? "";
    const added = text.startsWith(before) ? text.slice(before.length) : text;
    const block = added.split(/\n(?=## )/).find((b) => b.split("\n").includes(`- run: ${runId}`));
    if (block) return block;
  }
  return null;
}

/** The log entry (new in this run) for a write with this opId (the log-writes hook names it in the heading). */
export function writeEntry(a: RunArtifacts, opId: unknown): string | null {
  if (typeof opId !== "string") return null;
  for (const [p, text] of Object.entries(a.after)) {
    if (!p.startsWith("athlete/log/") || !p.endsWith(".md") || text === null) continue;
    const before = a.before[p] ?? "";
    const added = text.startsWith(before) ? text.slice(before.length) : text;
    const block = added.split(/\n(?=## )/).find((b) => b.includes(opId));
    if (block) return block;
  }
  return null;
}
