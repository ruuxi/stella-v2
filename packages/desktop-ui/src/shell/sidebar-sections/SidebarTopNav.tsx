/**
 * The right-sidebar top bar's navigation — a genuine per-ITEM browser-tab strip.
 *
 * Each open item is its own tab and is titled by WHAT IT SHOWS, not the generic
 * surface: a file tab shows the file name, an app tab the app's name, quick chat
 * "Quick chat", the empty launcher "Home", and the (shared) browser "Browser".
 * Click a tab to switch, X to close, and "+" opens a NEW empty Home tab.
 *
 * Selected-tab styling mirrors the main chat's conversation tabs
 * (`shell/topbar/conversation-topbar.css`): overlapping borders with the active
 * tab going borderless/transparent so it melts into the panel below.
 */
import { useSyncExternalStore } from "react";
import {
  sidebarSections,
  useSidebarActiveTabId,
  useSidebarOpenTabs,
  type SidebarTab,
} from "@/features/workspace-display/sidebar-sections";
import { useDisplayTabList } from "@/features/workspace-display/tab-store";
import type { DisplayTab } from "@/features/workspace-display/types";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import {
  getServerSnapshot as getUserAppsServerSnapshot,
  getSnapshot as getUserAppsSnapshot,
  subscribe as subscribeToUserApps,
} from "@/app/apps/user-apps-registry";
import { cloudAppTitles } from "@/features/cloud/cloud-app-title-store";
import { cloudAppIdFromLocation } from "@/features/cloud/open-cloud-app-panel";
import { Plus, X } from "@/ui/icons";
import { SIDEBAR_SECTION_META } from "./section-meta";
import "./sidebar-top-nav.css";

export function SidebarTopNav() {
  const tabs = useSidebarOpenTabs();
  const activeTabId = useSidebarActiveTabId();
  // `tab-store` is untyped JS (tabs infer as `never[]`); type the entries.
  const { tabs: displayTabs } = useDisplayTabList() as { tabs: DisplayTab[] };
  const appsRegistry = useSyncExternalStore(
    subscribeToUserApps,
    getUserAppsSnapshot,
    getUserAppsServerSnapshot,
  );
  const cloudTitles = useSyncExternalStore(
    cloudAppTitles.subscribe,
    cloudAppTitles.getSnapshot,
    cloudAppTitles.getSnapshot,
  ).titles;

  const titleFor = (tab: SidebarTab): string => {
    switch (tab.kind) {
      case "quickchat":
        return "Quick chat";
      case "browser":
        return "Browser";
      case "takeover":
        return "Sign in";
      case "home":
        return "Home";
      case "apps": {
        if (!tab.location) return "Apps";
        const cloudAppId = cloudAppIdFromLocation(tab.location);
        if (cloudAppId) return cloudTitles[cloudAppId] || "Cloud app";
        const app = appsRegistry.apps.find((a) => a.slug === tab.location);
        return app?.meta.label || tab.location;
      }
      case "files": {
        if (!tab.location) return "Files";
        const displayTab = displayTabs.find((d) => d.id === tab.location);
        return displayTab?.title || "File";
      }
    }
  };

  const renderIcon = (tab: SidebarTab) => {
    if (tab.kind === "files" && tab.location) {
      const displayTab = displayTabs.find((d) => d.id === tab.location);
      if (displayTab) return <DisplayTabIcon kind={displayTab.kind} size={15} />;
    }
    const { Icon } = SIDEBAR_SECTION_META[tab.kind];
    return <Icon size={15} strokeWidth={1.75} />;
  };

  return (
    <div className="sidebar-top-nav">
      <div className="sidebar-top-nav__tabs" role="tablist" aria-label="Sidebar">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const title = titleFor(tab);
          return (
            <div
              key={tab.id}
              className="sidebar-top-nav__tab"
              data-active={active ? "true" : undefined}
              title={title}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="sidebar-top-nav__tab-target"
                onClick={() => sidebarSections.activateTab(tab.id)}
              >
                <span className="sidebar-top-nav__tab-icon" aria-hidden="true">
                  {renderIcon(tab)}
                </span>
                <span className="sidebar-top-nav__tab-label">{title}</span>
              </button>
              <button
                type="button"
                className="sidebar-top-nav__tab-close"
                aria-label={`Close ${title}`}
                title={`Close ${title}`}
                onClick={() => sidebarSections.closeTab(tab.id)}
              >
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="sidebar-top-nav__plus"
        onClick={() => sidebarSections.openHomeLauncher()}
        aria-label="New tab"
        title="New tab"
      >
        <Plus size={16} strokeWidth={1.9} aria-hidden="true" />
      </button>
    </div>
  );
}
