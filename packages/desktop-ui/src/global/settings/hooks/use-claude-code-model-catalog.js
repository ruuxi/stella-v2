import { createResourceStore, useResourceStore, } from "@/shared/lib/resource-cache";
const ENGINE_MODEL_CATALOG_STALE_MS = 60 * 60 * 1000;
const CLAUDE_CODE_CATALOG_KEY = "default";
const claudeCodeCatalogStore = createResourceStore({
    staleMs: ENGINE_MODEL_CATALOG_STALE_MS,
    fetcher: async () => {
        const result = await window.electronAPI?.system?.listClaudeCodeModels?.();
        if (!result)
            throw new Error("Claude Code model discovery is unavailable.");
        return result.models;
    },
});
export function useClaudeCodeModelCatalog(enabled = true) {
    const { data, error, isLoading, isFetching, refresh } = useResourceStore(claudeCodeCatalogStore, enabled ? CLAUDE_CODE_CATALOG_KEY : null);
    return {
        models: data ?? null,
        loading: enabled && (isLoading || isFetching),
        error: error?.message ?? null,
        refresh,
    };
}
