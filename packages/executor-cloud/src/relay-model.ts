import type { ManagedModelAudience } from "@stella/contracts/gateway/capability";
import type { Context, AssistantMessageEvent } from "@stella/runtime/ai/types.js";
import type { StreamFn } from "@stella/runtime/kernel/agent-core/types.js";
import { streamSimple } from "@stella/runtime/ai/stream.js";
import { AssistantMessageEventStream } from "@stella/runtime/ai/utils/event-stream.js";
import { resolveManagedModelDescriptor } from "@stella/model-catalog/gateway-resolution";
import { GATEWAY_VALIDATED_RELAY_PREFIX, GATEWAY_RELAY_PREFIX, GATEWAY_MODEL_REVISION_HEADER, GATEWAY_MODEL_RESOLUTION_HEADER,
  gatewayModelResolutionRevision } from "@stella/contracts/gateway/api";
import type {
  AgentModelReasoningEffort,
  CloudExecutionSelection,
} from "@stella/contracts/agent-engine";
import {
  isDeepSeekV4FlashModel,
  isMuseSpark13ContributorModel,
} from "@stella/contracts/stella-api";
import { loadModelRegistry } from "@stella/contracts/model-registry";
import {
  GATEWAY_AGENT_TYPE_HEADER,
  GATEWAY_PROTOCOLS,
  GATEWAY_PROVIDERS,
  GATEWAY_RESOLVE_PATH,
  gatewayRelayBaseUrl,
  type GatewayModelResolution,
  type GatewayProtocol,
  type GatewayProvider,
  type GatewayResolveRequest,
} from "@stella/contracts/gateway/api";
import { clampThinkingLevel } from "@stella/runtime/ai/models.js";
import type {
  Api,
  Model,
  ModelThinkingLevel,
} from "@stella/runtime/ai/types.js";
import { CLOUD_MODEL_DIAGNOSTIC_SENTINELS } from "@stella/contracts/cloud-model-diagnostic";
import { findRegistryModel } from "@stella/runtime/kernel/model-routing-matching.js";
import type { ThinkingLevel } from "@stella/runtime/kernel/agent-core/types.js";

/**
 * Selects an owner-connected subscription on the gateway's native lane. The
 * gateway keys the lane off the capability's `credential` claim; this header
 * is informational so relay logs on both sides can be joined.
 */
export const CLOUD_LLM_CREDENTIAL_HEADER = "x-stella-llm-credential";

export const DEFAULT_CLOUD_ANTHROPIC_ENGINE_MODEL = "claude-sonnet-4-6";
export const DEFAULT_CLOUD_CODEX_ENGINE_MODEL = "gpt-5.6-sol";

const RESOLVE_TIMEOUT_MS = 15_000;

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const ENGINE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const ANTHROPIC_ENGINE_MODEL_PATTERN =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,191}|[A-Za-z0-9][A-Za-z0-9._-]{0,187}\[1m\])$/;
const LOCAL_ONLY_STELLA_PREFIXES = [
  "stella/local/",
  "stella/ollama/",
  "stella/lmstudio/",
  "stella/openai-codex/",
] as const;

const REASONING_EFFORTS = new Set<AgentModelReasoningEffort>([
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const validateCloudExecutionSelection = (
  execution: CloudExecutionSelection,
): CloudExecutionSelection => {
  if (execution.engine !== execution.provider) {
    throw new Error(
      "Cloud execution engine and provider must identify the same route.",
    );
  }
  if (!REASONING_EFFORTS.has(execution.reasoningEffort)) {
    throw new Error("Unsupported cloud reasoning effort.");
  }
  const model = execution.model.trim();
  const validModelSyntax =
    MODEL_ID_PATTERN.test(model) ||
    (execution.engine === "anthropic" &&
      model.length <= 192 &&
      ANTHROPIC_ENGINE_MODEL_PATTERN.test(model));
  if (!model || !validModelSyntax || model !== execution.model) {
    throw new Error("Cloud execution requires a valid exact model id.");
  }
  if (execution.engine === "stella") {
    if (
      !model.startsWith("stella/") ||
      model === "stella/" ||
      LOCAL_ONLY_STELLA_PREFIXES.some((prefix) => model.startsWith(prefix))
    ) {
      throw new Error(
        `"${model}" is not available to cloud execution. Select a Stella-managed model, Claude, or ChatGPT.`,
      );
    }
    return execution;
  }
  if (
    execution.engine === "anthropic" &&
    (model.length > 192 || !ANTHROPIC_ENGINE_MODEL_PATTERN.test(model))
  ) {
    throw new Error(
      `${execution.engine} cloud execution requires an engine-native model id.`,
    );
  }
  if (
    execution.engine === "openai-codex" &&
    !ENGINE_MODEL_PATTERN.test(model)
  ) {
    throw new Error(
      `${execution.engine} cloud execution requires an engine-native model id.`,
    );
  }
  return execution;
};

/**
 * What every gateway-bound model carries: the vendor SDK's base URL points at
 * the gateway relay prefix, the capability is the bearer, the agent type
 * names the policy the gateway applies, and an injected `fetch` (a service
 * binding inside a Durable Object) replaces the global one when present.
 */
type GatewayModelTransport = {
  gatewayOrigin: string;
  capability: string;
  agentType: string;
  fetch?: typeof fetch;
};

const gatewayHeaders = (
  transport: GatewayModelTransport,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  [GATEWAY_AGENT_TYPE_HEADER]: transport.agentType,
  authorization: `Bearer ${transport.capability}`,
  ...extra,
});

const withTransport = <T extends Model<Api>>(
  model: T,
  transport: GatewayModelTransport,
): T => ({
  ...model,
  baseUrl: gatewayRelayBaseUrl(transport.gatewayOrigin),
  ...(transport.fetch ? { fetch: transport.fetch } : {}),
});

const genericSubscriptionModel = (
  provider: "anthropic" | "openai-codex",
  modelId: string,
): Model<Api> => ({
  id: modelId,
  name: modelId,
  api:
    provider === "anthropic" ? "anthropic-messages" : "openai-codex-responses",
  provider,
  baseUrl: "",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 16_384,
});

/**
 * Connected Claude / ChatGPT subscriptions keep their native adapters; the
 * gateway forwards the bytes on its native lane using the owner's connected
 * credential selected by the capability's `credential` claim.
 */
const subscriptionRelayModel = (args: {
  execution: CloudExecutionSelection;
  transport: GatewayModelTransport;
}): Model<Api> => {
  const provider = args.execution.engine as "anthropic" | "openai-codex";
  const modelId = args.execution.model;
  const registryModel =
    findRegistryModel(provider, [modelId, modelId.replace(/\./g, "-")]) ??
    genericSubscriptionModel(provider, modelId);
  return withTransport(
    {
      ...registryModel,
      id: `stella/${provider}/${modelId}`,
      name:
        provider === "anthropic"
          ? "Claude (subscription)"
          : "ChatGPT (subscription)",
      provider,
      api:
        provider === "anthropic"
          ? "anthropic-messages"
          : "openai-codex-responses",
      headers: {
        ...(registryModel.headers ?? {}),
        ...gatewayHeaders(args.transport, {
          [CLOUD_LLM_CREDENTIAL_HEADER]: provider,
        }),
      },
    } as Model<Api>,
    args.transport,
  );
};

const isGatewayProvider = (value: unknown): value is GatewayProvider =>
  typeof value === "string" &&
  (GATEWAY_PROVIDERS as readonly string[]).includes(value);

const isGatewayProtocol = (value: unknown): value is GatewayProtocol =>
  typeof value === "string" &&
  (GATEWAY_PROTOCOLS as readonly string[]).includes(value);

const isOptionalPositiveInteger = (value: unknown): boolean =>
  value === undefined ||
  (typeof value === "number" && Number.isSafeInteger(value) && value > 0);

/** Structural check of the gateway's resolve response before it is trusted. */
export const parseGatewayModelResolution = (
  value: unknown,
): GatewayModelResolution | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.requestedModel !== "string" ||
    !MODEL_ID_PATTERN.test(row.requestedModel) ||
    typeof row.resolvedModel !== "string" ||
    !MODEL_ID_PATTERN.test(row.resolvedModel) ||
    !isGatewayProvider(row.provider) ||
    !isGatewayProtocol(row.protocol) ||
    typeof row.reasoning !== "boolean" ||
    typeof row.supportsImages !== "boolean" ||
    !isOptionalPositiveInteger(row.contextWindow) ||
    !isOptionalPositiveInteger(row.maxOutputTokens)
  ) {
    return null;
  }
  return {
    requestedModel: row.requestedModel,
    resolvedModel: row.resolvedModel,
    provider: row.provider,
    protocol: row.protocol,
    reasoning: row.reasoning,
    supportsImages: row.supportsImages,
    ...(row.contextWindow !== undefined
      ? { contextWindow: row.contextWindow as number }
      : {}),
    ...(row.maxOutputTokens !== undefined
      ? { maxOutputTokens: row.maxOutputTokens as number }
      : {}),
  };
};

/** The gateway's wire protocol is the runtime adapter id. */
const apiForProtocol = (protocol: GatewayProtocol): Api => protocol;

/**
 * Build the managed-lane model from a gateway resolution. Request bodies keep
 * sending the `stella/...` alias (`id = execution.model`); the gateway pins
 * the alias to the admitted execution and maps it upstream. The resolved
 * upstream id only selects registry metadata (context window, thinking map)
 * and is stashed as `upstreamModelId` for diagnostics.
 */
export const createResolvedManagedRelayModel = (args: {
  execution: CloudExecutionSelection;
  resolution: GatewayModelResolution;
  gatewayOrigin: string;
  capability: string;
  agentType: string;
  fetch?: typeof fetch;
}): Model<Api> => {
  const { resolution } = args;
  const relayProvider = resolution.provider;
  const directModelPrefix =
    relayProvider === "xai" ? "x-ai/" : `${relayProvider}/`;
  const nativeModelId =
    relayProvider !== "openrouter" &&
    relayProvider !== "fireworks" &&
    resolution.resolvedModel.startsWith(directModelPrefix)
      ? resolution.resolvedModel.slice(directModelPrefix.length)
      : resolution.resolvedModel;
  const registryModel = findRegistryModel(relayProvider, [
    resolution.resolvedModel,
    nativeModelId,
    nativeModelId.replace(/\./g, "-"),
  ]);
  const api = apiForProtocol(resolution.protocol);
  const transport: GatewayModelTransport = {
    gatewayOrigin: args.gatewayOrigin,
    capability: args.capability,
    agentType: args.agentType,
    ...(args.fetch ? { fetch: args.fetch } : {}),
  };
  const model = withTransport(
    {
      ...(registryModel ?? {
        id: nativeModelId,
        name: nativeModelId,
        provider: relayProvider,
        api,
        reasoning: resolution.reasoning,
        input: resolution.supportsImages ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 80_000,
        maxTokens: 16_384,
      }),
      id: args.execution.model,
      name: args.execution.model.replace(/^stella\//, ""),
      provider: registryModel?.provider ?? relayProvider,
      api,
      ...(resolution.contextWindow !== undefined
        ? { contextWindow: resolution.contextWindow }
        : {}),
      ...(resolution.maxOutputTokens !== undefined
        ? { maxTokens: resolution.maxOutputTokens }
        : {}),
      ...(isDeepSeekV4FlashModel(resolution.resolvedModel)
        ? {
            thinkingLevelMap: {
              ...registryModel?.thinkingLevelMap,
              ...(relayProvider === "crof" || relayProvider === "wafer"
                ? {
                    minimal: "low",
                    low: "low",
                    medium: "medium",
                    high: "high",
                    xhigh: "high",
                    off: "none",
                  }
                : {
                    minimal: "low",
                    low: "low",
                    medium: "high",
                    high: "max",
                    xhigh: "max",
                    off: "none",
                  }),
            },
          }
        : {}),
      ...(isMuseSpark13ContributorModel(resolution.resolvedModel)
        ? {
            thinkingLevelMap: {
              ...registryModel?.thinkingLevelMap,
              xhigh: "xhigh",
            } as NonNullable<Model<Api>["thinkingLevelMap"]>,
          }
        : {}),
      headers: {
        ...(registryModel?.headers ?? {}),
        ...gatewayHeaders(transport),
      },
    } as Model<Api>,
    transport,
  );
  (model as Model<Api> & { upstreamModelId?: string }).upstreamModelId =
    nativeModelId;
  return model;
};

const transportCodeOf = (error: unknown): string => {
  if (!error || typeof error !== "object") return "";
  const direct = Reflect.get(error, "code");
  if (typeof direct === "string") return direct;
  const cause = Reflect.get(error, "cause");
  if (!cause || typeof cause !== "object") return "";
  const nested = Reflect.get(cause, "code");
  return typeof nested === "string" ? nested : "";
};

/**
 * Collapse a failed gateway round trip to a static sentinel. Exception causes
 * can carry transport or provider detail and must never enter Builder logs
 * or acceptance output.
 */
const resolveTransportFailure = (error: unknown): Error => {
  const transportCode = transportCodeOf(error);
  if (
    transportCode === "ConnectionRefused" ||
    transportCode === "ECONNREFUSED"
  ) {
    return new Error(CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_refused);
  }
  if (transportCode === "Timeout" || transportCode === "ETIMEDOUT") {
    return new Error(CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_timeout);
  }
  if (
    transportCode === "NetworkUnreachable" ||
    transportCode === "ENETUNREACH" ||
    transportCode === "EHOSTUNREACH"
  ) {
    return new Error(
      CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_unreachable,
    );
  }
  return new Error(CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_connect);
};

const resolveManagedRelayModel = async (args: {
  execution: CloudExecutionSelection;
  transport: GatewayModelTransport;
  signal?: AbortSignal;
}): Promise<GatewayModelResolution> => {
  const timeoutSignal = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
  const request: GatewayResolveRequest = {
    model: args.execution.model,
    agentType: args.transport.agentType,
  };
  let response: Response;
  try {
    response = await (args.transport.fetch ?? fetch)(
      `${args.transport.gatewayOrigin.replace(/\/+$/, "")}${GATEWAY_RESOLVE_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...gatewayHeaders(args.transport),
        },
        body: JSON.stringify(request),
        signal: args.signal
          ? AbortSignal.any([args.signal, timeoutSignal])
          : timeoutSignal,
      },
    );
  } catch (error) {
    // Preserve an explicit turn cancellation; everything else is a sentinel.
    if (args.signal?.aborted) throw error;
    throw resolveTransportFailure(error);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_http_failure);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_response_invalid);
  }
  const resolution = parseGatewayModelResolution(payload);
  if (!resolution || resolution.requestedModel !== args.execution.model) {
    throw new Error(CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_response_invalid);
  }
  return resolution;
};

export type CloudRelayModelArgs = {
  /** Public origin of the model gateway (`MODEL_GATEWAY_URL`). */
  gatewayOrigin: string;
  /** Turn capability minted by the admitting Durable Object. */
  capability: string;
  agentType: string;
  execution: CloudExecutionSelection;
  /** Exact turn fiber cancellation; connected routes are synchronous/local. */
  signal?: AbortSignal;
  /**
   * Transport override. A Durable Object passes its `MODEL_GATEWAY` service
   * binding here so model traffic never leaves Cloudflare's network; a
   * sandbox omits it and reaches the public origin.
   */
  fetch?: typeof fetch;
};

/**
 * Create the exact gateway-bound adapter selected at dispatch. Managed routes
 * are resolved through `POST /v1/models/resolve` so the sandbox learns which
 * provider protocol to speak; connected subscriptions keep their native
 * Anthropic/Codex adapters on the gateway's native lane.
 */
export const createCloudRelayModel = async (
  args: CloudRelayModelArgs,
): Promise<Model<Api>> => {
  const execution = validateCloudExecutionSelection(args.execution);
  const gatewayOrigin = args.gatewayOrigin.trim();
  if (!/^https?:\/\//i.test(gatewayOrigin)) {
    throw new Error("Cloud model gateway origin must be an HTTP(S) URL.");
  }
  if (typeof args.capability !== "string" || !args.capability.trim()) {
    throw new Error("Cloud model gateway capability is required.");
  }
  const transport: GatewayModelTransport = {
    gatewayOrigin,
    capability: args.capability,
    agentType: args.agentType,
    ...(args.fetch ? { fetch: args.fetch } : {}),
  };
  if (execution.engine !== "stella") {
    await loadModelRegistry();
    return subscriptionRelayModel({ execution, transport });
  }
  // Resolution has no dependency on the registry. In a cold isolate, start
  // its network trip immediately while the local catalog module loads.
  const [, resolution] = await Promise.all([
    loadModelRegistry(),
    resolveManagedRelayModel({ execution, transport, signal: args.signal }),
  ]);
  args.signal?.throwIfAborted();
  try {
    return createResolvedManagedRelayModel({ execution, resolution, ...transport });
  } catch {
    throw new Error(CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_response_invalid);
  }
};

/**
 * Resolve the requested reasoning effort to the closest level the exact model
 * supports. `none` is an explicit off request; `default` preserves Stella's
 * normal medium/off behavior.
 */
export const resolveCloudThinkingLevel = (
  model: Model<Api>,
  requested: AgentModelReasoningEffort,
): ThinkingLevel => {
  if (requested === "default") {
    return model.reasoning ? "medium" : "off";
  }
  const desired: ModelThinkingLevel = requested === "none" ? "off" : requested;
  return clampThinkingLevel(model, desired);
};

export type CloudRelayContextTransform = (
  model: Model<Api>,
  context: Context,
  signal?: AbortSignal,
) => Promise<Context>;

/**
 * A turn-local adapter. Every physical request validates its descriptor at the
 * gateway; there is no TTL or remembered alias route. A deploy mismatch is
 * retried once from the original context, before anything can reach a provider.
 */
export const createCloudRelaySession = async (
  args: CloudRelayModelArgs & { audience: ManagedModelAudience },
): Promise<{
  readonly model: Model<Api>;
  createStreamFn: (options: {
    reasoningEffort: AgentModelReasoningEffort;
    transformContext?: CloudRelayContextTransform;
  }) => StreamFn;
}> => {
  const execution = validateCloudExecutionSelection(args.execution);
  if (execution.engine !== "stella") {
    const model = await createCloudRelayModel(args);
    return { model, createStreamFn: (streamOptions) => async (_ignoredModel, context, options) => {
      const signal = options?.signal && args.signal
        ? AbortSignal.any([options.signal, args.signal]) : options?.signal ?? args.signal;
      try {
        signal?.throwIfAborted();
        const prepared = streamOptions.transformContext
          ? await streamOptions.transformContext(model, context, signal) : context;
        signal?.throwIfAborted();
        return streamSimple(model, prepared, { ...options, signal });
      } catch (error) {
        return relaySessionErrorStream(model, error, options?.signal?.aborted || args.signal?.aborted);
      }
    } };
  }
  const gatewayOrigin = args.gatewayOrigin.trim();
  if (!/^https?:\/\//i.test(gatewayOrigin)) throw new Error("Cloud model gateway origin must be an HTTP(S) URL.");
  if (!args.capability.trim()) throw new Error("Cloud model gateway capability is required.");
  await loadModelRegistry();
  args.signal?.throwIfAborted();
  const transport: GatewayModelTransport = { ...args, gatewayOrigin };
  let resolution: GatewayModelResolution;
  try {
    resolution = resolveManagedModelDescriptor({ agentType: args.agentType,
      requestedModel: execution.model, audience: args.audience });
    if (resolution.requestedModel !== execution.model) throw new Error("Unresolved model");
  } catch {
    // Open-ended explicit models and newer catalog entries retain the existing
    // authoritative lookup/error behavior when this build cannot resolve them.
    resolution = await resolveManagedRelayModel({ execution, transport, signal: args.signal });
  }
  let model = createResolvedManagedRelayModel({ execution, resolution, ...transport });
  let revision = await gatewayModelResolutionRevision(resolution);
  let validatedRoute = true;
  return {
    get model() { return model; },
    createStreamFn: (streamOptions) => (_ignoredModel, rawContext, options) => {
      const signal = options?.signal && args.signal
        ? AbortSignal.any([options.signal, args.signal]) : options?.signal ?? args.signal;
      const out = new AssistantMessageEventStream();
      const run = async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          options?.signal?.throwIfAborted();
          args.signal?.throwIfAborted();
          let mismatch: GatewayModelResolution | undefined;
          let legacyGateway = false;
          const attemptModel: Model<Api> = { ...model,
            headers: { ...model.headers, ...(validatedRoute ? { [GATEWAY_MODEL_REVISION_HEADER]: revision } : {}) },
            fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
              let request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
              if (validatedRoute) {
                const url = new URL(request.url);
                url.pathname = url.pathname.replace(GATEWAY_RELAY_PREFIX, GATEWAY_VALIDATED_RELAY_PREFIX);
                request = new Request(url.href, request);
              }
              const response = await (args.fetch ?? fetch)(request);
              if (validatedRoute && response.status === 404) {
                try {
                  const body: unknown = await response.clone().json();
                  legacyGateway = !!(body && typeof body === "object" && "error" in body &&
                    body.error && typeof body.error === "object" && "code" in body.error &&
                    body.error.code === "bad_request" && "message" in body.error && body.error.message === "Not found.");
                } catch { /* Only the old router's explicit refusal allows fallback. */ }
              }
              if (response.status === 409) {
                const encoded = response.headers.get(GATEWAY_MODEL_RESOLUTION_HEADER);
                if (encoded && encoded.length <= 4096) {
                  try {
                    const body: unknown = await response.clone().json();
                    const current = parseGatewayModelResolution(JSON.parse(decodeURIComponent(encoded)));
                    if (body && typeof body === "object" && "error" in body &&
                        body.error && typeof body.error === "object" && "code" in body.error &&
                        body.error.code === "model_revision_mismatch" && current?.requestedModel === execution.model) {
                      mismatch = current;
                    }
                  } catch { /* Invalid mismatch metadata is a normal request failure. */ }
                }
              }
              return response;
            }, args.fetch ?? fetch),
          };
          const context = streamOptions.transformContext
            ? await streamOptions.transformContext(attemptModel, rawContext, signal)
            : rawContext;
          options?.signal?.throwIfAborted();
          args.signal?.throwIfAborted();
          const thinking = resolveCloudThinkingLevel(attemptModel, streamOptions.reasoningEffort);
          const inner = streamSimple(attemptModel, context, { ...options, signal,
            reasoning: thinking === "off" ? undefined : thinking,
            disableReasoning: thinking === "off",
          });
          // Managed replies already arrive as one complete JSON response. Hold
          // only this adapter attempt's events so a refused request never enters
          // the journal as a spurious assistant error or duplicate start event.
          const events: AssistantMessageEvent[] = [];
          for await (const event of inner) events.push(event);
          if ((mismatch || legacyGateway) && attempt === 0 && !options?.signal?.aborted && !args.signal?.aborted) {
            if (legacyGateway) {
              resolution = await resolveManagedRelayModel({ execution, transport,
                signal: options?.signal && args.signal ? AbortSignal.any([options.signal, args.signal]) : options?.signal ?? args.signal });
              validatedRoute = false;
            } else if (mismatch) resolution = mismatch;
            model = createResolvedManagedRelayModel({ execution, resolution, ...transport });
            revision = await gatewayModelResolutionRevision(resolution);
            continue;
          }
          for (const event of events) out.push(event);
          out.end(await inner.result());
          return;
        }
      };
      void run().catch(async error => {
        const aborted = options?.signal?.aborted || args.signal?.aborted;
        for await (const event of relaySessionErrorStream(model, error, aborted)) out.push(event);
        out.end();
      });
      return out;
    },
  };
};

const relaySessionErrorStream = (model: Model<Api>, error: unknown, aborted?: boolean): AssistantMessageEventStream => {
  const out = new AssistantMessageEventStream();
  out.push({ type: "error", reason: aborted ? "aborted" : "error", error: {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
  } });
  out.end();
  return out;
};
