import type { CloudExecutionSelection } from "../agent-engine.js";

/**
 * Model-gateway capability tokens.
 *
 * A capability is a compact ES256 JWT that carries everything the model
 * gateway needs to authorize and meter a request without consulting a
 * database: who pays, which audience rules apply, how much may be spent,
 * and (for turns) the exact execution the turn was admitted with.
 *
 * Two issuers sign capabilities:
 *   - Convex mints `session` capabilities for signed-in and anonymous desktop
 *     runtimes (exchanged for a Better Auth JWT at the gateway).
 *   - cloud-builder mints `turn` capabilities inside the Durable Object that
 *     admitted the turn, from its cached owner snapshot.
 *
 * The gateway verifies signatures against a static JWKS of both issuers'
 * public keys. Revocation is by expiry plus the per-capability budget ledger;
 * there is deliberately no per-request lookup.
 */

export const GATEWAY_CAPABILITY_AUDIENCE = "stella-model-gateway" as const;
/**
 * Control-plane audience: presented by cloud-builder Durable Objects to Convex
 * callback routes. Never handed to a sandbox or a client, so a leaked
 * model-gateway capability cannot be replayed against the control plane.
 */
export const CONTROL_PLANE_CAPABILITY_AUDIENCE = "stella-control-plane" as const;

export type CapabilityAudience =
  | typeof GATEWAY_CAPABILITY_AUDIENCE
  | typeof CONTROL_PLANE_CAPABILITY_AUDIENCE;

export const GATEWAY_CAPABILITY_ISSUERS = {
  convex: "stella-convex",
  cloudBuilder: "stella-cloud-builder",
} as const;

export type GatewayCapabilityIssuer =
  (typeof GATEWAY_CAPABILITY_ISSUERS)[keyof typeof GATEWAY_CAPABILITY_ISSUERS];

export const GATEWAY_CAPABILITY_ALGORITHM = "ES256" as const;

export type GatewayCapabilityKind = "session" | "turn";

export const MANAGED_MODEL_AUDIENCES = [
  "anonymous",
  "free",
  "go",
  "pro",
  "go_fallback",
  "pro_fallback",
] as const;

export type ManagedModelAudience = (typeof MANAGED_MODEL_AUDIENCES)[number];

export type GatewayNativeCredentialProvider = "anthropic" | "openai-codex";

/** Budget sentinel: the capability may spend without a ceiling. */
export const GATEWAY_BUDGET_UNLIMITED = -1;

export type GatewayTurnBinding = {
  turnId: string;
  conversationId: string;
  /** The execution the turn was admitted with. The gateway pins model calls to it. */
  execution: CloudExecutionSelection;
};

export type GatewayCapabilityClaims = {
  iss: GatewayCapabilityIssuer;
  aud: CapabilityAudience;
  /** Owner id (`${issuer}|${subject}` tokenIdentifier form). */
  sub: string;
  /** Unique capability id; the budget ledger is keyed on it. */
  jti: string;
  iat: number;
  exp: number;
  /** Owner data generation. A stale generation is refused at the gateway. */
  gen: string;
  kind: GatewayCapabilityKind;
  audience: ManagedModelAudience;
  /**
   * Agent types this capability may act as (`x-stella-agent-type`). Absent
   * means any agent type.
   */
  agentTypes?: string[];
  /** Total spend ceiling for the capability's lifetime, or GATEWAY_BUDGET_UNLIMITED. */
  budgetMicroCents: number;
  /** Request-count ceiling. Used for anonymous trials; absent means unlimited. */
  maxRequests?: number;
  /**
   * Session capabilities: base64url SHA-256 of the client's raw device public
   * key. Relay requests must carry a matching proof (see gateway/dpop.ts).
   */
  dpk?: string;
  /** Present on `turn` capabilities. */
  turn?: GatewayTurnBinding;
  /**
   * Native lane: requests are forwarded byte-for-byte to the provider using
   * the owner's connected subscription credential. Never billed to Stella.
   */
  credential?: GatewayNativeCredentialProvider;
};

export const GATEWAY_SESSION_CAPABILITY_TTL_MS = 60 * 60 * 1000;
export const GATEWAY_TURN_CAPABILITY_TTL_MS = 30 * 60 * 1000;
/** Clock skew tolerated when checking `exp`/`iat`. */
export const GATEWAY_CAPABILITY_CLOCK_SKEW_S = 60;

export type GatewayJwks = {
  keys: Array<{ kid: string; jwk: JsonWebKey; issuer: GatewayCapabilityIssuer }>;
};

export const isManagedModelAudience = (
  value: unknown,
): value is ManagedModelAudience =>
  typeof value === "string" &&
  (MANAGED_MODEL_AUDIENCES as readonly string[]).includes(value);
