/**
 * The right-sidebar top bar's navigation — a genuine browser-tab strip.
 *
 * Each open destination is its own tab (Home launcher, Quick chat, Files, Apps,
 * Browser). Tabs coexist: click to switch, X to close, and "+" opens a NEW
 * empty Home tab alongside whatever you already had open (it never replaces the
 * current view). The selected-tab styling mirrors the main chat's conversation
 * tabs (see `conversation-topbar.css`): overlapping borders with the active tab
 * going borderless/transparent so it melts into the panel below.
 *
 * A drilled-in tab (an open file / running app) keeps a back affordance in the
 * top bar; re-clicking the active tab also returns it to its list.
 */
import {
  sidebarSections,
  useActiveSidebarSection,
  useSidebarOpenTabs,
  useSidebarSectionLocation,
} from "@/features/workspace-display/sidebar-sections";
import { ChevronLeft, Plus, X } from "@/ui/icons";
import { SIDEBAR_SECTION_META } from "./section-meta";
import "./sidebar-top-nav.css";

export function SidebarTopNav() {
  const openTabs = useSidebarOpenTabs();
  const activeSection = useActiveSidebarSection();
  const filesLocation = useSidebarSectionLocation("files");
  const appsLocation = useSidebarSectionLocation("apps");

  // Files and Apps can drill into a sub-item (an open file / running app); the
  // back-to-list affordance for the active tab lives here.
  const drilledSection =
    activeSection === "files" && filesLocation
      ? "files"
      : activeSection === "apps" && appsLocation
        ? "apps"
        : null;
  const activeMeta = SIDEBAR_SECTION_META[activeSection];

  return (
    <div className="sidebar-top-nav">
      {drilledSection ? (
        <button
          type="button"
          className="sidebar-top-nav__back"
          onClick={() => sidebarSections.clearLocation(drilledSection)}
          aria-label={`Back to ${activeMeta.label}`}
          title={`Back to ${activeMeta.label}`}
        >
          <ChevronLeft size={16} strokeWidth={1.9} aria-hidden="true" />
        </button>
      ) : null}
      <div className="sidebar-top-nav__tabs" role="tablist" aria-label="Sidebar">
        {openTabs.map((section) => {
          const { label, Icon } = SIDEBAR_SECTION_META[section];
          const active = section === activeSection;
          return (
            <div
              key={section}
              className="sidebar-top-nav__tab"
              data-active={active ? "true" : undefined}
              title={label}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="sidebar-top-nav__tab-target"
                onClick={() => sidebarSections.activateTab(section)}
              >
                <span className="sidebar-top-nav__tab-icon" aria-hidden="true">
                  <Icon size={15} strokeWidth={1.75} />
                </span>
                <span className="sidebar-top-nav__tab-label">{label}</span>
              </button>
              <button
                type="button"
                className="sidebar-top-nav__tab-close"
                aria-label={`Close ${label}`}
                title={`Close ${label}`}
                onClick={() => sidebarSections.closeTab(section)}
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
