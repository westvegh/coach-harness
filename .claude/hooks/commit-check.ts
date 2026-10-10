// Stop (docs/contracts.md §13 and §20 item 27). Built-ins entry; the work is in
// commit-check.body.ts. Engine cannot load: no coach.yaml is exit 0 with no output; with
// coach.yaml the first stop is blocked with the reason and the second only warns.
import { bootHook, emit, missing } from "./bootstrap.ts";

await bootHook(new URL("./commit-check.body.ts", import.meta.url), ({ input, configured, detail }) => {
  if (!configured) return;
  if (input?.stop_hook_active === true) emit({ systemMessage: `commit-check: ${missing(detail)}` });
  else emit({ decision: "block", reason: missing(detail) });
});
