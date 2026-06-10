import type { ManagedGatewayProvider } from "../lib/managed_gateway";

export type RelayUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  model?: string;
};

type UsageParser = {
  pushText: (text: string) => void;
  finish: () => RelayUsage | null;
};

const toInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const mergeUsage = (current: RelayUsage, next: RelayUsage): RelayUsage => ({
  ...current,
  ...Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  ),
});

const parseOpenAIUsage = (usage: unknown): RelayUsage => {
  const record = asRecord(usage);
  if (!record) return {};
  const promptDetails = asRecord(record.prompt_tokens_details);
  const completionDetails = asRecord(record.completion_tokens_details);
  return {
    inputTokens: toInt(record.prompt_tokens ?? record.input_tokens),
    outputTokens: toInt(record.completion_tokens ?? record.output_tokens),
    totalTokens: toInt(record.total_tokens),
    cachedInputTokens: toInt(promptDetails?.cached_tokens),
    cacheWriteInputTokens: toInt(promptDetails?.cache_write_tokens),
    reasoningTokens: toInt(completionDetails?.reasoning_tokens),
  };
};

const parseResponsesUsage = (usage: unknown): RelayUsage => {
  const record = asRecord(usage);
  if (!record) return {};
  const inputDetails = asRecord(record.input_tokens_details);
  const outputDetails = asRecord(record.output_tokens_details);
  return {
    inputTokens: toInt(record.input_tokens),
    outputTokens: toInt(record.output_tokens),
    totalTokens: toInt(record.total_tokens),
    cachedInputTokens: toInt(inputDetails?.cached_tokens),
    cacheWriteInputTokens: toInt(inputDetails?.cache_write_tokens),
    reasoningTokens: toInt(outputDetails?.reasoning_tokens),
  };
};

const parseAnthropicUsage = (usage: unknown): RelayUsage => {
  const record = asRecord(usage);
  if (!record) return {};
  return {
    inputTokens: toInt(record.input_tokens),
    outputTokens: toInt(record.output_tokens),
    cachedInputTokens: toInt(record.cache_read_input_tokens),
    cacheWriteInputTokens: toInt(record.cache_creation_input_tokens),
  };
};

const parseGoogleUsage = (usage: unknown): RelayUsage => {
  const record = asRecord(usage);
  if (!record) return {};
  const input = toInt(record.promptTokenCount);
  const output = toInt(record.candidatesTokenCount);
  const reasoning = toInt(record.thoughtsTokenCount);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: toInt(record.totalTokenCount) ?? (
      input !== undefined || output !== undefined || reasoning !== undefined
        ? (input ?? 0) + (output ?? 0) + (reasoning ?? 0)
        : undefined
    ),
    cachedInputTokens: toInt(record.cachedContentTokenCount),
    reasoningTokens: reasoning,
  };
};

function createSseParser(
  parseEvent: (event: Record<string, unknown>) => RelayUsage,
): UsageParser {
  let buffer = "";
  let usage: RelayUsage = {};

  const consumeEvent = (rawEvent: string) => {
    const data = rawEvent
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    // Non-streaming relay responses are plain JSON bodies with no SSE
    // framing; parse the raw payload so their usage is still metered.
    const payload = data || rawEvent.trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const event = JSON.parse(payload) as unknown;
      const record = asRecord(event);
      if (record) {
        usage = mergeUsage(usage, parseEvent(record));
      }
    } catch {
      // Ignore partial or non-JSON provider comments.
    }
  };

  return {
    pushText(text) {
      buffer += text;
      while (true) {
        const separator = /\r?\n\r?\n/u.exec(buffer);
        if (!separator) break;
        const rawEvent = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        consumeEvent(rawEvent);
      }
    },
    finish() {
      if (buffer.trim()) {
        consumeEvent(buffer);
        buffer = "";
      }
      return Object.keys(usage).length > 0 ? usage : null;
    },
  };
}

export function createRelayUsageParser(
  provider: ManagedGatewayProvider,
): UsageParser {
  if (provider === "anthropic") {
    return createSseParser((event) => {
      const message = asRecord(event.message);
      const delta = asRecord(event.delta);
      return {
        model:
          typeof message?.model === "string"
            ? message.model
            : typeof event.model === "string"
              ? event.model
              : undefined,
        ...parseAnthropicUsage(event.usage ?? message?.usage ?? delta?.usage),
      };
    });
  }

  if (provider === "google") {
    return createSseParser((event) => ({
      model:
        typeof event.modelVersion === "string" ? event.modelVersion : undefined,
      ...parseGoogleUsage(event.usageMetadata),
    }));
  }

  if (provider === "openai" || provider === "fireworks") {
    return createSseParser((event) => {
      const response = asRecord(event.response);
      return {
        model:
          typeof response?.model === "string"
            ? response.model
            : typeof event.model === "string"
              ? event.model
              : undefined,
        ...parseResponsesUsage(response?.usage ?? event.usage),
      };
    });
  }

  return createSseParser((event) => ({
    model: typeof event.model === "string" ? event.model : undefined,
    ...parseOpenAIUsage(event.usage),
  }));
}
