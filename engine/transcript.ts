// V7b: the assistant message that sent a tool call, from Claude Code's transcript (JSONL). The
// capture hook uses it to bind a history page to the request that produced it (contracts §9a):
// Tally's requests cannot carry a generation, but every tool use belongs to one assistant message,
// and Claude Code runs a message's tool calls (and their hooks) before the next model call.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** How much of the transcript's end is read: the current message is near the end. */
export const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

/** The id of the assistant message holding the tool use, or null when it cannot be found. */
export function requestMessage(transcriptPath: unknown, toolUseId: unknown): string | null {
  if (typeof transcriptPath !== "string" || transcriptPath === "" || typeof toolUseId !== "string" || toolUseId === "") return null;
  let text: string;
  try {
    const fd = openSync(transcriptPath, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line.includes(toolUseId)) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = ev?.message;
    if (ev?.type !== "assistant" || typeof msg?.id !== "string" || !Array.isArray(msg.content)) continue;
    if (msg.content.some((b: any) => b?.type === "tool_use" && b.id === toolUseId)) return msg.id;
  }
  return null;
}
