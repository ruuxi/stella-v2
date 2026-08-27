import type { CloudApp } from "./cloud-api";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";

const CLOUD_APP_LOCATION_PREFIX = "cloud:";

export const cloudAppLocation = (appId: string): string =>
  `${CLOUD_APP_LOCATION_PREFIX}${appId}`;

export const cloudAppIdFromLocation = (location: string | null): string | null => {
  if (!location?.startsWith(CLOUD_APP_LOCATION_PREFIX)) return null;
  const appId = location.slice(CLOUD_APP_LOCATION_PREFIX.length).trim();
  return appId || null;
};

export const isCloudAppLocation = (location: string | null): boolean =>
  cloudAppIdFromLocation(location) !== null;

export const openCloudAppPanel = (
  app: Pick<CloudApp, "appId">,
): void => {
  sidebarSections.openLocation("apps", cloudAppLocation(app.appId));
};

export const closeCloudAppPanel = (appId: string): void => {
  const location = cloudAppLocation(appId);
  const matchingTabs = sidebarSections
    .getSnapshot()
    .tabs.filter((tab) => tab.kind === "apps" && tab.location === location);
  for (const tab of matchingTabs) sidebarSections.closeTab(tab.id);
};

