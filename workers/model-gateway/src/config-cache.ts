import {
  limitsAudienceFor,
  type ManagedModelAudienceForLimits,
} from "@stella/contracts/gateway/api";
import type { GatewayConfigSnapshot } from "@stella/contracts/gateway/usage";
import { isManagedModelAudience } from "@stella/contracts/gateway/capability";
import type { TokenPriceConfig } from "@stella/model-catalog/pricing";
import type { ConvexClient } from "./convex-client.js";
import { GatewayError } from "./errors.js";
import {
  sharedGatewayConfigRecord,
  type SharedGatewayConfigRecord,
  type SharedGatewayConfigStore,
  validateSharedGatewayConfigRecord,
} from "./shared-config.js";

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

/**
 * An object-local durable copy of the shared record (same shape and key as
 * the shared KV snapshot), so a restarted owner object serves warm pricing.
 */
export type GatewayConfigStorage = {
  source: string;
  read(): unknown;
  write(record: SharedGatewayConfigRecord): void;
};

let cached: GatewayConfig | null = null;
let inflight: Promise<GatewayConfig> | null = null;
let sharedInflight: Promise<GatewayConfig | null> | null = null;

/** A delayed restore never replaces a newer resident copy. */
const adopt = (restored: GatewayConfig | null): void => {
  if (!cached || (restored && restored.fetchedAt > cached.fetchedAt)) {
    cached = restored;
  }
};

export const resetConfigCacheForTests = (): void => {
  cached = null;
  inflight = null;
  sharedInflight = null;
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
    const result = await client.config();
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
    return cached;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
};

const restoreRecord = async (
  value: unknown,
  source: string,
  now: number,
): Promise<GatewayConfig | null> => {
  const result = await validateSharedGatewayConfigRecord({
    value,
    source,
    now,
    maxAgeMs: CONFIG_TTL_MS,
  });
  return result.ok
    ? indexPrices(result.record.snapshot, result.record.originalFetchedAt)
    : null;
};

const persistConfig = async (
  config: GatewayConfig,
  storage?: GatewayConfigStorage,
): Promise<void> => {
  if (!storage) return;
  // Incomplete or oversize snapshots still serve from memory. Persist the
  // original fetch time, never extend freshness.
  const built = await sharedGatewayConfigRecord({
    snapshot: config.snapshot,
    source: storage.source,
    originalFetchedAt: config.fetchedAt,
  });
  if (!built.ok || JSON.stringify(storage.read()) === built.serialized) return;
  storage.write(built.record);
};

export const getGatewayConfig = async (
  client: ConvexClient,
  waitUntil: (promise: Promise<unknown>) => void,
  now: () => number = Date.now,
  storage?: GatewayConfigStorage,
  shared?: SharedGatewayConfigStore,
): Promise<GatewayConfig> => {
  if (!cached && storage) {
    adopt(await restoreRecord(storage.read(), storage.source, now()));
  }
  if (!cached && shared) {
    sharedInflight ??= (async () => {
      try {
        return await restoreRecord(await shared.read(), shared.source, now());
      } catch {
        // The authoritative Convex pull below remains the cold-path fallback.
        return null;
      }
    })().finally(() => {
      sharedInflight = null;
    });
    adopt(await sharedInflight);
    if (cached) await persistConfig(cached, storage);
  }
  const refreshAndPersist = async (): Promise<GatewayConfig> => {
    const config = await refresh(client, now);
    await persistConfig(config, storage);
    return config;
  };
  const current = cached;
  if (!current) return await refreshAndPersist();
  if (now() - current.fetchedAt >= CONFIG_TTL_MS) {
    waitUntil(
      refreshAndPersist().catch((error: unknown) => {
        console.warn(
          `[model-gateway] config refresh failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }),
    );
  }
  // A warm isolate can serve several owners; seed each owner's restart cache.
  await persistConfig(current, storage);
  return current;
};
