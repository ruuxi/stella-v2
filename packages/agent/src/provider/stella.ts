/**
 * Stella's own models as one pi-ai provider, `stella`.
 *
 * Requests go to the model gateway's managed lane, which bills the owner
 * and answers with one complete provider-native JSON body. The provider
 * reuses pi-ai's upstream adapters (openai-completions, anthropic-messages,
 * openai-responses) and gives them a fetch that asks for JSON and hands the
 * body back as the provider's SSE stream (relay-sse.ts).
 *
 * The gateway resolves a Stella alias per agent type (`x-stella-agent-type`),
 * so a model id names both: `orchestrator:stella/default`,
 * `general:stella/default`. A conversation stores that id in its `pi.agent`
 * document; the fetch strips the prefix and sends it as the header.
 *
 * Authentication is the host's: `capability()` is the bearer pi-ai puts on
 * the request, and `fetch` adds whatever proof the host's lane needs (DPoP
 * on the desktop, the service binding in the cloud) and may exchange one
 * fresh capability on a 401/402/429 as Stella's routes do today.
 */
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai";
import {
  GATEWAY_AGENT_TYPE_HEADER,
  GATEWAY_REQUEST_ID_HEADER,
  type GatewayProtocol,
} from "@stella/contracts/gateway/api";
import { anthropicMessageToSse, chatCompletionToSse, responseToSse } from "./relay-sse.ts";

export const STELLA_PROVIDER_ID = "stella";

/** Context window the relay reports when the gateway names none. */
export const STELLA_FALLBACK_CONTEXT_WINDOW = 80_000;
const STELLA_FALLBACK_MAX_TOKENS = 16_384;
/**
 * The gateway reserves budget against a request's output ceiling, so a
 * model's full output window (128k for some) is not asked for by default.
 */
const STELLA_MAX_OUTPUT_TOKENS = 32_768;

export type StellaAgentType = "orchestrator" | "general" | (string & {});

/** One Stella alias as the gateway resolved it for one agent type. */
export type StellaModelSpec = {
  agentType: StellaAgentType;
  /** `stella/default`, `stella/max`, ... */
  alias: string;
  protocol: GatewayProtocol;
  reasoning?: boolean;
  supportsImages?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Display name; defaults to the alias. */
  name?: string;
};

/** Which conversation a request belongs to: pi-durable passes its provider session id. */
export type StellaRequestRoute = { sessionId?: string };

export type StellaGatewayAccess = {
  /** `<gateway origin>/v1/relay`. */
  relayBaseUrl: string;
  /** The capability pi-ai sends as `Authorization: Bearer`. */
  capability(signal: AbortSignal): Promise<string>;
  /**
   * One relay request; adds the host's proof headers. A host that bills
   * conversations separately (the cloud: each agent run is admitted on its
   * own) picks the conversation's capability by `route`.
   */
  fetch(input: string | URL | Request, init?: RequestInit, route?: StellaRequestRoute): Promise<Response>;
};

export const stellaModelId = (agentType: StellaAgentType, alias: string): string => `${agentType}:${alias}`;

export const parseStellaModelId = (id: string): { agentType: string; alias: string } | undefined => {
  const separator = id.indexOf(":");
  if (separator <= 0) return undefined;
  return { agentType: id.slice(0, separator), alias: id.slice(separator + 1) };
};

const API_FOR_PROTOCOL: Record<GatewayProtocol, Api | undefined> = {
  "openai-completions": "openai-completions",
  "anthropic-messages": "anthropic-messages",
  "openai-responses": "openai-responses",
  // The gateway's Google lane has no SSE replay here yet.
  "google-generative-ai": undefined,
};

export function stellaModel(spec: StellaModelSpec, relayBaseUrl: string): Model<Api> {
  const api = API_FOR_PROTOCOL[spec.protocol];
  if (api === undefined) throw new Error(`Stella provider cannot serve ${spec.alias} over ${spec.protocol}.`);
  return {
    id: stellaModelId(spec.agentType, spec.alias),
    name: spec.name ?? spec.alias,
    api,
    provider: STELLA_PROVIDER_ID,
    baseUrl: relayBaseUrl,
    reasoning: spec.reasoning ?? true,
    input: spec.supportsImages === false ? ["text"] : ["text", "image"],
    // Stella bills through the gateway ledger; pi.usage keeps tokens only.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow ?? STELLA_FALLBACK_CONTEXT_WINDOW,
    maxTokens: Math.min(spec.maxOutputTokens ?? STELLA_FALLBACK_MAX_TOKENS, STELLA_MAX_OUTPUT_TOKENS),
    headers: { [GATEWAY_AGENT_TYPE_HEADER]: spec.agentType },
  } as Model<Api>;
}

const toSse: Record<string, ((body: unknown) => string) | undefined> = {
  "openai-completions": chatCompletionToSse,
  "anthropic-messages": anthropicMessageToSse,
  "openai-responses": responseToSse,
};

const protocolForPath = (pathname: string): string | undefined => {
  if (pathname.endsWith("/chat/completions")) return "openai-completions";
  if (pathname.endsWith("/messages")) return "anthropic-messages";
  if (pathname.endsWith("/responses")) return "openai-responses";
  return undefined;
};

/**
 * The managed-lane fetch: the adapter's streaming request goes out as a
 * JSON request with the bare alias and the agent type header, and its JSON
 * answer comes back as SSE.
 */
export function managedRelayFetch(host: StellaGatewayAccess["fetch"]) {
  return async (input: string | URL | Request, init?: RequestInit, route?: StellaRequestRoute): Promise<Response> => {
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const protocol = protocolForPath(new URL(request.url).pathname);
    if (request.method !== "POST" || protocol === undefined) return host(request, undefined, route);
    const body = (await request.json()) as Record<string, unknown>;
    const headers = new Headers(request.headers);
    const streamed = body.stream === true;
    if (streamed) {
      body.stream = false;
      delete body.stream_options;
    }
    if (typeof body.model === "string") {
      const parsed = parseStellaModelId(body.model);
      if (parsed) {
        body.model = parsed.alias;
        headers.set(GATEWAY_AGENT_TYPE_HEADER, parsed.agentType);
      }
    }
    // The Anthropic adapter sends its key as `x-api-key`; the gateway reads only the bearer.
    const apiKey = headers.get("x-api-key");
    if (apiKey !== null) {
      if (!headers.has("authorization")) headers.set("authorization", `Bearer ${apiKey}`);
      headers.delete("x-api-key");
    }
    if (!headers.has(GATEWAY_REQUEST_ID_HEADER)) headers.set(GATEWAY_REQUEST_ID_HEADER, crypto.randomUUID());
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    const response = await host(
      request.url,
      { method: "POST", headers, body: JSON.stringify(body), signal: request.signal },
      route,
    );
    if (!streamed || !response.ok) return response;
    const convert = toSse[protocol]!;
    const text = convert(await response.json());
    const replayHeaders = new Headers(response.headers);
    replayHeaders.set("content-type", "text/event-stream; charset=utf-8");
    replayHeaders.delete("content-length");
    replayHeaders.delete("content-encoding");
    return new Response(text, { status: 200, statusText: "OK", headers: replayHeaders });
  };
}

type RelayFetch = ReturnType<typeof managedRelayFetch>;

/** The adapter's fetch, bound to the request's conversation. */
const routed = (relay: RelayFetch, sessionId: string | undefined): typeof fetch =>
  ((input: string | URL | Request, init?: RequestInit) => relay(input, init, { ...(sessionId ? { sessionId } : {}) })) as typeof fetch;

const withFetch = (streams: ProviderStreams, relay: RelayFetch): ProviderStreams => ({
  stream: (model, context, options) => streams.stream(model, context, { ...options, fetch: routed(relay, options?.sessionId) }),
  streamSimple: (model, context, options) =>
    streams.streamSimple(model, context, { ...options, fetch: routed(relay, options?.sessionId) }),
});

export type StellaProviderOptions = {
  access: StellaGatewayAccess;
  models: readonly StellaModelSpec[];
};

/** The `stella` provider: Stella's aliases over the model gateway's managed lane. */
export function stellaProvider(options: StellaProviderOptions): Provider {
  const relay = managedRelayFetch(options.access.fetch);
  const models: Model<Api>[] = [];
  for (const spec of options.models) {
    if (API_FOR_PROTOCOL[spec.protocol] === undefined) continue;
    models.push(stellaModel(spec, options.access.relayBaseUrl));
  }
  return createProvider({
    id: STELLA_PROVIDER_ID,
    name: "Stella",
    baseUrl: options.access.relayBaseUrl,
    auth: {
      apiKey: {
        name: "Stella session capability",
        resolve: async ({ signal }) => ({
          auth: { apiKey: await options.access.capability(signal) },
          source: "Stella account",
        }),
      },
    },
    models,
    api: {
      "openai-completions": withFetch(openAICompletionsApi(), relay),
      "anthropic-messages": withFetch(anthropicMessagesApi(), relay),
      "openai-responses": withFetch(openAIResponsesApi(), relay),
    },
  });
}
