export type MobileChatStreamToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
  source?: {
    api:
      | "openai-completions"
      | "openai-responses"
      | "anthropic-messages"
      | "google-generative-ai";
    provider: string;
    model: string;
  };
};

export type MobileChatStreamFrame =
  | { type: "text"; text: string }
  | { type: "toolCall"; toolCall: MobileChatStreamToolCall }
  | { type: "error"; error: string }
  | { type: "done" }
  | { type: "ignore" };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const API_NAMES = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

export const parseMobileChatStreamPayload = (
  payload: string,
): MobileChatStreamFrame => {
  if (payload === "[DONE]") return { type: "done" };
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(payload) as unknown);
  } catch {
    return { type: "ignore" };
  }
  if (!parsed) return { type: "ignore" };
  if (typeof parsed.error === "string" && parsed.error.trim()) {
    return { type: "error", error: parsed.error.trim() };
  }
  if (typeof parsed.t === "string" && parsed.t.length > 0) {
    return { type: "text", text: parsed.t };
  }
  const rawToolCall = asRecord(parsed.toolCall);
  const args = rawToolCall ? asRecord(rawToolCall.arguments) : null;
  if (
    rawToolCall &&
    typeof rawToolCall.id === "string" &&
    rawToolCall.id.trim() &&
    typeof rawToolCall.name === "string" &&
    rawToolCall.name.trim() &&
    args
  ) {
    const thoughtSignature =
      typeof rawToolCall.thoughtSignature === "string"
        ? rawToolCall.thoughtSignature
        : "";
    const rawSource = asRecord(rawToolCall.source);
    const source =
      rawSource &&
      typeof rawSource.api === "string" &&
      API_NAMES.has(rawSource.api) &&
      typeof rawSource.provider === "string" &&
      rawSource.provider.trim() &&
      typeof rawSource.model === "string" &&
      rawSource.model.trim()
        ? {
            api: rawSource.api as NonNullable<
              MobileChatStreamToolCall["source"]
            >["api"],
            provider: rawSource.provider,
            model: rawSource.model,
          }
        : null;
    return {
      type: "toolCall",
      toolCall: {
        id: rawToolCall.id,
        name: rawToolCall.name,
        arguments: args,
        ...(thoughtSignature ? { thoughtSignature } : {}),
        ...(source ? { source } : {}),
      },
    };
  }
  return { type: "ignore" };
};
