// Tally's planned-day version token (workout-api/lib/mcp/version.ts):
// base64url("<id>|<updated_at or ''>"). Opaque to callers; the snapshot re-encodes it
// after a skip, whose result carries only the new updatedAt.

export function encodeTallyVersion(id: string, updatedAt: string | null): string {
  return Buffer.from(`${id}|${updatedAt ?? ""}`, "utf8").toString("base64url");
}

export function decodeTallyVersion(token: string): { id: string; updatedAt: string | null } | null {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,400}$/.test(token)) return null;
  const text = Buffer.from(token, "base64url").toString("utf8");
  if (Buffer.from(text, "utf8").toString("base64url") !== token) return null;
  const bar = text.indexOf("|");
  if (bar <= 0) return null;
  const updatedAt = text.slice(bar + 1);
  return { id: text.slice(0, bar), updatedAt: updatedAt === "" ? null : updatedAt };
}
