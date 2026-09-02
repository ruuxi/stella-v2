/**
 * Model-gateway HTTP surface.
 *
 * The gateway speaks provider-native request and response bodies. Callers use
 * their vendor SDK with `baseUrl = <gatewayOrigin>/v1/relay`; the SDK appends
 * its usual path and the gateway routes on that suffix:
 *
 *   POST /v1/relay/v1/messages                       anthropic-messages
 *   POST /v1/relay/responses                         openai-responses
 *   POST /v1/relay/chat/completions                  openai-completions
 *   POST /v1/relay/models/{model}:generateContent    google-generative-ai
 *   POST /v1/relay/models/{model}:streamGenerateContent (accepted; treated as generateContent)
 *
 * Managed lane (Stella-billed): request/response only. The gateway streams
 * from the provider internally and returns ONE complete provider-native JSON
 * object. `stream: true` in the body is rejected with 400 `stream_unsupported`.
 *
 * Native lane (owner subscription; capability carries `credential`): a byte
 * pipe. Whatever the CLI sends goes upstream untouched apart from
 * credentials; whatever comes back (SSE or JSON) is returned untouched.
 */

export const GATEWAY_API_VERSION = 1 as const;

export const GATEWAY_RELAY_PREFIX = "/v1/relay" as const;
export const GATEWAY_RESOLVE_PATH = "/v1/models/resolve" as const;
export const GATEWAY_SESSION_CAPABILITY_PATH = "/v1/capabilities/session" as const;
export const GATEWAY_HEALTH_PATH = "/healthz" as const;

/** Caller-minted idempotency key. Same id + same body => cached result. */
export const GATEWAY_REQUEST_ID_HEADER = "x-stella-request-id" as const;
export const GATEWAY_AGENT_TYPE_HEADER = "x-stella-agent-type" as const;
/** Echoed on every response so logs on both sides can be joined. */
export const GATEWAY_TRACE_HEADER = "x-stella-gateway-trace" as const;
/** Capability travels as `Authorization: Bearer <jwt>`. */
export const GATEWAY_AUTHORIZATION_HEADER = "authorization" as const;

export type GatewayProtocol =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-completions"
  | "google-generative-ai";

export const GATEWAY_PROTOCOLS: readonly GatewayProtocol[] = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
  "google-generative-ai",
];

export type GatewayProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "fireworks"
  | "deepseek"
  | "crof"
  | "wafer"
  | "xai"
  | "openrouter"
  | "meta";

export const GATEWAY_PROVIDERS: readonly GatewayProvider[] = [
  "anthropic",
  "openai",
  "google",
  "fireworks",
  "deepseek",
  "crof",
  "wafer",
  "xai",
  "openrouter",
  "meta",
];

/** `POST /v1/models/resolve` request. */
export type GatewayResolveRequest = {
  /** `stella/...` alias, `stella/default`, or empty for the audience default. */
  model?: string;
  agentType: string;
};

/** `POST /v1/models/resolve` response. */
export type GatewayModelResolution = {
  /** The alias the caller should keep sending in request bodies. */
  requestedModel: string;
  /** Upstream model id as the provider knows it (before native mapping). */
  resolvedModel: string;
  provider: GatewayProvider;
  protocol: GatewayProtocol;
  reasoning: boolean;
  supportsImages: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
};

/** `POST /v1/capabilities/session` request (Better Auth JWT in Authorization). */
export type GatewaySessionCapabilityRequest = {
  /** Anonymous callers identify their device so trial counters stay per device. */
  deviceId?: string;
};

export type GatewaySessionCapabilityResponse = {
  capability: string;
  expiresAt: number;
  audience: string;
  budgetMicroCents: number;
  maxRequests?: number;
};

export type GatewayErrorCode =
  | "unauthorized"
  | "capability_expired"
  | "capability_invalid"
  | "generation_stale"
  | "agent_type_forbidden"
  | "model_forbidden"
  | "execution_mismatch"
  | "stream_unsupported"
  | "budget_exhausted"
  | "request_limit"
  | "rate_limited"
  | "body_too_large"
  | "bad_request"
  | "upstream_error"
  | "upstream_timeout"
  | "canceled"
  | "internal";

export type GatewayErrorBody = {
  error: {
    code: GatewayErrorCode;
    message: string;
    retryable: boolean;
    /** Upstream HTTP status when the failure came from the provider. */
    upstreamStatus?: number;
  };
};

export const GATEWAY_MAX_REQUEST_BODY_BYTES = 24 * 1024 * 1024;
export const GATEWAY_MAX_RESULT_CACHE_BYTES = 8 * 1024 * 1024;
/** Completed results are replayable for retries with the same request id for this long. */
export const GATEWAY_RESULT_CACHE_TTL_MS = 10 * 60 * 1000;
/** The gateway gives up on an upstream that produced no bytes for this long. */
export const GATEWAY_UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Absolute ceiling on one managed completion. */
export const GATEWAY_UPSTREAM_MAX_DURATION_MS = 45 * 60 * 1000;

export const gatewayRelayBaseUrl = (gatewayOrigin: string): string =>
  `${gatewayOrigin.replace(/\/+$/, "")}${GATEWAY_RELAY_PREFIX}`;

export const isGatewayRelayBaseUrl = (baseUrl: string): boolean =>
  /\/v1\/relay(?:\/|$)/i.test(baseUrl);

export const gatewayOriginFromRelayBaseUrl = (baseUrl: string): string =>
  baseUrl.replace(/\/v1\/relay(?:\/.*)?$/i, "").replace(/\/+$/, "");
