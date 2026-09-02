/**
 * Model-gateway session capabilities for renderer-side model calls.
 *
 * The renderer never sends its Better Auth JWT to the gateway on a model
 * request. It exchanges the JWT once at
 * `POST {gatewayOrigin}/v1/capabilities/session` for a session capability
 * (an ES256 JWT minted by Convex) and presents that capability as
 * `Authorization: Bearer <capability>` on every relay call.
 *
 * Same rules as the Electron runtime's `kernel/gateway-session.ts`:
 *   - cached per (gateway, owner identity) until 60 s before
 *     `expiresAt`;
 *   - one exchange in flight per cache key, shared by concurrent callers;
 *   - a 401 on the exchange retries exactly once with a freshly minted JWT.
 */
import {
  GATEWAY_SESSION_CAPABILITY_PATH,
  type GatewayErrorBody,
  type GatewaySessionCapabilityRequest,
  type GatewaySessionCapabilityResponse,
} from "@stella/contracts/gateway/api";
import { getConvexToken } from "@/global/auth/services/auth-token";
import { parseJwtPayload } from "@/shared/lib/jwt";
import { getPlatformChallengeToken } from "@/platform/auth/challenge-token";

/** Re-exchange this long before the capability's own expiry. */
export const GATEWAY_SESSION_CAPABILITY_REFRESH_SKEW_MS = 60_000;
/** Bound on the capability exchange round-trip. */
const GATEWAY_SESSION_EXCHANGE_TIMEOUT_MS = 15_000;

export const STELLA_GATEWAY_SIGN_IN_REQUIRED_MESSAGE =
  "Sign in to Stella to use Stella models.";
export const STELLA_GATEWAY_CHALLENGE_REQUIRED_MESSAGE =
  "Stella needs to verify you're human before continuing.";

type CapabilityCacheEntry = {
  capability: string;
  expiresAt: number;
};

const capabilityCache = new Map<string, CapabilityCacheEntry>();
const inFlightExchanges = new Map<string, Promise<CapabilityCacheEntry>>();

export class GatewaySessionExchangeError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, code?: string, message?: string) {
    super(
      `Stella model gateway refused the session capability exchange (HTTP ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""})`,
    );
    this.name = "GatewaySessionExchangeError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Cache identity of a Better Auth JWT: who the token is for, not which
 * rotation of it. A rotated JWT for the same owner keeps using the still-valid
 * capability; a different owner (sign-out, sign-in, anonymous -> signed in)
 * never sees another's entry.
 */
const authIdentity = (token: string): string => {
  let payload: Record<string, unknown>;
  try {
    payload = parseJwtPayload<Record<string, unknown>>(token);
  } catch {
    return `token:${token}`;
  }
  const pick = (key: string): string =>
    typeof payload[key] === "string" ? (payload[key] as string) : "";
  const audience = Array.isArray(payload.aud)
    ? payload.aud.join(",")
    : pick("aud");
  const anonymous =
    typeof payload.isAnonymous === "boolean" ? String(payload.isAnonymous) : "";
  return [
    "jwt",
    pick("iss"),
    pick("sub"),
    pick("tokenIdentifier"),
    audience,
    anonymous,
  ].join(":");
};

const cacheKey = (args: { gatewayOrigin: string; authToken: string }): string =>
  [args.gatewayOrigin, authIdentity(args.authToken)].join("|");

const readGatewayError = async (
  response: Response,
): Promise<{ code?: string; message?: string }> => {
  try {
    const body = (await response.json()) as Partial<GatewayErrorBody>;
    const error = body?.error;
    return {
      code: typeof error?.code === "string" ? error.code : undefined,
      message: typeof error?.message === "string" ? error.message : undefined,
    };
  } catch {
    return {};
  }
};

const isSessionCapabilityResponse = (
  value: unknown,
): value is GatewaySessionCapabilityResponse => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GatewaySessionCapabilityResponse>;
  return (
    typeof candidate.capability === "string" &&
    candidate.capability.length > 0 &&
    typeof candidate.expiresAt === "number" &&
    Number.isFinite(candidate.expiresAt)
  );
};

const exchangeOnce = async (args: {
  gatewayOrigin: string;
  authToken: string;
  turnstileToken?: string;
}): Promise<CapabilityCacheEntry> => {
  const body: GatewaySessionCapabilityRequest = args.turnstileToken
    ? { turnstileToken: args.turnstileToken }
    : {};
  const response = await fetch(
    `${args.gatewayOrigin}${GATEWAY_SESSION_CAPABILITY_PATH}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GATEWAY_SESSION_EXCHANGE_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    const { code, message } = await readGatewayError(response);
    throw new GatewaySessionExchangeError(response.status, code, message);
  }
  const payload = (await response.json()) as unknown;
  if (!isSessionCapabilityResponse(payload)) {
    throw new Error(
      "Stella model gateway returned a malformed session capability response",
    );
  }
  return { capability: payload.capability, expiresAt: payload.expiresAt };
};

const exchange = async (args: {
  key: string;
  gatewayOrigin: string;
  authToken: string;
}): Promise<CapabilityCacheEntry> => {
  const inFlight = inFlightExchanges.get(args.key);
  if (inFlight) return inFlight;
  const work = (async () => {
    let currentAuthToken = args.authToken;
    let refreshedAuth = false;
    let challenged = false;
    let turnstileToken: string | undefined;
    while (true) {
      try {
        return await exchangeOnce({
          ...args,
          authToken: currentAuthToken,
          turnstileToken,
        });
      } catch (error) {
        if (
          error instanceof GatewaySessionExchangeError &&
          error.status === 401 &&
          !refreshedAuth &&
          !turnstileToken
        ) {
          refreshedAuth = true;
          const refreshed = (
            await getConvexToken({ forceRefresh: true })
          )?.trim();
          if (refreshed && refreshed !== currentAuthToken) {
            currentAuthToken = refreshed;
            continue;
          }
        }
        if (
          error instanceof GatewaySessionExchangeError &&
          error.status === 403 &&
          error.code === "challenge_required" &&
          !challenged
        ) {
          challenged = true;
          try {
            turnstileToken = (await getPlatformChallengeToken())?.trim();
          } catch {
            throw new Error(STELLA_GATEWAY_CHALLENGE_REQUIRED_MESSAGE);
          }
          if (!turnstileToken) {
            throw new Error(STELLA_GATEWAY_CHALLENGE_REQUIRED_MESSAGE);
          }
          continue;
        }
        throw error;
      }
    }
  })();
  inFlightExchanges.set(args.key, work);
  try {
    const entry = await work;
    capabilityCache.set(args.key, entry);
    return entry;
  } finally {
    if (inFlightExchanges.get(args.key) === work) {
      inFlightExchanges.delete(args.key);
    }
  }
};

/**
 * The session capability for `gatewayOrigin`: cached, exchanged on first use
 * and 60 s before expiry. `forceRefresh` drops the cached one first (after the
 * gateway rejected it with 401/402).
 */
export const getGatewaySessionCapability = async (
  gatewayOrigin: string,
  options: { forceRefresh?: boolean } = {},
): Promise<string> => {
  const authToken = (await getConvexToken())?.trim();
  if (!authToken) throw new Error(STELLA_GATEWAY_SIGN_IN_REQUIRED_MESSAGE);
  const key = cacheKey({ gatewayOrigin, authToken });
  if (options.forceRefresh) {
    capabilityCache.delete(key);
  } else {
    const cached = capabilityCache.get(key);
    if (
      cached &&
      cached.expiresAt - GATEWAY_SESSION_CAPABILITY_REFRESH_SKEW_MS > Date.now()
    ) {
      return cached.capability;
    }
    capabilityCache.delete(key);
  }
  return (await exchange({ key, gatewayOrigin, authToken })).capability;
};

/** Test seam: forget every cached capability. */
export const resetGatewaySessionState = (): void => {
  capabilityCache.clear();
  inFlightExchanges.clear();
};
