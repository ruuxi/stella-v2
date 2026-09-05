import {
  limitsAudienceFor,
  type ManagedModelAudienceForLimits,
} from "@stella/contracts/gateway/api";
import type { GatewayConfigSnapshot } from "@stella/contracts/gateway/usage";
import { isManagedModelAudience } from "@stella/contracts/gateway/capability";
import type { TokenPriceConfig } from "@stella/model-catalog/pricing";
import type { ConvexClient } from "./convex-client.js";
import { GatewayError } from "./errors.js";

/**
 * `GET /api/gateway/config` cached per isolate. Fresh for CONFIG_TTL_MS; after
 * that the stale copy keeps serving while one background refresh runs
 * (stale-while-revalidate), so the control plane is never on a request's
 * critical path except on a cold isolate.
 */
export const CONFIG_TTL_MS = 5 * 60_000;

export type GatewayConfig = {
  snapshot: GatewayConfigSnapshot;
  fetchedAt: number;
  anonymous: { maxRequestsPerOwner: number | null };
  tierCeilings: ReadonlyMap<
    ManagedModelAudienceForLimits,
    { hourlyMicroCents: number; dailyMicroCents: number }
  >;
  priceFor(model: string): TokenPriceConfig | null;
};

let cached: GatewayConfig | null = null;
let inflight: Promise<GatewayConfig> | null = null;

export const resetConfigCacheForTests = (): void => {
  cached = null;
  inflight = null;
};

const isSnapshot = (value: unknown): value is GatewayConfigSnapshot =>
  !!value &&
  typeof value === "object" &&
  (value as { v?: unknown }).v === 1 &&
  Array.isArray((value as { prices?: unknown }).prices);

const indexPrices = (
  snapshot: GatewayConfigSnapshot,
  now: number,
): GatewayConfig => {
  const prices = new Map<string, TokenPriceConfig>();
  for (const price of snapshot.prices) {
    if (!price || typeof price.model !== "string") continue;
    prices.set(price.model, {
      inputPerMillionUsd: price.inputPerMillionUsd,
      outputPerMillionUsd: price.outputPerMillionUsd,
      cacheReadPerMillionUsd: price.cacheReadPerMillionUsd,
      cacheWritePerMillionUsd: price.cacheWritePerMillionUsd,
      reasoningPerMillionUsd: price.reasoningPerMillionUsd,
    });
  }
  const tierCeilings = new Map<
    ManagedModelAudienceForLimits,
    { hourlyMicroCents: number; dailyMicroCents: number }
  >();
  if (Array.isArray(snapshot.tierCeilings)) {
    for (const ceiling of snapshot.tierCeilings) {
      if (
        !ceiling ||
        !isManagedModelAudience(ceiling.audience) ||
        typeof ceiling.hourlyMicroCents !== "number" ||
        !Number.isFinite(ceiling.hourlyMicroCents) ||
        typeof ceiling.dailyMicroCents !== "number" ||
        !Number.isFinite(ceiling.dailyMicroCents)
      ) {
        continue;
      }
      tierCeilings.set(limitsAudienceFor(ceiling.audience), {
        hourlyMicroCents: Math.round(ceiling.hourlyMicroCents),
        dailyMicroCents: Math.round(ceiling.dailyMicroCents),
      });
    }
  }
  const maxRequestsPerOwner = snapshot.anonymous?.maxRequestsPerOwner;
  return {
    snapshot,
    fetchedAt: now,
    anonymous: {
      maxRequestsPerOwner:
        typeof maxRequestsPerOwner === "number" &&
        Number.isFinite(maxRequestsPerOwner)
          ? Math.max(0, Math.floor(maxRequestsPerOwner))
          : null,
    },
    tierCeilings,
    priceFor: (model) => prices.get(model) ?? null,
  };
};

const refresh = (
  client: ConvexClient,
  now: () => number,
): Promise<GatewayConfig> => {
  if (inflight) return inflight;
  inflight = (async () => {
    const startedAt = performance.now();
    const cold = cached === null;
    const result = await client.config();
    const fetchMs = performance.now() - startedAt;
    if (!result.ok || !isSnapshot(result.body)) {
      throw new GatewayError(
        503,
        "internal",
        "Model pricing is temporarily unavailable.",
        {
          retryable: true,
        },
      );
    }
    cached = indexPrices(result.body, now());
    console.info(JSON.stringify({ event: "gateway_config_load_timing", cold,
      fetchMs, indexingMs: performance.now() - startedAt - fetchMs,
      totalMs: performance.now() - startedAt }));
    return cached;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
};

export const getGatewayConfig = async (
  client: ConvexClient,
  waitUntil: (promise: Promise<unknown>) => void,
  now: () => number = Date.now,
): Promise<GatewayConfig> => {
  const current = cached;
  if (!current) return await refresh(client, now);
  if (now() - current.fetchedAt >= CONFIG_TTL_MS) {
    waitUntil(
      refresh(client, now).catch((error: unknown) => {
        console.warn(
          `[model-gateway] config refresh failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }),
    );
  }
  return current;
};
