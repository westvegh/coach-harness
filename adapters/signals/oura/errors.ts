// Error text for the Oura adapter. Nothing from the provider or the transport reaches a
// message: a response body, an error_description, an exception message or a header could
// echo a token or the client secret. Messages are fixed text plus values from allowlists.
import { CoachError } from "../../../engine/errors.ts";

/** OAuth 2.0 error codes (RFC 6749 §4.1.2.1 and §5.2). Anything else is reported as "unknown". */
export const OAUTH_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "unsupported_response_type",
  "invalid_scope",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
]);

export function oauthCode(v: unknown): string {
  return typeof v === "string" && OAUTH_ERROR_CODES.has(v) ? v : "unknown";
}

/** Network error codes that are safe to show (Node and undici). */
const NET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function isTimeout(e: unknown): boolean {
  const name = (e as { name?: unknown })?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** A transport failure as a CoachError with fixed text. `what` is our own label, never provider text. */
export function transportError(e: unknown, what: string): CoachError {
  if (isTimeout(e)) return new CoachError("OURA_TIMEOUT", `${what} timed out`);
  const cause = (e as { cause?: { code?: unknown } })?.cause?.code ?? (e as { code?: unknown })?.code;
  const code = typeof cause === "string" && NET_CODES.has(cause) ? ` (${cause})` : "";
  return new CoachError("OURA_NETWORK", `${what} failed: network error${code}`);
}

/** For the CLIs: a CoachError as is (its text is ours); anything else as a fixed message. */
export function formatCliError(e: unknown): { code: string; message: string } {
  if (e instanceof CoachError) return { code: e.code, message: e.message };
  const name = e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "error";
  return { code: "INTERNAL", message: `unexpected ${name}; no details are shown because they could contain a credential` };
}
