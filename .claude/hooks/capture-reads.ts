// PostToolUse on logger reads and writes (docs/contracts.md §9 and §20 item 27).
// Built-ins entry; the work is in capture-reads.body.ts. Engine cannot load: no
// coach.yaml is exit 0 with no output; with coach.yaml the reason goes to stderr, exit 2.
import { bootHook, missing } from "./bootstrap.ts";

await bootHook(new URL("./capture-reads.body.ts", import.meta.url), ({ configured, detail }) => {
  if (!configured) return;
  process.stderr.write(`capture-reads: ${missing(detail)}\n`);
  process.exitCode = 2;
});
