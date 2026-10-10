// Stop (docs/contracts.md §13): uncommitted changes under athlete/ block the first stop with a
// reason; the second stop (stop_hook_active) only warns, so it never loops.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { emit, projectRoot, readInput, runHook } from "./lib.ts";

runHook("commit-check", () => {
  const input = readInput();
  const root = projectRoot();
  let status: string;
  try {
    status = execFileSync("git", ["status", "--porcelain", "--", "athlete/"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (input.stop_hook_active) return;
    throw new Error(`cannot read git status: ${(e as Error).message.split("\n")[0]}`);
  }
  const files = status.split("\n").filter(Boolean).map((l) => l.slice(3));
  if (files.length === 0) return;
  const list = files.slice(0, 10).join(", ") + (files.length > 10 ? `, and ${files.length - 10} more` : "");
  if (input.stop_hook_active) {
    emit({ systemMessage: `commit-check: athlete/ still has uncommitted changes: ${list}` });
    return;
  }
  // athlete/.safety-pending is committed too: cloud runs
  // start from fresh clones and must see an unresolved pain flag.
  const pending = (files.includes("athlete/.safety-pending") || (files.includes("athlete/") && existsSync(join(root, "athlete/.safety-pending"))))
    ? " athlete/.safety-pending is committed like the other athlete files (cloud runs need it; it holds only terms and a time). Never delete it to clean up."
    : "";
  emit({ decision: "block", reason: `Uncommitted changes in athlete/: ${list}. Commit them (git add athlete && git commit) and push, or say why not.${pending}` });
});
