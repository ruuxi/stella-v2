import type { LiveCodexModel } from "@/global/settings/lib/engine-model-routing";
import {
  createResourceStore,
  useResourceStore,
} from "@/shared/lib/resource-cache";

const codexModelCatalogStore = createResourceStore<"default", LiveCodexModel[]>(
  {
    // Preserve the old mount behavior while deduplicating simultaneous picker
    // mounts: a later mount may revalidate, but concurrent consumers share one
    // in-flight model/list request and one accepted snapshot.
    staleMs: 0,
    fetcher: async () => {
      const result = await window.electronAPI?.system?.listCodexModels?.();
      if (!result) throw new Error("Codex model discovery is unavailable.");
      return result.models.filter((model) => !model.hidden);
    },
  },
);

export function useCodexModelCatalog() {
  const query = useResourceStore(codexModelCatalogStore, "default");

  return {
    models: query.data ?? null,
    loading: query.isLoading || query.isFetching,
    // A forced refresh supersedes the previous attempt. Hide its stale error
    // while the replacement request is active, matching the prior hook.
    error: query.isFetching ? null : (query.error?.message ?? null),
    refresh: query.refresh,
  };
}

export const resetCodexModelCatalogStoreForTests = (): void => {
  codexModelCatalogStore.invalidate("*");
};
