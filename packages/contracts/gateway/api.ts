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
/**
 * Service route (GATEWAY_SERVICE_SECRET) Convex calls when an owner's
 * enforcement status changes. The gateway stores the status in KV so every
 * colo refuses that owner's outstanding capabilities within a minute, with no
 * Convex call and no Durable Object creation on the push.
 */
export const GATEWAY_OWNER_ENFORCEMENT_PATH = "/internal/owners/enforcement" as const;

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

/**
 * `POST /v1/capabilities/session` request (Better Auth JWT in Authorization).
 * Deliberately empty: the anonymous trial is keyed on the anonymous owner the
 * JWT names plus the caller's network as the gateway sees it. A client-chosen
 * device string is never an allowance key.
 */
export type GatewaySessionCapabilityRequest = {
  /**
   * Turnstile token for step-up: required when the owner's enforcement status
   * is `challenged` or the caller's network class demands it (the exchange
   * answered `challenge_required`). Ignored otherwise.
   */
  turnstileToken?: string;
};

export type GatewaySessionCapabilityResponse = {
  capability: string;
  expiresAt: number;
  audience: string;
  budgetMicroCents: number;
  maxRequests?: number;
  /** Identity ladder rung the allowance was computed for. */
  identityLevel?: IdentityLevel;
};

/**
 * Identity ladder. Allowances grow with proof that is expensive to fake:
 *   0 anonymous; 1 verified email (magic link); 2 Google or Apple account;
 *   3 paying (Stripe subscription or purchased credits).
 */
export type IdentityLevel = 0 | 1 | 2 | 3;

/**
 * Network class from the edge (`request.cf.asn` / `asOrganization`).
 * `hosting` and `vpn` are datacenter or relay origins; `unknown` is the
 * default when the edge gives no ASN.
 */
export type NetworkClass =
  | "hosting"
  | "vpn"
  | "residential"
  | "mobile"
  | "edu"
  | "unknown";

/**
 * Step-up policy by network class. Anonymous callers from hosting or VPN
 * origins are refused (`sign_in_required`); Free callers from hosting origins
 * must pass a challenge at mint and run at half the network caps.
 */
export const GATEWAY_NETWORK_POLICY = {
  anonymousRefused: ["hosting", "vpn"] as readonly NetworkClass[],
  freeChallenged: ["hosting"] as readonly NetworkClass[],
} as const;

export type GatewayErrorCode =
  | "unauthorized"
  | "capability_expired"
  | "capability_invalid"
  | "generation_stale"
  | "agent_type_forbidden"
  | "model_forbidden"
  | "execution_mismatch"
  | "stream_unsupported"
  /** This capability's budget is spent. Clients exchange a fresh one once. */
  | "budget_exhausted"
  /** This capability's request count is spent. Clients exchange a fresh one once. */
  | "request_limit"
  | "rate_limited"
  /** Owner-level in-flight ceiling for the audience (see GATEWAY_OWNER_RELAY_LIMITS). */
  | "concurrency_limit"
  /** The anonymous tier is not allowed here (network policy or tier breaker). */
  | "sign_in_required"
  /** The audience's global spend breaker tripped; retry after `resetAt`. */
  | "tier_paused"
  /** Owner enforcement status refuses service. */
  | "owner_suspended"
  /** The exchange needs a Turnstile token (`turnstileToken` in the body). */
  | "challenge_required"
  | "body_too_large"
  | "bad_request"
  | "upstream_error"
  | "upstream_timeout"
  | "canceled"
  | "internal";

/** Which counter refused a request, so clients can explain without knowing policy. */
export type GatewayQuotaScope =
  | "capability"
  | "owner"
  | "network"
  | "tier";

export type GatewayErrorBody = {
  error: {
    code: GatewayErrorCode;
    message: string;
    retryable: boolean;
    /** Upstream HTTP status when the failure came from the provider. */
    upstreamStatus?: number;
    /** Present on quota refusals: what refused and when it clears. */
    quota?: {
      scope: GatewayQuotaScope;
      /** Absolute ms timestamp when the counter next admits a request, when known. */
      resetAt?: number;
      retryAfterMs?: number;
    };
  };
};

// ---------------------------------------------------------------------------
// Tier policy the gateway enforces locally. Values are starting points; the
// monetary ceilings live in Convex env and arrive through the config snapshot.
// ---------------------------------------------------------------------------

export type GatewayOwnerRelayLimit = {
  /** Requests in flight at once for one owner. */
  inFlight: number;
  /** Requests admitted per rolling minute for one owner. */
  perMinute: number;
  /** Session capability exchanges per rolling hour for one owner. */
  mintsPerHour: number;
};

/** Keyed by managed model audience. Fallback audiences share their base tier. */
export const GATEWAY_OWNER_RELAY_LIMITS: Readonly<
  Record<ManagedModelAudienceForLimits, GatewayOwnerRelayLimit>
> = {
  anonymous: { inFlight: 1, perMinute: 20, mintsPerHour: 12 },
  free: { inFlight: 2, perMinute: 40, mintsPerHour: 12 },
  go: { inFlight: 4, perMinute: 80, mintsPerHour: 24 },
  pro: { inFlight: 8, perMinute: 120, mintsPerHour: 24 },
};

/** A throttled owner (enforcement status) gets this share of its tier limits. */
export const GATEWAY_THROTTLED_LIMIT_SHARE = 0.5;

/**
 * Output-token ceiling shaped into every managed request by audience
 * (`max_tokens` / `max_output_tokens` / `maxOutputTokens`). Absent means the
 * model's own ceiling.
 */
export const GATEWAY_MAX_OUTPUT_TOKENS_BY_AUDIENCE: Readonly<
  Partial<Record<ManagedModelAudienceForLimits, number>>
> = {
  anonymous: 2_048,
  free: 4_096,
  go: 8_192,
};

/** Per-network (client IP) ceilings enforced before any provider spend. */
export const GATEWAY_NETWORK_LIMITS = {
  anonymous: {
    /** Relay requests per rolling hour from one IP. (The 60/min edge limiter stays.) */
    relayPerHour: 300,
    /** Relay requests per rolling 24 hours from one IP. */
    relayPerDay: 1_000,
    /** Session capability exchanges per rolling 24 hours from one IP. */
    mintsPerDay: 20,
  },
  free: {
    relayPerDay: 3_000,
  },
} as const;

/** Budget chunk one session capability carries, by audience; owners re-mint as they spend. */
export const GATEWAY_SESSION_BUDGET_CHUNK_MICRO_CENTS: Readonly<
  Record<ManagedModelAudienceForLimits, number>
> = {
  anonymous: 10_000_000, // $0.10
  free: 100_000_000, // $1
  go: 200_000_000, // $2
  pro: 500_000_000, // $5
};

/** Request-count chunk one anonymous session capability carries. */
export const GATEWAY_ANONYMOUS_REQUEST_CHUNK = 10;

/** Base tier for limit lookups (fallback audiences inherit their paid tier). */
export type ManagedModelAudienceForLimits = "anonymous" | "free" | "go" | "pro";

export const limitsAudienceFor = (
  audience: string,
): ManagedModelAudienceForLimits => {
  switch (audience) {
    case "anonymous":
      return "anonymous";
    case "go":
    case "go_fallback":
      return "go";
    case "pro":
    case "pro_fallback":
      return "pro";
    default:
      return "free";
  }
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
