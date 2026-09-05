import type { GatewayConfigSnapshot } from "@stella/contracts/gateway/usage";
import { isManagedModelAudience } from "@stella/contracts/gateway/capability";
import type { ConvexClient } from "./convex-client.js";

export const SHARED_GATEWAY_CONFIG_KEY = "gatewayConfig:v1";
const SHARED_GATEWAY_CONFIG_RECORD_VERSION = 1;
const MAX_SHARED_GATEWAY_CONFIG_BYTES = 100_000;

export type SharedGatewayConfigRecord = {
  version: typeof SHARED_GATEWAY_CONFIG_RECORD_VERSION;
  source: string;
  originalFetchedAt: number;
  revision: string;
  snapshot: GatewayConfigSnapshot;
};

export type SharedGatewayConfigStore = {
  source: string;
  read(): Promise<unknown>;
};

export const sharedGatewayConfigStore = (
  env: Pick<Env, "CONFIG_SNAPSHOT" | "STELLA_CONVEX_SITE_URL">,
): SharedGatewayConfigStore | undefined => {
  const store = env.CONFIG_SNAPSHOT;
  if (!store) return undefined;
  return {
    source: env.STELLA_CONVEX_SITE_URL,
    read: () => store.get(SHARED_GATEWAY_CONFIG_KEY, "json"),
  };
};

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isFiniteCeiling = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  (value === -1 || value >= 0);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isCompleteGatewayConfigSnapshot = (
  value: unknown,
): value is GatewayConfigSnapshot => {
  if (!isObject(value) || value.v !== 1 || !Array.isArray(value.prices)) {
    return false;
  }
  if (!isObject(value.anonymous)) return false;
  if (
    !isFiniteNonNegative(value.anonymous.maxRequestsPerOwner) ||
    !Number.isInteger(value.anonymous.maxRequestsPerOwner) ||
    !isFiniteNonNegative(value.anonymous.maxRequestsPerIp) ||
    !Number.isInteger(value.anonymous.maxRequestsPerIp)
  ) {
    return false;
  }
  if (
    !Array.isArray(value.tierCeilings) ||
    !isFiniteNonNegative(value.updatedAt)
  ) {
    return false;
  }
  const seenModels = new Set<string>();
  for (const price of value.prices) {
    if (
      !isObject(price) ||
      typeof price.model !== "string" ||
      price.model.length === 0 ||
      !isFiniteNonNegative(price.inputPerMillionUsd) ||
      !isFiniteNonNegative(price.outputPerMillionUsd) ||
      !isFiniteNonNegative(price.cacheReadPerMillionUsd) ||
      !isFiniteNonNegative(price.cacheWritePerMillionUsd) ||
      !isFiniteNonNegative(price.reasoningPerMillionUsd)
    ) {
      return false;
    }
    if (seenModels.has(price.model)) return false;
    seenModels.add(price.model);
  }
  const requiredCeilings = new Set(["anonymous", "free"]);
  const seenCeilings = new Set<string>();
  for (const ceiling of value.tierCeilings) {
    if (
      !isObject(ceiling) ||
      !isManagedModelAudience(ceiling.audience) ||
      !isFiniteCeiling(ceiling.hourlyMicroCents) ||
      !isFiniteCeiling(ceiling.dailyMicroCents)
    ) {
      return false;
    }
    if (seenCeilings.has(ceiling.audience)) return false;
    seenCeilings.add(ceiling.audience);
    requiredCeilings.delete(ceiling.audience);
  }
  return requiredCeilings.size === 0;
};

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const gatewayConfigRevision = async (
  snapshot: GatewayConfigSnapshot,
): Promise<string> => {
  const encoded = new TextEncoder().encode(JSON.stringify(snapshot));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)));
};

type SharedRecordResult =
  | { ok: true; record: SharedGatewayConfigRecord }
  | {
      ok: false;
      reason:
        | "missing"
        | "malformed"
        | "wrong_source"
        | "future"
        | "stale"
        | "revision_mismatch";
    };

export const validateSharedGatewayConfigRecord = async (args: {
  value: unknown;
  source: string;
  now: number;
  maxAgeMs: number;
}): Promise<SharedRecordResult> => {
  const { value } = args;
  if (value === null || value === undefined)
    return { ok: false, reason: "missing" };
  if (
    !isObject(value) ||
    value.version !== SHARED_GATEWAY_CONFIG_RECORD_VERSION ||
    typeof value.source !== "string" ||
    typeof value.originalFetchedAt !== "number" ||
    !Number.isFinite(value.originalFetchedAt) ||
    typeof value.revision !== "string" ||
    !isCompleteGatewayConfigSnapshot(value.snapshot)
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (value.source !== args.source)
    return { ok: false, reason: "wrong_source" };
  if (value.originalFetchedAt > args.now)
    return { ok: false, reason: "future" };
  if (args.now - value.originalFetchedAt >= args.maxAgeMs) {
    return { ok: false, reason: "stale" };
  }
  if (value.revision !== (await gatewayConfigRevision(value.snapshot))) {
    return { ok: false, reason: "revision_mismatch" };
  }
  return {
    ok: true,
    record: {
      version: SHARED_GATEWAY_CONFIG_RECORD_VERSION,
      source: value.source,
      originalFetchedAt: value.originalFetchedAt,
      revision: value.revision,
      snapshot: value.snapshot,
    },
  };
};

/**
 * The KV record for a snapshot. Only complete snapshots are shared, and only
 * when the record fits one KV value.
 */
export const sharedGatewayConfigRecord = async (args: {
  snapshot: unknown;
  source: string;
  originalFetchedAt: number;
}): Promise<
  | { ok: true; record: SharedGatewayConfigRecord; serialized: string }
  | { ok: false; reason: "incomplete_snapshot" | "oversize" }
> => {
  if (!isCompleteGatewayConfigSnapshot(args.snapshot)) {
    return { ok: false, reason: "incomplete_snapshot" };
  }
  const record: SharedGatewayConfigRecord = {
    version: SHARED_GATEWAY_CONFIG_RECORD_VERSION,
    source: args.source,
    originalFetchedAt: args.originalFetchedAt,
    revision: await gatewayConfigRevision(args.snapshot),
    snapshot: args.snapshot,
  };
  const serialized = JSON.stringify(record);
  if (
    new TextEncoder().encode(serialized).byteLength >=
    MAX_SHARED_GATEWAY_CONFIG_BYTES
  ) {
    return { ok: false, reason: "oversize" };
  }
  return { ok: true, record, serialized };
};

export const publishSharedGatewayConfig = async (args: {
  client: ConvexClient;
  store: Pick<KVNamespace, "put">;
  source: string;
  now?: () => number;
}): Promise<void> => {
  const startedAt = performance.now();
  const result = await args.client.config();
  const built = result.ok
    ? await sharedGatewayConfigRecord({
        snapshot: result.body,
        source: args.source,
        originalFetchedAt: (args.now ?? Date.now)(),
      })
    : { ok: false as const, reason: "convex_unavailable" as const };
  if (!built.ok) {
    console.warn(
      JSON.stringify({
        event: "gateway_config_shared_publish",
        status: "failed",
        reason: built.reason,
        durationMs: performance.now() - startedAt,
      }),
    );
    return;
  }
  const { record, serialized } = built;
  try {
    await args.store.put(SHARED_GATEWAY_CONFIG_KEY, serialized);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "gateway_config_shared_publish",
        status: "failed",
        reason: "kv_write_failed",
        durationMs: performance.now() - startedAt,
      }),
    );
    throw error;
  }
  console.info(
    JSON.stringify({
      event: "gateway_config_shared_publish",
      status: "completed",
      revision: record.revision,
      durationMs: performance.now() - startedAt,
    }),
  );
};
