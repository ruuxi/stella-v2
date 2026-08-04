import { useEffect } from "react";
import { STELLA_CLOSE_PANEL_EVENT, STELLA_OPEN_WORKSPACE_PANEL_EVENT, STELLA_OPEN_PANEL_CHAT_EVENT, } from "@/shared/lib/stella-orb-chat";
import { displayTabs } from "@/features/workspace-display/tab-store";
/**
 * Window-event + IPC wiring for the workspace panel. Subscribes to:
 * - `STELLA_OPEN_PANEL_CHAT_EVENT` — open the chat tab
 * - `STELLA_CLOSE_PANEL_EVENT` — close the panel
 * - `STELLA_OPEN_WORKSPACE_PANEL_EVENT` — manual open; opens the
 *   route-aware default surface (Home launcher on home, chat elsewhere).
 * - `electronAPI.ui.onOpenChatSidebar` — IPC equivalent of "open chat tab".
 */
export function useWorkspacePanelEvents({ rightSidebarRef, latestDisplayPayloadRef, openChatPanel, openDefaultPanelSurface, }) {
    useEffect(() => {
        const handleOpen = (event) => {
            const detail = event.detail;
            openChatPanel(detail ?? {});
        };
        const handleClose = () => displayTabs.setPanelOpen(false);
        const handleOpenDisplay = () => {
            openDefaultPanelSurface();
        };
        window.addEventListener(STELLA_OPEN_PANEL_CHAT_EVENT, handleOpen);
        window.addEventListener(STELLA_CLOSE_PANEL_EVENT, handleClose);
        window.addEventListener(STELLA_OPEN_WORKSPACE_PANEL_EVENT, handleOpenDisplay);
        const cleanupIpcOpen = window.electronAPI?.ui.onOpenChatSidebar?.(() => {
            openChatPanel();
        });
        return () => {
            window.removeEventListener(STELLA_OPEN_PANEL_CHAT_EVENT, handleOpen);
            window.removeEventListener(STELLA_CLOSE_PANEL_EVENT, handleClose);
            window.removeEventListener(STELLA_OPEN_WORKSPACE_PANEL_EVENT, handleOpenDisplay);
            cleanupIpcOpen?.();
        };
    }, [
        rightSidebarRef,
        latestDisplayPayloadRef,
        openChatPanel,
        openDefaultPanelSurface,
    ]);
}
