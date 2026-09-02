import type {
  GatewayCapabilityKind,
  ManagedModelAudience,
} from "./capability.js";
import type { GatewayProtocol, GatewayProvider } from "./api.js";

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
  /** Anonymous trial accounting. */
  anonymous?: { deviceId?: string; ipHash?: string };
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
  /** Anonymous trial ceilings. */
  anonymous: { maxRequestsPerDevice: number; maxRequestsPerIp: number };
  updatedAt: number;
};

/** `POST /api/gateway/session-capability` request from the gateway to Convex. */
export type ConvexSessionCapabilityRequest = {
  ownerId: string;
  isAnonymous: boolean;
  deviceId?: string;
};

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
