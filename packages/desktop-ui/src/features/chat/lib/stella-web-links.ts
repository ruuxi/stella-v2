import type { ElectronBrowserViewApi } from "@/shared/types/electron";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { displayTabs } from "@/features/workspace-display/tab-store";

/**
 * Chat markdown links are Stella-browser destinations, not OS-browser ones:
 * an unmodified primary click hands the URL to the in-app browser section so
 * the page stays inside the workspace. Modifier and middle clicks keep the
 * anchor's native behaviour (Electron's external-link handlers own those).
 */
type WebLinkBrowserApi = Pick<
  ElectronBrowserViewApi,
  "createTab" | "getState" | "selectTab"
>;

type LinkClick = {
  altKey: boolean;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

export const normalizedHttpUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
};

export const isUnmodifiedPrimaryClick = (event: LinkClick): boolean =>
  event.button === 0 &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey;

const revealBrowserSection = () => {
  const existing = sidebarSections
    .getSnapshot()
    .tabs.find((tab) => tab.kind === "browser");
  if (existing) {
    sidebarSections.activateTab(existing.id);
    displayTabs.setPanelOpen(true);
    return;
  }
  sidebarSections.openLocation("browser", null);
};

export const openUrlInStellaBrowser = async (
  value: string,
  api: WebLinkBrowserApi,
): Promise<boolean> => {
  const url = normalizedHttpUrl(value);
  if (!url) return false;

  revealBrowserSection();
  const state = await api.getState();
  const existing = state.tabs.find((tab) => tab.url === url);
  if (existing) {
    await api.selectTab({
      tabId: existing.id,
      ownerId: existing.ownerId,
      activate: true,
    });
  } else {
    await api.createTab({
      url,
      ownerId: state.visibleOwnerId,
      activate: true,
    });
  }
  return true;
};
