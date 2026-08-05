import { displayTabs, useDisplayPanelExpanded, useDisplayPanelOpen, } from "@/features/workspace-display/tab-store";
import { displaySearchStore } from "@/features/workspace-display/display-search-store";
import { getPlatform } from "@/platform/electron/platform";
import { SidebarTabRail } from "@/shell/sidebar-sections/SidebarTabRail";
import { SettingsMenuButton } from "@/shell/SettingsMenuButton";
import { WindowControls } from "@/shell/WindowControls";
import { PanelRight } from "@/ui/icons";
export function DisplayPanelTopBar() {
    const panelOpen = useDisplayPanelOpen();
    const panelExpanded = useDisplayPanelExpanded();
    const platform = getPlatform();
    const isMac = platform === "darwin";
    const isWin = platform === "win32";
    return (<header className="display-panel-topbar" data-platform={isMac ? "mac" : isWin ? "win" : "other"} data-display-open={panelOpen ? "true" : "false"} data-display-expanded={panelExpanded ? "true" : "false"} aria-hidden={!panelOpen} inert={!panelOpen}>
      <div className="display-panel-topbar__tabs">
        <SidebarTabRail />
      </div>
      <SettingsMenuButton className="shell-topbar-account-settings" showActiveState={panelOpen}/>
      <button type="button" className="shell-topbar-icon-btn" onClick={() => {
            if (panelOpen)
                displaySearchStore.close();
            displayTabs.setPanelOpen(!panelOpen);
        }} aria-label={panelOpen ? "Close panel" : "Open panel"} aria-expanded={panelOpen} title={panelOpen ? "Close panel" : "Open panel"}>
        <PanelRight size={16} strokeWidth={1.75}/>
      </button>
      {isWin ? <WindowControls useWindowsIcons hidden={false}/> : null}
    </header>);
}
