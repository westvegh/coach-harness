// SessionStart (docs/contracts.md §13). Built-ins entry (docs/contracts.md §20 item 27); the
// work is in session-context.body.ts. Engine cannot load: one line of context.
import { bootHook, context, missing } from "./bootstrap.ts";

await bootHook(new URL("./session-context.body.ts", import.meta.url), ({ configured, detail }) => {
  if (!configured) return context("SessionStart", "coach-harness is not set up. Run `npm ci`, then say 'set me up'.");
  context("SessionStart", `${missing(detail)} Until then the urgent stop, limits and due items cannot be read here: read athlete/limits.md (and an old athlete/limits.yaml, if there is one), and check for athlete/.urgent-stop, before any plan.`);
});
