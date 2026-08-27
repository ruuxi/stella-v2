import { useCallback, useMemo } from "react";
import { api } from "@/convex/api";
import { useDesktopAuthSession, getAuthSessionSnapshot } from "@/global/auth/services/auth-session";
import { readModelCatalogUpdatedAtSnapshot, useModelCatalogUpdatedAt } from "@/global/settings/hooks/model-catalog-updated-at";
import { createServiceRequest } from "@/platform/http/service-request";
import {
  groupCatalogModelsByProvider,
  listLocalCatalogModels,
  mergeCatalogModels,
  normalizeRuntimeCatalogSnapshot,
  normalizeStellaCatalogModels,
  searchCatalogModels,
  withStellaPresetFallbacks,
  type CatalogApiResponse,
  type CatalogDefaultModel,
  type CatalogModel,
  type ManagedRuntimeCatalogPayload,
  type ProviderGroup,
} from "@/global/settings/lib/model-catalog";
import { STELLA_MODELS_PATH } from "@/shared/stella-api";
import {
  resolveBillingAudience,
  type ManagedModelAudience,
} from "@/global/billing/audience";
import {
  createResourceStore,
  useResourceStore,
} from "@/shared/lib/resource-cache";
import { usePersistentConvexOneShot } from "@/shared/lib/use-convex-one-shot";

type StellaCatalogPayload = {
  models: CatalogModel[];
  defaults: CatalogDefaultModel[];
};

type AuthSessionData =
  | {
      user?: {
        id?: string | null;
        email?: string | null;
        isAnonymous?: boolean | null;
      } | null;
      session?: {
        id?: string | null;
      } | null;
    }
  | null
  | undefined;

type BillingStatus = {
  plan: "free" | "go" | "pro";
  usage: {
    rollingUsedUsd: number;
    rollingLimitUsd: number;
    weeklyUsedUsd: number;
    weeklyLimitUsd: number;
    monthlyUsedUsd: number;
    monthlyLimitUsd: number;
  };
};

const MODEL_CATALOG_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const EMPTY_STELLA: StellaCatalogPayload = { models: [], defaults: [] };
const EMPTY_MANAGED: ManagedRuntimeCatalogPayload = {
  revision: 0,
  directModels: [],
};

const stellaCatalogStore = createResourceStore<string, StellaCatalogPayload>({
  staleMs: MODEL_CATALOG_REFRESH_INTERVAL_MS,
  fetcher: async () => {
    const request = await createServiceRequest(STELLA_MODELS_PATH);
    const res = await fetch(request.endpoint, { headers: request.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as CatalogApiResponse;
    return {
      models: normalizeStellaCatalogModels(data?.data ?? []),
      defaults: data.defaults ?? [],
    };
  },
});

const managedGatewayStore = createResourceStore<"default", ManagedRuntimeCatalogPayload>({
  staleMs: MODEL_CATALOG_REFRESH_INTERVAL_MS,
  accept: (next, current) => next.revision > current.revision,
  fetcher: async (_key, context) => {
    const data = await window.electronAPI?.system?.listLlmModels?.({
      forceRefresh: context.force,
    });

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
    usage.rollingUsedUsd >= usage.rollingLimitUsd ||
    usage.weeklyUsedUsd >= usage.weeklyLimitUsd ||
    usage.monthlyUsedUsd >= usage.monthlyLimitUsd;
  return isDowngraded ? `${plan}_fallback` : plan;
}

function getSessionCacheKey(sessionData: AuthSessionData): string {
  if (!sessionData) return "signed-out";
  const user = sessionData.user;
  const identity =
    user?.id ?? user?.email ?? sessionData.session?.id ?? "unknown";
  const sessionId = sessionData.session?.id ?? "no-session";
  const kind = user?.isAnonymous === true ? "anonymous" : "account";
  return `${kind}:${identity}:${sessionId}`;
}

export function useModelCatalog() {
  const session = useDesktopAuthSession();

  const modelCatalogUpdatedAt = useModelCatalogUpdatedAt();
  const sessionData = session.data as AuthSessionData;
  const user = sessionData?.user ?? null;
  const hasConnectedAccount = Boolean(
    sessionData && user?.isAnonymous !== true,
  );
  const sessionCacheScope = getSessionCacheKey(sessionData);
  const billingStatus = usePersistentConvexOneShot(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount ? {} : "skip",
    {
      scope: sessionCacheScope,
      ttlMs: 5 * 60 * 1000,
    },
  ) as BillingStatus | undefined;
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
    if (session.isPending) return null;
    if (!hasConnectedAccount) return `${sessionCacheScope}:audience:anonymous`;

    return `${sessionCacheScope}:audience:${billingAudienceKey ?? "pending"}`;
  }, [
    billingAudienceKey,
    hasConnectedAccount,
    session.isPending,
    sessionCacheScope,
  ]);

  const stellaCacheKey = useMemo(() => {
    if (!authAudienceKey) return null;

    return `${authAudienceKey}::${modelCatalogUpdatedAt ?? "pending"}`;
  }, [authAudienceKey, modelCatalogUpdatedAt]);

  const stellaQuery = useResourceStore(stellaCatalogStore, stellaCacheKey);
  const managedQuery = useResourceStore(managedGatewayStore, "default");

  const stellaPayload = stellaQuery.data ?? EMPTY_STELLA;
  const managedPayload = managedQuery.data ?? EMPTY_MANAGED;

  const localModels = useMemo(() => listLocalCatalogModels(), []);

  const stellaModels = useMemo(
    () => withStellaPresetFallbacks(stellaPayload.models),
    [stellaPayload.models],
  );
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
    loading:
      stellaCacheKey === null ||
      (stellaQuery.isLoading && stellaPayload.models.length === 0),
    error: errorMessage,
    searchModels,
    modelCatalogUpdatedAt,
    refresh,
    refreshing: stellaQuery.isFetching || managedQuery.isFetching,
    audience,
  };
}

function buildAnonymousStellaCatalogKey(
  sessionData: AuthSessionData,
  modelCatalogUpdatedAt: number,
): string {
  return `${getSessionCacheKey(sessionData)}:audience:anonymous::${modelCatalogUpdatedAt}`;
}

export function preloadModelCatalogCache(): void {
  void managedGatewayStore.ensure("default");

  const modelCatalogUpdatedAt = readModelCatalogUpdatedAtSnapshot();
  if (modelCatalogUpdatedAt === null) return;

  const session = getAuthSessionSnapshot();
  if (session.isPending) return;

  const sessionData = session.data as AuthSessionData;
  const hasConnectedAccount = Boolean(
    sessionData && sessionData.user?.isAnonymous !== true,
  );
  if (hasConnectedAccount) return;

  void stellaCatalogStore.ensure(
    buildAnonymousStellaCatalogKey(sessionData, modelCatalogUpdatedAt),
  );
}
