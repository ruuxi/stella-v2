import type {
  DeviceAuthorization,
  DeviceCodeFixtureBinding,
  DeviceGrantConsumeResponse,
  DeviceGrantStatusResponse,
} from "@stella/device-code-fixture/protocol";
import { GatewayError } from "./errors.js";

export type DeviceCodeGrant = Readonly<{
  userCode: string;
  deviceCode: string;
}>;

export interface DeviceCodeFixtureClient {
  authorize(requestId: string): Promise<DeviceAuthorization>;
  status(grant: DeviceCodeGrant): Promise<DeviceGrantStatusResponse>;
  consume(
    grant: DeviceCodeGrant,
    consumerId: string,
  ): Promise<DeviceGrantConsumeResponse>;
}

const DEVICE_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const USER_CODE_PATTERN =
  /^[BCDFGHJKLMNPQRSTVWXYZ23456789]{4}-[BCDFGHJKLMNPQRSTVWXYZ23456789]{4}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError("internal_error", 500);
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
    throw new GatewayError("internal_error", 500);
  }
};

const exactHttpsOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayError("internal_error", 500);
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new GatewayError("internal_error", 500);
  }
  return url.origin;
};

const parseAuthorization = (
  value: unknown,
  origin: string,
  now: number,
): DeviceAuthorization => {
  const parsed = record(value);
  exactKeys(parsed, [
    "schemaVersion",
    "deviceCode",
    "userCode",
    "verificationUri",
    "verificationUriComplete",
    "expiresAt",
    "intervalSeconds",
  ]);
  const verificationUri = `${origin}/activate`;
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.deviceCode !== "string" ||
    !DEVICE_CODE_PATTERN.test(parsed.deviceCode) ||
    typeof parsed.userCode !== "string" ||
    !USER_CODE_PATTERN.test(parsed.userCode) ||
    parsed.verificationUri !== verificationUri ||
    parsed.verificationUriComplete !==
      `${verificationUri}?user_code=${encodeURIComponent(parsed.userCode)}` ||
    !Number.isSafeInteger(parsed.expiresAt) ||
    Number(parsed.expiresAt) <= now ||
    Number(parsed.expiresAt) > now + 5 * 60_000 ||
    parsed.intervalSeconds !== 2
  ) {
    throw new GatewayError("internal_error", 500);
  }
  return parsed as unknown as DeviceAuthorization;
};

const STATUS_VALUES = new Set([
  "authorization_pending",
  "approved",
  "access_denied",
  "expired_token",
  "already_consumed",
  "invalid_grant",
]);

const parseStatus = (value: unknown): DeviceGrantStatusResponse => {
  const parsed = record(value);
  exactKeys(parsed, ["schemaVersion", "status"]);
  if (
    parsed.schemaVersion !== 1 ||
    !STATUS_VALUES.has(parsed.status as string)
  ) {
    throw new GatewayError("internal_error", 500);
  }
  return parsed as unknown as DeviceGrantStatusResponse;
};

const parseConsume = (value: unknown): DeviceGrantConsumeResponse => {
  const parsed = record(value);
  exactKeys(parsed, ["schemaVersion", "outcome"]);
  if (
    parsed.schemaVersion !== 1 ||
    !STATUS_VALUES.has(parsed.outcome as string)
  ) {
    throw new GatewayError("internal_error", 500);
  }
  return parsed as unknown as DeviceGrantConsumeResponse;
};

const validGrant = (grant: DeviceCodeGrant): void => {
  if (
    !USER_CODE_PATTERN.test(grant.userCode) ||
    !DEVICE_CODE_PATTERN.test(grant.deviceCode)
  ) {
    throw new GatewayError("internal_error", 500);
  }
};

export class CloudflareDeviceCodeFixtureClient
  implements DeviceCodeFixtureClient
{
  private readonly binding: DeviceCodeFixtureBinding;
  private readonly publicOrigin: string;
  private readonly now: () => number;

  constructor(
    binding: DeviceCodeFixtureBinding,
    publicOrigin: string,
    now: () => number = Date.now,
  ) {
    this.binding = binding;
    this.publicOrigin = exactHttpsOrigin(publicOrigin);
    this.now = now;
  }

  async authorize(requestId: string): Promise<DeviceAuthorization> {
    if (!UUID_PATTERN.test(requestId)) {
      throw new GatewayError("internal_error", 500);
    }
    try {
      return parseAuthorization(
        await this.binding.authorize({ schemaVersion: 1, requestId }),
        this.publicOrigin,
        this.now(),
      );
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("internal_error", 500);
    }
  }

  async status(grant: DeviceCodeGrant): Promise<DeviceGrantStatusResponse> {
    validGrant(grant);
    try {
      return parseStatus(
        await this.binding.status({ schemaVersion: 1, ...grant }),
      );
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("internal_error", 500);
    }
  }

  async consume(
    grant: DeviceCodeGrant,
    consumerId: string,
  ): Promise<DeviceGrantConsumeResponse> {
    validGrant(grant);
    if (!UUID_PATTERN.test(consumerId)) {
      throw new GatewayError("internal_error", 500);
    }
    try {
      return parseConsume(
        await this.binding.consume({ schemaVersion: 1, ...grant, consumerId }),
      );
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("internal_error", 500);
    }
  }
}
