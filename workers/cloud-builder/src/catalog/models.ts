import type { ManagedModelAudience } from "@stella/contracts/gateway/capability";
import { STELLA_MODELS_PATH } from "@stella/contracts/stella-api";
import {
  STELLA_MODEL_CATALOG_UPDATED_AT,
  listStellaCatalogModels,
  listStellaDefaultSelections,
} from "@stella/model-catalog/aliases";
import { sha256Hex } from "../hash.js";
import { verifyCaller } from "../owner-store/routes.js";
import { readManagedModelPrices } from "./prices.js";

/**
 * `GET /api/stella/models`: the public model catalog for Stella runtimes.
 * Which `stella/...` models the caller's audience may pick, the per-agent
 * defaults, each model's price, and where the model gateway lives. The
 * bearer is optional: without one the audience is anonymous; with one it is
 * the plan the owner's billing says. Clients revalidate with `If-None-Match`.
 */

const CORS_HEADERS = {
  // Public data behind an optional bearer, never cookies.
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET",
  "access-control-allow-headers": "authorization, if-none-match, x-device-id",
  "access-control-expose-headers": "etag",
  "access-control-max-age": "600",
};

const reply = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      ...(body === null ? {} : { "content-type": "application/json" }),
      "cache-control": "private, no-cache",
      ...headers,
    },
  });

const audienceFor = async (
  request: Request,
  env: Cloudflare.Env,
): Promise<{ ok: true; audience: ManagedModelAudience } | { ok: false; response: Response }> => {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return { ok: true, audience: "anonymous" };
  const verified = await verifyCaller(env, token);
  if (!verified.ok) {
    const status = verified.error.code === "UNAUTHENTICATED" ? 401 : 503;
    return { ok: false, response: reply(status, { error: verified.error.message }) };
  }
  if (verified.caller.isAnonymous) return { ok: true, audience: "anonymous" };
  const access = await env.OWNER_GATES.getByName(verified.caller.ownerId).billingAccess({ isAnonymous: false });
  return { ok: true, audience: access.audience };
};

export async function handleStellaModelsRoute(request: Request, env: Cloudflare.Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== STELLA_MODELS_PATH) return null;
  if (request.method === "OPTIONS") return reply(204, null);
  if (request.method !== "GET") return reply(405, { error: "Method not allowed." });
  const gatewayOrigin = new URL(env.MODEL_GATEWAY_URL).origin;
  try {
    const resolved = await audienceFor(request, env);
    if (!resolved.ok) return resolved.response;
    const { audience } = resolved;
    const { prices, updatedAt: pricesUpdatedAt } = await readManagedModelPrices(env);
    const priceByModel = new Map(prices.map((price) => [price.model, price]));
    const body = JSON.stringify({
      data: listStellaCatalogModels(audience).map((model) => {
        const price = priceByModel.get(model.upstreamModel);
        return {
          id: model.id,
          name: model.name,
          provider: model.provider,
          type: model.type,
          upstreamModel: model.upstreamModel,
          api: model.api,
          allowedForAudience: model.allowedForAudience,
          pricing: price
            ? {
                inputPerMillionUsd: price.inputPerMillionUsd,
                outputPerMillionUsd: price.outputPerMillionUsd,
                cacheReadPerMillionUsd: price.cacheReadPerMillionUsd,
                cacheWritePerMillionUsd: price.cacheWritePerMillionUsd,
              }
            : null,
        };
      }),
      defaults: listStellaDefaultSelections(audience),
      updatedAt: Math.max(STELLA_MODEL_CATALOG_UPDATED_AT, pricesUpdatedAt),
      gateway: { origin: gatewayOrigin },
    });
    const etag = `"${(await sha256Hex(body)).slice(0, 32)}"`;
    const presented = request.headers.get("if-none-match") ?? "";
    if (presented.split(",").some((value) => value.trim().replace(/^W\//, "") === etag)) {
      return reply(304, null, { etag });
    }
    return new Response(body, {
      status: 200,
      headers: { ...CORS_HEADERS, "content-type": "application/json", "cache-control": "private, no-cache", etag },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "stella_models_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return reply(503, { error: "The model catalog is temporarily unavailable." });
  }
}
