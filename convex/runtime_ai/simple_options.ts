import type {
  Api,
  Model,
  SimpleStreamOptions,
  StreamOptions,
  ThinkingLevel,
} from "./types";

export function buildBaseOptions(
  model: Model<Api>,
  options?: SimpleStreamOptions,
  apiKey?: string,
): StreamOptions {
  // `maxTokens` is intentionally passed through verbatim — no
  // `model.maxTokens` fallback. Caps truncate output and can be
  // exhausted by reasoning on thinking models; we rely on callers
  // (e.g. Anthropic, which requires the field per its protocol) to
  // set it explicitly. Anthropic's adapter has its own internal
  // fallback to `model.maxTokens` when nothing is passed in.
  return {
    temperature: options?.temperature,
    maxTokens: options?.maxTokens,
    signal: options?.signal,
    apiKey: apiKey || options?.apiKey,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    onResponse: options?.onResponse,
    timeoutMs: options?.timeoutMs,
    maxRetries: options?.maxRetries,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
    extraBody: options?.extraBody,
  };
}

export function clampReasoning(
  effort: ThinkingLevel | undefined,
): Exclude<ThinkingLevel, "xhigh"> | undefined {
  return effort === "xhigh" ? "high" : effort;
}
