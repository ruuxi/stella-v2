export type RecentApp = {

  name: string;

  bundleId?: string;

  pid: number;

  isActive: boolean;

  windowTitle?: string;

  iconDataUrl?: string;
};

export type ListRecentAppsResult = {
  apps: RecentApp[];
};

export type ActiveBrowserTab = {

  browser: string;

  bundleId?: string;

  url: string;

  title?: string;
};

export type GetActiveBrowserTabResult = {
  tab: ActiveBrowserTab | null;
};
