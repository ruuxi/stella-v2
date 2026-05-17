import {
  getModeConfig,
  getModelConfig,
  isStellaModelAllowedForAudience,
  LOCKED_AGENT_TYPES,
  type ManagedModelAudience,
  type ModelConfig,
} from "../agent/model";
import {
  inferManagedGatewayProviderFromModel,
  type ManagedGatewayProvider,
} from "../lib/managed_gateway";
import type { ManagedProtocol } from "../runtime_ai/managed";
import type { Context } from "../runtime_ai/types";
import {
  STELLA_DEFAULT_MODEL,
  isStellaModel,
  parseStellaModelSelection,
  resolveStellaModelSelection,
} from "../stella_models";
import {
  asRecord,
  STELLA_REQUEST_PASSTHROUGH_EXCLUSIONS,
  type ManagedRuntimeRequest,
  type ResolvedStellaModelSelection,
  type StellaRequestBody,
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

  // Anonymous/free/go (and go's downgraded fallback) are pinned to the
  // backend-chosen model for most picks, with one carve-out: a small
  // allowlist of additional presets (currently `stella/light`) they may
  // still opt into. `isStellaModelAllowedForAudience` is the single
  // source of truth — the same predicate the `/api/models` endpoint uses
  // when telling the desktop picker which rows to disable. Per-agent
  // locks (currently only `chronicle`) ignore the client model
  // regardless of audience.
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
      config,
    };
  }

  // Upstream model picks (e.g. `stella/anthropic/claude-opus-4.7`,
  // `stella/openai/gpt-5.5`) must NOT reuse the agent's default gateway:
  // the orchestrator's standard mode is Fireworks, which would 404 on an
  // Anthropic model id and then fall back to the agent's light fallback
  // (deepseek/openrouter), which in turn fails with "No endpoints found
  // that support image input" the moment the user attaches an image.
  // Infer the gateway from the model prefix instead, leaving it
  // unset for unrecognized prefixes so `resolveManagedGatewayProvider`
  // downstream defaults to OpenRouter (the universal multi-provider
  // gateway). Also clear the agent's fallback — an explicit upstream
  // pick should fail loudly rather than silently downgrade to a model
  // the user didn't choose.
  const agentConfig = getModelConfig(agentType, audience);
  const resolvedModel = resolveStellaModelSelection(
    agentType,
    requestedModel,
    audience,
  );
  const inferredProvider = inferManagedGatewayProviderFromModel(resolvedModel);
  const config: ModelConfig = {
    ...agentConfig,
    model: resolvedModel,
    managedGatewayProvider: inferredProvider,
    fallback: undefined,
    fallbackManagedGatewayProvider: undefined,
    fallbackProviderOptions: undefined,
  };
  return {
    requestedModel,
    resolvedModel,
    config,
  };
}

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
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string") {
        inputTextLength += text.length;
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

export function estimateContextTokens(args: {
  context: Context;
  request?: Record<string, unknown> | null;
}): TokenEstimate {
  const parts: string[] = [];
  if (typeof args.context.systemPrompt === "string") {
    parts.push(args.context.systemPrompt);
  }

  for (const message of args.context.messages) {
    if (typeof message.content === "string") {
      parts.push(message.content);
      continue;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const block of message.content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if ("text" in block && typeof block.text === "string") {
        parts.push(block.text);
        continue;
      }
      if ("thinking" in block && typeof block.thinking === "string") {
        parts.push(block.thinking);
        continue;
      }
      if (
        "arguments" in block &&
        block.arguments &&
        typeof block.arguments === "object"
      ) {
        parts.push(JSON.stringify(block.arguments));
      }
    }
  }

  const requestRecord = args.request ?? null;
  const maxTokens =
    typeof requestRecord?.maxTokens === "number"
      ? requestRecord.maxTokens
      : typeof requestRecord?.max_completion_tokens === "number"
        ? requestRecord.max_completion_tokens
        : typeof requestRecord?.max_tokens === "number"
          ? requestRecord.max_tokens
          : 1024;

  const inputTextLength = parts.join("\n").length;
  return {
    inputTokens: Math.max(1, Math.ceil(inputTextLength / 4)),
    outputTokens: Math.max(0, Math.min(16_384, Math.floor(maxTokens))),
  };
}

export function buildManagedRuntimeRequest(
  requestBody: StellaRequestBody,
  signal: AbortSignal,
): ManagedRuntimeRequest {
  const extraBody = Object.fromEntries(
    Object.entries(requestBody).filter(
      ([key]) => !STELLA_REQUEST_PASSTHROUGH_EXCLUSIONS.has(key),
    ),
  );
  const sessionId =
    typeof requestBody.sessionId === "string" &&
    requestBody.sessionId.length > 0
      ? requestBody.sessionId
      : typeof requestBody.user === "string"
        ? requestBody.user
        : undefined;

  return {
    temperature:
      typeof requestBody.temperature === "number"
        ? requestBody.temperature
        : undefined,
    maxTokens:
      typeof requestBody.max_completion_tokens === "number"
        ? requestBody.max_completion_tokens
        : typeof requestBody.max_tokens === "number"
          ? requestBody.max_tokens
          : typeof requestBody.maxOutputTokens === "number"
            ? requestBody.maxOutputTokens
            : undefined,
    reasoning:
      requestBody.reasoning === "minimal" ||
      requestBody.reasoning === "low" ||
      requestBody.reasoning === "medium" ||
      requestBody.reasoning === "high" ||
      requestBody.reasoning === "xhigh"
        ? requestBody.reasoning
        : requestBody.reasoning_effort === "minimal" ||
            requestBody.reasoning_effort === "low" ||
            requestBody.reasoning_effort === "medium" ||
            requestBody.reasoning_effort === "high" ||
            requestBody.reasoning_effort === "xhigh"
          ? requestBody.reasoning_effort
          : undefined,
    toolChoice:
      requestBody.tool_choice === "auto" ||
      requestBody.tool_choice === "none" ||
      requestBody.tool_choice === "required" ||
      (requestBody.tool_choice && typeof requestBody.tool_choice === "object")
        ? (requestBody.tool_choice as ManagedRuntimeRequest["toolChoice"])
        : undefined,
    responseFormat: requestBody.response_format,
    extraBody: Object.keys(extraBody).length > 0 ? extraBody : undefined,
    signal,
    sessionId,
    cacheRetention:
      requestBody.cacheRetention === "none" ||
      requestBody.cacheRetention === "short" ||
      requestBody.cacheRetention === "long"
        ? requestBody.cacheRetention
        : undefined,
  };
}

export function buildManagedRuntimeRequestFromNativeRequest(
  requestBody: unknown,
  signal: AbortSignal,
): ManagedRuntimeRequest {
  const record = asRecord(requestBody) ?? {};
  const extraBody = asRecord(record.extraBody) ?? undefined;
  const headerRecord = asRecord(record.headers);
  const headers = headerRecord
    ? Object.fromEntries(
        Object.entries(headerRecord).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;

  return {
    temperature:
      typeof record.temperature === "number" ? record.temperature : undefined,
    maxTokens:
      typeof record.maxTokens === "number"
        ? record.maxTokens
        : typeof record.max_completion_tokens === "number"
          ? record.max_completion_tokens
          : typeof record.max_tokens === "number"
            ? record.max_tokens
            : undefined,
    reasoning:
      record.reasoning === "minimal" ||
      record.reasoning === "low" ||
      record.reasoning === "medium" ||
      record.reasoning === "high" ||
      record.reasoning === "xhigh"
        ? record.reasoning
        : record.reasoning_effort === "minimal" ||
            record.reasoning_effort === "low" ||
            record.reasoning_effort === "medium" ||
            record.reasoning_effort === "high" ||
            record.reasoning_effort === "xhigh"
          ? record.reasoning_effort
          : undefined,
    toolChoice:
      record.toolChoice === "auto" ||
      record.toolChoice === "none" ||
      record.toolChoice === "required" ||
      (record.toolChoice && typeof record.toolChoice === "object")
        ? (record.toolChoice as ManagedRuntimeRequest["toolChoice"])
        : record.tool_choice === "auto" ||
            record.tool_choice === "none" ||
            record.tool_choice === "required" ||
            (record.tool_choice && typeof record.tool_choice === "object")
          ? (record.tool_choice as ManagedRuntimeRequest["toolChoice"])
          : undefined,
    responseFormat: record.responseFormat ?? record.response_format,
    extraBody,
    signal,
    headers,
    sessionId:
      typeof record.sessionId === "string" && record.sessionId.length > 0
        ? record.sessionId
        : undefined,
    cacheRetention:
      record.cacheRetention === "none" ||
      record.cacheRetention === "short" ||
      record.cacheRetention === "long"
        ? record.cacheRetention
        : undefined,
  };
}

export function parseNativeContext(value: unknown): Context | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.messages)) {
    return null;
  }
  return record as unknown as Context;
}

export function resolveManagedProtocol(args: {
  resolvedModel: string;
  managedGatewayProvider: ManagedGatewayProvider;
}): ManagedProtocol {
  const normalizedModel = args.resolvedModel.trim().toLowerCase();
  if (args.managedGatewayProvider === "anthropic") {
    return "anthropic-messages";
  }
  if (args.managedGatewayProvider === "google") {
    return "google-generative-ai";
  }
  if (
    args.managedGatewayProvider === "fireworks" ||
    args.managedGatewayProvider === "openai" ||
    normalizedModel.startsWith("openai/")
  ) {
    return "openai-responses";
  }
  return "openai-completions";
}
