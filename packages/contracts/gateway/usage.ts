import type {
  GatewayCapabilityKind,
  ManagedModelAudience,
} from "./capability.js";
import type {
  GatewayErrorCode,
  GatewayProtocol,
  GatewayProvider,
  GatewaySessionCapabilityResponse,
  IdentityLevel,
  NetworkClass,
} from "./api.js";

/**
 * Usage events are the gateway's only write toward the control plane. They
 * travel gateway -> Cloudflare Queue -> cloud-builder (`BillingControl`),
 * which settles them into each owner's ledger, in batches, idempotent on
 * `requestId`; the owner object also takes its risk signals from them.
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
  /** Provider-reported exact cost when available; overrides token math. */
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


// ---------------------------------------------------------------------------
// Owner enforcement (suspension / throttling), pushed owner object -> gateway.
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
export type OwnerEnforcementState = {
  enforcement: OwnerEnforcement;
  /** Null means this owner has never had an enforcement row. */
  updatedAt: number | null;
};

/** `ModelGatewayControl.applyOwnerEnforcement` input, pushed by the owner object. */
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

/** `BillingControl.gatewayConfig()` response; cached by the gateway for a few minutes. */
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

/** A session capability exchange, as the gateway forwards it to `BillingControl`. */
export type SessionCapabilityRequest = {
  ownerId: string;
  isAnonymous: boolean;
  /** sha256hex(client ip).slice(0, 32) as the gateway computes it for usage events. */
  ipHash?: string;
  /** Edge classification of the caller's network. */
  networkClass?: NetworkClass;
  /** Turnstile token presented for step-up; the owner object verifies it with the secret key. */
  turnstileToken?: string;
  /** `dpk` the gateway verified for this exchange; recorded on the grant and origins. */
  deviceKeyHash: string;
};

export type SessionAdmissionResponse = {
  ownerGeneration: string;
  /** The account record's answer, authoritative over the gateway's token flag. */
  isAnonymous: boolean;
  identityLevel: IdentityLevel;
  /** Anonymous trials: the request chunk this capability may spend. */
  maxRequests?: number;
};

/** Result of a `BillingControl` call, shaped like the gateway's control-plane results. */
export type BillingControlResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: number | null; code: GatewayErrorCode | null; retryable: boolean };

/** cloud-builder's `BillingControl` entrypoint, reached over a service binding. */
export type BillingControlRpc = {
  issueSessionCapability(
    request: SessionCapabilityRequest,
  ): Promise<BillingControlResult<GatewaySessionCapabilityResponse>>;
  ingestUsage(batch: GatewayUsageBatch): Promise<GatewayUsageBatchResult>;
  /** Prices, anonymous ceilings and tier breakers; throws while unavailable. */
  gatewayConfig(): Promise<GatewayConfigSnapshot>;
  /** One owner's enforcement, seeding the gateway's owner object; throws while unavailable. */
  ownerEnforcement(ownerId: string): Promise<OwnerEnforcementState>;
  /** A fresh access token for the owner's connected engine, for the native lane. */
  engineAccess(
    request: EngineAccessRequest,
  ): Promise<BillingControlResult<EngineAccessResponse>>;
  /** The native lane saw an account hit its subscription limit. */
  engineLimit(
    report: EngineLimitReport,
  ): Promise<BillingControlResult<EngineLimitResult>>;
};

export type { IdentityLevel };

/** `BillingControl.engineAccess` request/response for the native lane. */
export type EngineAccessRequest = {
  ownerId: string;
  ownerGeneration: string;
  provider: "anthropic" | "openai-codex";
};

export type EngineAccessResponse = {
  accessToken: string;
  /** Codex only: the provider's chatgpt_account_id header value. */
  accountId?: string;
  /** Stella's id for the connected account the token belongs to. */
  engineAccountId?: string;
  /** Absolute ms timestamp; the gateway must not cache past this. */
  expiresAt: number;
};

/** `BillingControl.engineLimit`: an account's subscription limit was reached. */
export type EngineLimitReport = {
  ownerId: string;
  ownerGeneration: string;
  provider: "anthropic" | "openai-codex";
  engineAccountId: string;
  /** When the provider says the limit resets (ms), if it said. */
  resetsAt?: number;
};

export type EngineLimitResult = {
  /** Another account now serves the provider; the request may be retried. */
  switched: boolean;
};
