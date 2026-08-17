import {
  displayTabs,
  useDisplayPanelExpanded,
  useDisplayPanelOpen,
} from "@/features/workspace-display/tab-store";
import { displaySearchStore } from "@/features/workspace-display/display-search-store";
import { getPlatform } from "@/platform/electron/platform";
import { SidebarTopNav } from "@/shell/sidebar-sections/SidebarTopNav";
import { SettingsMenuButton } from "@/shell/SettingsMenuButton";
import { PanelRight } from "@/ui/icons";
import { useT } from "@/shared/i18n";

export function DisplayPanelTopBar() {
  const t = useT();
  const panelOpen = useDisplayPanelOpen();
  const panelExpanded = useDisplayPanelExpanded();
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWin = platform === "win32";

  return (
    <header
      className="display-panel-topbar"
      data-platform={isMac ? "mac" : isWin ? "win" : "other"}
      data-display-open={panelOpen ? "true" : "false"}
      data-display-expanded={panelExpanded ? "true" : "false"}
      aria-hidden={!panelOpen}
      inert={!panelOpen}
    >
      <div className="display-panel-topbar__tabs">
        <SidebarTopNav />
      </div>
      <SettingsMenuButton
        className="shell-topbar-account-settings"
        showActiveState={panelOpen}
      />
      <button
        type="button"
        className="shell-topbar-icon-btn"
        onClick={() => {
          if (panelOpen) displaySearchStore.close();
          displayTabs.setPanelOpen(!panelOpen);
        }}
        aria-label={
          panelOpen
            ? t("shell.displayPanel.closePanel")
            : t("shell.displayPanel.openPanel")
        }
        aria-expanded={panelOpen}
        title={
          panelOpen
            ? t("shell.displayPanel.closePanel")
            : t("shell.displayPanel.openPanel")
        }
      >
        <PanelRight size={16} strokeWidth={1.75} />
      </button>
    </header>
  );
}
