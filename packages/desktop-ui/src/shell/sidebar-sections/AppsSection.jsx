import { useEffect, useState, useSyncExternalStore } from "react";
import { PersistentUserAppsHost } from "@/app/apps/PersistentUserAppsHost";
import { listUserApps, useRequestUserApp, } from "@/app/apps/user-app-library";
import { getServerSnapshot, getSnapshot, refreshUserApps, stopUserApp, subscribe, } from "@/app/apps/user-apps-registry";
import { markAllUserAppsSeen } from "@/app/apps/new-user-apps-hint";
import { sidebarSections, useActiveSidebarSection, useSidebarOpenTabs, useSidebarSectionLocation, } from "@/features/workspace-display/sidebar-sections";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
import { AppWindowMac, LoaderCircle, Power } from "@/ui/icons";
import "./apps-section.css";
export function AppsSection() {
    const registry = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
    const apps = registry.apps;
    const openSlug = useSidebarSectionLocation("apps");
    const sidebarTabs = useSidebarOpenTabs();
    const activeSection = useActiveSidebarSection();
    const panelOpen = useDisplayPanelOpen();
    const openApp = openSlug
        ? (apps.find((app) => app.slug === openSlug) ?? null)
        : null;
    useEffect(() => {
        if (registry.phase !== "ready")
            return;
        const installedSlugs = new Set(apps.map((app) => app.slug));
        const removedTabIds = sidebarTabs
            .filter((tab) => tab.kind === "apps" && tab.location && !installedSlugs.has(tab.location))
            .map((tab) => tab.id);
        for (const tabId of removedTabIds)
            sidebarSections.closeTab(tabId);
    }, [apps, registry.phase, sidebarTabs]);

    const listVisible = panelOpen && activeSection === "apps" && !openApp;
    useEffect(() => {
        if (listVisible)
            markAllUserAppsSeen();
    }, [apps, listVisible]);
    return (<>
      {
}
      <div className="apps-section__body">
        {openApp ? null : <AppsLibrary registry={registry}/>}
        <PersistentUserAppsHost />
      </div>
    </>);
}
function AppsLibrary({ registry }) {
    const requestUserApp = useRequestUserApp();
    const [stoppingSlugs, setStoppingSlugs] = useState(() => new Set());
    const { apps, error, phase, refreshing } = registry;
    const shutDown = async (slug) => {
        setStoppingSlugs((current) => new Set(current).add(slug));
        try {
            await stopUserApp(slug);
        }
        catch {

        }
        finally {
            setStoppingSlugs((current) => {
                const next = new Set(current);
                next.delete(slug);
                return next;
            });
        }
    };
    if (phase === "loading" && apps.length === 0) {
        return (<div className="apps-section__library apps-section__library--status" role="status" aria-live="polite">
        <LoaderCircle className="stella-loader-circle" size={18} strokeWidth={2} aria-hidden="true"/>
        <p>Loading apps…</p>
      </div>);
    }
    if (phase === "unsupported") {
        return (<div className="apps-section__library sidebar-section__empty" role="status">
        <span className="sidebar-section__empty-icon" aria-hidden="true">
          <AppWindowMac size={17} strokeWidth={1.75}/>
        </span>
        <p className="sidebar-section__empty-title">Apps live on desktop</p>
        <p className="sidebar-section__empty-body">
          Open Stella on your computer to use locally installed apps.
        </p>
      </div>);
    }
    if (phase === "error" && apps.length === 0) {
        return (<div className="apps-section__library sidebar-section__empty" role="alert">
        <span className="sidebar-section__empty-icon" aria-hidden="true">
          <AppWindowMac size={17} strokeWidth={1.75}/>
        </span>
        <p className="sidebar-section__empty-title">Couldn’t load apps</p>
        <p className="sidebar-section__empty-body">
          {error || "Stella couldn’t read your apps folder."}
        </p>
        <button type="button" className="pill-btn" onClick={() => void refreshUserApps()}>
          Try again
        </button>
      </div>);
    }
    if (apps.length === 0) {
        return (<div className="apps-section__library sidebar-section__empty">
        <span className="sidebar-section__empty-icon" aria-hidden="true">
          <AppWindowMac size={17} strokeWidth={1.75}/>
        </span>
        <p className="sidebar-section__empty-title">No apps yet</p>
        <p className="sidebar-section__empty-body">
          Ask Stella to build a small app. It will show up here.
        </p>
        <button type="button" className="pill-btn" onClick={requestUserApp}>
          Ask Stella to create an app
        </button>
      </div>);
    }
    const visible = listUserApps(apps, "", "recent");
    return (<div className="apps-section__library">
      {phase === "error" ? (<div className="apps-section__warning" role="status">
          <span>Apps may be out of date.</span>
          <button type="button" onClick={() => void refreshUserApps()}>
            Try again
          </button>
        </div>) : null}
      <ul className="apps-section__grid sidebar-section__scroll">
        {visible.map((app) => {
            const stopping = stoppingSlugs.has(app.slug) || app.status === "stopping";
            const running = app.status === "running";
            return (<li key={app.slug} className="apps-section__card">
            <button type="button" className={`apps-section__card-open${running || stopping ? " apps-section__card-open--with-runtime" : ""}`} onClick={() => sidebarSections.openLocation("apps", app.slug)}>
              <AppWindowMac className="apps-section__card-icon" size={16} strokeWidth={1.7} aria-hidden="true"/>
              <span className="apps-section__card-label">{app.meta.label}</span>
            </button>
            {running || stopping ? (<div className="apps-section__card-runtime">
                <span className="apps-section__card-status">
                  {stopping ? "Stopping" : "On"}
                </span>
                <button type="button" className="apps-section__shutdown" aria-label={`Shut down ${app.meta.label}`} title="Shut down" disabled={stopping} onClick={() => void shutDown(app.slug)}>
                  <Power size={15} strokeWidth={1.8} aria-hidden="true"/>
                </button>
              </div>) : null}
          </li>);
        })}
      </ul>

      <div className="apps-section__footer" aria-busy={refreshing || undefined}>
        <button type="button" className="pill-btn" onClick={requestUserApp}>
          Create an app
        </button>
      </div>
    </div>);
}
