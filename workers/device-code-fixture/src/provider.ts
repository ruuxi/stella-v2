import {
  DEVICE_CODE_POLL_INTERVAL_SECONDS,
  DEVICE_CODE_TTL_MS,
  formatUserCode,
  parseAuthorizeRequest,
  parseConsumeRequest,
  parseGrantRequest,
  randomDeviceCode,
  randomUserCode,
  sha256Hex,
  type DeviceAuthorization,
  type DeviceCodeFixtureBinding,
  type DeviceGrantConsumeResponse,
  type DeviceGrantStatusResponse,
} from "./protocol.js";
import type { StoredAuthorizationInput } from "./authorization-session.js";

export interface AuthorizationStub {
  create(input: StoredAuthorizationInput): Promise<{ created: boolean }>;
  status(deviceCodeDigest: string): Promise<DeviceGrantStatusResponse>;
  consume(
    deviceCodeDigest: string,
    consumerId: string,
  ): Promise<DeviceGrantConsumeResponse>;
}

export interface AuthorizationNamespace {
  getByName(name: string): AuthorizationStub;
}

type ProviderDependencies = Readonly<{
  authorizations: AuthorizationNamespace;
  publicOrigin: string;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}>;

const exactHttpsOrigin = (value: string): string => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new TypeError("invalid_public_origin");
  }
  return url.origin;
};

const secureRandomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

export class DeviceCodeFixtureProvider implements DeviceCodeFixtureBinding {
  private readonly authorizations: AuthorizationNamespace;
  private readonly publicOrigin: string;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;

  constructor(dependencies: ProviderDependencies) {
    this.authorizations = dependencies.authorizations;
    this.publicOrigin = exactHttpsOrigin(dependencies.publicOrigin);
    this.now = dependencies.now ?? Date.now;
    this.randomBytes = dependencies.randomBytes ?? secureRandomBytes;
  }

  async authorize(value: unknown): Promise<DeviceAuthorization> {
    parseAuthorizeRequest(value);
    const createdAt = this.now();
    const expiresAt = createdAt + DEVICE_CODE_TTL_MS;
    const deviceCode = randomDeviceCode(this.randomBytes);
    const deviceCodeDigest = await sha256Hex(deviceCode);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const normalizedUserCode = randomUserCode(this.randomBytes);
      const stub = this.authorizations.getByName(normalizedUserCode);
      const result = await stub.create({
        schemaVersion: 1,
        userCode: normalizedUserCode,
        deviceCodeDigest,
        createdAt,
        expiresAt,
      });
      if (!result.created) continue;
      const userCode = formatUserCode(normalizedUserCode);
      const verificationUri = `${this.publicOrigin}/activate`;
      return {
        schemaVersion: 1,
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
        expiresAt,
        intervalSeconds: DEVICE_CODE_POLL_INTERVAL_SECONDS,
      };
    }
    throw new Error("authorization_capacity_exhausted");
  }

  async status(value: unknown): Promise<DeviceGrantStatusResponse> {
    const request = parseGrantRequest(value);
    const digest = await sha256Hex(request.deviceCode);
    return await this.authorizations.getByName(request.userCode).status(digest);
  }

  async consume(value: unknown): Promise<DeviceGrantConsumeResponse> {
    const request = parseConsumeRequest(value);
    const digest = await sha256Hex(request.deviceCode);
    return await this.authorizations
      .getByName(request.userCode)
      .consume(digest, request.consumerId);
  }
}
