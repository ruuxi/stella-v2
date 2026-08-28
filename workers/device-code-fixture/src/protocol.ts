export const DEVICE_CODE_TTL_MS = 5 * 60_000;
export const DEVICE_CODE_POLL_INTERVAL_SECONDS = 2;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEVICE_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ23456789";
const USER_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXYZ23456789]{8}$/u;

export type DeviceAuthorizationRequest = Readonly<{
  schemaVersion: 1;
  requestId: string;
}>;

export type DeviceAuthorization = Readonly<{
  schemaVersion: 1;
  /** Sensitive. This field exists only on the named service-binding RPC. */
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
  intervalSeconds: typeof DEVICE_CODE_POLL_INTERVAL_SECONDS;
}>;

export type DeviceGrantRequest = Readonly<{
  schemaVersion: 1;
  userCode: string;
  /** Sensitive. Never place this value in an HTTP URL or public response. */
  deviceCode: string;
}>;

export type DeviceGrantConsumeRequest = DeviceGrantRequest &
  Readonly<{
    /**
     * Gateway-owned interaction identity. The fixture records it with the
     * terminal consume so an exact retry can recover a lost success response
     * without making the grant reusable by a different interaction.
     */
    consumerId: string;
  }>;

export type DeviceGrantStatus =
  | "authorization_pending"
  | "approved"
  | "access_denied"
  | "expired_token"
  | "already_consumed"
  | "invalid_grant";

export type DeviceGrantStatusResponse = Readonly<{
  schemaVersion: 1;
  status: DeviceGrantStatus;
}>;

export type DeviceGrantConsumeResponse = Readonly<{
  schemaVersion: 1;
  outcome:
    | "approved"
    | "authorization_pending"
    | "access_denied"
    | "expired_token"
    | "already_consumed"
    | "invalid_grant";
}>;

/** The only methods exposed to the browser gateway service binding. */
export interface DeviceCodeFixtureBinding {
  authorize(value: unknown): Promise<DeviceAuthorization>;
  status(value: unknown): Promise<DeviceGrantStatusResponse>;
  consume(value: unknown): Promise<DeviceGrantConsumeResponse>;
}

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid_request");
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): void => {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !(key in value))
  ) {
    throw new TypeError("invalid_request");
  }
};

export const normalizeUserCode = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 32) return undefined;
  const normalized = value.toUpperCase().replace(/[\s-]/gu, "");
  return USER_CODE_PATTERN.test(normalized) ? normalized : undefined;
};

export const formatUserCode = (value: string): string => {
  if (!USER_CODE_PATTERN.test(value)) throw new TypeError("invalid_user_code");
  return `${value.slice(0, 4)}-${value.slice(4)}`;
};

export const parseAuthorizeRequest = (
  value: unknown,
): DeviceAuthorizationRequest => {
  const parsed = record(value);
  exactKeys(parsed, ["schemaVersion", "requestId"]);
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.requestId !== "string" ||
    !UUID_PATTERN.test(parsed.requestId)
  ) {
    throw new TypeError("invalid_request");
  }
  return parsed as DeviceAuthorizationRequest;
};

export const parseGrantRequest = (value: unknown): DeviceGrantRequest => {
  const parsed = record(value);
  exactKeys(parsed, ["schemaVersion", "userCode", "deviceCode"]);
  const userCode = normalizeUserCode(parsed.userCode);
  if (
    parsed.schemaVersion !== 1 ||
    userCode === undefined ||
    typeof parsed.deviceCode !== "string" ||
    !DEVICE_CODE_PATTERN.test(parsed.deviceCode)
  ) {
    throw new TypeError("invalid_request");
  }
  return {
    schemaVersion: 1,
    userCode,
    deviceCode: parsed.deviceCode,
  };
};

export const parseConsumeRequest = (
  value: unknown,
): DeviceGrantConsumeRequest => {
  const parsed = record(value);
  exactKeys(parsed, ["schemaVersion", "userCode", "deviceCode", "consumerId"]);
  const userCode = normalizeUserCode(parsed.userCode);
  if (
    parsed.schemaVersion !== 1 ||
    userCode === undefined ||
    typeof parsed.deviceCode !== "string" ||
    !DEVICE_CODE_PATTERN.test(parsed.deviceCode) ||
    typeof parsed.consumerId !== "string" ||
    !UUID_PATTERN.test(parsed.consumerId)
  ) {
    throw new TypeError("invalid_request");
  }
  return {
    schemaVersion: 1,
    userCode,
    deviceCode: parsed.deviceCode,
    consumerId: parsed.consumerId,
  };
};

export const randomUserCode = (
  randomBytes: (length: number) => Uint8Array,
): string => {
  const bytes = randomBytes(8);
  if (bytes.length !== 8) throw new TypeError("invalid_random_source");
  let code = "";
  for (const byte of bytes) {
    code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  }
  return code;
};

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
};

export const randomDeviceCode = (
  randomBytes: (length: number) => Uint8Array,
): string => {
  const bytes = randomBytes(32);
  if (bytes.length !== 32) throw new TypeError("invalid_random_source");
  const code = base64Url(bytes);
  if (!DEVICE_CODE_PATTERN.test(code)) {
    throw new TypeError("invalid_random_source");
  }
  return code;
};

export const sha256Hex = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};
