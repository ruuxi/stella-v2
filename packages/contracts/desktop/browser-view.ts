import type { StellaBrowserBridgeFailureReason } from "../browser-bridge-status.js";

/** The in-app browser view (Electron `WebContentsView` tabs) as the renderer sees it. */

export type BrowserViewConnection = "checking" | "disconnected" | "connected";

export type BrowserViewUnavailableReason =
  | "extension_not_installed"
  | "extension_disconnected"
  | StellaBrowserBridgeFailureReason;

export type BrowserViewTabState = {
  id: string;
  ownerId: string;
  url: string;
  title: string;
  faviconUrl?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type BrowserViewOwnerState = {
  id: string;
  kind: "manual" | "agent";
  tabCount: number;
  activeTabId?: string;
  latest: boolean;
};

export type BrowserViewState = {
  connection: BrowserViewConnection;
  profileName?: string;
  visibleOwnerId: string;
  owners: BrowserViewOwnerState[];
  tabs: BrowserViewTabState[];
  activeTabId?: string;
  error?: string;
  unavailableReason?: BrowserViewUnavailableReason;
};

export type BrowserViewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserViewLayout = {
  pageBounds: BrowserViewBounds;
  surfaceBounds: BrowserViewBounds;
};

/** A cookie as the Stella browser extension exports it (Chrome's cookie shape). */
export type StellaBrowserExportedCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
  session: boolean;
  storeId: string;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  expirationDate?: number;
  partitionKey?: {
    topLevelSite?: string;
    hasCrossSiteAncestor?: boolean;
  };
  [key: string]: unknown;
};
