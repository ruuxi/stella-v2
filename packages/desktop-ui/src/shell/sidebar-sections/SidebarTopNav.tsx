/**
 * The right-sidebar top bar's navigation, browser-tab style.
 *
 * Instead of a fixed row of tabs, it shows WHATEVER destination you're
 * currently on (icon + name), an optional back affordance when a section is
 * drilled into a sub-item, and a "+" that opens the Home launcher to pick a
 * new destination — like opening a new browser tab.
 */
import {
  sidebarSections,
  useActiveSidebarSection,
  useSidebarSectionLocation,
} from "@/features/workspace-display/sidebar-sections";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
import { ChevronLeft, Plus } from "@/ui/icons";
import { SIDEBAR_SECTION_META } from "./section-meta";
import "./sidebar-top-nav.css";

export function SidebarTopNav() {
  const activeSection = useActiveSidebarSection();
  const panelOpen = useDisplayPanelOpen();
  const filesLocation = useSidebarSectionLocation("files");
  const appsLocation = useSidebarSectionLocation("apps");
  const { label, Icon } = SIDEBAR_SECTION_META[activeSection];

  // Files and Apps can drill into a sub-item (an open file / running app).
  // The back-to-list affordance lives here now — the in-body section headers
  // are gone (superseded by this top-bar model).
  const drilledSection =
    activeSection === "files" && filesLocation
      ? "files"
      : activeSection === "apps" && appsLocation
        ? "apps"
        : null;

  return (
    <div className="sidebar-top-nav">
      {drilledSection ? (
        <button
          type="button"
          className="sidebar-top-nav__back"
          onClick={() => sidebarSections.clearLocation(drilledSection)}
          aria-label={`Back to ${label}`}
          title={`Back to ${label}`}
        >
          <ChevronLeft size={16} strokeWidth={1.9} aria-hidden="true" />
        </button>
      ) : null}
      <span className="sidebar-top-nav__current">
        <span className="sidebar-top-nav__icon" aria-hidden="true">
          <Icon size={15} strokeWidth={1.75} />
        </span>
        <span className="sidebar-top-nav__label">{label}</span>
      </span>
      {activeSection !== "home" ? (
        <button
          type="button"
          className="sidebar-top-nav__new"
          onClick={() => sidebarSections.openHomeLauncher()}
          aria-label="Open Home to switch views"
          title="Home"
          disabled={!panelOpen}
        >
          <Plus size={16} strokeWidth={1.9} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
