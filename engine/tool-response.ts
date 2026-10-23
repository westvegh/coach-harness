// The JSON payload of a hook's `tool_response` (contracts §9). Its own module, with no imports, so
// engine/tally-shape.ts can read a hook-style response without loading the snapshot code (W1:
// the input checks add under 5 ms to a command).

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The JSON payload of a hook's `tool_response`: an array of {type: "text", text} blocks
 * (spike #8), or an object with `content` holding them. Null when no block parses as
 * JSON (an error message, for example).
 */
export function responsePayload(toolResponse: unknown): unknown {
  let blocks: unknown = toolResponse;
  if (isPlainObject(toolResponse) && Array.isArray(toolResponse.content)) {
    if (toolResponse.isError === true) return null;
    blocks = toolResponse.content;
  }
  if (typeof blocks === "string") blocks = [{ type: "text", text: blocks }];
  if (!Array.isArray(blocks)) return isPlainObject(toolResponse) && !("content" in toolResponse) ? toolResponse : null;
  for (const b of blocks) {
    if (isPlainObject(b) && b.type === "text" && typeof b.text === "string") {
      try {
        return JSON.parse(b.text);
      } catch {
        /* not JSON: try the next block */
      }
    }
  }
  return null;
}

