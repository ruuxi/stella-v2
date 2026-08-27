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
