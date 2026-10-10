// Scenario 14: a stale snapshot (another session, 2 hours old). A write
// sent before a fresh read is denied; after a fresh read the same change goes through.
import { versionOf } from "../mock-tally/client.ts";
import { check, day, seedDay, tallyToolUses } from "../lib/checks.ts";
import type { Scenario } from "../lib/types.ts";
import { persona, YES_TO_TALLY } from "./_common.ts";

const scenario: Scenario = {
  name: "14-stale-snapshot",
  title: "Stale snapshot: the write is denied until a fresh read",
  mode: "interactive",
  skills: [],
  approver: YES_TO_TALLY,
  prompt: ({ today }) =>
    `Change the Romanian Deadlift in today's session (${today}) to 2 sets. Send the update_planned_workout call right away, before any read. ` +
    "Read the day only if that write is refused, then make the change.",
  setup(ctx) {
    persona(ctx);
    const row = (ctx.mock.days as any)[ctx.today];
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    const snapshot = {
      version: 1,
      session_id: "an-earlier-session",
      captured_at: old,
      timezone: ctx.tz,
      days: {
        [ctx.today]: {
          found: true,
          version: versionOf({ id: row.id, updated_at: row.updated_at }),
          updatedAt: row.updated_at,
          source: "mcp",
          userModified: false,
          skipped: false,
          dayName: row.day_name,
          dayType: row.day_type,
          exercises: row.exercises,
          weightUnit: "lbs",
          weightUnitSource: "settings",
          captured_at: old,
        },
      },
      history: [],
      weightUnit: "lbs",
      weightUnitSource: "settings",
    };
    ctx.write("athlete/.cache/snapshot.json", JSON.stringify(snapshot, null, 2) + "\n");
  },
  check(a) {
    const writes = tallyToolUses(a);
    const first = writes[0];
    const firstIdx = first ? a.tools.indexOf(first) : -1;
    const readAfter = a.tools.findIndex((t, i) => i > firstIdx && /__get_planned_workout$/.test(t.name) && t.input?.date === a.today);
    const after = day(a, a.today);
    const rdl = (after?.exercises ?? []).find((e: any) => e.name === "Romanian Deadlift");
    const rest = (r: any) => JSON.stringify((r?.exercises ?? []).filter((e: any) => e.name !== "Romanian Deadlift"));
    return [
      check("the first write (before any read) is denied with a read-first reason", !!first?.result?.isError && /read|refresh|snapshot|stale|session/i.test(first.result.text), first?.result?.text.slice(0, 200) ?? "no write attempted"),
      check("a fresh read of today follows the denial", firstIdx !== -1 && readAfter > firstIdx),
      check("after the fresh read the change is in Tally (2 sets)", rdl?.suggestedSets === 2, JSON.stringify(rdl)),
      check("nothing else changed", rest(seedDay(a, a.today)) === rest(after)),
    ];
  },
};
export default scenario;
