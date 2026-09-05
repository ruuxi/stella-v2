import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import {
  CONTROL_PLANE_CAPABILITY_AUDIENCE,
  GATEWAY_CAPABILITY_AUDIENCE,
  GATEWAY_CAPABILITY_ISSUERS,
  GATEWAY_TURN_CAPABILITY_TTL_MS,
  isManagedModelAudience,
  type CapabilityAudience,
  type GatewayCapabilityClaims,
  type GatewayNativeCredentialProvider,
  type ManagedModelAudience,
} from "@stella/contracts/gateway/capability";
import {
  importCapabilitySigningKey,
  signCapability,
  type CapabilitySigningKey,
} from "@stella/contracts/gateway/jwt";

/**
 * Turn capabilities minted inside the Durable Object that admitted a turn.
 *
 * The private key lives only in this Worker (secret `CAPABILITY_SIGNING_KEY`,
 * PKCS8 PEM) and the model gateway verifies against the matching public JWK
 * under `CAPABILITY_SIGNING_KID`. A capability carries everything the gateway
 * needs to authorize and meter the turn's model calls without consulting
 * Convex: owner, generation, audience, budget, the exact admitted execution,
 * and (for connected subscriptions) which native credential lane to use.
 *
 * Every admitted turn mints TWO capabilities from the same input: one for the
 * model gateway (`stella-model-gateway`, may enter a sandbox or a CLI) and
 * one for Convex callback routes (`stella-control-plane`, never leaves the
 * Durable Object). The split is what makes a leaked gateway capability
 * useless against the control plane.
 *
 * The imported CryptoKey is cached per isolate; PKCS8 import is not free and
 * every turn in the isolate signs with the same key.
 */

export type CapabilitySignerEnv = {
  CAPABILITY_SIGNING_KEY?: string;
  CAPABILITY_SIGNING_KID?: string;
};

export type TurnCapabilityInput = {
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  conversationId: string;
  execution: CloudExecutionSelection;
  audience: ManagedModelAudience;
  budgetMicroCents: number;
  /** Agent types this turn may act as (`x-stella-agent-type`). */
  agentTypes: readonly string[];
  /** Defaults to the model-gateway audience. */
  aud?: CapabilityAudience;
  /**
   * Native credential lane. Defaults to the execution engine when that engine
   * is a connected subscription (`anthropic` / `openai-codex`); a Stella
   * execution never carries one.
   */
  credential?: GatewayNativeCredentialProvider;
  /** Test seam; defaults to `Date.now()`. */
  now?: number;
};

export type MintedTurnCapability = {
  /** Compact ES256 JWS; travels as `Authorization: Bearer <token>`. */
  token: string;
  claims: GatewayCapabilityClaims;
  /** Absolute ms timestamp derived from the `exp` claim. */
  expiresAt: number;
};

const KID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

let cachedKey:
  | { pem: string; kid: string; key: Promise<CapabilitySigningKey> }
  | undefined;

/** Resolve (and cache per isolate) the Worker's capability signing key. */
export const capabilitySigningKey = (
  env: CapabilitySignerEnv,
): Promise<CapabilitySigningKey> => {
  const pem = env.CAPABILITY_SIGNING_KEY?.trim() ?? "";
  const kid = env.CAPABILITY_SIGNING_KID?.trim() ?? "";
  if (!pem || !kid || !KID_PATTERN.test(kid)) {
    return Promise.reject(
      new Error(
        "Capability signing is not configured (CAPABILITY_SIGNING_KEY / CAPABILITY_SIGNING_KID).",
      ),
    );
  }
  if (cachedKey && cachedKey.pem === pem && cachedKey.kid === kid) {
    return cachedKey.key;
  }
  const key = importCapabilitySigningKey(pem, kid).catch((error: unknown) => {
    // A failed import must not poison the cache for a later, corrected env.
    if (cachedKey?.key === key) cachedKey = undefined;
    throw error;
  });
  cachedKey = { pem, kid, key };
  return key;
};

/** Test-only: forget the cached key so a new env is imported fresh. */
export const resetCapabilitySigningKeyCache = (): void => {
  cachedKey = undefined;
};

const nativeCredentialFor = (
  execution: CloudExecutionSelection,
): GatewayNativeCredentialProvider | undefined =>
  execution.engine === "anthropic" || execution.engine === "openai-codex"
    ? execution.engine
    : undefined;

export const mintTurnCapability = async (
  env: CapabilitySignerEnv,
  input: TurnCapabilityInput,
): Promise<MintedTurnCapability> => {
  for (const [field, value] of [
    ["ownerId", input.ownerId],
    ["ownerGeneration", input.ownerGeneration],
    ["turnId", input.turnId],
    ["conversationId", input.conversationId],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Turn capability requires ${field}.`);
    }
  }
  if (!isManagedModelAudience(input.audience)) {
    throw new Error("Turn capability requires a managed model audience.");
  }
  if (!Number.isFinite(input.budgetMicroCents)) {
    throw new Error("Turn capability requires a finite budget.");
  }
  if (
    input.agentTypes.length === 0 ||
    input.agentTypes.some(
      (agentType) =>
        typeof agentType !== "string" || agentType.trim().length === 0,
    )
  ) {
    throw new Error("Turn capability requires at least one agent type.");
  }
  const execution = input.execution;
  if (
    !execution ||
    execution.engine !== execution.provider ||
    typeof execution.model !== "string" ||
    execution.model.trim().length === 0 ||
    typeof execution.reasoningEffort !== "string"
  ) {
    throw new Error("Turn capability requires the admitted execution.");
  }
  const credential = input.credential ?? nativeCredentialFor(execution);
  if (credential !== undefined && credential !== execution.engine) {
    throw new Error(
      "Turn capability credential must match the admitted engine.",
    );
  }
  const signingKey = await capabilitySigningKey(env);
  const signed = await signCapability(
    {
      iss: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
      aud: input.aud ?? GATEWAY_CAPABILITY_AUDIENCE,
      sub: input.ownerId,
      gen: input.ownerGeneration,
      kind: "turn",
      ledgerScope: "owner-relay-v2",
      audience: input.audience,
      agentTypes: [...input.agentTypes],
      budgetMicroCents: input.budgetMicroCents,
      turn: {
        turnId: input.turnId,
        conversationId: input.conversationId,
        execution: {
          engine: execution.engine,
          provider: execution.provider,
          model: execution.model,
          reasoningEffort: execution.reasoningEffort,
        } as CloudExecutionSelection,
      },
      ...(credential ? { credential } : {}),
    },
    signingKey,
    {
      ttlMs: GATEWAY_TURN_CAPABILITY_TTL_MS,
      ...(input.now !== undefined ? { now: input.now } : {}),
    },
  );
  return {
    token: signed.token,
    claims: signed.claims,
    expiresAt: signed.claims.exp * 1000,
  };
};

export type MintedTurnCapabilities = {
  /** Presented to the model gateway; may travel into a sandbox. */
  model: MintedTurnCapability;
  /** Presented to Convex callback routes; never leaves the Durable Object. */
  controlPlane: MintedTurnCapability;
};

/**
 * Both capabilities for one admitted turn. They share every binding claim
 * (owner, generation, turn, execution, audience, budget) and differ only in
 * `aud`, so a Convex route can bind on `turn.turnId` exactly as the gateway
 * does while a gateway token can never be replayed against Convex.
 */
export const mintTurnCapabilities = async (
  env: CapabilitySignerEnv,
  input: Omit<TurnCapabilityInput, "aud">,
): Promise<MintedTurnCapabilities> => {
  const [model, controlPlane] = await Promise.all([
    mintTurnCapability(env, { ...input, aud: GATEWAY_CAPABILITY_AUDIENCE }),
    mintTurnCapability(env, {
      ...input,
      aud: CONTROL_PLANE_CAPABILITY_AUDIENCE,
    }),
  ]);
  return { model, controlPlane };
};
