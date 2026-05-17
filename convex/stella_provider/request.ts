import {
  getModeConfig,
  getModelConfig,
  isStellaModelAllowedForAudience,
  LOCKED_AGENT_TYPES,
  type ManagedModelAudience,
  type ModelConfig,
} from "../agent/model";
import { inferManagedGatewayProviderFromModel } from "../lib/managed_gateway";
import {
  STELLA_DEFAULT_MODEL,
  isStellaModel,
  parseStellaModelSelection,
  resolveStellaModelSelection,
} from "../stella_models";
import type {
  ResolvedStellaModelSelection,
  StellaRequestBody,
} from "./shared";
import type { TokenEstimate } from "./billing";

export function resolveRequestedStellaModel(
  agentType: string,
  requestBody: StellaRequestBody,
  audience: ManagedModelAudience,
): ResolvedStellaModelSelection {
  const clientRequestedModel =
    typeof requestBody.model === "string" && requestBody.model.trim().length > 0
      ? requestBody.model.trim()
      : STELLA_DEFAULT_MODEL;

  const requestedModel =
    !LOCKED_AGENT_TYPES.has(agentType) &&
    isStellaModelAllowedForAudience(clientRequestedModel, audience)
      ? clientRequestedModel
      : STELLA_DEFAULT_MODEL;

  if (!isStellaModel(requestedModel)) {
    throw new Error(`Unsupported Stella model selection: ${requestedModel}`);
  }

  const parsedModel = parseStellaModelSelection(requestedModel);
  if (parsedModel?.kind === "default" || parsedModel?.kind === "mode") {
    const config =
      parsedModel.kind === "default"
        ? getModelConfig(agentType, audience)
        : getModeConfig(parsedModel.mode, audience);
    return {
      requestedModel,
      resolvedModel: config.model,
      config: withoutFallback(config),
    };
  }

  const agentConfig = getModelConfig(agentType, audience);
  const resolvedModel = resolveStellaModelSelection(
    agentType,
    requestedModel,
    audience,
  );
  const inferredProvider = inferManagedGatewayProviderFromModel(resolvedModel);
  const config: ModelConfig = {
    ...withoutFallback(agentConfig),
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

// Extract the Stella/upstream model id from a Google relay path. The
// desktop's Google SDK constructs URLs as `…/models/{model}:{verb}`
// where `{model}` is whatever was set as `model.id` on the relay model
// — which is the full requested id (e.g. `stella/google/gemini-3-flash-preview`,
// containing slashes). The previous `[^/]+` capture only matched single-
// segment names and silently dropped the rest, so the auth layer fell
// back to `stella/default` and the user's pick was ignored. Allow
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
