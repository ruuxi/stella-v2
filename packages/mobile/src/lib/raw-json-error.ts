/**
 * True when a message looks like a raw JSON parse failure (Hermes: "JSON
 * Parse error: Unexpected character: <"; V8: "Unexpected token < in JSON").
 * Used as a last-resort net so no such message ever reaches the user.
 */
export const isRawJsonParseErrorMessage = (message: string): boolean => {
  const lower = message.toLowerCase();
  return (
    lower.includes("json parse") ||
    (lower.includes("unexpected") &&
      (lower.includes("token") || lower.includes("character")) &&
      lower.includes("json")) ||
    /unexpected (character|token|end of (json )?input)/i.test(message)
  );
};
