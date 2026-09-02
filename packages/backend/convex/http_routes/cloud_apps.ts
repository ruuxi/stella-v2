import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { enforceActionRateLimit } from "../lib/rate_limits";
import { executeWebSearch } from "../tools/backend";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";
import { computeUsageCostMicroCents } from "../lib/billing_money";
import { estimateRequestTokens } from "@stella/model-catalog/request-estimate";
import {
  bindManagedProviderRequest,
  createManagedUsageDispatchGuard,
} from "../lib/managed_billing";
import { runManagedDispatchAttempt } from "../runtime_ai/managed";
import { MANAGED_USAGE_BILLING_KIND } from "../lib/managed_dispatch";
import { authorizeControlPlaneRequest } from "../lib/capability_verify";

/**
 * Cloud app routes.
 *
 * Turn-scoped callbacks (`/api/cloud/web-search`) are authenticated by the
 * control-plane turn capability the Durable Object minted for the turn
 * (`Authorization: Bearer <capability>`). Owner-scoped, non-turn routes keep
 * the builder service secret. Projections of turn state (events, index,
 * threads, builds) no longer have routes here: they arrive through
 * `POST /api/cloud/outbox`.
 */

const CLOUD_APP_MODEL = "anthropic/claude-haiku-4.5";
const CLOUD_APP_UPSTREAM_MODEL = "claude-haiku-4-5-20251001";
const CLOUD_APP_MODEL_AGENT = "cloud-app-model";
const CLOUD_APP_MODEL_SYSTEM_PROMPT =
  "You are Stella's cloud app art director. Return only JSON with keys title, eyebrow, headline, subhead, accent, accentSoft, habits (array of exactly four objects with name, detail, progress number 0-100), and focus. No markdown.";

class CloudModelUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly providerMessage: string,
  ) {
    super(`Cloud model upstream returned ${status}`);
  }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const serviceAuthorized = (request: Request): boolean => {
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return Boolean(
    secret && request.headers.get("authorization") === `Bearer ${secret}`,
  );
};

export function registerCloudAppRoutes(http: HttpRouter) {
  http.route({
    path: "/api/cloud/interior-active-route",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const stableRouteId = new URL(request.url).searchParams
        .get("stableRouteId")
        ?.trim();
      if (
        !stableRouteId ||
        !/^sr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          stableRouteId,
        )
      ) {
        return json({ error: "stableRouteId required" }, 400);
      }
      const route = await ctx.runQuery(
        internal.cloud_deployments.getInteriorRouteByStableRouteIdInternal,
        { stableRouteId },
      );
      return route
        ? json(route)
        : json({ error: "Stella interior route not found." }, 404);
    }),
  });

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

  http.route({
    path: "/api/cloud/model",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      let body: {
        ownerId?: unknown;
        ownerGeneration?: unknown;
        requestId?: unknown;
        prompt?: unknown;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: "Cloud model request must be valid JSON" }, 400);
      }
      const ownerId =
        typeof body.ownerId === "string" ? body.ownerId.trim() : "";
      const ownerGeneration =
        typeof body.ownerGeneration === "string"
          ? body.ownerGeneration.trim()
          : "";
      const requestId =
        typeof body.requestId === "string" ? body.requestId.trim() : "";
      if (!ownerId || !ownerGeneration || !requestId) {
        return json(
          { error: "ownerId, ownerGeneration, and requestId required" },
          400,
        );
      }
      if (!/^cloud-model:[a-f0-9]{64}$/u.test(requestId)) {
        return json({ error: "requestId is invalid" }, 400);
      }
      try {
        const current = await assertOwnerDataAccessActive(ctx, ownerId);
        if (current.generation !== ownerGeneration) {
          return json({ error: "Owner data generation is stale" }, 409);
        }
      } catch {
        return json({ error: "Owner data is unavailable" }, 409);
      }

      let access: {
        allowed: boolean;
        retryAfterMs: number;
        message: string;
      };
      try {
        access = await ctx.runMutation(
          internal.billing.resolveManagedModelAccess,
          { ownerId, ownerGeneration },
        );
      } catch {
        return json({ error: "Owner data is unavailable" }, 409);
      }
      if (!access.allowed) {
        const response = json({ error: access.message }, 429);
        response.headers.set(
          "Retry-After",
          String(Math.max(1, Math.ceil(access.retryAfterMs / 1_000))),
        );
        return response;
      }

      const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
      if (!apiKey)
        return json({ error: "Anthropic relay is not configured" }, 503);

      const upstreamBody = {
        model: CLOUD_APP_UPSTREAM_MODEL,
        max_tokens: 900,
        system: CLOUD_APP_MODEL_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: typeof body.prompt === "string" ? body.prompt : "",
          },
        ],
      };
      const upstreamBodyJson = JSON.stringify(upstreamBody);
      const tokenEstimate = estimateRequestTokens(upstreamBody);
      const modelPrice = await ctx.runQuery(
        internal.billing.getManagedModelPrice,
        { model: CLOUD_APP_MODEL },
      );
      const price = modelPrice
        ? {
            inputPerMillionUsd: modelPrice.inputPerMillionUsd,
            outputPerMillionUsd: modelPrice.outputPerMillionUsd,
            cacheReadPerMillionUsd: modelPrice.cacheReadPerMillionUsd,
            cacheWritePerMillionUsd: modelPrice.cacheWritePerMillionUsd,
            reasoningPerMillionUsd: modelPrice.reasoningPerMillionUsd,
          }
        : undefined;
      const estimatedCost = Math.max(
        1,
        computeUsageCostMicroCents({
          model: CLOUD_APP_MODEL,
          inputTokens: tokenEstimate.inputTokens,
          outputTokens: tokenEstimate.outputTokens,
          price,
        }),
      );
      try {
        const limit = await ctx.runMutation(
          internal.billing.enforceManagedUsageLimit,
          {
            ownerId,
            ownerGeneration,
            minimumRemainingMicroCents: estimatedCost,
          },
        );
        if (!limit.allowed) {
          const response = json({ error: limit.message }, 429);
          response.headers.set(
            "Retry-After",
            String(Math.max(1, Math.ceil(limit.retryAfterMs / 1_000))),
          );
          return response;
        }
      } catch {
        return json({ error: "Owner data is unavailable" }, 409);
      }

      let requestFingerprint: string;
      try {
        const binding = await bindManagedProviderRequest(ctx, {
          ownerId,
          ownerGeneration,
          route: "cloud:model",
          requestId,
          canonicalBody: upstreamBodyJson,
        });
        if (binding.replayed) {
          return json(
            {
              error:
                "This cloud model request was already accepted; use a new requestId for new work.",
            },
            409,
          );
        }
        requestFingerprint = binding.requestFingerprint;
      } catch {
        return json(
          { error: "requestId conflicts with an existing cloud model request" },
          409,
        );
      }

      const startedAt = Date.now();
      const dispatchGuard = createManagedUsageDispatchGuard(ctx, {
        ownerId,
        ownerGeneration,
      });
      const billing = {
        kind: MANAGED_USAGE_BILLING_KIND,
        requestFingerprint,
        agentType: CLOUD_APP_MODEL_AGENT,
        model: CLOUD_APP_MODEL,
        fallbackCostMicroCents: estimatedCost,
      } as const;
      try {
        const result = await runManagedDispatchAttempt({
          dispatchGuard,
          callerSignal: request.signal,
          billing,
          run: async (signal, receipt) => {
            const upstream = await fetch(
              "https://api.anthropic.com/v1/messages",
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-api-key": apiKey,
                  "anthropic-version": "2023-06-01",
                },
                body: upstreamBodyJson,
                signal,
              },
            );
            const payload = (await upstream.json()) as {
              content?: Array<{ type?: string; text?: string }>;
              usage?: { input_tokens?: number; output_tokens?: number };
              model?: string;
              error?: { message?: string };
            };
            const inputTokens =
              payload.usage?.input_tokens ?? tokenEstimate.inputTokens;
            const outputTokens = payload.usage?.output_tokens ?? 0;
            const exactCost = Math.max(
              1,
              computeUsageCostMicroCents({
                model: CLOUD_APP_MODEL,
                inputTokens,
                outputTokens,
                price,
              }),
            );
            if (!upstream.ok) {
              await receipt.captureUsage({
                durationMs: Date.now() - startedAt,
                success: false,
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                costMicroCents: exactCost,
              });
              throw new CloudModelUpstreamError(
                upstream.status,
                payload.error?.message ?? "Provider request failed",
              );
            }
            const text =
              payload.content?.find((item) => item.type === "text")?.text ?? "";
            let spec: unknown;
            try {
              spec = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
            } catch {
              await receipt.captureUsage({
                durationMs: Date.now() - startedAt,
                success: false,
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                costMicroCents: exactCost,
              });
              throw new Error(
                "Cloud model returned invalid specification JSON",
              );
            }
            await receipt.captureUsage({
              durationMs: Date.now() - startedAt,
              success: true,
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              costMicroCents: exactCost,
            });
            return { payload, spec, inputTokens, outputTokens };
          },
        });
        return json({
          spec: result.spec,
          usage: {
            model: result.payload.model ?? CLOUD_APP_UPSTREAM_MODEL,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            estimatedCostUsd:
              result.inputTokens / 1_000_000 +
              (result.outputTokens * 5) / 1_000_000,
            durationMs: Date.now() - startedAt,
          },
        });
      } catch (error) {
        if (error instanceof CloudModelUpstreamError) {
          return json({ error: error.providerMessage }, error.status);
        }
        return dispatchGuard.signal.aborted || request.signal.aborted
          ? json({ error: "Owner data is unavailable" }, 409)
          : json({ error: "Provider request failed" }, 502);
      }
    }),
  });
}
