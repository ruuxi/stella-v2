import type { ManagedGatewayProvider } from "./managed-gateway";

/**
 * Normalized relay usage. `inputTokens` is gross (includes cached reads and
 * cache writes) and `outputTokens` is gross (includes reasoning tokens),
 * matching the contract `computeUsageCostMicroCents` expects. Providers
 * report these differently, so each parser converts into this shape.
 */
export type RelayUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  /** Exact upstream-reported spend, normalized to Stella's micro-cent unit. */
  costMicroCents?: number;
  model?: string;
};

export type RelayUsageParser = {
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
    // DeepSeek reports cache hits at the top level as `prompt_cache_hit_tokens`
    // (with `prompt_tokens` already gross) instead of inside
    // `prompt_tokens_details`. Without this the chat-completions path would
    // bill every cached read at the full uncached rate.
    cachedInputTokens:
      toInt(promptDetails?.cached_tokens) ??
      toInt(record.prompt_cache_hit_tokens),
    cacheWriteInputTokens: toInt(promptDetails?.cache_write_tokens),
    reasoningTokens:
      toInt(completionDetails?.reasoning_tokens) ??
      toInt(record.reasoning_tokens),
  };
};

const parseCrofCost = (usage: unknown): Pick<RelayUsage, "costMicroCents"> => {
  const record = asRecord(usage);
  const costUsd = record?.cost;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
    return {};
  }
  // 1 USD = 100 cents = 100,000,000 micro-cents.
  return { costMicroCents: Math.round(costUsd * 100_000_000) };
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

/**
 * Anthropic reports `input_tokens` net of both cache buckets. Left as-is it
 * gets discounted a second time by `computeUsageCostMicroCents` — clamping to
 * zero on any cached conversation — so `grossAnthropicInput` folds the cache
 * counts back in once the stream's fields have merged. Extended thinking is
 * already inside `output_tokens` and is never broken out, so there is no
 * reasoning bucket to report.
 */
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

/**
 * Applied after merging, not per event: `message_start` carries the cache
 * counts while `message_delta` may repeat `input_tokens` without them, so
 * converting per event could drop the cache half of the sum.
 */
const grossAnthropicInput = (usage: RelayUsage): RelayUsage =>
  usage.inputTokens === undefined
    ? usage
    : {
        ...usage,
        inputTokens:
          usage.inputTokens +
          (usage.cachedInputTokens ?? 0) +
          (usage.cacheWriteInputTokens ?? 0),
      };

const parseGoogleUsage = (usage: unknown): RelayUsage => {
  const record = asRecord(usage);
  if (!record) return {};
  const input = toInt(record.promptTokenCount);
  const candidates = toInt(record.candidatesTokenCount);
  const reasoning = toInt(record.thoughtsTokenCount);
  // Gemini reports `candidatesTokenCount` exclusive of `thoughtsTokenCount`
  // (totalTokenCount sums the two). Roll thinking back into the output count
  // so the calculator's `output - reasoning` yields the visible completion
  // rather than clamping to zero and billing the whole response at nothing.
  const output =
    candidates === undefined && reasoning === undefined
      ? undefined
      : (candidates ?? 0) + (reasoning ?? 0);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens:
      toInt(record.totalTokenCount) ??
      (input !== undefined || output !== undefined
        ? (input ?? 0) + (output ?? 0)
        : undefined),
    cachedInputTokens: toInt(record.cachedContentTokenCount),
    reasoningTokens: reasoning,
  };
};

function createSseParser(
  parseEvent: (event: Record<string, unknown>) => RelayUsage,
): RelayUsageParser {
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
): RelayUsageParser {
  if (provider === "anthropic") {
    const parser = createSseParser((event) => {
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
    return {
      pushText: (text) => parser.pushText(text),
      finish: () => {
        const usage = parser.finish();
        return usage ? grossAnthropicInput(usage) : usage;
      },
    };
  }

  if (provider === "google") {
    return createSseParser((event) => ({
      model:
        typeof event.modelVersion === "string" ? event.modelVersion : undefined,
      ...parseGoogleUsage(event.usageMetadata),
    }));
  }

  if (provider === "deepseek") {
    // DeepSeek serves both APIs, so the wire shape isn't fixed by the
    // provider. Streaming Responses events nest usage under `response`;
    // non-streaming Responses bodies carry it at the top level with the same
    // `input_tokens` field names; chat completions use `prompt_tokens`.
    // Choose the parser from the usage payload itself rather than the
    // envelope, so a non-streamed Responses reply still reports cache hits.
    return createSseParser((event) => {
      const response = asRecord(event.response);
      const usage = asRecord(response?.usage ?? event.usage);
      return {
        model:
          typeof response?.model === "string"
            ? response.model
            : typeof event.model === "string"
              ? event.model
              : undefined,
        ...(usage?.input_tokens !== undefined
          ? parseResponsesUsage(usage)
          : parseOpenAIUsage(usage)),
      };
    });
  }

  if (provider === "crof") {
    return createSseParser((event) => ({
      model: typeof event.model === "string" ? event.model : undefined,
      ...parseOpenAIUsage(event.usage),
      ...parseCrofCost(event.usage),
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

  if (provider === "xai") {
    return createSseParser((event) => {
      const response = asRecord(event.response);
      return {
        model:
          typeof response?.model === "string"
            ? response.model
            : typeof event.model === "string"
              ? event.model
              : undefined,
        ...(response
          ? parseResponsesUsage(response.usage)
          : parseOpenAIUsage(event.usage)),
      };
    });
  }

  if (provider === "openrouter") {
    // OpenRouter serves both APIs: chat completions for most models and the
    // Responses API for Muse Spark 1.2 Contributor (the Stella default).
    // Streaming Responses events nest usage under `response` with
    // input_tokens/output_tokens (+ reasoning in output_tokens_details);
    // chat completions use prompt_tokens/completion_tokens at the top
    // level. Pick the parser from the usage payload itself, mirroring the
    // deepseek handling.
    return createSseParser((event) => {
      const response = asRecord(event.response);
      const usage = asRecord(response?.usage ?? event.usage);
      return {
        model:
          typeof response?.model === "string"
            ? response.model
            : typeof event.model === "string"
              ? event.model
              : undefined,
        ...(usage?.input_tokens !== undefined
          ? parseResponsesUsage(usage)
          : parseOpenAIUsage(usage)),
      };
    });
  }

  return createSseParser((event) => ({
    model: typeof event.model === "string" ? event.model : undefined,
    ...parseOpenAIUsage(event.usage),
  }));
}
