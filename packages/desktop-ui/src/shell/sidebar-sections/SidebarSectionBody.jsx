/**
 * Renders whichever panel-owned sidebar section is active.
 *
 * Every section is mounted for the lifetime of the panel and hidden with
 * `display: none` rather than unmounted. That is load-bearing, not an
 * optimization: the Files section hosts canvas iframes whose browsing context
 * is destroyed by an unmount, and the Apps section hosts live user apps whose
 * whole point is that they keep running. Switching tabs must not cost either
 * of them their state, and neither must closing the panel — which is why the
 * hidden host stays mounted even when `panelOpen` is false.
 */
import { PANEL_SIDEBAR_SECTIONS, useActiveSidebarSection, } from "@/features/workspace-display/sidebar-sections";
import { AppsSection } from "./AppsSection";
import { BrowserSection } from "./BrowserSection";
import { FilesSection } from "./FilesSection";
import { HomeLauncherSection } from "./HomeLauncherSection";
import { QuickChatSection } from "./QuickChatSection";
import "./sidebar-sections.css";
/**
 * Typed as a total `Record` rather than inferred: adding a section without a
 * body is then a compile error here instead of an `undefined` at render.
 */
const SECTION_BODIES = {
    home: HomeLauncherSection,
    quickchat: QuickChatSection,
    files: FilesSection,
    apps: AppsSection,
    browser: BrowserSection,
};
/**
 * The body for a section id, never `undefined`.
 *
 * A retired/unknown id degrades to the Home launcher, the panel's default.
 */
export const sidebarSectionBody = (section) => SECTION_BODIES[section] ?? HomeLauncherSection;
export function SidebarSectionBody() {
    const activeSection = useActiveSidebarSection();
    return (<>
      {PANEL_SIDEBAR_SECTIONS.map((section) => {
            const Body = sidebarSectionBody(section);
            const active = section === activeSection;
            return (<div key={section} className="sidebar-section" data-section={section} data-active={active ? "true" : undefined} role="tabpanel" aria-hidden={!active} inert={!active}>
            <Body />
          </div>);
        })}
    </>);
}
