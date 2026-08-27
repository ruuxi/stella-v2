import OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { sleepMs } from "../effect-runtime.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { clampThinkingLevel } from "../models.js";
import type {
  Api,
  AssistantMessage,
  CacheRetention,
  Context,
  Model,
  OpenAIResponsesCompat,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
  Usage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { anomalousStreamStopError } from "../utils/provider-stop.js";
import { hashProviderRequestIdentity } from "../utils/provider-request-proof.js";
import { resilientEventStream } from "../utils/resilient-event-stream.js";
import { readRetryAfterMs } from "../utils/retry.js";
import {
  isCloudflareProvider,
  resolveCloudflareBaseUrl,
} from "./cloudflare.js";
import {
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
} from "./github-copilot-headers.js";
import { requestWithAuthRefresh } from "./auth-refresh.js";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set([
  "openai",
  "openai-codex",
  "opencode",
]);
const STELLA_RELAY_RESUME_HEADER = "x-stella-relay-resume";
const STELLA_RELAY_REQUEST_ID_HEADER = "x-stella-relay-request-id";
const STELLA_RELAY_RESUME_VERSION = "1";
const RELAY_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,100}$/u;

const isManagedStellaRelayBaseUrl = (baseUrl: string): boolean => {
  try {
    return new URL(baseUrl).pathname
      .replace(/\/+$/u, "")
      .endsWith("/api/stella/relay");
  } catch {
    return false;
  }
};

const newRequestNonce = (): string =>
  (globalThis as { crypto?: Crypto }).crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const validRelayRequestId = (value: string): boolean =>
  RELAY_REQUEST_ID_PATTERN.test(value);
/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(
  cacheRetention?: CacheRetention,
): CacheRetention {
  if (cacheRetention) {
    return cacheRetention;
  }
  if (
    typeof process !== "undefined" &&
    process.env.PI_CACHE_RETENTION === "long"
  ) {
    return "long";
  }
  return "short";
}

function getCompat(
  model: Model<"openai-responses">,
): Required<Omit<OpenAIResponsesCompat, "supportsToolSearch">> {
  return {
    sendSessionIdHeader: model.compat?.sendSessionIdHeader ?? true,
    supportsLongCacheRetention:
      model.compat?.supportsLongCacheRetention ?? true,
  };
}

function getPromptCacheRetention(
  compat: Required<Omit<OpenAIResponsesCompat, "supportsToolSearch">>,
  cacheRetention: CacheRetention,
): "24h" | undefined {
  return cacheRetention === "long" && compat.supportsLongCacheRetention
    ? "24h"
    : undefined;
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

/**
 * Generate function for OpenAI Responses API
 */
export const streamOpenAIResponses: StreamFunction<
  "openai-responses",
  OpenAIResponsesOptions
> = (
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();

  // Start async processing
  (async () => {
    let detachRelayAbortListener = () => {};
    let relayCancellationWork: Promise<boolean> | undefined;
    let relayCancellationRequired = false;
    let requestIdSha256: string | undefined;
    let physicalAttempt = 0;
    const notifyRequestLifecycle = async (
      phase:
        | "request-admitted"
        | "request-dispatched"
        | "stream-open"
        | "transport-closed",
      outcome?: "completed" | "canceled" | "error",
    ): Promise<void> => {
      if (!requestIdSha256) return;
      try {
        await options?.onProviderRequestLifecycle?.({
          phase,
          requestIdSha256,
          physicalAttempt: Math.max(physicalAttempt, 1),
          ...(outcome ? { outcome } : {}),
        });
      } catch {
        // Acceptance diagnostics are observation-only and cannot alter a
        // production provider request.
      }
    };
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api as Api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      // A response is successful only after a terminal protocol event.
      stopReason: "error",
      timestamp: Date.now(),
    };

    try {
      const initialApiKey =
        options?.apiKey || getEnvApiKey(model.provider) || "";
      const cacheRetention = resolveCacheRetention(options?.cacheRetention);
      const cacheSessionId =
        cacheRetention === "none" ? undefined : options?.sessionId;
      const promptCacheKey =
        cacheRetention === "none"
          ? undefined
          : (options?.promptCacheKey ?? options?.sessionId);
      let params = buildParams(model, context, options);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as ResponseCreateParamsStreaming;
      }

      // One nonce identifies exactly one logical model request. Agent tool
      // loops call this provider again and therefore receive a different
      // nonce; physical transport retries and cursor resumes below retain it.
      const requestNonce = newRequestNonce();
      const idempotencyKey = `stella-response-${requestNonce}`;
      const proposedRelayRequestId = isManagedStellaRelayBaseUrl(model.baseUrl)
        ? `stella-relay-${requestNonce}`
        : undefined;
      relayCancellationRequired = proposedRelayRequestId !== undefined;
      // The adapter owns the raw transport id. Only its digest crosses the
      // callback boundary, and it is bound before the first POST dispatch.
      requestIdSha256 = await hashProviderRequestIdentity(
        proposedRelayRequestId ?? idempotencyKey,
      );
      await notifyRequestLifecycle("request-admitted");
      const requestOptions = (
        signal?: AbortSignal,
        initializeRelay = false,
        recoveryTimeoutMs?: number,
      ) => {
        const timeout =
          recoveryTimeoutMs === undefined
            ? options?.timeoutMs
            : options?.timeoutMs === undefined
              ? recoveryTimeoutMs
              : Math.min(options.timeoutMs, recoveryTimeoutMs);
        return {
          ...(signal ? { signal } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
          // The bounded recovery state machine owns every physical retry.
          maxRetries: 0,
          headers: {
            "Idempotency-Key": idempotencyKey,
            ...(initializeRelay && proposedRelayRequestId
              ? {
                  [STELLA_RELAY_REQUEST_ID_HEADER]: proposedRelayRequestId,
                }
              : {}),
          },
        };
      };

      let activeApiKey = initialApiKey;
      const clientForKey = (requestApiKey: string) =>
        createClient(
          model,
          context,
          requestApiKey,
          options?.headers,
          cacheSessionId,
          promptCacheKey,
        );
      const withActiveAuth = async <T>(
        request: (client: OpenAI) => Promise<T>,
      ): Promise<T> =>
        await requestWithAuthRefresh({
          apiKey: activeApiKey,
          refreshApiKey: options?.refreshApiKey,
          request: async (requestApiKey) => {
            activeApiKey = requestApiKey;
            return await request(clientForKey(requestApiKey));
          },
        });

      let relayRequestId = proposedRelayRequestId;
      let relayResumeCapable = false;
      let relayAbortListenerAttached = false;
      const providerDurableResumeEnabled =
        params.background === true && params.store !== false;

      const attachRelayAbortListener = (requestId: string) => {
        if (!options?.signal || relayAbortListenerAttached) return;
        relayAbortListenerAttached = true;
        const cancelRelayResponse = () => {
          relayCancellationWork ??= (async () => {
            // A pre-header abort can race the relay reservation. Retrying only
            // 404 lets the server's bounded cancellation tombstone win that
            // race without retrying the upstream Responses POST.
            for (const delayMs of [0, 100, 250, 500, 1_000]) {
              if (delayMs > 0) await sleepMs(delayMs);
              try {
                await withActiveAuth(async (client) => {
                  await client.delete<void>(
                    `/responses/${encodeURIComponent(requestId)}`,
                    {
                      maxRetries: 0,
                      timeout: options.timeoutMs ?? 10_000,
                    },
                  );
                });
                return true;
              } catch (error) {
                if ((error as { status?: unknown })?.status !== 404) {
                  return false;
                }
              }
            }
            return false;
          })();
        };
        if (options.signal.aborted) cancelRelayResponse();
        else
          options.signal.addEventListener("abort", cancelRelayResponse, {
            once: true,
          });
        detachRelayAbortListener = () =>
          options.signal?.removeEventListener("abort", cancelRelayResponse);
      };
      if (proposedRelayRequestId) {
        attachRelayAbortListener(proposedRelayRequestId);
      }

      const noteResponse = async (response: Response): Promise<void> => {
        const headers = headersToRecord(response.headers);
        const advertisedVersion = response.headers
          .get(STELLA_RELAY_RESUME_HEADER)
          ?.trim();
        const advertisedRequestId = response.headers
          .get(STELLA_RELAY_REQUEST_ID_HEADER)
          ?.trim();
        if (
          advertisedVersion === STELLA_RELAY_RESUME_VERSION &&
          advertisedRequestId
        ) {
          if (!validRelayRequestId(advertisedRequestId)) {
            throw new Error(
              "Stella relay returned an invalid resume request id",
            );
          }
          if (relayRequestId && advertisedRequestId !== relayRequestId) {
            throw new Error(
              "Stella relay returned a mismatched resume request id",
            );
          }
          relayResumeCapable = true;
          relayRequestId = advertisedRequestId;
          attachRelayAbortListener(advertisedRequestId);
        }
        await options?.onResponse?.(
          { status: response.status, headers },
          model,
        );
        await notifyRequestLifecycle("stream-open");
      };

      const connect = async (
        signal?: AbortSignal,
        timeoutMs?: number,
      ): Promise<AsyncIterable<ResponseStreamEvent>> => {
        physicalAttempt += 1;
        await notifyRequestLifecycle("request-dispatched");
        const { data, response } = await withActiveAuth((client) =>
          client.responses
            .create(params, requestOptions(signal, true, timeoutMs))
            .withResponse(),
        );
        await noteResponse(response);
        return data;
      };
      const resume = async ({
        runId,
        cursor,
        signal,
        timeoutMs,
      }: {
        runId: string;
        cursor: number;
        signal?: AbortSignal;
        timeoutMs?: number;
      }): Promise<AsyncIterable<ResponseStreamEvent>> => {
        physicalAttempt += 1;
        await notifyRequestLifecycle("request-dispatched");
        const { data, response } = await withActiveAuth((client) =>
          client.responses
            .retrieve(
              runId,
              { stream: true, starting_after: cursor },
              requestOptions(signal, false, timeoutMs),
            )
            .withResponse(),
        );
        await noteResponse(response);
        return data;
      };

      const openaiStream = resilientEventStream<ResponseStreamEvent>({
        connect,
        resume,
        // The managed client proposes the durable id before POST, so even a
        // pre-header failure tries GET cursor zero rather than replaying POST.
        getInitialResumeState: () =>
          proposedRelayRequestId
            ? { runId: proposedRelayRequestId, cursor: 0 }
            : relayResumeCapable && relayRequestId
              ? { runId: relayRequestId, cursor: 0 }
              : undefined,
        getRunId: (event) => {
          if (relayResumeCapable) return relayRequestId;
          return providerDurableResumeEnabled &&
            "response" in event &&
            event.response?.id
            ? event.response.id
            : undefined;
        },
        getSequence: (event) => {
          const relaySequence = (
            event as ResponseStreamEvent & {
              stella_relay_sequence?: unknown;
            }
          ).stella_relay_sequence;
          if (relayResumeCapable) {
            if (
              typeof relaySequence !== "number" ||
              !Number.isSafeInteger(relaySequence) ||
              relaySequence < 1
            ) {
              throw new Error(
                "Stella relay event is missing a valid durable cursor",
              );
            }
            return relaySequence;
          }
          return typeof event.sequence_number === "number"
            ? event.sequence_number
            : undefined;
        },
        isTerminal: (event) =>
          event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed" ||
          event.type === "error",
        abortSource: (source, reason) => {
          // OpenAI's Stream owns the platform AbortController used by its
          // fetch/body reader. The recovery timer is Effect-owned; at this SDK
          // boundary it interrupts that already-owned physical request.
          (
            source as AsyncIterable<ResponseStreamEvent> & {
              controller?: AbortController;
            }
          ).controller?.abort(reason);
        },
        ...(options?.signal ? { signal: options.signal } : {}),
        onReconnect: ({ attempt, delayMs, reason }) =>
          options?.onProviderRetry?.({ attempt, delayMs, reason }),
      });
      stream.push({ type: "start", partial: output });

      await processResponsesStream(openaiStream, output, stream, model, {
        serviceTier: options?.serviceTier,
        applyServiceTierPricing: (usage, serviceTier) =>
          applyServiceTierPricing(usage, serviceTier, model),
      });

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw anomalousStreamStopError(output);
      }

      await notifyRequestLifecycle("transport-closed", "completed");
      stream.push({ type: "done", reason: output.stopReason, message: output });
      detachRelayAbortListener();
      stream.end();
    } catch (error) {
      detachRelayAbortListener();
      for (const block of output.content) {
        delete (block as { index?: number }).index;
        // partialJson is only a streaming scratch buffer; never persist it.
        delete (block as { partialJson?: string }).partialJson;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : JSON.stringify(error);
      // Flattening the error to a string drops its headers, so pull the
      // provider's requested backoff out first — the run-level retry has
      // no other way to learn it. `maxRetries: 0` above means nothing
      // below this layer has already honored it.
      const retryAfterMs = readRetryAfterMs(error);
      if (retryAfterMs !== undefined) output.retryAfterMs = retryAfterMs;
      const canceled = options?.signal?.aborted === true;
      // A managed relay owns a background provider response after the local
      // body closes. Do not claim `transport-closed` until its exact DELETE
      // completed; the run-scoped wrapper will publish `outcome-unknown` when
      // cancellation could not be confirmed and therefore cannot truthfully
      // report `transport-joined`/provider-stopped.
      const relayCancellationConfirmed =
        !canceled ||
        !relayCancellationRequired ||
        (await relayCancellationWork?.catch(() => false)) === true;
      if (relayCancellationConfirmed) {
        await notifyRequestLifecycle(
          "transport-closed",
          canceled ? "canceled" : "error",
        );
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

export const streamSimpleOpenAIResponses: StreamFunction<
  "openai-responses",
  SimpleStreamOptions
> = (
  model: Model<"openai-responses">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  // The OpenAI SDK requires a non-empty apiKey even when authentication is
  // supplied entirely by custom headers. Match the completions transport's
  // local/custom-base-url sentinel; model/options headers still override the
  // SDK's generated Authorization header.
  const apiKey =
    options?.apiKey ||
    getEnvApiKey(model.provider) ||
    (model.baseUrl ? "local" : undefined);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  const clampedReasoning = options?.reasoning
    ? clampThinkingLevel(model, options.reasoning)
    : undefined;
  const reasoningEffort =
    clampedReasoning === "off" ? undefined : clampedReasoning;

  return streamOpenAIResponses(model, context, {
    ...base,
    reasoningEffort,
  } satisfies OpenAIResponsesOptions);
};

function createClient(
  model: Model<"openai-responses">,
  context: Context,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
  sessionId?: string,
  promptCacheKey?: string,
) {
  if (!apiKey) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
      );
    }
    apiKey = process.env.OPENAI_API_KEY;
  }

  const compat = getCompat(model);
  const headers = { ...model.headers };
  if (
    model.provider === "openrouter" ||
    model.baseUrl.includes("openrouter.ai")
  ) {
    headers["HTTP-Referer"] ??= "https://stella.sh";
    headers["X-OpenRouter-Title"] ??= "Stella";
  }
  if (model.provider === "github-copilot") {
    const hasImages = hasCopilotVisionInput(context.messages);
    const copilotHeaders = buildCopilotDynamicHeaders({
      messages: context.messages,
      hasImages,
    });
    Object.assign(headers, copilotHeaders);
  }

  if (sessionId) {
    if (compat.sendSessionIdHeader) {
      headers.session_id = sessionId;
    }
    headers["x-client-request-id"] = sessionId;
  }
  if (
    promptCacheKey &&
    (model.provider === "fireworks" || model.baseUrl.includes("fireworks.ai"))
  ) {
    headers["x-session-affinity"] = promptCacheKey;
  }

  // Merge options headers last so they can override defaults
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }
  // These two headers are transport identities, not session/cache identity.
  // Request-level values generated in streamOpenAIResponses must win even if
  // an older caller supplied one static value for the whole agent turn.
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (
      lower === "idempotency-key" ||
      lower === STELLA_RELAY_REQUEST_ID_HEADER
    ) {
      delete headers[name];
    }
  }

  const defaultHeaders =
    model.provider === "cloudflare-ai-gateway"
      ? {
          ...headers,
          Authorization: headers.Authorization ?? null,
          "cf-aig-authorization": `Bearer ${apiKey}`,
        }
      : headers;

  return new OpenAI({
    apiKey,
    baseURL: isCloudflareProvider(model.provider)
      ? resolveCloudflareBaseUrl(model)
      : model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders,
  });
}

function buildParams(
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
) {
  const compat = getCompat(model);
  const messages = convertResponsesMessages(
    model,
    context,
    OPENAI_TOOL_CALL_PROVIDERS,
  );
  // Dedupe by name — last definition wins, matching historical behavior.
  const uniqueTools = [
    ...new Map((context.tools ?? []).map((tool) => [tool.name, tool])).values(),
  ];

  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const params: ResponseCreateParamsStreaming = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key:
      cacheRetention === "none"
        ? undefined
        : (options?.promptCacheKey ?? options?.sessionId),
    prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
    // OpenRouter rejects `store: true` on its Responses API (verified live:
    // "Invalid Responses API request"); omit it there, keep it elsewhere.
    store: !(
      model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")
    ),
  };

  if (options?.maxTokens) {
    params.max_output_tokens = options?.maxTokens;
  }

  if (options?.temperature !== undefined) {
    params.temperature = options?.temperature;
  }

  if (options?.serviceTier !== undefined) {
    params.service_tier = options.serviceTier;
  }

  if (uniqueTools.length > 0) {
    params.tools = convertResponsesTools(uniqueTools);
  }

  if (model.reasoning) {
    if (options?.reasoningEffort || options?.reasoningSummary) {
      const effort = options?.reasoningEffort
        ? (model.thinkingLevelMap?.[options.reasoningEffort] ??
          options.reasoningEffort)
        : "medium";
      params.reasoning = {
        effort: effort as NonNullable<typeof params.reasoning>["effort"],
        summary: options?.reasoningSummary || "auto",
      };
      params.include = ["reasoning.encrypted_content"];
    } else if (
      model.provider !== "github-copilot" &&
      model.thinkingLevelMap?.off !== null
    ) {
      params.reasoning = {
        effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<
          typeof params.reasoning
        >["effort"],
      };
    }
  }

  return params;
}

function getServiceTierCostMultiplier(
  model: Pick<Model<"openai-responses">, "id">,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return model.id === "gpt-5.5" ? 2.5 : 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(
  usage: Usage,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  model: Pick<Model<"openai-responses">, "id">,
) {
  const multiplier = getServiceTierCostMultiplier(model, serviceTier);
  if (multiplier === 1) return;

  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input +
    usage.cost.output +
    usage.cost.cacheRead +
    usage.cost.cacheWrite;
}
