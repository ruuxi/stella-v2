import {
  useActiveSidebarSection,
  useSidebarActiveTabId,
  useSidebarOpenTabs,
} from "@/features/workspace-display/sidebar-sections";
import { AppsSection } from "./AppsSection";
import { BrowserSection } from "./BrowserSection";
import { FileSidebarTabExistenceReconciler } from "./FileSidebarTabExistenceReconciler";
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
      <FileSidebarTabExistenceReconciler />
      {tabs.map((tab) => {
        const Body = PER_ITEM_BODIES[tab.kind];
        if (!Body) return null;
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
      {

}
      <SectionHost section="apps" active={appsActive}>
        <AppsSection />
      </SectionHost>
      <SectionHost section="browser" active={browserActive}>
        <BrowserSection />
      </SectionHost>
    </>
  );
}
