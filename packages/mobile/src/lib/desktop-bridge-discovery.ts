import type {
  DesktopBridgeRegistrationDescriptor,
  DesktopBridgeStatus,
} from "../types";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const readStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value;
};

/**
 * Parse the additive durable descriptor defensively. A malformed descriptor
 * must not break the legacy live-registration response used by older clients.
 */
export function readDesktopBridgeRegistrationDescriptor(
  value: unknown,
): DesktopBridgeRegistrationDescriptor | null {
  const record = asRecord(value);
  if (!record) return null;

  const baseUrls = readStringArray(record.baseUrls);
  if (
    typeof record.desktopDeviceId !== "string" ||
    !baseUrls ||
    typeof record.updatedAt !== "number" ||
    !Number.isFinite(record.updatedAt) ||
    (record.platform !== undefined &&
      record.platform !== null &&
      typeof record.platform !== "string") ||
    (record.desktopPublicKey !== undefined &&
      record.desktopPublicKey !== null &&
      typeof record.desktopPublicKey !== "string")
  ) {
    return null;
  }

  return {
    desktopDeviceId: record.desktopDeviceId,
    baseUrls,
    platform: record.platform ?? null,
    desktopPublicKey: record.desktopPublicKey ?? null,
    updatedAt: record.updatedAt,
  };
}

const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, "");

const uniqueBaseUrls = (values: string[]) => [
  ...new Set(values.map(normalizeBaseUrl).filter(Boolean)),
];

export type DesktopBridgeStatusProbeResult = {
  /** A route whose `/bridge/health` endpoint answered successfully. */
  reachableUrl: string | null;
  /**
   * A currently leased URL that may still be tried for old desktops without a
   * health endpoint. Durable descriptors never qualify for this fallback.
   */
  liveFallbackUrl: string | null;
};

/**
 * Resolve backend discovery metadata using direct route health as the source
 * of truth. An expired lease can therefore connect through a durable
 * descriptor, but only a currently leased registration retains the legacy
 * unverified fallback for old desktop versions.
 */
export async function probeDesktopBridgeStatus(
  status: DesktopBridgeStatus,
  desktopDeviceId: string,
  canReach: (baseUrl: string) => Promise<boolean>,
): Promise<DesktopBridgeStatusProbeResult> {
  const liveUrls = status.available ? uniqueBaseUrls(status.baseUrls) : [];
  const descriptorUrls =
    status.lastKnownRegistration?.desktopDeviceId === desktopDeviceId
      ? uniqueBaseUrls(status.lastKnownRegistration.baseUrls)
      : [];
  const candidates = [...new Set([...liveUrls, ...descriptorUrls])];

  for (const candidate of candidates) {
    if (await canReach(candidate)) {
      return {
        reachableUrl: candidate,
        liveFallbackUrl: liveUrls[0] ?? null,
      };
    }
  }

  return {
    reachableUrl: null,
    liveFallbackUrl: liveUrls[0] ?? null,
  };
}
