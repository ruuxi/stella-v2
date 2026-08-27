import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  sidebarSections,
  useSidebarOpenTabs,
  useSidebarSectionLocation,
} from "@/features/workspace-display/sidebar-sections";
import { CloudAppPanel } from "./CloudAppPanel";
import { CloudBoundary } from "./CloudBoundary";
import { cloudAppTitles } from "./cloud-app-title-store";
import { cloudAppIdFromLocation } from "./open-cloud-app-panel";
import { useCloudApps, type CloudAppsState } from "./use-cloud-apps";

function AccountScopedCloudAppsHost({ state }: { state: CloudAppsState }) {
  const openLocation = useSidebarSectionLocation("apps");
  const sidebarTabs = useSidebarOpenTabs();
  const openAppId = cloudAppIdFromLocation(openLocation);
  const appById = useMemo(
    () => new Map(state.apps.map((app) => [app.appId, app])),
    [state.apps],
  );
  const [retainedAppIds, setRetainedAppIds] = useState<readonly string[]>([]);

  useLayoutEffect(() => {
    cloudAppTitles.replace(
      state.accountScope,
      state.phase === "ready" ? state.apps : [],
    );
    return () => cloudAppTitles.clear(state.accountScope);
  }, [state.accountScope, state.apps, state.phase]);

  useEffect(() => {
    if (state.phase !== "ready") return;
    const validIds = new Set(state.apps.map((app) => app.appId));
    const staleTabIds = sidebarTabs
      .filter((tab) => {
        if (tab.kind !== "apps") return false;
        const appId = cloudAppIdFromLocation(tab.location);
        return appId !== null && !validIds.has(appId);
      })
      .map((tab) => tab.id);
    for (const tabId of staleTabIds) sidebarSections.closeTab(tabId);
  }, [sidebarTabs, state.apps, state.phase]);

  useEffect(() => {
    if (state.phase !== "ready") return;
    setRetainedAppIds((current) => {
      const valid = current.filter((appId) => appById.has(appId));
      if (!openAppId || !appById.has(openAppId)) return valid;
      return [...valid.filter((appId) => appId !== openAppId), openAppId];
    });
  }, [appById, openAppId, state.phase]);

  if (openAppId && state.phase !== "ready") {
    return (
      <div className="persistent-cloud-app-surface persistent-cloud-app-surface--active">
        <div
          className="persistent-user-app-status"
          role={state.phase === "error" ? "alert" : "status"}
        >
          <strong>
            {state.phase === "error"
              ? "Cloud apps are unavailable"
              : "Opening cloud app…"}
          </strong>
          {state.error ? <span>{state.error}</span> : null}
        </div>
      </div>
    );
  }

  return (
    <>
      {retainedAppIds.map((appId) => {
        const app = appById.get(appId);
        if (!app) return null;
        const active = openAppId === appId;
        return (
          <div
            key={appId}
            className={`persistent-cloud-app-surface${
              active ? " persistent-cloud-app-surface--active" : ""
            }`}
            aria-hidden={!active}
            inert={!active}
          >
            <CloudBoundary
              fallback={
                <div className="persistent-user-app-status" role="alert">
                  <strong>Cloud app unavailable</strong>
                  <span>Close this tab and try opening it again.</span>
                </div>
              }
            >
              <CloudAppPanel slug={app.slug} />
            </CloudBoundary>
          </div>
        );
      })}
    </>
  );
}

export function PersistentCloudAppsHost() {
  const state = useCloudApps();
  return (
    <AccountScopedCloudAppsHost key={state.accountScope} state={state} />
  );
}

