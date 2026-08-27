import type { ManagedModelAudience, ModelConfig } from "../agent/model";
import {
  resolveStellaModelConfigForSelection,
  STELLA_DEFAULT_MODEL,
} from "../stella_models";
import type { ResolvedStellaModelSelection, StellaRequestBody } from "./shared";
import type { TokenEstimate } from "./billing";

const NON_VISION_USER_IMAGE_PLACEHOLDER =
  "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER =
  "(tool image omitted: model does not support images)";

const IMAGE_CAPABLE_MANAGED_MODEL_PREFIXES = [
  "accounts/fireworks/models/kimi-k3",
  "anthropic/",
  "google/",
  "openai/",
  "meta/",
  "x-ai/grok-4.5",
] as const;

export function resolveRequestedStellaModel(
  agentType: string,
  requestBody: StellaRequestBody,
  audience: ManagedModelAudience,
): ResolvedStellaModelSelection {
  const trimmed =
    typeof requestBody.model === "string" ? requestBody.model.trim() : "";
  const { config, applied } = resolveStellaModelConfigForSelection(
    trimmed,
    agentType,
    audience,
  );
  return {

    requestedModel: applied ? trimmed : STELLA_DEFAULT_MODEL,
    resolvedModel: config.model,
    config: withoutFallback(config),
  };
}

const withoutFallback = (config: ModelConfig): ModelConfig => ({
  ...config,
  fallback: undefined,
  fallbackManagedGatewayProvider: undefined,
  fallbackProviderOptions: undefined,
});

const IMAGE_ESTIMATE_CHARS = 512;

const MAX_ESTIMATED_OUTPUT_TOKENS = 64_000;
const DEFAULT_ESTIMATED_OUTPUT_TOKENS = 1024;

const MAX_ESTIMATE_DEPTH = 8;

const isImagePart = (record: Record<string, unknown>): boolean =>
  record.image_url !== undefined ||
  record.inlineData !== undefined ||
  record.inline_data !== undefined ||
  record.fileData !== undefined ||
  record.file_data !== undefined ||

  record.source !== undefined;

const textLengthOf = (value: unknown, depth = 0): number => {
  if (typeof value === "string") return value.length;
  if (depth >= MAX_ESTIMATE_DEPTH || !value || typeof value !== "object") {
    return 0;
  }

  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += textLengthOf(item, depth + 1);
    return total;
  }

  const record = value as Record<string, unknown>;
  let length = 0;

  for (const key of ["text", "output", "arguments"] as const) {
    const field = record[key];
    if (typeof field === "string") length += field.length;
  }

  for (const key of ["content", "parts"] as const) {
    length += textLengthOf(record[key], depth + 1);
  }
  return length === 0 && isImagePart(record) ? IMAGE_ESTIMATE_CHARS : length;
};

const numberAt = (
  container: unknown,
  ...keys: string[]
): number | undefined => {
  const record =
    container && typeof container === "object" && !Array.isArray(container)
      ? (container as Record<string, unknown>)
      : null;
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
};

export function estimateRequestTokens(
  requestBody: StellaRequestBody,
): TokenEstimate {
  const inputTextLength = [

    requestBody.messages,
    requestBody.input,
    requestBody.contents,

    requestBody.system,
    requestBody.instructions,
    requestBody.systemInstruction,
    requestBody.system_instruction,
  ].reduce<number>((total, value) => total + textLengthOf(value), 0);

  const maxCompletionTokens =
    numberAt(
      requestBody,
      "max_completion_tokens",
      "max_tokens",
      "max_output_tokens",
      "maxOutputTokens",
    ) ??
    numberAt(requestBody.generationConfig, "maxOutputTokens") ??
    numberAt(requestBody.generation_config, "max_output_tokens") ??
    DEFAULT_ESTIMATED_OUTPUT_TOKENS;

  return {
    inputTokens: Math.max(1, Math.ceil(inputTextLength / 4)),
    outputTokens: Math.max(
      0,
      Math.min(MAX_ESTIMATED_OUTPUT_TOKENS, Math.floor(maxCompletionTokens)),
    ),
  };
}

const TEXT_ONLY_MANAGED_MODEL_EXACT_IDS = [
  "meta/muse-spark-1.2-contributor",
] as const;

const managedRelayModelSupportsImageInput = (resolvedModel: string): boolean =>
  !(TEXT_ONLY_MANAGED_MODEL_EXACT_IDS as readonly string[]).includes(
    resolvedModel,
  ) &&
  IMAGE_CAPABLE_MANAGED_MODEL_PREFIXES.some((prefix) =>
    resolvedModel.startsWith(prefix),
  );

const roleImagePlaceholder = (role: unknown): string =>
  role === "tool" || role === "function"
    ? NON_VISION_TOOL_IMAGE_PLACEHOLDER
    : NON_VISION_USER_IMAGE_PLACEHOLDER;

const replacementTextPartType = (partType: unknown): "input_text" | "text" =>
  partType === "input_image" ? "input_text" : "text";

const isImageContentPart = (part: Record<string, unknown>): boolean =>
  part.type === "image_url" ||
  part.type === "input_image" ||
  Object.prototype.hasOwnProperty.call(part, "image_url");

const downgradeContentImages = (
  content: unknown,
  role: unknown,
): { content: unknown; changed: boolean } => {
  if (!Array.isArray(content)) {
    return { content, changed: false };
  }

  let changed = false;
  const placeholder = roleImagePlaceholder(role);
  const mapped = content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return part;
    }
    const record = part as Record<string, unknown>;
    if (!isImageContentPart(record)) {
      return part;
    }
    changed = true;
    return {
      type: replacementTextPartType(record.type),
      text: placeholder,
    };
  });

  return { content: changed ? mapped : content, changed };
};

const downgradeMessageListImages = (
  value: unknown,
): { value: unknown; changed: boolean } => {
  if (!Array.isArray(value)) {
    return { value, changed: false };
  }

  let changed = false;
  const mapped = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return item;
    }
    const record = item as Record<string, unknown>;
    const result = downgradeContentImages(record.content, record.role);
    if (!result.changed) {
      return item;
    }
    changed = true;
    return {
      ...record,
      content: result.content,
    };
  });

  return { value: changed ? mapped : value, changed };
};

export function downgradeUnsupportedRequestImages(
  requestBody: StellaRequestBody,
  resolvedModel: string,
): StellaRequestBody {
  if (managedRelayModelSupportsImageInput(resolvedModel)) {
    return requestBody;
  }

  const messages = downgradeMessageListImages(requestBody.messages);
  const input = downgradeMessageListImages(requestBody.input);
  if (!messages.changed && !input.changed) {
    return requestBody;
  }

  return {
    ...requestBody,
    ...(messages.changed ? { messages: messages.value } : {}),
    ...(input.changed ? { input: input.value } : {}),
  };
}

export function requestedModelFromGooglePath(pathname: string): string | null {
  const match = /\/models\/(.+?):[A-Za-z][A-Za-z0-9]*$/u.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
