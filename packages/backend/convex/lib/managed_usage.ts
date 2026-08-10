import type { AssistantMessage } from "../runtime_ai/types";
import { dollarsToMicroCents } from "./billing_money";

/**
 * Normalized usage handed to billing. `inputTokens` is gross (includes cached
 * reads and cache writes) and `outputTokens` is gross (includes reasoning),
 * matching the contract `computeUsageCostMicroCents` expects.
 */
export type ManagedUsageSummary = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  costMicroCents?: number;
};

export function usageSummaryFromAssistant(
  message: AssistantMessage | null | undefined,
): ManagedUsageSummary | undefined {
  if (!message) {
    return undefined;
  }

  return {
    // Every runtime_ai parser stores `usage.input` already net of the cache
    // buckets. Billing subtracts them itself, so add them back here or the
    // uncached prompt is discounted twice (and bills at zero once cached
    // tokens exceed it).
    inputTokens:
      message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
    // `usage.output` is inclusive of reasoning for every runtime_ai parser.
    outputTokens: message.usage.output,
    totalTokens: message.usage.totalTokens,
    cachedInputTokens: message.usage.cacheRead,
    cacheWriteInputTokens: message.usage.cacheWrite,
    reasoningTokens: message.usage.reasoningTokens,
    ...(message.usage.cost.total > 0
      ? { costMicroCents: dollarsToMicroCents(message.usage.cost.total) }
      : {}),
  };
}
