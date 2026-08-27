function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message).toLowerCase();
  }
  return "";
}

export function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("abort") || msg.includes("cancel")) return true;
    if (error.name === "AbortError") return true;
  }
  return false;
}

const CONTEXT_OVERFLOW_RE =
  /(context length|context window|too many tokens|max(?:imum)? context|prompt(?:\s+is)? too long|token limit|context_length_exceeded)/i;

export function isContextOverflowError(error: unknown): boolean {
  const msg = getErrorMessage(error);
  if (msg.length === 0) return false;
  return CONTEXT_OVERFLOW_RE.test(msg);
}

export function matchesRetryablePattern(error: unknown): boolean {
  const msg = getErrorMessage(error);
  if (msg.length === 0) return false;
  return (
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("429") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("invalid api key") ||
    msg.includes("authentication") ||
    msg.includes("model not found") ||
    msg.includes("temporarily unavailable") ||
    msg.includes("upstream")
  );
}

export function isConvexInternalError(error: unknown): boolean {
  const msg = getErrorMessage(error);
  return msg.includes("convex") && msg.includes("function");
}

export function isToolLoopExhaustionError(error: unknown): boolean {
  if (error instanceof Error && error.name === "ToolLoopExhaustedError") {
    return true;
  }
  const msg = getErrorMessage(error);
  return msg.includes("tool loop exhausted") || msg.includes("maxsteps=");
}
