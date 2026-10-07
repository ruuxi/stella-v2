import { useBackendValue } from "@/platform/backend/use-backend-view";
import type { BillingStatus } from "@stella/contracts/backend/billing";
import { useCallback, useMemo } from "react";
import { isWebsiteHost } from "@/platform/capabilities";
import { useDesktopAuthSession } from "@/global/auth/services/auth-session";
import { fetchStellaModels } from "@/platform/backend/stella-models";
import {
  groupCatalogModelsByProvider,
  listLocalCatalogModels,
  mergeCatalogModels,
  normalizeRuntimeCatalogSnapshot,
  normalizeStellaCatalogModels,
  searchCatalogModels,
  type CatalogDefaultModel,
  type CatalogModel,
  type ManagedRuntimeCatalogPayload,
  type ProviderGroup,
} from "@/global/settings/lib/model-catalog";
import {
  resolveBillingAudience,
  type ManagedModelAudience,
} from "@/global/billing/audience";
import {
  createResourceStore,
  useResourceStore,
} from "@/shared/lib/resource-cache";

type StellaCatalogPayload = {
  models: CatalogModel[];
  defaults: CatalogDefaultModel[];
};

type AuthSessionData =
  | {
      user?: {
        id?: string | null;
        email?: string | null;
      } | null;
      session?: {
        id?: string | null;
      } | null;
    }
  | null
  | undefined;

const MODEL_CATALOG_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const EMPTY_STELLA: StellaCatalogPayload = { models: [], defaults: [] };
const EMPTY_MANAGED: ManagedRuntimeCatalogPayload = {
  revision: 0,
  directModels: [],
};

/**
 * Per-audience Stella catalog, keyed by the auth audience. Fetched once per
 * launch and again (with its ETag) when `billing.status` moves the audience.
 */
const stellaCatalogStore = createResourceStore<string, StellaCatalogPayload>({
  staleMs: MODEL_CATALOG_REFRESH_INTERVAL_MS,
  fetcher: async () => {
    const data = await fetchStellaModels();
    return {
      models: normalizeStellaCatalogModels(data?.data ?? []),
      defaults: data.defaults ?? [],
    };
  },
});

/**
 * Single worker-owned catalog for direct providers. The runtime restores its
 * persisted last-good catalog immediately and refreshes pi.dev in the
 * background, so the renderer never maintains a second provider registry.
 */
const managedGatewayStore = createResourceStore<"default", ManagedRuntimeCatalogPayload>({
  staleMs: MODEL_CATALOG_REFRESH_INTERVAL_MS,
  accept: (next, current) => next.revision > current.revision,
  fetcher: async (_key, context) => {
    const data = await window.electronAPI?.system?.listLlmModels?.({
      forceRefresh: context.force,
    });
    // Do not normalize a missing response into an empty catalog — that would
    // cache `{revision: 0, directModels: []}` as a successful fetch for the
    // whole stale window. Surface the missing bridge as an error instead.
    if (!data) throw new Error("Model catalog IPC bridge is unavailable.");
    return normalizeRuntimeCatalogSnapshot(data);
  },
});

const stopManagedCatalogUpdates =
  typeof window !== "undefined"
    ? window.electronAPI?.system?.onLlmModelsUpdated?.((snapshot) => {
        managedGatewayStore.push(
          "default",
          normalizeRuntimeCatalogSnapshot(snapshot),
        );
      })
    : undefined;
if (import.meta.hot && stopManagedCatalogUpdates) {
  import.meta.hot.dispose(stopManagedCatalogUpdates);
}

function getBillingAudienceKey(
  billingStatus: BillingStatus | undefined,
): string | null {
  if (!billingStatus) return null;
  const { plan, usage } = billingStatus;
  if (plan === "free") return "free";
  const isDowngraded =
    usage !== null &&
    (usage.rollingUsedUsd >= usage.rollingLimitUsd ||
    usage.weeklyUsedUsd >= usage.weeklyLimitUsd ||
    usage.monthlyUsedUsd >= usage.monthlyLimitUsd);
  return isDowngraded ? `${plan}_fallback` : plan;
}

function getSessionCacheKey(sessionData: AuthSessionData): string {
  if (!sessionData) return "signed-out";
  const user = sessionData.user;
  const identity =
    user?.id ?? user?.email ?? sessionData.session?.id ?? "unknown";
  const sessionId = sessionData.session?.id ?? "no-session";
  return `account:${identity}:${sessionId}`;
}

export function useModelCatalog() {
  const session = useDesktopAuthSession();
  const sessionData = session.data as AuthSessionData;
  const hasConnectedAccount = Boolean(sessionData);
  const sessionCacheScope = getSessionCacheKey(sessionData);
  const billingStatus = useBackendValue(
    "billing.status",
    hasConnectedAccount ? {} : "skip",
  );
  const billingAudienceKey = getBillingAudienceKey(billingStatus);
  const audience = useMemo<ManagedModelAudience | null>(
    () =>
      resolveBillingAudience({
        hasConnectedAccount,
        billingStatus,
      }),
    [billingStatus, hasConnectedAccount],
  );
  const authAudienceKey = useMemo(() => {
    if (session.isPending || !hasConnectedAccount) return null;
    // Once billing resolves we key by the precise audience. Until then fetch
    // under a provisional key rather than returning null — the backend derives
    // the real audience (and `allowedForAudience`) from the auth token, not
    // from this client cache key, so the fetched data is already correct; the
    // audience only busts the cache so restricted styling re-evaluates on plan
    // change. Returning null here previously left the picker stuck on
    // "Loading Stella models…" forever whenever the billing query was slow or
    // failed (it swallows errors and never resolves).
    return `${sessionCacheScope}:audience:${billingAudienceKey ?? "pending"}`;
  }, [
    billingAudienceKey,
    hasConnectedAccount,
    session.isPending,
    sessionCacheScope,
  ]);

  // The key follows `billing.status` (plan and fallback), so a billing change
  // that moves the audience refetches; the ETag makes an unchanged catalog a
  // 304.
  const stellaCacheKey = authAudienceKey;

  const stellaQuery = useResourceStore(stellaCatalogStore, stellaCacheKey);
  const managedQuery = useResourceStore(managedGatewayStore, isWebsiteHost() ? null : "default");

  const stellaPayload = stellaQuery.data ?? EMPTY_STELLA;
  const managedPayload = managedQuery.data ?? EMPTY_MANAGED;

  const localModels = useMemo(() => isWebsiteHost() ? [] : listLocalCatalogModels(), []);
  const stellaModels = stellaPayload.models;
  const directModels = useMemo(
    () => mergeCatalogModels(localModels, managedPayload.directModels),
    [managedPayload.directModels, localModels],
  );
  const mergedModels = useMemo(
    () => mergeCatalogModels(stellaModels, directModels),
    [directModels, stellaModels],
  );
  const groups = useMemo<ProviderGroup[]>(
    () => groupCatalogModelsByProvider(mergedModels),
    [mergedModels],
  );
  const searchModels = useMemo(
    () => (query: string) => searchCatalogModels(mergedModels, query),
    [mergedModels],
  );

  const refresh = useCallback(async () => {
    await Promise.all([
      stellaQuery.refresh(),
      managedQuery.refresh(),
    ]);
  }, [managedQuery, stellaQuery]);

  const errorMessage =
    managedPayload.configError ??
    managedQuery.error?.message ??
    managedPayload.catalogError ??
    stellaQuery.error?.message ??
    null;

  return {
    models: stellaModels,
    stellaModels,
    localModels: directModels,
    allModels: mergedModels,
    defaults: stellaPayload.defaults,
    groups,
    loading: hasConnectedAccount
      ? stellaCacheKey === null ||
        (stellaQuery.isLoading && stellaPayload.models.length === 0)
      : Boolean(session.isPending),
    error: errorMessage,
    searchModels,
    refresh,
    refreshing: stellaQuery.isFetching || managedQuery.isFetching,
    audience,
  };
}

/** Intent-hover warm for the sidebar Models popover and composer entry points. */
export function preloadModelCatalogCache(): void {
  if (!isWebsiteHost()) void managedGatewayStore.ensure("default");
}
