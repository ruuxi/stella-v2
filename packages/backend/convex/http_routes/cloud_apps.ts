import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { enforceActionRateLimit } from "../lib/rate_limits";
import { executeWebSearch } from "../tools/backend";
import { authorizeControlPlaneRequest } from "../lib/capability_verify";

/**
 * Cloud app routes.
 *
 * Turn-scoped callbacks (`/api/cloud/web-search`) are authenticated by the
 * control-plane turn capability the Durable Object minted for the turn
 * (`Authorization: Bearer <capability>`). Projections of turn state arrive
 * through `POST /api/cloud/outbox`.
 */

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function registerCloudAppRoutes(http: HttpRouter) {
  // Web search for cloud executors (orchestrator DO + sandbox agents, via the
  // DO's broker). The turn capability attributes the search to its owner for
  // rate limiting and binds it to one turn.
  http.route({
    path: "/api/cloud/web-search",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const auth = await authorizeControlPlaneRequest(ctx, request);
      if (!auth.ok) return auth.response;
      if (auth.authority.claims.audience === "anonymous") {
        return json({ error: "sign_in_required" }, 403);
      }
      const { ownerId, ownerGeneration, turnId } = auth.authority;
      const body = (await request.json().catch(() => ({}))) as {
        query?: string;
        category?: string;
        turnId?: string;
      };
      if (body.turnId && body.turnId !== turnId) {
        return json({ error: "Forbidden" }, 403);
      }
      await enforceActionRateLimit(
        ctx,
        "cloud_web_search",
        ownerId,
        { rate: 30, periodMs: 60_000 },
        "Too many web searches. Wait a moment and try again.",
      );
      // Rate limiting and provider preparation happen outside a database
      // transaction. Recheck the admitted generation at the last possible
      // moment before the search provider can incur work or return owner data.
      try {
        await ctx.runMutation(
          internal.owner_lifecycle.assertOwnerDataDispatchAllowedInternal,
          { ownerId, ownerGeneration },
        );
      } catch {
        return json({ error: "Owner data is unavailable" }, 409);
      }
      try {
        const result = await executeWebSearch(ctx, body.query ?? "", {
          ownerId,
          ownerGeneration,
          turnAuthority: { turnId },
          signal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(90_000),
          ]),
          category: body.category,
        });
        return json(result);
      } catch {
        return json({ error: "Owner data is unavailable" }, 409);
      }
    }),
  });
}
