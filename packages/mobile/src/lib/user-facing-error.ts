import { isRawJsonParseErrorMessage } from "./bridge-http";

/**
 * Maps errors and raw API messages to short, user-facing copy (no stack traces).
 */
export function userFacingError(error: unknown): string {
  if (error instanceof Error) {
    return mapMessage(error.message);
  }
  return "Something went wrong. Please try again.";
}

function mapMessage(raw: string): string {
  const t = raw.trim();
  if (!t) {
    return "Something went wrong. Please try again.";
  }
  // Last-resort net: parse sites are individually guarded, but no raw
  // JSON-parse garbage ("Unexpected character: <") may ever reach a bubble
  // or toast, whatever path produced it.
  if (isRawJsonParseErrorMessage(t)) {
    return "Your computer sent an unexpected response. Update Stella on your desktop, then try again.";
  }
  const lower = t.toLowerCase();
  // Structured version-skew signal (BridgeEndpointUnavailableError) that
  // escaped a capability gate — phrase it as the actionable thing it is.
  if (lower.includes("endpoint unavailable")) {
    return "Your computer sent an unexpected response. Update Stella on your desktop, then try again.";
  }
  if (
    lower.includes("usage")
    && (lower.includes("limit") || lower.includes("reached"))
  ) {
    return "You’ve reached the limit for now. Try again in a little while.";
  }
  if (lower.includes("429") || lower.includes("too many")) {
    return "Too many requests. Wait a moment and try again.";
  }
  if (
    lower.includes("unauthorized")
    || lower.includes("401")
    || (lower.includes("session")
      && (lower.includes("expired")
        || lower.includes("revoked")
        || lower.includes("sign in")))
  ) {
    return "Your session expired. Sign in again.";
  }
  if (
    lower.includes("network")
    || lower.includes("fetch")
    || lower.includes("failed to connect")
  ) {
    return "Check your connection and try again.";
  }
  if (t.length > 160) {
    return "Something went wrong. Please try again.";
  }
  return t;
}
