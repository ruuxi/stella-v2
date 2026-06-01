import {
  getAgentModelMode,
  getModeConfig,
  getModelConfig,
  isStellaModelAllowedForAudience,
  LOCKED_AGENT_TYPES,
  type ModelMode,
  type ManagedModelAudience,
  type ModelConfig,
} from "../agent/model";
import { inferManagedGatewayProviderFromModel } from "../lib/managed_gateway";
import {
  isStellaModel,
  parseStellaModelSelection,
  resolveStellaModelSelection,
  STELLA_DEFAULT_MODEL,
  toStellaModeModelId,
} from "../stella_models";
import type { ResolvedStellaModelSelection, StellaRequestBody } from "./shared";
import type { TokenEstimate } from "./billing";

const DEFAULT_STELLA_MODE = "standard";
const NON_VISION_USER_IMAGE_PLACEHOLDER =
  "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER =
  "(tool image omitted: model does not support images)";

const IMAGE_CAPABLE_MANAGED_MODEL_PREFIXES = [
  "anthropic/",
  "google/",
  "openai/",
] as const;

const defaultModeForAgent = (
  agentType: string,
  audience: ManagedModelAudience,
): ModelMode => getAgentModelMode(agentType, audience) ?? DEFAULT_STELLA_MODE;

export function resolveRequestedStellaModel(
  agentType: string,
  requestBody: StellaRequestBody,
  audience: ManagedModelAudience,
): ResolvedStellaModelSelection {
  const trimmed =
    typeof requestBody.model === "string" ? requestBody.model.trim() : "";
  const defaultModel = toStellaModeModelId(
    defaultModeForAgent(agentType, audience),
  );
  const clientRequestedModel =
    !trimmed || trimmed === STELLA_DEFAULT_MODEL ? defaultModel : trimmed;

  if (
    isStellaModel(clientRequestedModel) &&
    !parseStellaModelSelection(clientRequestedModel)
  ) {
    throw new Error(`Unsupported Stella model selection: ${clientRequestedModel}`);
  }

  const requestedModel =
    !LOCKED_AGENT_TYPES.has(agentType) &&
    isStellaModelAllowedForAudience(clientRequestedModel, audience)
      ? clientRequestedModel
      : defaultModel;

  if (!isStellaModel(requestedModel)) {
    throw new Error(`Unsupported Stella model selection: ${requestedModel}`);
  }

  const parsedModel = parseStellaModelSelection(requestedModel);
  if (!parsedModel) {
    throw new Error(`Unsupported Stella model selection: ${requestedModel}`);
  }

  if (parsedModel?.kind === "mode") {
    const config = getModeConfig(parsedModel.mode, audience);
    return {
      requestedModel,
      resolvedModel: config.model,
      config: withoutFallback(config),
    };
  }

  const resolvedModel = resolveStellaModelSelection(requestedModel, audience);
  const inferredProvider = inferManagedGatewayProviderFromModel(resolvedModel);
  const config: ModelConfig = {
    ...withoutFallback(getModelConfig(agentType, audience)),
    model: resolvedModel,
    managedGatewayProvider: inferredProvider,
  };
  return {
    requestedModel,
    resolvedModel,
    config,
  };
}

const withoutFallback = (config: ModelConfig): ModelConfig => ({
  ...config,
  fallback: undefined,
  fallbackManagedGatewayProvider: undefined,
  fallbackProviderOptions: undefined,
});

export function estimateRequestTokens(
  requestBody: StellaRequestBody,
): TokenEstimate {
  const messages = Array.isArray(requestBody.messages)
    ? (requestBody.messages as Array<Record<string, unknown>>)
    : [];

  let inputTextLength = 0;
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === "string") {
      inputTextLength += content.length;
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") {
        inputTextLength += record.text.length;
      } else if (typeof record.image_url === "object") {
        inputTextLength += 512;
      }
    }
  }

  const maxCompletionTokens =
    typeof requestBody.max_completion_tokens === "number"
      ? requestBody.max_completion_tokens
      : typeof requestBody.max_tokens === "number"
        ? requestBody.max_tokens
        : typeof requestBody.maxOutputTokens === "number"
          ? requestBody.maxOutputTokens
          : 1024;

  return {
    inputTokens: Math.max(1, Math.ceil(inputTextLength / 4)),
    outputTokens: Math.max(
      0,
      Math.min(16_384, Math.floor(maxCompletionTokens)),
    ),
  };
}

const managedRelayModelSupportsImageInput = (resolvedModel: string): boolean =>
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

// Extract the Stella/upstream model id from a Google relay path. The
// desktop's Google SDK constructs URLs as `…/models/{model}:{verb}`
// where `{model}` is whatever was set as `model.id` on the relay model
// — which is the full requested id (e.g. `stella/google/gemini-3-flash-preview`,
// containing slashes). The previous `[^/]+` capture only matched single-
// segment names and silently dropped the rest, so the auth layer fell
// back to the standard mode and the user's pick was ignored. Allow
// slashes by capturing greedily up to the verb, and tolerate any
// `generateContent` / `streamGenerateContent` / `countTokens` /
// `embedContent` suffix Google ever ships.
export function requestedModelFromGooglePath(pathname: string): string | null {
  const match = /\/models\/(.+?):[A-Za-z][A-Za-z0-9]*$/u.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
