import { ConvexError } from "convex/values";
import {
  CONTROL_PLANE_CAPABILITY_AUDIENCE,
  GATEWAY_CAPABILITY_ISSUERS,
  type GatewayCapabilityClaims,
  type GatewayJwks,
} from "@stella/contracts/gateway/capability";
import {
  importCapabilityVerificationKeys,
  verifyCapability,
  type CapabilityVerificationFailure,
  type CapabilityVerificationKeys,
} from "@stella/contracts/gateway/jwt";
import type { CloudExecutionSelection } from "./cloud_execution";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";

/**
 * Control-plane capability verification for Convex callback routes.
 *
 * A cloud-builder Durable Object presents `Authorization: Bearer <capability>`
 * on every turn-scoped callback (web search, drive, recall, schedule, MCP).
 * The capability is a `turn` JWT minted by the DO for the
 * `stella-control-plane` audience; the model-gateway audience is refused here
 * so a capability that entered a sandbox can never reach the control plane.
 *
 * Keys come from `CAPABILITY_JWKS` (JSON `GatewayJwks`) and are imported once
 * per isolate; a changed env value re-imports on the next request.
 */

export const CAPABILITY_JWKS_ENV = "CAPABILITY_JWKS";
export const CONTROL_PLANE_CAPABILITY_ISSUER =
  GATEWAY_CAPABILITY_ISSUERS.cloudBuilder;

let cachedKeys: {
  json: string;
  keys: Promise<CapabilityVerificationKeys>;
} | null = null;

const parseJwks = (json: string): GatewayJwks => {
  const parsed = JSON.parse(json) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { keys?: unknown }).keys)
  ) {
    throw new Error(`${CAPABILITY_JWKS_ENV} must be a JSON object with keys[]`);
  }
  return parsed as GatewayJwks;
};

/** Import the verification keys from env once per isolate. */
export const loadCapabilityVerificationKeys = (
  env: Record<string, string | undefined> = process.env,
): Promise<CapabilityVerificationKeys> | null => {
  const json = env[CAPABILITY_JWKS_ENV]?.trim();
  if (!json) return null;
  if (!cachedKeys || cachedKeys.json !== json) {
    const keys = importCapabilityVerificationKeys(parseJwks(json));
    keys.catch(() => {
      cachedKeys = null;
    });
    cachedKeys = { json, keys };
  }
  return cachedKeys.keys;
};

export type ControlPlaneTurnAuthority = {
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  conversationId: string;
  execution: CloudExecutionSelection;
  /** Absent means the capability may act as any agent type. */
  agentTypes?: string[];
  claims: GatewayCapabilityClaims;
};

export type ControlPlaneCapabilityFailure =
  | CapabilityVerificationFailure
  | "missing"
  | "not_turn"
  | "unconfigured";

export type ControlPlaneCapabilityResult =
  | { ok: true; authority: ControlPlaneTurnAuthority }
  | { ok: false; reason: ControlPlaneCapabilityFailure };

/** Pure verification: signature, issuer, audience, expiry, and turn binding. */
export const verifyControlPlaneCapability = async (
  token: string | null | undefined,
  options: {
    env?: Record<string, string | undefined>;
    now?: number;
  } = {},
): Promise<ControlPlaneCapabilityResult> => {
  const trimmed = token?.trim();
  if (!trimmed) return { ok: false, reason: "missing" };
  const keys = loadCapabilityVerificationKeys(options.env ?? process.env);
  if (!keys) return { ok: false, reason: "unconfigured" };
  const verified = await verifyCapability(trimmed, await keys, {
    ...(options.now !== undefined ? { now: options.now } : {}),
    expectedIssuer: CONTROL_PLANE_CAPABILITY_ISSUER,
    expectedAudience: CONTROL_PLANE_CAPABILITY_AUDIENCE,
  });
  if (!verified.ok) return verified;
  const { claims } = verified;
  if (claims.kind !== "turn" || !claims.turn) {
    return { ok: false, reason: "not_turn" };
  }
  return {
    ok: true,
    authority: {
      ownerId: claims.sub,
      ownerGeneration: claims.gen,
      turnId: claims.turn.turnId,
      conversationId: claims.turn.conversationId,
      execution: claims.turn.execution as CloudExecutionSelection,
      ...(claims.agentTypes ? { agentTypes: claims.agentTypes } : {}),
      claims,
    },
  };
};

export const bearerToken = (request: Request): string | null => {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
};

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export type ControlPlaneRequestAuthority =
  | { ok: true; authority: ControlPlaneTurnAuthority }
  | { ok: false; response: Response };

/**
 * Route-level admission: verify the bearer capability, then pin its owner
 * generation to the owner's CURRENT generation. A capability minted before a
 * reset verifies fine cryptographically and is refused here.
 */
export const authorizeControlPlaneRequest = async (
  ctx: Parameters<typeof assertOwnerDataAccessActive>[0],
  request: Request,
): Promise<ControlPlaneRequestAuthority> => {
  const verified = await verifyControlPlaneCapability(bearerToken(request));
  if (!verified.ok) {
    if (verified.reason === "unconfigured") {
      return {
        ok: false,
        response: json(
          {
            error: "Capability verification is not configured.",
            env: CAPABILITY_JWKS_ENV,
          },
          503,
        ),
      };
    }
    return {
      ok: false,
      response: json({ error: "Unauthorized", reason: verified.reason }, 401),
    };
  }
  const { authority } = verified;
  try {
    const current = await assertOwnerDataAccessActive(ctx, authority.ownerId);
    if (current.generation !== authority.ownerGeneration) {
      return {
        ok: false,
        response: json({ error: "Owner data generation is stale" }, 409),
      };
    }
  } catch (error) {
    if (error instanceof ConvexError) {
      return {
        ok: false,
        response: json({ error: "Owner data is unavailable" }, 409),
      };
    }
    throw error;
  }
  return { ok: true, authority };
};

/** Whether the capability may act as `agentType` (absent list = any). */
export const capabilityAllowsAgentType = (
  authority: Pick<ControlPlaneTurnAuthority, "agentTypes">,
  agentType: string,
): boolean =>
  authority.agentTypes === undefined || authority.agentTypes.includes(agentType);
