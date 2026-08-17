/**
 * Home — the right sidebar's empty-state launcher (the browser-tab "new tab").
 *
 * It keeps the shared search field at the top (owned here; results render in
 * place) and, when nothing is being searched, offers a vertically-centered
 * list of destinations: Quick chat, Files, Apps, Browser. Picking one swaps
 * the panel to that section, mirroring opening a new browser tab.
 */
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { WorkList } from "./FilesSection";
import { HOME_LAUNCHER_SECTIONS, SIDEBAR_SECTION_META } from "./section-meta";
import "./home-launcher.css";

function LauncherOptions() {
  return (
    <div className="home-launcher">
      <ul className="home-launcher__list">
        {HOME_LAUNCHER_SECTIONS.map((section) => {
          const { label, Icon } = SIDEBAR_SECTION_META[section];
          return (
            <li key={section}>
              <button
                type="button"
                className="home-launcher__option"
                onClick={() => sidebarSections.selectSection(section)}
              >
                <span className="home-launcher__option-icon" aria-hidden="true">
                  <Icon size={18} strokeWidth={1.75} />
                </span>
                <span className="home-launcher__option-label">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function HomeLauncherSection() {
  return (
    <div className="work-section">
      <div className="work-section__body">
        <WorkList section="home" idleContent={<LauncherOptions />} />
      </div>
    </div>
  );
}
