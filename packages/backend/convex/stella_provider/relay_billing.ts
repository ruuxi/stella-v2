export const RELAY_BILLING_TERMINAL_STATUSES = [
  "completed",
  "incomplete",
  "failed",
  "error",
  "canceled",
  "upstream_eof",
  "truncated",
] as const;

export type RelayBillingTerminalStatus =
  (typeof RELAY_BILLING_TERMINAL_STATUSES)[number];

export type RelayBillingUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  costMicroCents?: number;
};

/**
 * Convex rejects extra object fields at runtime. Provider usage also carries
 * diagnostic fields such as `model`, so project the parser result onto the
 * persisted billing contract before crossing a mutation boundary.
 */
export const normalizeRelayBillingUsage = (
  usage: RelayBillingUsage,
): RelayBillingUsage =>
  Object.fromEntries(
    [
      ["inputTokens", usage.inputTokens],
      ["outputTokens", usage.outputTokens],
      ["totalTokens", usage.totalTokens],
      ["cachedInputTokens", usage.cachedInputTokens],
      ["cacheWriteInputTokens", usage.cacheWriteInputTokens],
      ["reasoningTokens", usage.reasoningTokens],
      ["costMicroCents", usage.costMicroCents],
    ].filter((entry) => entry[1] !== undefined),
  ) as RelayBillingUsage;

export type RelayBillingReceiptSnapshot = {
  terminalStatus?: RelayBillingTerminalStatus;
  success?: boolean;
  durationMs?: number;
  hasActualUsage: boolean;
  actualUsage?: RelayBillingUsage;
  billedAt?: number;
};

export type RelayBillingFinalization = {
  terminalStatus: RelayBillingTerminalStatus;
  success: boolean;
  durationMs: number;
  actualUsage?: RelayBillingUsage;
};

export type RelayBillingFinalizationPatch = {
  terminalStatus?: RelayBillingTerminalStatus;
  success?: boolean;
  durationMs?: number;
  hasActualUsage?: boolean;
  actualUsage?: RelayBillingUsage;
};

/**
 * First terminal outcome wins. A later copy of the same logical request may
 * still upgrade an unbilled fallback with provider-reported usage, but can
 * never change an already-billed receipt or replace cancellation with success.
 */
export const mergeRelayBillingFinalization = (
  current: RelayBillingReceiptSnapshot,
  next: RelayBillingFinalization,
): RelayBillingFinalizationPatch | null => {
  if (current.billedAt !== undefined) return null;
  if (current.terminalStatus === undefined) {
    return {
      terminalStatus: next.terminalStatus,
      success: next.success,
      durationMs: Math.max(0, next.durationMs),
      hasActualUsage: next.actualUsage !== undefined,
      actualUsage: next.actualUsage,
    };
  }
  if (!current.hasActualUsage && next.actualUsage !== undefined) {
    return {
      durationMs: Math.max(current.durationMs ?? 0, next.durationMs),
      hasActualUsage: true,
      actualUsage: next.actualUsage,
    };
  }
  return null;
};

/**
 * Provider usage is authoritative. If a canceled/failed request has no usage
 * event, reserve only the estimated prompt work and never the maximum output
 * cap. Successful terminal responses retain the existing conservative full
 * estimate when their provider omitted usage entirely.
 */
export const relayBillingUsageForDelivery = (args: {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  success: boolean;
  hasActualUsage: boolean;
  actualUsage?: RelayBillingUsage;
}): RelayBillingUsage => {
  if (args.hasActualUsage && args.actualUsage) {
    return normalizeRelayBillingUsage(args.actualUsage);
  }
  const inputTokens = Math.max(0, args.estimatedInputTokens);
  const outputTokens = args.success
    ? Math.max(0, args.estimatedOutputTokens)
    : 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
};
