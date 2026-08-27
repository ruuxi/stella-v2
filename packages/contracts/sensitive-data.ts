const SENSITIVE_KEY_RE =
  /(authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|client[-_]?secret|session|csrf|x[-_]api[-_]?key)/i;
const PRIVATE_KEY_RE =
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g;
const URL_SECRET_RE =
  /([?&](?:api[-_]?key|token|access_token|refresh_token|session|secret|password)=)([^&#\s]+)/gi;
const AUTH_HEADER_RE =
  /\b(authorization|proxy-authorization)\s*:\s*([^\n\r]+)/gi;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*\b/gi;
const BASIC_RE = /\b(Basic)\s+[A-Za-z0-9+/=]+\b/gi;
const COOKIE_INLINE_RE = /\b(cookie|set-cookie)\s*:\s*([^\n\r;]+)/gi;
const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;

const AWS_SECRET_LABEL_RE =
  /\b(aws\s+secret(?:\s+access)?\s+key\s*[:=]?\s*['"]?)([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi;

const AWS_SECRET_KEY_RE =
  /\b((?:aws|secret)[A-Za-z0-9_]*['"\s:=-]+)([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi;

const SK_TOKEN_RE = /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g;

const ASSIGNMENT_RE =
  /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/g;

const SECRET_KEY_TOKENS = new Set([
  "token",
  "secret",
  "key",
  "password",
  "passwd",
  "pwd",
  "auth",
  "cookie",
  "bearer",
  "credential",
]);

const FUSED_SECRET_KEYS = [
  "apikey",
  "apisecret",
  "apitoken",
  "authtoken",
  "authorization",
  "accesskey",
  "accesstoken",
  "secretkey",
  "secrettoken",
  "clientsecret",
  "clientkey",
  "privatekey",
  "sessiontoken",
  "bearertoken",
  "password",
  "passwd",
  "passphrase",
];

const HIGH_ENTROPY_VALUE_RE = /^[A-Za-z0-9+_=-]{24,}$/;
const SECRET_FLAG_RE =
  /(\s--?(?:api[-_]?key|token|secret|password|passwd|authorization))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi;

const splitKeyTokens = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean);

const keyLooksSensitive = (key: string): boolean => {
  if (
    splitKeyTokens(key).some((token) =>
      SECRET_KEY_TOKENS.has(token.toLowerCase()),
    )
  ) {
    return true;
  }

  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return FUSED_SECRET_KEYS.includes(normalized);
};

const assignmentValueIsSensitive = (rawValue: string): boolean => {
  const quoted =
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"));
  if (quoted) return true;
  if (!HIGH_ENTROPY_VALUE_RE.test(rawValue)) return false;
  return /[A-Za-z]/.test(rawValue) && /[0-9]/.test(rawValue);
};

const redactAssignment = (
  match: string,
  key: string,
  rawValue: string,
): string =>
  keyLooksSensitive(key) || assignmentValueIsSensitive(rawValue)
    ? `${key}=[REDACTED]`
    : match;

export const redactSensitiveText = (input: string): string =>
  input
    .replace(PRIVATE_KEY_RE, "[REDACTED PRIVATE KEY]")
    .replace(URL_SECRET_RE, "$1[REDACTED]")
    .replace(AUTH_HEADER_RE, "$1: [REDACTED]")
    .replace(BEARER_RE, "$1 [REDACTED]")
    .replace(BASIC_RE, "$1 [REDACTED]")
    .replace(COOKIE_INLINE_RE, "$1: [REDACTED]")
    .replace(JWT_RE, "[REDACTED]")
    .replace(AWS_ACCESS_KEY_RE, "[REDACTED]")
    .replace(AWS_SECRET_LABEL_RE, "$1[REDACTED]")
    .replace(AWS_SECRET_KEY_RE, "$1[REDACTED]")
    .replace(SK_TOKEN_RE, "[REDACTED]")
    .replace(ASSIGNMENT_RE, redactAssignment)
    .replace(SECRET_FLAG_RE, "$1 [REDACTED]");

export const sanitizeSensitiveData = (
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown => {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (value instanceof Error) {
    const errorWithCause = value as Error & { cause?: unknown };
    const output: Record<string, unknown> = {
      message: redactSensitiveText(value.message),
      ...(value.stack ? { stack: redactSensitiveText(value.stack) } : {}),
      ...(errorWithCause.cause !== undefined
        ? { cause: sanitizeSensitiveData(errorWithCause.cause, depth + 1, seen) }
        : {}),
    };
    for (const [key, entry] of Object.entries(
      value as unknown as Record<string, unknown>,
    )) {
      output[key] = SENSITIVE_KEY_RE.test(key)
        ? "[REDACTED]"
        : sanitizeSensitiveData(entry, depth + 1, seen);
    }
    return output;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSensitiveData(entry, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY_RE.test(key)
      ? "[REDACTED]"
      : sanitizeSensitiveData(entry, depth + 1, seen);
  }
  return output;
};
