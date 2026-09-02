import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { ManagedModelAudience } from "../agent/model";
import {
  corsPreflightHandler,
  errorResponse,
  handleCorsRequest,
  jsonResponse,
} from "../http_shared/cors";
import { getClientAddressKey } from "../lib/http_utils";
import { resolveManagedModelAccess } from "../lib/managed_billing";
import {
  STELLA_MODEL_CATALOG_UPDATED_AT,
  listStellaCatalogModels,
  listStellaDefaultSelections,
} from "../stella_models";

/**
 * Public model catalog for Stella runtimes: which `stella/...` aliases the
 * caller's audience may use, the defaults, and where the model gateway lives.
 */

export const STELLA_API_BASE_PATH = "/api/stella";
export const STELLA_MODELS_PATH = `${STELLA_API_BASE_PATH}/models`;
export const STELLA_MODELS_RATE_LIMIT = 60;
export const STELLA_MODELS_RATE_WINDOW_MS = 60_000;
export const MODEL_GATEWAY_URL_ENV = "MODEL_GATEWAY_URL";

type ModelGatewayEnv = Readonly<{
  MODEL_GATEWAY_URL?: string;
  STELLA_DEPLOYMENT_IDENTITY?: string;
}>;

const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

let warnedMissingGatewayOrigin = false;

/**
 * The gateway origin advertised to runtimes. Production must set it; a dev
 * deployment without one advertises an empty origin (with one warning) so the
 * catalog still serves.
 */
export const resolveModelGatewayOrigin = (env: ModelGatewayEnv): string => {
  const raw = env.MODEL_GATEWAY_URL?.trim();
  if (raw) {
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      url = null;
    }
    if (
      url &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && isLoopbackHost(url.hostname)))
    ) {
      return url.origin;
    }
    throw new Error(`${MODEL_GATEWAY_URL_ENV} must be an https origin.`);
  }
  if (env.STELLA_DEPLOYMENT_IDENTITY?.trim().startsWith("prod:")) {
    throw new Error(`${MODEL_GATEWAY_URL_ENV} is required in production.`);
  }
  if (!warnedMissingGatewayOrigin) {
    warnedMissingGatewayOrigin = true;
    console.warn(
      `[stella-models] ${MODEL_GATEWAY_URL_ENV} is unset; the catalog advertises no gateway origin.`,
    );
  }
  return "";
};

export const stellaModels = httpAction(async (ctx, request) =>
  handleCorsRequest(request, async (origin) => {
    let gatewayOrigin: string;
    try {
      gatewayOrigin = resolveModelGatewayOrigin(process.env);
    } catch (error) {
      console.error(
        `[stella-models] ${error instanceof Error ? error.message : String(error)}`,
      );
      return errorResponse(500, "Model gateway is not configured", origin);
    }

    const identity = await ctx.auth.getUserIdentity();

    let audience: ManagedModelAudience = identity
      ? (identity as Record<string, unknown>).isAnonymous === true
        ? "anonymous"
        : "free"
      : "anonymous";

    let shouldRateLimitModels = true;
    if (
      identity &&
      (identity as Record<string, unknown>).isAnonymous !== true
    ) {
      const access = await resolveManagedModelAccess(
        ctx,
        identity.tokenIdentifier,
      );
      audience = access.modelAudience;
      shouldRateLimitModels = !access.unlimited;
    }

    if (shouldRateLimitModels) {
      const rateLimit = await ctx.runMutation(
        internal.rate_limits.consumeWebhookRateLimit,
        {
          scope: "stella_models",
          key:
            identity?.tokenIdentifier ?? getClientAddressKey(request) ?? "anon",
          limit: STELLA_MODELS_RATE_LIMIT,
          windowMs: STELLA_MODELS_RATE_WINDOW_MS,
          blockMs: STELLA_MODELS_RATE_WINDOW_MS,
        },
      );
      if (!rateLimit.allowed) {
        const response = errorResponse(429, "Rate limit exceeded", origin);
        response.headers.set(
          "Retry-After",
          String(Math.ceil(rateLimit.retryAfterMs / 1000)),
        );
        return response;
      }
    }

    return jsonResponse(
      {
        data: listStellaCatalogModels(audience).map((model) => ({
          id: model.id,
          name: model.name,
          provider: model.provider,
          type: model.type,
          upstreamModel: model.upstreamModel,
          allowedForAudience: model.allowedForAudience,
        })),
        defaults: listStellaDefaultSelections(audience),
        updatedAt: STELLA_MODEL_CATALOG_UPDATED_AT,
        gateway: { origin: gatewayOrigin },
      },
      200,
      origin,
    );
  }),
);

export const registerStellaModelRoutes = (http: HttpRouter) => {
  http.route({
    path: STELLA_MODELS_PATH,
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) => corsPreflightHandler(request)),
  });
  http.route({ path: STELLA_MODELS_PATH, method: "GET", handler: stellaModels });
};
