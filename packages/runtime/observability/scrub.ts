const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const BEARER = /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEYED_SECRET =
  /\b(?:api[_-]?key|secret|password|passwd|pwd|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?token|cookie)\b\s*[:=]\s*["']?[^\s"',}]{6,}/gi;
const SK_KEY = /\b(?:sk|pk|rk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9]{16,}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

const LONG_BLOB = /\b[A-Za-z0-9+/]{60,}={0,2}\b/g;
const LONG_HEX = /\b[0-9a-f]{48,}\b/gi;

const PHONE = /(?<!\d)\+?\d[\d\s().-]{8,}\d(?!\d)/g;

export const scrubText = (input: string): string => {
  if (!input) return input;
  return input
    .replace(JWT, "<redacted-jwt>")
    .replace(BEARER, "<redacted-token>")
    .replace(KEYED_SECRET, (match) => {
      const key = match.split(/[:=]/, 1)[0]?.trim() ?? "secret";
      return `${key}=<redacted>`;
    })
    .replace(SK_KEY, "<redacted-key>")
    .replace(EMAIL, "<email>")
    .replace(PHONE, "<phone>")
    .replace(LONG_BLOB, "<redacted>")
    .replace(LONG_HEX, "<redacted>");
};

const MAX_VALUE_LENGTH = 512;

export const scrubFieldValue = (value: unknown): string => {
  if (value == null) return "";
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  } else if (value instanceof Error) {
    text = value.message;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_VALUE_LENGTH) {
    text = `${text.slice(0, MAX_VALUE_LENGTH)}…(${text.length})`;
  }
  return scrubText(text);
};
