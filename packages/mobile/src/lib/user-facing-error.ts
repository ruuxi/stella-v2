import { isRawJsonParseErrorMessage } from "./bridge-http";

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

  if (isRawJsonParseErrorMessage(t)) {
    return "Your computer sent an unexpected response. Update Stella on your desktop, then try again.";
  }
  const lower = t.toLowerCase();

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
