import {
  CONTROL_PLANE_CAPABILITY_AUDIENCE,
  GATEWAY_CAPABILITY_AUDIENCE,
  GATEWAY_CAPABILITY_ISSUERS,
  type CapabilityAudience,
  type GatewayCapabilityIssuer,
  type GatewayJwks,
} from "@stella/contracts/gateway/capability";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import {
  generateCapabilityKeyPair,
  importCapabilitySigningKey,
  signCapability,
  type CapabilitySigningKey,
} from "@stella/contracts/gateway/jwt";

/**
 * Test-only issuer of cloud-builder capabilities. Mirrors what the Durable
 * Object mints for its callbacks: a `turn` capability for the control-plane
 * audience (and, for negative tests, the model-gateway audience).
 */
export type ControlPlaneSigner = {
  kid: string;
  jwks: GatewayJwks;
  jwksJson: string;
  signingKey: CapabilitySigningKey;
  mint: (args: {
    ownerId: string;
    ownerGeneration: string;
    turnId: string;
    conversationId: string;
    audience?: CapabilityAudience;
    issuer?: GatewayCapabilityIssuer;
    agentTypes?: string[];
    execution?: {
      engine: "stella" | "anthropic" | "openai-codex";
      provider: "stella" | "anthropic" | "openai-codex";
      model: string;
      reasoningEffort: "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
    };
    ttlMs?: number;
    now?: number;
  }) => Promise<string>;
};

export const createControlPlaneSigner = async (
  kid = "builder-test",
): Promise<ControlPlaneSigner> => {
  const pair = await generateCapabilityKeyPair();
  const signingKey = await importCapabilitySigningKey(pair.privateKeyPem, kid);
  const jwks: GatewayJwks = {
    keys: [
      { kid, issuer: GATEWAY_CAPABILITY_ISSUERS.cloudBuilder, jwk: pair.publicJwk },
    ],
  };
  return {
    kid,
    jwks,
    jwksJson: JSON.stringify(jwks),
    signingKey,
    mint: async (args) => {
      const { token } = await signCapability(
        {
          iss: args.issuer ?? GATEWAY_CAPABILITY_ISSUERS.cloudBuilder,
          aud: args.audience ?? CONTROL_PLANE_CAPABILITY_AUDIENCE,
          sub: args.ownerId,
          gen: args.ownerGeneration,
          kind: "turn",
          audience: "free",
          budgetMicroCents: 0,
          ...(args.agentTypes ? { agentTypes: args.agentTypes } : {}),
          turn: {
            turnId: args.turnId,
            conversationId: args.conversationId,
            execution: (args.execution ?? {
              engine: "stella",
              provider: "stella",
              model: "stella/default",
              reasoningEffort: "default",
            }) as CloudExecutionSelection,
          },
        },
        signingKey,
        { ttlMs: args.ttlMs ?? 60_000, ...(args.now ? { now: args.now } : {}) },
      );
      return token;
    },
  };
};

export { GATEWAY_CAPABILITY_AUDIENCE, CONTROL_PLANE_CAPABILITY_AUDIENCE };
