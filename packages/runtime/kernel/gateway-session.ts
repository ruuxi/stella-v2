/**
 * Model-gateway session capabilities for the desktop runtime.
 *
 * A signed-in (or anonymous) runtime never sends its Better Auth JWT to the
 * gateway on model requests. It exchanges the JWT once at
 * `POST {gatewayOrigin}/v1/capabilities/session` for a session capability
 * (an ES256 JWT minted by Convex) and presents that capability as
 * `Authorization: Bearer <capability>` on every relay call.
 *
 * This module owns two process-wide caches:
 *   - the gateway origin advertised by the `/api/stella/models` catalog, per
 *     Stella site, so routes built before the catalog resolves can still
 *     find the origin once it is known; and
 *   - the session capability, per (gateway, owner identity), cached
 *     until 60 s before its `expiresAt` and re-exchanged on demand when the
 *     gateway rejects it.
 *
 * Deliberately free of node builtins: the same file is reachable from the
 * Cloudflare runtime paths.
 */
import {
  GATEWAY_SESSION_CAPABILITY_PATH,
  type GatewayErrorBody,
  type GatewaySessionCapabilityRequest,
  type GatewaySessionCapabilityResponse,
} from "@stella/contracts/gateway/api";
import { normalizeStellaSiteUrl } from "@stella/contracts/stella-api";

/** Re-exchange this long before the capability's own expiry. */
export const GATEWAY_SESSION_CAPABILITY_REFRESH_SKEW_MS = 60_000;
/** Bound on the capability exchange round-trip. */
const GATEWAY_SESSION_EXCHANGE_TIMEOUT_MS = 15_000;

export const STELLA_GATEWAY_UNCONFIGURED_MESSAGE =
  "Stella model gateway is not configured: the model catalog did not advertise gateway.origin (MODEL_GATEWAY_URL on the backend).";
export const STELLA_GATEWAY_CHALLENGE_REQUIRED_MESSAGE =
  "Stella needs to verify you're human before continuing.";

// ---------------------------------------------------------------------------
// Gateway origin memory
// ---------------------------------------------------------------------------

const knownGatewayOrigins = new Map<string, string>();

const siteKey = (siteBaseUrl: string): string =>
  normalizeStellaSiteUrl(siteBaseUrl);

/**
 * Validate a catalog-advertised gateway origin. Accepts an absolute http(s)
 * URL (a path prefix is allowed) and strips trailing slashes; anything else
 * is rejected so a misconfigured backend fails loudly instead of producing
 * a relay URL that quietly points nowhere.
 */
export const normalizeGatewayOrigin = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.search || url.hash) return null;
    return trimmed;
  } catch {
    return null;
  }
};

export const rememberStellaGatewayOrigin = (
  siteBaseUrl: string,
  gatewayOrigin: string,
): void => {
  const normalized = normalizeGatewayOrigin(gatewayOrigin);
  if (!normalized) {
    throw new Error(`Invalid Stella model gateway origin: ${gatewayOrigin}`);
  }
  knownGatewayOrigins.set(siteKey(siteBaseUrl), normalized);
};

export const getRememberedStellaGatewayOrigin = (
  siteBaseUrl: string | null | undefined,
): string | null =>
  siteBaseUrl ? (knownGatewayOrigins.get(siteKey(siteBaseUrl)) ?? null) : null;

/** Test seam: forget every remembered origin and cached capability. */
export const resetGatewaySessionState = (): void => {
  knownGatewayOrigins.clear();
  capabilityCache.clear();
  inFlightExchanges.clear();
};

// ---------------------------------------------------------------------------
// Session capability cache
// ---------------------------------------------------------------------------

type CapabilityCacheEntry = {
  capability: string;
  expiresAt: number;
};

const capabilityCache = new Map<string, CapabilityCacheEntry>();
const inFlightExchanges = new Map<string, Promise<CapabilityCacheEntry>>();

const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  const [, payload] = token.split(".");
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return decoded && typeof decoded === "object"
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * Cache identity of a Better Auth JWT: who the token is for, not which
 * rotation of it. A capability is bound to the owner, so a rotated JWT for
 * the same owner keeps using the still-valid capability; a different owner
 * (sign-out, sign-in, anonymous -> signed in) can never see another's entry.
 */
const authIdentity = (token: string): string => {
  const payload = decodeJwtPayload(token);
  if (!payload) return `token:${token}`;
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
  fetchImpl: typeof fetch;
  turnstileToken?: string;
}): Promise<CapabilityCacheEntry> => {
  const body: GatewaySessionCapabilityRequest = args.turnstileToken
    ? { turnstileToken: args.turnstileToken }
    : {};
  const response = await args.fetchImpl(
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

export type GatewaySessionClientArgs = {
  /** Resolved lazily so a route built before the catalog fetch still works. */
  gatewayOrigin: () => string | null;
  /** Current Better Auth JWT, already refreshed when it is about to expire. */
  getAuthToken: () => Promise<string | undefined> | string | undefined;
  /** Mint a fresh Better Auth JWT after the gateway rejects the current one. */
  refreshAuthToken?: () => Promise<string | undefined> | string | undefined;
  /** Obtain one fresh Turnstile token after a challenge_required response. */
  getChallengeToken?: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
};

export type GatewaySessionClient = {
  /** Cached capability, exchanged on first use and 60 s before expiry. */
  getCapability(): Promise<string | undefined>;
  /** Drop the cached capability and exchange a new one immediately. */
  refreshCapability(): Promise<string | undefined>;
  /** Drop the cached capability; the next `getCapability` re-exchanges. */
  invalidate(): Promise<void>;
};

export const createGatewaySessionClient = (
  args: GatewaySessionClientArgs,
): GatewaySessionClient => {
  const now = args.now ?? (() => Date.now());
  const fetchImpl = args.fetch ?? globalThis.fetch;

  const requireOrigin = (): string => {
    const origin = args.gatewayOrigin();
    if (!origin) throw new Error(STELLA_GATEWAY_UNCONFIGURED_MESSAGE);
    return origin;
  };

  const exchange = async (
    gatewayOrigin: string,
    authToken: string,
  ): Promise<CapabilityCacheEntry> => {
    const key = cacheKey({
      gatewayOrigin,
      authToken,
    });
    const inFlight = inFlightExchanges.get(key);
    if (inFlight) return inFlight;
    const work = (async () => {
      let currentAuthToken = authToken;
      let refreshedAuth = false;
      let challenged = false;
      let turnstileToken: string | undefined;
      while (true) {
        try {
          return await exchangeOnce({
            gatewayOrigin,
            authToken: currentAuthToken,
            fetchImpl,
            turnstileToken,
          });
        } catch (error) {
          if (
            error instanceof GatewaySessionExchangeError &&
            error.status === 401 &&
            !refreshedAuth &&
            !turnstileToken &&
            args.refreshAuthToken
          ) {
            refreshedAuth = true;
            const refreshed = (await args.refreshAuthToken())?.trim();
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
              turnstileToken = (await args.getChallengeToken?.())?.trim();
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
    inFlightExchanges.set(key, work);
    try {
      const entry = await work;
      capabilityCache.set(key, entry);
      return entry;
    } finally {
      if (inFlightExchanges.get(key) === work) inFlightExchanges.delete(key);
    }
  };

  const getCapability = async (
    forceRefresh: boolean,
  ): Promise<string | undefined> => {
    const gatewayOrigin = requireOrigin();
    const authToken = (await args.getAuthToken())?.trim();
    if (!authToken) return undefined;
    const key = cacheKey({
      gatewayOrigin,
      authToken,
    });
    if (forceRefresh) {
      capabilityCache.delete(key);
    } else {
      const cached = capabilityCache.get(key);
      if (
        cached &&
        cached.expiresAt - GATEWAY_SESSION_CAPABILITY_REFRESH_SKEW_MS > now()
      ) {
        return cached.capability;
      }
      capabilityCache.delete(key);
    }
    return (await exchange(gatewayOrigin, authToken)).capability;
  };

  return {
    getCapability: () => getCapability(false),
    refreshCapability: () => getCapability(true),
    invalidate: async () => {
      const gatewayOrigin = args.gatewayOrigin();
      const authToken = (await args.getAuthToken())?.trim();
      if (!gatewayOrigin || !authToken) return;
      capabilityCache.delete(cacheKey({ gatewayOrigin, authToken }));
    },
  };
};
