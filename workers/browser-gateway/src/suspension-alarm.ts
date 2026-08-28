const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Extract the durable expiry boundary from either supported suspension kind.
 * Keeping this independent from BrowserProfileSession makes the alarm policy
 * directly testable without a Cloudflare runtime shim.
 */
export const suspensionAlarmDeadline = (value: unknown): number | undefined => {
  const result = record(value);
  if (result?.outcome !== "suspended") return undefined;
  const suspension = record(result.suspension);
  if (
    (suspension?.interactionKind !== "login_takeover" &&
      suspension?.interactionKind !== "device_code") ||
    !Number.isSafeInteger(suspension.expiresAt) ||
    Number(suspension.expiresAt) < 1
  ) {
    return undefined;
  }
  return Number(suspension.expiresAt);
};
