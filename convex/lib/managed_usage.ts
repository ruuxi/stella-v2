import type { AssistantMessage } from "../runtime_ai/types";
import { dollarsToMicroCents } from "./billing_money";

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
    inputTokens: message.usage.input,
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
