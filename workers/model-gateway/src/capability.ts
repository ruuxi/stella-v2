import { GATEWAY_AUTHORIZATION_HEADER } from "@stella/contracts/gateway/api";
import {
  GATEWAY_BUDGET_UNLIMITED,
  GATEWAY_CAPABILITY_AUDIENCE,
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
import { GatewayError } from "./errors.js";

/**
 * Capability bearer verification. Keys come from the CAPABILITY_JWKS var and
 * are imported once per isolate; a redeploy with a new key set is a new
 * isolate. There is deliberately no network fetch here: an unreachable key
 * source must never turn into an open gateway.
 */
export const RELAY_PROBE_SECRET_HEADER = "x-stella-relay-probe-secret" as const;

export type AuthenticatedCapability = {
  claims: GatewayCapabilityClaims;
  /**
   * True for the ops probe: a synthetic `pro` session capability with an
   * unlimited budget that is never metered and never emits usage events.
   */
  probe: boolean;
};

let keyCache: {
  raw: string;
  keys: Promise<CapabilityVerificationKeys>;
} | null = null;

export const resetCapabilityKeysForTests = (): void => {
  keyCache = null;
};

const parseJwks = (raw: string): GatewayJwks => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as GatewayJwks).keys)
    ) {
      return parsed as GatewayJwks;
    }
  } catch {
    // Fall through to the empty set below.
  }
  console.error(
    "[model-gateway] CAPABILITY_JWKS is not a GatewayJwks document; refusing all capabilities",
  );
  return { keys: [] };
};

export const verificationKeys = (
  env: Pick<Env, "CAPABILITY_JWKS">,
): Promise<CapabilityVerificationKeys> => {
  const raw = env.CAPABILITY_JWKS ?? "";
  if (!keyCache || keyCache.raw !== raw) {
    keyCache = { raw, keys: importCapabilityVerificationKeys(parseJwks(raw)) };
  }
  return keyCache.keys;
};

export const bearerToken = (request: Request): string | null => {
  const header = request.headers.get(GATEWAY_AUTHORIZATION_HEADER);
  if (!header || header.length > 16_384) return null;
  const match = /^Bearer\s+(\S+)$/iu.exec(header);
  return match?.[1] ?? null;
};

export const capabilityFailureError = (
  reason: CapabilityVerificationFailure,
): GatewayError => {
  switch (reason) {
    case "expired":
      return new GatewayError(
        401,
        "capability_expired",
        "The capability has expired.",
      );
    case "not_yet_valid":
      return new GatewayError(
        401,
        "capability_invalid",
        "The capability is not valid yet.",
      );
    case "unknown_key":
      return new GatewayError(
        401,
        "capability_invalid",
        "The capability was signed by an unknown key.",
      );
    case "bad_signature":
      return new GatewayError(
        401,
        "capability_invalid",
        "The capability signature is invalid.",
      );
    case "issuer_mismatch":
    case "audience_mismatch":
    case "invalid_claims":
    case "malformed":
    default:
      return new GatewayError(
        401,
        "capability_invalid",
        "The capability is malformed.",
      );
  }
};

const constantTimeEqual = (a: string, b: string): boolean => {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
};

/** The synthetic capability granted by a matching relay probe secret. */
export const probeCapability = (
  request: Request,
  env: Pick<Env, "STELLA_RELAY_PROBE_SECRET">,
  now: number,
): GatewayCapabilityClaims | null => {
  const header = request.headers.get(RELAY_PROBE_SECRET_HEADER)?.trim();
  const secret = env.STELLA_RELAY_PROBE_SECRET?.trim();
  if (!header || !secret || !constantTimeEqual(header, secret)) return null;
  const nowSeconds = Math.floor(now / 1000);
  return {
    iss: GATEWAY_CAPABILITY_ISSUERS.convex,
    aud: GATEWAY_CAPABILITY_AUDIENCE,
    sub: "probe|stella-ops",
    jti: `probe-${crypto.randomUUID()}`,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    gen: "probe",
    kind: "session",
    audience: "pro",
    budgetMicroCents: GATEWAY_BUDGET_UNLIMITED,
  };
};

/**
 * Resolve the caller's capability: the probe secret first (ops checks carry
 * no capability), otherwise the bearer. Throws a GatewayError with the exact
 * `GatewayErrorCode` for every refusal.
 */
export const authenticateCapability = async (
  request: Request,
  env: Pick<Env, "CAPABILITY_JWKS" | "STELLA_RELAY_PROBE_SECRET">,
  options: { now?: number; allowProbe?: boolean } = {},
): Promise<AuthenticatedCapability> => {
  const now = options.now ?? Date.now();
  if (options.allowProbe) {
    const probe = probeCapability(request, env, now);
    if (probe) return { claims: probe, probe: true };
  }
  const token = bearerToken(request);
  if (!token) {
    throw new GatewayError(
      401,
      "unauthorized",
      "A capability bearer token is required.",
    );
  }
  const keys = await verificationKeys(env);
  const result = await verifyCapability(token, keys, { now });
  if (!result.ok) throw capabilityFailureError(result.reason);
  return { claims: result.claims, probe: false };
};
