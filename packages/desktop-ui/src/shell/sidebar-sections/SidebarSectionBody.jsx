/**
 * Renders the panel body for the open sidebar tabs (browser-tab model).
 *
 * Files, Quick chat and Home are genuinely per-item: each open tab of those
 * kinds gets its OWN mounted instance (its file viewer, its ephemeral
 * conversation, its launcher), so multiple can coexist and keep their state.
 * Every instance stays mounted and only the active one is visible — that is
 * load-bearing, not an optimization: a Files tab hosts canvas iframes whose
 * browsing context is destroyed by an unmount.
 *
 * Apps and Browser are shared singletons — a running app process and the single
 * embedded browser webview can't be duplicated per tab — so one instance of
 * each renders the ACTIVE apps/browser tab's item. (See report notes.)
 */
import {
  useActiveSidebarSection,
  useSidebarActiveTabId,
  useSidebarOpenTabs,
} from "@/features/workspace-display/sidebar-sections";
import { AppsSection } from "./AppsSection";
import { BrowserSection } from "./BrowserSection";
import { FilesSection } from "./FilesSection";
import { HomeLauncherSection } from "./HomeLauncherSection";
import { QuickChatSection } from "./QuickChatSection";
import "./sidebar-sections.css";

const PER_ITEM_BODIES = {
  files: FilesSection,
  quickchat: QuickChatSection,
  home: HomeLauncherSection,
};

function SectionHost({ section, active, children }) {
  return (
    <div
      className="sidebar-section"
      data-section={section}
      data-active={active ? "true" : undefined}
      role="tabpanel"
      aria-hidden={!active}
      inert={!active}
    >
      {children}
    </div>
  );
}

export function SidebarSectionBody() {
  const tabs = useSidebarOpenTabs();
  const activeTabId = useSidebarActiveTabId();
  const activeSection = useActiveSidebarSection();
  const appsActive = activeSection === "apps";
  const browserActive = activeSection === "browser";

  return (
    <>
      {tabs.map((tab) => {
        const Body = PER_ITEM_BODIES[tab.kind];
        if (!Body) return null; // apps / browser handled by shared instances
        return (
          <SectionHost
            key={tab.id}
            section={tab.kind}
            active={tab.id === activeTabId}
          >
            <Body location={tab.location} active={tab.id === activeTabId} />
          </SectionHost>
        );
      })}
      {/* Shared singletons: one apps host + one embedded browser. They render
          whichever apps/browser tab is active (the active tab's slug / empty
          browser); switching between apps/browser tabs re-points them. */}
      <SectionHost section="apps" active={appsActive}>
        <AppsSection />
      </SectionHost>
      <SectionHost section="browser" active={browserActive}>
        <BrowserSection />
      </SectionHost>
    </>
  );
}
