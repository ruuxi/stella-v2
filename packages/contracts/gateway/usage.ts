import type {
  GatewayCapabilityKind,
  ManagedModelAudience,
} from "./capability.js";
import type {
  GatewayProtocol,
  GatewayProvider,
  IdentityLevel,
  NetworkClass,
} from "./api.js";

/**
 * Usage events are the gateway's only write toward the control plane. They
 * travel gateway -> Cloudflare Queue -> Convex `POST /api/gateway/usage` in
 * batches, and are idempotent on `requestId`.
 */

export const GATEWAY_USAGE_EVENT_VERSION = 1 as const;

export type GatewayUsageTokens = {
  /** Gross input tokens, including cached reads and cache writes. */
  inputTokens: number;
  /** Gross output tokens, including reasoning. */
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Provider-reported exact cost when available (Crof); overrides token math. */
  costMicroCents?: number;
  /** True when the provider reported usage; false when estimated. */
  reported: boolean;
};

export type GatewayUsageOutcome = "succeeded" | "failed" | "aborted";

export type GatewayUsageEvent = {
  v: typeof GATEWAY_USAGE_EVENT_VERSION;
  requestId: string;
  capabilityId: string;
  kind: GatewayCapabilityKind;
  ownerId: string;
  ownerGeneration: string;
  audience: ManagedModelAudience;
  agentType: string;
  turnId?: string;
  conversationId?: string;
  provider: GatewayProvider;
  protocol: GatewayProtocol;
  requestedModel: string;
  resolvedModel: string;
  usage: GatewayUsageTokens;
  /** Cost the gateway charged against the capability budget, in micro-cents. */
  chargedMicroCents: number;
  outcome: GatewayUsageOutcome;
  upstreamStatus?: number;
  startedAt: number;
  finishedAt: number;
  /** False for native-lane (owner subscription) traffic; those are never billed. */
  billable: boolean;
  /** Anonymous trial accounting: the caller's network as the gateway hashed it. */
  anonymous?: { ipHash?: string };
  /** Edge classification of the caller's network, for risk signals. */
  networkClass?: NetworkClass;
  /** Session capabilities: the `dpk` the request proved. */
  deviceKeyHash?: string;
};

export type GatewayUsageBatch = {
  v: typeof GATEWAY_USAGE_EVENT_VERSION;
  events: GatewayUsageEvent[];
};

export type GatewayUsageBatchResult = {
  accepted: string[];
  duplicate: string[];
  rejected: Array<{ requestId: string; reason: string }>;
};

/** Convex HTTP routes the gateway talks to, all authenticated by GATEWAY_SERVICE_SECRET. */
export const CONVEX_GATEWAY_USAGE_PATH = "/api/gateway/usage" as const;
export const CONVEX_GATEWAY_CONFIG_PATH = "/api/gateway/config" as const;
export const CONVEX_GATEWAY_SESSION_CAPABILITY_PATH =
  "/api/gateway/session-capability" as const;
export const CONVEX_GATEWAY_ENGINE_ACCESS_PATH =
  "/api/gateway/engine-access" as const;
export const CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH =
  "/api/gateway/owner-enforcement" as const;

// ---------------------------------------------------------------------------
// Owner enforcement (suspension / throttling), pushed Convex -> gateway.
// ---------------------------------------------------------------------------

export const OWNER_ENFORCEMENT_STATUSES = [
  "ok",
  "challenged",
  "throttled",
  "suspended",
] as const;

export type OwnerEnforcementStatus = (typeof OWNER_ENFORCEMENT_STATUSES)[number];

export type OwnerEnforcement = {
  status: OwnerEnforcementStatus;
  /** Absolute ms timestamp the status expires back to `ok`; absent means until cleared. */
  until?: number;
  reason?: string;
};

/** Authenticated one-owner enforcement read used to seed a gateway owner DO. */
export type ConvexOwnerEnforcementState = {
  enforcement: OwnerEnforcement;
  /** Null means this owner has never had an enforcement row. */
  updatedAt: number | null;
};

/** `POST {gateway}/internal/owners/enforcement` body (GATEWAY_SERVICE_SECRET). */
export type GatewayOwnerEnforcementRequest = {
  ownerId: string;
  enforcement: OwnerEnforcement;
  updatedAt: number;
};

export type GatewayTierCeiling = {
  audience: ManagedModelAudience;
  /** Spend admitted per rolling hour across every owner in the audience; -1 = none. */
  hourlyMicroCents: number;
  /** Spend admitted per rolling 24 hours across every owner in the audience; -1 = none. */
  dailyMicroCents: number;
};

export type GatewayModelPrice = {
  model: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd: number;
  cacheWritePerMillionUsd: number;
  reasoningPerMillionUsd: number;
};

/** `GET /api/gateway/config` response; cached by the gateway for a few minutes. */
export type GatewayConfigSnapshot = {
  v: 1;
  prices: GatewayModelPrice[];
  /** Anonymous trial ceilings (per anonymous owner, per network). */
  anonymous: { maxRequestsPerOwner: number; maxRequestsPerIp: number };
  /**
   * Global spend breakers by audience. An audience absent here has no
   * breaker. When one trips the gateway answers `tier_paused` (anonymous:
   * `sign_in_required`) until the window rolls.
   */
  tierCeilings: GatewayTierCeiling[];
  updatedAt: number;
};

/** `POST /api/gateway/session-capability` request from the gateway to Convex. */
export type ConvexSessionCapabilityRequest = {
  ownerId: string;
  isAnonymous: boolean;
  /** sha256hex(client ip).slice(0, 32) as the gateway computes it for usage events. */
  ipHash?: string;
  /** Edge classification of the caller's network. */
  networkClass?: NetworkClass;
  /** Turnstile token presented for step-up; Convex verifies it with the secret key. */
  turnstileToken?: string;
  /** `dpk` the gateway verified for this exchange; recorded on the grant and origins. */
  deviceKeyHash: string;
};

/** Convex answers the exchange with this when step-up is required and no valid token came. */
export const CONVEX_SESSION_CHALLENGE_REQUIRED = "challenge_required" as const;

export type { IdentityLevel };

/** `POST /api/gateway/engine-access` request/response for the native lane. */
export type ConvexEngineAccessRequest = {
  ownerId: string;
  ownerGeneration: string;
  provider: "anthropic" | "openai-codex";
};

export type ConvexEngineAccessResponse = {
  accessToken: string;
  accountId?: string;
  /** Absolute ms timestamp; the gateway must not cache past this. */
  expiresAt: number;
};
