import type { Id } from "../_generated/dataModel";
import {
  computeUsageCostMicroCents,
  type TokenPriceConfig,
} from "./billing_money";
import { hashSha256Hex } from "./crypto_utils";

export type DurableManagedDispatchOutcome =
  | "succeeded"
  | "failed"
  | "aborted"
  | "timed_out"
  | "outcome_unknown";

export const PARALLEL_SEARCH_FAST_BILLING_KIND =
  "parallel_search_fast" as const;
// Parallel Fast is $1 / 1,000 requests: $0.001 per physical request equals
// 100,000 micro-cents in Stella's billing unit.
export const PARALLEL_SEARCH_FAST_COST_MICRO_CENTS = 100_000;
export const PARALLEL_SEARCH_FAST_MODEL = "parallel-search-fast";
export const PARALLEL_SEARCH_FAST_AGENT_TYPE = "web_search";

/**
 * Variable-cost managed provider attempts (model, STT, and similar services)
 * declare their immutable attribution and conservative crash fallback before
 * crossing the provider boundary. Exact usage is attached to the same receipt
 * after the response body is fully consumed.
 */
export const MANAGED_USAGE_BILLING_KIND = "managed_usage" as const;

export type ManagedDispatchCapturedUsage = {
  durationMs: number;
  success: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  costMicroCents?: number;
};

export type ManagedDispatchBillingEnvelope =
  | {
      kind: typeof PARALLEL_SEARCH_FAST_BILLING_KIND;
      requestFingerprint: string;
      chargeMicroCents: typeof PARALLEL_SEARCH_FAST_COST_MICRO_CENTS;
    }
  | {
      kind: typeof MANAGED_USAGE_BILLING_KIND;
      requestFingerprint: string;
      agentType: string;
      model: string;
      conversationId?: Id<"conversations">;
      /** Minimum spend admission and crash/ambiguity fallback. */
      fallbackCostMicroCents: number;
    };

export type ManagedDispatchBillingState =
  | "pending"
  | "not_chargeable"
  | "billed";

export type ManagedDispatchProviderState = "reserved" | "may_have_dispatched";

/** Stable logical fingerprint shared by all physical retries/fallbacks. */
export async function createManagedDispatchRequestFingerprint(
  namespace: string,
  stableRequestKey: string,
): Promise<string> {
  const normalizedNamespace = namespace.trim().replace(/[^a-z0-9:_-]/giu, "-");
  if (!normalizedNamespace || normalizedNamespace.length > 64) {
    throw new Error("Invalid managed dispatch fingerprint namespace.");
  }
  return `${normalizedNamespace}:${await hashSha256Hex(stableRequestKey)}`;
}

/**
 * Conservative pre-dispatch charge for response loss. Callers pass the full
 * admitted input estimate and the model's maximum output, not expected output.
 */
export function estimateManagedModelFallbackCostMicroCents(args: {
  model: string;
  inputTokens: number;
  maxOutputTokens: number;
  price?: TokenPriceConfig;
}): number {
  const cost = computeUsageCostMicroCents({
    model: args.model,
    inputTokens: Math.max(0, Math.ceil(args.inputTokens)),
    outputTokens: Math.max(0, Math.ceil(args.maxOutputTokens)),
    price: args.price,
  });
  if (cost <= 0) {
    throw new Error("Managed model fallback estimate must be positive.");
  }
  return cost;
}

/**
 * A definitive provider response closes external work immediately. Abort,
 * timeout, and transport ambiguity can leave the upstream request running, so
 * destructive lifecycle operations must retain their debt through the fixed
 * lease expiry and abort-grace boundary.
 */
export const managedDispatchOutcomeRequiresQuiescence = (
  outcome: DurableManagedDispatchOutcome | undefined,
): boolean =>
  outcome === undefined ||
  outcome === "aborted" ||
  outcome === "timed_out" ||
  outcome === "outcome_unknown";
