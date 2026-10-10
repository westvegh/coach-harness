// PostToolUse on logger mutations (docs/contracts.md §9 and §20 item 27). Built-ins
// entry; the work is in log-writes.body.ts. Engine cannot load: no coach.yaml is exit 0
// with no output; with coach.yaml the reason goes to stderr, exit 2.
import { bootHook, missing } from "./bootstrap.ts";

await bootHook(new URL("./log-writes.body.ts", import.meta.url), ({ configured, detail }) => {
  if (!configured) return;
  process.stderr.write(`log-writes: ${missing(detail)}\n`);
  process.exitCode = 2;
});
