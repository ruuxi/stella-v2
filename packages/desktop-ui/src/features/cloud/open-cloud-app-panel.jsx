import { createElement } from "react";
import { displayTabs } from "@/features/workspace-display/tab-store";
import { CloudAppPanel } from "./CloudAppPanel";

const appTabId = (slug) => `cloud-app:${slug}`;

export const openCloudAppPanel = (app, toggleActive = true) => {
  const id = appTabId(app.slug);
  const { activeTabId, panelOpen } = displayTabs.getSnapshot();

  if (toggleActive && activeTabId === id && panelOpen) {
    displayTabs.setPanelOpen(false);
    return;
  }

  displayTabs.openTab({
    id,
    kind: "canvas",
    title: app.title,
    tooltip: app.title,
    render: () => createElement(CloudAppPanel, { slug: app.slug }),
    metadata: {
      appId: app.appId,
      slug: app.slug,
      displayType: "cloud-app",
    },
  });
};

export const closeCloudAppPanel = (slug) => {
  displayTabs.closeTab(appTabId(slug));
};
