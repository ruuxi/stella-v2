import { useEffect, useRef } from "react";
import {
  sidebarSections,
  useSidebarOpenTabs,
} from "@/features/workspace-display/sidebar-sections";
import { useDisplayTabList } from "@/features/workspace-display/tab-store";
import type { DisplayTab } from "@/features/workspace-display/types";

export function FileSidebarTabExistenceReconciler() {
  const sidebarTabs = useSidebarOpenTabs();
  const { tabs } = useDisplayTabList() as { tabs: DisplayTab[] };
  const previousDisplayTabIds = useRef(
    new Set(tabs.map((tab) => tab.id)),
  );

  useEffect(() => {
    const nextDisplayTabIds = new Set(tabs.map((tab) => tab.id));
    const removedDisplayTabIds = new Set(
      [...previousDisplayTabIds.current].filter(
        (id) => !nextDisplayTabIds.has(id),
      ),
    );
    previousDisplayTabIds.current = nextDisplayTabIds;

    if (removedDisplayTabIds.size === 0) return;
    const removedSidebarTabIds = sidebarTabs
      .filter(
        (tab) =>
          tab.kind === "files" &&
          tab.location !== null &&
          removedDisplayTabIds.has(tab.location),
      )
      .map((tab) => tab.id);
    for (const tabId of removedSidebarTabIds) {
      sidebarSections.closeTab(tabId);
    }
  }, [sidebarTabs, tabs]);

  return null;
}
