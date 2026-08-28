export const sanitizePageUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "about:") return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
};

export const redactVisibleText = (value: string): string =>
  value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{10,})?\b/gu,
      "[redacted-token]",
    )
    .replace(
      /\b(?:bearer|authorization)\s+[A-Za-z0-9._~+/-]{12,}\b/giu,
      "[redacted-token]",
    )
    .replace(
      /\b(password|passwd|secret|api[_ -]?key)\s*[:=]\s*\S+/giu,
      "$1: [redacted]",
    )
    .replace(/\b(?:\+?1[ .-]?)?(?:\d{3}[ .-]?){2}\d{4}\b/gu, "[redacted-phone]")
    .slice(0, 12_000);

/** Trusted DOM filter; model commands cannot alter or bypass this selector. */
export const SENSITIVE_OBSERVATION_SELECTOR = [
  "input",
  "textarea",
  "select",
  "option",
  "[contenteditable]",
  '[id*="user" i]',
  '[class*="user" i]',
  '[id*="email" i]',
  '[class*="email" i]',
  '[id*="account" i]',
  '[class*="account" i]',
  '[id*="profile" i]',
  '[class*="profile" i]',
  '[aria-label*="user" i]',
  '[aria-label*="email" i]',
  '[aria-label*="account" i]',
  '[data-testid*="user" i]',
  '[data-testid*="account" i]',
].join(",");
