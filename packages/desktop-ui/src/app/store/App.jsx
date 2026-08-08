import { useCallback, useEffect } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { uiState } from "@/platform/ui-state";
import { DEFAULT_STORE_TAB, LAST_STORE_TAB_KEY, normalizeStoreTab, readStoredStoreTab, } from "@/features/store/store-tabs";
import { useEmbeddedWebsiteTheme } from "@/global/website-view/use-embedded-website-theme";
import { EmbeddedWebsiteView } from "@/global/website-view/EmbeddedWebsiteView";
import { showToast } from "@/ui/toast";
const normalizeActionRecord = (value) => value && typeof value === "object" ? value : {};
const handleStoreWebLocalAction = async (action, handlers) => {
    const record = normalizeActionRecord(action);
    const type = record.type;
    const payload = normalizeActionRecord(record.payload);
    switch (type) {
        case "openSignIn": {
            handlers.openSignIn();
            return { ok: true };
        }
        case "showToast": {
            const title = typeof payload.title === "string" ? payload.title : "";
            const description = typeof payload.description === "string" ? payload.description : "";
            const variant = payload.variant === "success" ||
                payload.variant === "error" ||
                payload.variant === "loading"
                ? payload.variant
                : undefined;
            const duration = typeof payload.duration === "number" &&
                Number.isFinite(payload.duration)
                ? payload.duration
                : undefined;
            showToast({
                ...(title ? { title } : {}),
                ...(description ? { description } : {}),
                ...(variant ? { variant } : {}),
                ...(duration ? { duration } : {}),
            });
            return { ok: true };
        }
        case "listNativeIntegrations":
            return await window.electronAPI?.nativeIntegrations?.list?.();
        default:
            throw new Error("The desktop Store is browse-only.");
    }
};
export function StoreApp() {
    const navigate = useNavigate();
    const search = useSearch({ from: "/store" });
    const embeddedTheme = useEmbeddedWebsiteTheme();
    const requestedTab = normalizeStoreTab(search.tab);
    const urlIsLegacy = typeof search.tab === "string" && search.tab !== requestedTab;
    const openSignIn = useCallback(() => {
        void navigate({
            to: ".",
            search: (prev) => ({
                ...(prev ?? {}),
                dialog: "auth",
            }),
        });
    }, [navigate]);
    // Two redirects share this effect:
    //   - Legacy `?tab=installed`/`?tab=publish` URLs collapse to Discover.
    //   - First entry without any tab param goes to the user's last-saved tab.
    useEffect(() => {
        if (urlIsLegacy) {
            void navigate({
                to: "/store",
                search: { tab: requestedTab },
                replace: true,
            });
            return;
        }
        if (search.tab)
            return;
        const stored = readStoredStoreTab();
        if (stored === DEFAULT_STORE_TAB)
            return;
        void navigate({ to: "/store", search: { tab: stored }, replace: true });
    }, [navigate, search.tab, urlIsLegacy, requestedTab]);
    useEffect(() => {
        uiState.setItem(LAST_STORE_TAB_KEY, requestedTab);
    }, [requestedTab]);
    useEffect(() => {
        return window.electronAPI?.storeWebLocal?.onAction?.((payload) => {
            void handleStoreWebLocalAction(payload.action, { openSignIn })
                .then((result) => {
                window.electronAPI?.storeWebLocal?.reply({
                    requestId: payload.requestId,
                    ok: true,
                    result,
                });
            })
                .catch((error) => {
                window.electronAPI?.storeWebLocal?.reply({
                    requestId: payload.requestId,
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        });
    }, [openSignIn]);
    return (<div className="workspace-area">
      <div className="workspace-content workspace-content--full">
        <EmbeddedWebsiteView tab={requestedTab} packageId={typeof search.package === "string" && search.package.trim()
            ? search.package
            : undefined} theme={embeddedTheme}/>
      </div>
    </div>);
}
