import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  BrowserWindow,
  session,
  WebContentsView,
  type Rectangle,
  type Session,
} from "electron";
import {
  importBrowserProfileSnapshot,
  readBrowserHistoryUrls,
  resolveBrowserProfileSelection,
  type BrowserProfileImportResult,
} from "./in-app-browser-profile.js";
import {
  IN_APP_BROWSER_USER_AGENT,
  isAuthOrigin,
  isAuthPermission,
  isAuthPopupUrl,
  isTrustCriticalCookieName,
  shouldAllowAuthDevice,
  shouldPreserveExistingCookie,
} from "./in-app-browser-auth-policy.js";
import type {
  InAppBrowserDebuggerEvent,
  InAppBrowserDebuggerRecovery,
  InAppBrowserDebuggerTarget,
} from "./in-app-browser-cdp-adapter.js";

export type BrowserViewConnection = "checking" | "disconnected" | "connected";

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
};

export type BrowserViewLayout = {
  pageBounds: Rectangle;
  surfaceBounds: Rectangle;
};

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

type ManagedTab = {
  id: string;
  ownerId: string;
  view: WebContentsView;
  title: string;
  faviconUrl?: string;
  loading: boolean;
};

type OwnerTabRegistry = {
  tabIds: Set<string>;
  activeTabId?: string;
};

type DrawableLease = {
  count: number;
  mountedInHiddenHost: boolean;
};

export type InAppBrowserDrawableLease = {
  release: () => void;
};

type InAppBrowserServiceOptions = {
  stellaDataDir: string;
  getWindow: () => BrowserWindow | null;
  ensureBrowserBridgeStarted: () => void | Promise<void>;
  openExtensionStore?: () => void | Promise<void>;
  getExtensionStatus: () => Promise<boolean>;
  exportAllCookies: () => Promise<StellaBrowserExportedCookie[]>;
  exportCookiesForUrls?: (
    urls: string[],
  ) => Promise<StellaBrowserExportedCookie[]>;
  onStateChanged?: (state: BrowserViewState) => void;
  connectionTimeoutMs?: number;
  connectionPollMs?: number;
  automaticConnectionTimeoutMs?: number;
  /** Continuous cookie-mirror cadence (ms). Defaults to 60s; floored at 5s. */
  cookieMirrorIntervalMs?: number;
  /** Min gap between navigation-triggered cookie reseeds (ms). Defaults to 5s. */
  navigationReseedThrottleMs?: number;
  profilePath?: string;
  resolveProfile?: typeof resolveBrowserProfileSelection;
  importProfile?: typeof importBrowserProfileSnapshot;
  sessionFromPath?: typeof session.fromPath;
  createView?: (browserSession: Session) => WebContentsView;
  createDrawableHost?: () => BrowserWindow;
  createId?: () => string;
  wait?: (delayMs: number) => Promise<void>;
  debuggerRecoveryTimeoutMs?: number;
};

const DEFAULT_URL = "about:blank";
const MANUAL_OWNER_ID = "stella:manual";
const DRAWABLE_HOST_BOUNDS: Rectangle = {
  x: -100_000,
  y: -100_000,
  width: 1280,
  height: 720,
};
const DRAWABLE_CDP_METHODS = new Set([
  "Page.captureScreenshot",
  "Page.printToPDF",
]);
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECTION_POLL_MS = 250;
const DEFAULT_DEBUGGER_RECOVERY_TIMEOUT_MS = 1_000;
// Extension wake (MV3 service worker) plus native-host/daemon spawn can take
// several seconds on a cold start. 1.5s was too tight and routinely produced a
// "connected extension but no seed" state; give the first automatic connect a
// more forgiving window. Repeated getState polls also retry the seed, so this
// is only the first-attempt budget.
const DEFAULT_AUTOMATIC_CONNECTION_TIMEOUT_MS = 5_000;
// Continuous cookie mirror: how often, once the initial seed has completed, the
// in-app cookie store is refreshed from the real browser so it never goes
// stale. Background, unref'd, single-flight.
const DEFAULT_COOKIE_MIRROR_INTERVAL_MS = 60_000;
const MIN_COOKIE_MIRROR_INTERVAL_MS = 5_000;
// Reconcile-on-navigation coalescing: skip a navigation-triggered refresh if a
// reseed already ran within this window, so rapid navigations don't each pull a
// full cookie export.
const DEFAULT_NAVIGATION_RESEED_THROTTLE_MS = 5_000;

const cloneState = (state: BrowserViewState): BrowserViewState => ({
  ...state,
  owners: state.owners.map((owner) => ({ ...owner })),
  tabs: state.tabs.map((tab) => ({ ...tab })),
});

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const normalizeWebUrl = (input: string | undefined) => {
  const raw = input?.trim() || DEFAULT_URL;
  if (raw === DEFAULT_URL) return raw;
  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error("Enter a valid web address.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http, https, and about:blank URLs are allowed.");
  }
  return parsed.toString();
};

const isAllowedNavigationUrl = (value: string) => {
  if (value === DEFAULT_URL) return true;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

const normalizeBounds = (bounds: Rectangle): Rectangle => ({
  x: Math.round(Number.isFinite(bounds.x) ? bounds.x : 0),
  y: Math.round(Number.isFinite(bounds.y) ? bounds.y : 0),
  width: Math.max(
    0,
    Math.round(Number.isFinite(bounds.width) ? bounds.width : 0),
  ),
  height: Math.max(
    0,
    Math.round(Number.isFinite(bounds.height) ? bounds.height : 0),
  ),
});

const clampBoundsToWindow = (
  bounds: Rectangle,
  window: BrowserWindow,
): Rectangle => {
  const normalized = normalizeBounds(bounds);
  const [windowWidth, windowHeight] = window.getContentSize();
  const x = Math.min(Math.max(normalized.x, 0), windowWidth);
  const y = Math.min(Math.max(normalized.y, 0), windowHeight);
  return {
    x,
    y,
    width: Math.max(0, Math.min(normalized.width, windowWidth - x)),
    height: Math.max(0, Math.min(normalized.height, windowHeight - y)),
  };
};

const cookieUrl = (cookie: StellaBrowserExportedCookie) => {
  const host = cookie.domain.trim().replace(/^\./, "");
  if (!host || host.includes("/") || host.includes("\0")) return null;
  return `${cookie.secure ? "https" : "http"}://${host}${
    cookie.path?.startsWith("/") ? cookie.path : "/"
  }`;
};

export class InAppBrowserService {
  private readonly options: InAppBrowserServiceOptions;
  private readonly tabs = new Map<string, ManagedTab>();
  private readonly owners = new Map<string, OwnerTabRegistry>();
  private readonly errorsByOwner = new Map<string, string>();
  private readonly drawableLeases = new Map<string, DrawableLease>();
  private readonly debuggerListeners = new Set<
    (event: InAppBrowserDebuggerEvent) => void
  >();
  private readonly profilePath: string;

  private state: BrowserViewState = {
    connection: "checking",
    visibleOwnerId: MANUAL_OWNER_ID,
    owners: [
      {
        id: MANUAL_OWNER_ID,
        kind: "manual",
        tabCount: 0,
        latest: false,
      },
    ],
    tabs: [],
  };
  private browserSession: Session | null = null;
  private profileImport: BrowserProfileImportResult | null = null;
  private initializePromise: Promise<void> | null = null;
  private connectPromise: Promise<BrowserViewState> | null = null;
  private visibleOwnerId = MANUAL_OWNER_ID;
  /**
   * `undefined` preserves the legacy single-owner view, `null` exposes every
   * owner, and a string pins the view to one conversation/session owner.
   */
  private scopedOwnerId: string | null | undefined;
  private latestOwnerId: string | undefined;
  private visible = false;
  private layout: BrowserViewLayout | null = null;
  private attachedView: WebContentsView | null = null;
  private attachedWindow: BrowserWindow | null = null;
  private drawableHost: BrowserWindow | null = null;
  private disposed = false;
  /**
   * True once at least one successful cookie seed has completed. Unlike the
   * old one-shot `seeded` latch, this does NOT block reseeding: freshness is
   * owned by the continuous cookie mirror (`startCookieMirror`), which keeps
   * running after the initial seed. This flag only gates the connection-state
   * fast paths and marks that the mirror may start.
   */
  private hasSeededOnce = false;
  /** Single-flight guard so overlapping reseeds never interleave cookie writes. */
  private reseedInFlight = false;
  /** Background, unref'd timer that drives the continuous cookie mirror. */
  private cookieMirrorTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timestamp (ms) of the last completed reseed, for navigation throttling. */
  private lastReseedAt = 0;
  private pendingPartitionedCookies: StellaBrowserExportedCookie[] = [];
  private connectionError: string | undefined;

  constructor(options: InAppBrowserServiceOptions) {
    this.options = options;
    this.profilePath =
      options.profilePath ??
      path.join(options.stellaDataDir, "browser", "profile-v1");
  }

  async getState(ownerId?: string): Promise<BrowserViewState> {
    const resolvedOwnerId =
      ownerId === undefined ? undefined : this.resolveOwnerId(ownerId);
    if (this.disposed) return this.snapshot(resolvedOwnerId);
    if (this.hasSeededOnce) {
      this.updateConnection("connected");
      return this.snapshot(resolvedOwnerId);
    }
    try {
      const extensionConnected = await this.options.getExtensionStatus();
      // Extension presence is only the first half of connection. Do not claim
      // readiness until profile/cookie seeding and in-app CDP routing finish.
      if (extensionConnected) {
        this.updateConnection("checking");
        // Race fix: the extension is up but we have not seeded yet. Drive the
        // seed now instead of waiting for a manual connect. Because the UI polls
        // getState, an extension that woke up after the first automatic-connect
        // window still gets picked up here on the next poll. connect() dedupes
        // via connectPromise, so concurrent polls collapse to one attempt.
        void this.connect().catch(() => {});
      } else {
        this.updateConnection("disconnected");
      }
    } catch {
      // The bridge socket commonly isn't ready during app startup. That is a
      // normal disconnected state, not a fatal Browser-tab error.
      this.updateConnection("disconnected");
    }
    return this.snapshot(resolvedOwnerId);
  }

  async requestExtensionConnect(): Promise<BrowserViewState> {
    if (this.disposed) throw new Error("The in-app browser has been closed.");
    if (this.hasSeededOnce) {
      this.updateConnection("connected");
      return this.snapshot();
    }
    this.updateConnection("checking");
    try {
      await this.options.ensureBrowserBridgeStarted();
      let connected = false;
      try {
        connected = await this.options.getExtensionStatus();
      } catch {
        // Daemon startup races the first status probe; poll below.
      }
      if (connected) {
        this.updateConnection("checking");
        return this.snapshot();
      }
      await this.options.openExtensionStore?.();
      const timeoutMs =
        this.options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
      const pollMs =
        this.options.connectionPollMs ?? DEFAULT_CONNECTION_POLL_MS;
      if (await this.pollExtensionStatus(timeoutMs, pollMs)) {
        this.updateConnection("checking");
        return this.snapshot();
      }
      this.updateConnection(
        "disconnected",
        "Connect the Stella browser extension to continue.",
      );
    } catch (error) {
      this.updateConnection("disconnected", errorMessage(error));
    }
    return this.snapshot();
  }

  connect(
    options: {
      browserType?: string;
      profileId?: string;
    } = {},
  ): Promise<BrowserViewState> {
    if (this.connectPromise) return this.connectPromise;
    const promise = this.connectInternal(options).finally(() => {
      if (this.connectPromise === promise) this.connectPromise = null;
    });
    this.connectPromise = promise;
    return promise;
  }

  private async connectInternal(options: {
    browserType?: string;
    profileId?: string;
  }): Promise<BrowserViewState> {
    if (this.hasSeededOnce) {
      this.updateConnection("connected");
      return this.snapshot();
    }
    try {
      await this.options.ensureBrowserBridgeStarted();
      const connected = await this.pollExtensionStatus(
        this.options.automaticConnectionTimeoutMs ??
          DEFAULT_AUTOMATIC_CONNECTION_TIMEOUT_MS,
        this.options.connectionPollMs ?? DEFAULT_CONNECTION_POLL_MS,
      );
      if (!connected) {
        this.updateConnection("disconnected");
        return this.snapshot();
      }
      this.updateConnection("checking");
      await this.ensureSessionInitialized(options);
      let cookies: StellaBrowserExportedCookie[];
      try {
        cookies = await this.options.exportAllCookies();
      } catch (error) {
        const message = errorMessage(error);
        if (
          !/unknown (?:command|action): cookies_export_all/i.test(message) ||
          !this.options.exportCookiesForUrls
        ) {
          throw error;
        }
        cookies = await this.options.exportCookiesForUrls(
          readBrowserHistoryUrls(this.profilePath),
        );
      }
      await this.seedCookies(cookies);
      this.hasSeededOnce = true;
      this.lastReseedAt = Date.now();
      this.updateConnection("connected");
      // Freshness from here on is owned by the continuous mirror, not by a
      // one-shot latch: the in-app store is refreshed on a cadence and on
      // navigation so new logins / rotated tokens in the real browser propagate.
      this.startCookieMirror();
    } catch (error) {
      this.updateConnection("disconnected", errorMessage(error));
    }
    return this.snapshot();
  }

  async show(
    layout: BrowserViewLayout,
    ownerId?: string,
  ): Promise<BrowserViewState> {
    this.visibleOwnerId = this.resolveShowOwnerId(ownerId);
    this.visible = true;
    this.setLayoutInternal(layout);
    this.syncState();
    this.attachActiveView();
    return this.snapshot();
  }

  setVisibleOwner(ownerId?: string): BrowserViewState {
    const resolvedOwnerId = this.resolveOwnerId(ownerId);
    if (
      resolvedOwnerId !== MANUAL_OWNER_ID &&
      !this.owners.has(resolvedOwnerId)
    ) {
      throw new Error(`Browser owner not found: ${resolvedOwnerId}`);
    }
    this.scopedOwnerId = undefined;
    this.visibleOwnerId = resolvedOwnerId;
    this.syncState();
    this.attachActiveView();
    return this.snapshot();
  }

  setOwnerScope(ownerId?: string): BrowserViewState {
    const normalizedOwnerId = ownerId?.trim();
    this.scopedOwnerId = normalizedOwnerId || null;
    if (normalizedOwnerId) {
      this.visibleOwnerId = normalizedOwnerId;
    }
    this.syncState();
    this.attachActiveView();
    return this.snapshot();
  }

  async setLayout(layout: BrowserViewLayout): Promise<BrowserViewState> {
    this.setLayoutInternal(layout);
    if (this.visible) this.attachActiveView();
    return this.snapshot();
  }

  async hide(): Promise<BrowserViewState> {
    this.visible = false;
    this.detachAttachedView();
    return this.snapshot();
  }

  async createTab(
    options: { url?: string; ownerId?: string; activate?: boolean } = {},
  ): Promise<BrowserViewState> {
    await this.ensureSessionInitialized({});
    const browserSession = this.browserSession;
    if (!browserSession) throw new Error("Browser session is unavailable.");
    const ownerId = this.resolveOwnerId(options.ownerId);
    const id = (this.options.createId ?? randomUUID)();
    const view =
      this.options.createView?.(browserSession) ??
      new WebContentsView({
        webPreferences: {
          session: browserSession,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
        },
      });
    // Match the session UA on the tab's WebContents so navigator.userAgent and
    // outgoing request headers present a real Chrome UA rather than Electron's.
    try {
      view.webContents.setUserAgent(IN_APP_BROWSER_USER_AGENT);
    } catch {
      // Injected/mock views in tests may not implement setUserAgent.
    }
    const tab: ManagedTab = {
      id,
      ownerId,
      view,
      title: "New Tab",
      loading: false,
    };
    this.tabs.set(id, tab);
    const owner = this.getOrCreateOwner(ownerId);
    owner.tabIds.add(id);
    owner.activeTabId = id;
    this.latestOwnerId = ownerId;
    if (this.shouldActivateOwner(ownerId, options.activate)) {
      this.visibleOwnerId = ownerId;
    }
    this.bindTab(tab);
    this.syncState();
    this.attachActiveView();
    try {
      await this.applyPendingPartitionedCookies(tab);
      await view.webContents.loadURL(normalizeWebUrl(options.url));
    } catch (error) {
      if (!view.webContents.isDestroyed()) {
        this.setError(errorMessage(error), ownerId);
      }
    }
    this.syncState();
    return this.snapshot(ownerId);
  }

  async selectTab(options: {
    tabId: string;
    ownerId?: string;
    activate?: boolean;
  }): Promise<BrowserViewState> {
    const ownerId = this.resolveOwnerId(options.ownerId);
    this.requireTab(options.tabId, ownerId);
    this.getOrCreateOwner(ownerId).activeTabId = options.tabId;
    this.latestOwnerId = ownerId;
    if (this.shouldActivateOwner(ownerId, options.activate)) {
      this.visibleOwnerId = ownerId;
    }
    this.syncState();
    this.attachActiveView();
    return this.snapshot(ownerId);
  }

  async closeTab(options: {
    tabId: string;
    ownerId?: string;
  }): Promise<BrowserViewState> {
    const ownerId = this.resolveOwnerId(options.ownerId);
    this.closeTabInternal(options.tabId, ownerId);
    return this.snapshot(ownerId);
  }

  async navigate(options: {
    tabId: string;
    url: string;
    ownerId?: string;
  }): Promise<BrowserViewState> {
    const ownerId = this.resolveOwnerId(options.ownerId);
    const tab = this.requireTab(options.tabId, ownerId);
    this.clearOwnerError(ownerId);
    await tab.view.webContents.loadURL(normalizeWebUrl(options.url));
    this.syncState();
    return this.snapshot(ownerId);
  }

  async goBack(options: {
    tabId: string;
    ownerId?: string;
  }): Promise<BrowserViewState> {
    const ownerId = this.resolveOwnerId(options.ownerId);
    const history = this.requireTab(options.tabId, ownerId).view.webContents
      .navigationHistory;
    if (history.canGoBack()) history.goBack();
    this.syncState();
    return this.snapshot(ownerId);
  }

  async goForward(options: {
    tabId: string;
    ownerId?: string;
  }): Promise<BrowserViewState> {
    const ownerId = this.resolveOwnerId(options.ownerId);
    const history = this.requireTab(options.tabId, ownerId).view.webContents
      .navigationHistory;
    if (history.canGoForward()) history.goForward();
    this.syncState();
    return this.snapshot(ownerId);
  }

  async reload(options: {
    tabId: string;
    ownerId?: string;
  }): Promise<BrowserViewState> {
    const ownerId = this.resolveOwnerId(options.ownerId);
    this.clearOwnerError(ownerId);
    this.requireTab(options.tabId, ownerId).view.webContents.reload();
    this.syncState();
    return this.snapshot(ownerId);
  }

  listDebuggerTargets(ownerId?: string): InAppBrowserDebuggerTarget[] {
    const owner = this.owners.get(this.resolveOwnerId(ownerId));
    if (!owner) return [];
    return [...owner.tabIds].flatMap((tabId) => {
      const tab = this.tabs.get(tabId);
      if (!tab || tab.view.webContents.isDestroyed()) return [];
      return [{ id: tab.id, url: this.readTabUrl(tab), title: tab.title }];
    });
  }

  async createDebuggerTarget(
    url = DEFAULT_URL,
    ownerId?: string,
  ): Promise<InAppBrowserDebuggerTarget> {
    const resolvedOwnerId = this.resolveOwnerId(ownerId);
    const state = await this.createTab({ url, ownerId: resolvedOwnerId });
    const tabId = state.activeTabId;
    const target = tabId
      ? this.listDebuggerTargets(resolvedOwnerId).find(
          (candidate) => candidate.id === tabId,
        )
      : undefined;
    if (!target) throw new Error("Failed to create browser target.");
    return target;
  }

  async closeDebuggerTarget(tabId: string, ownerId?: string): Promise<boolean> {
    const resolvedOwnerId = this.resolveOwnerId(ownerId);
    if (!this.isOwnedBy(tabId, resolvedOwnerId)) return false;
    this.closeTabInternal(tabId, resolvedOwnerId);
    return true;
  }

  async activateDebuggerTarget(tabId: string, ownerId?: string): Promise<void> {
    await this.selectTab({ tabId, ownerId: this.resolveOwnerId(ownerId) });
  }

  async sendDebuggerCommand(
    tabId: string,
    method: string,
    params?: Record<string, unknown>,
    ownerId?: string,
  ): Promise<unknown> {
    const resolvedOwnerId = this.resolveOwnerId(ownerId);
    const tab = this.requireTab(tabId, resolvedOwnerId);
    const tabDebugger = tab.view.webContents.debugger;
    if (!tabDebugger.isAttached()) tabDebugger.attach();
    if (!DRAWABLE_CDP_METHODS.has(method)) {
      return await tabDebugger.sendCommand(method, params);
    }
    const lease = this.acquireDrawableHost(tabId, resolvedOwnerId);
    try {
      await this.settleDrawableHost(tabId);
      return await tabDebugger.sendCommand(method, params);
    } finally {
      lease.release();
    }
  }

  async recoverDebuggerTarget(
    tabId: string,
    ownerId?: string,
  ): Promise<InAppBrowserDebuggerRecovery> {
    const resolvedOwnerId = this.resolveOwnerId(ownerId);
    const tab = this.requireTab(tabId, resolvedOwnerId);
    const contents = tab.view.webContents;
    const tabDebugger = contents.debugger;
    const timeoutMs =
      this.options.debuggerRecoveryTimeoutMs ??
      DEFAULT_DEBUGGER_RECOVERY_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    let terminated = false;

    try {
      if (!tabDebugger.isAttached()) tabDebugger.attach();
      terminated = await Promise.race([
        Promise.resolve(
          tabDebugger.sendCommand("Runtime.terminateExecution"),
        ).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      terminated = false;
    } finally {
      clearTimeout(timer);
    }

    if (terminated) return "terminated";
    if (contents.isDestroyed()) {
      throw new Error("Browser tab was destroyed during page recovery.");
    }
    contents.reload();
    return "reloaded";
  }

  acquireDrawableHost(
    tabId: string,
    ownerId?: string,
  ): InAppBrowserDrawableLease {
    const tab = this.requireTab(tabId, this.resolveOwnerId(ownerId));
    let lease = this.drawableLeases.get(tabId);
    if (lease) {
      lease.count += 1;
      if (
        this.attachedView !== tab.view &&
        (!lease.mountedInHiddenHost || this.drawableHost?.isDestroyed())
      ) {
        lease.mountedInHiddenHost = false;
        this.mountLeaseInHiddenHost(tab, lease);
      }
    } else {
      lease = { count: 1, mountedInHiddenHost: false };
      this.drawableLeases.set(tabId, lease);
      if (this.attachedView !== tab.view)
        this.mountLeaseInHiddenHost(tab, lease);
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.releaseDrawableHost(tabId);
      },
    };
  }

  closeOwnerTabs(ownerId: string): void {
    const resolvedOwnerId = this.resolveOwnerId(ownerId);
    const owner = this.owners.get(resolvedOwnerId);
    if (!owner) return;
    const wasVisibleOwner = this.visibleOwnerId === resolvedOwnerId;
    if (wasVisibleOwner) this.visibleOwnerId = MANUAL_OWNER_ID;
    for (const tabId of [...owner.tabIds]) {
      if (this.tabs.has(tabId)) this.closeTabInternal(tabId, resolvedOwnerId);
    }
    this.owners.delete(resolvedOwnerId);
    this.errorsByOwner.delete(resolvedOwnerId);
    if (wasVisibleOwner) {
      this.syncState();
      this.attachActiveView();
    }
  }

  subscribeDebuggerEvents(
    listener: (event: InAppBrowserDebuggerEvent) => void,
  ): () => void {
    this.debuggerListeners.add(listener);
    return () => this.debuggerListeners.delete(listener);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.visible = false;
    this.stopCookieMirror();
    this.detachAttachedView();
    for (const tab of [...this.tabs.values()]) {
      this.closeTabInternal(tab.id, tab.ownerId);
    }
    this.drawableLeases.clear();
    const drawableHost = this.drawableHost;
    this.drawableHost = null;
    if (drawableHost && !drawableHost.isDestroyed()) drawableHost.destroy();
    this.owners.clear();
    this.debuggerListeners.clear();
  }

  private async ensureSessionInitialized(options: {
    browserType?: string;
    profileId?: string;
  }) {
    if (this.browserSession) return;
    if (this.initializePromise) return await this.initializePromise;
    const initializePromise = (async () => {
      const resolveProfile =
        this.options.resolveProfile ?? resolveBrowserProfileSelection;
      const importProfile =
        this.options.importProfile ?? importBrowserProfileSnapshot;
      const selection = await resolveProfile(options);
      this.profileImport = await importProfile({
        destinationPath: this.profilePath,
        selection,
      });
      this.browserSession = (this.options.sessionFromPath ?? session.fromPath)(
        this.profilePath,
        { cache: true },
      );
      // Present a real, current Chrome-on-macOS UA at the session level (not just
      // the CDP Browser.getVersion facade) so pages don't see an Electron UA,
      // which adds bot-fingerprint weight on risk engines like Google's.
      this.browserSession.setUserAgent(IN_APP_BROWSER_USER_AGENT);
      // Permission policy: deny by default, but allow the WebAuthn / security-key
      // access that reauth needs and ONLY on trusted auth origins. Sensitive,
      // auth-irrelevant permissions (camera, microphone, geolocation,
      // notifications) stay denied everywhere. The request handler's permission
      // union excludes hid/usb/serial, so it stays effectively deny-all; the
      // check + device handlers are where security-key access is granted.
      this.browserSession.setPermissionRequestHandler(
        (webContents, permission, callback) => {
          const origin = webContents?.getURL?.() ?? "";
          callback(isAuthPermission(permission) && isAuthOrigin(origin));
        },
      );
      this.browserSession.setPermissionCheckHandler(
        (_webContents, permission, requestingOrigin) =>
          isAuthPermission(permission) && isAuthOrigin(requestingOrigin),
      );
      this.browserSession.setDevicePermissionHandler((details) =>
        shouldAllowAuthDevice(details),
      );
      this.state.profileName =
        this.profileImport.profileName ??
        this.profileImport.profileId ??
        this.profileImport.browserType;
      this.emitState();
    })().finally(() => {
      if (this.initializePromise === initializePromise) {
        this.initializePromise = null;
      }
    });
    this.initializePromise = initializePromise;
    await initializePromise;
  }

  private async pollExtensionStatus(timeoutMs: number, pollMs: number) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      try {
        if (await this.options.getExtensionStatus()) return true;
      } catch {
        // Native-host registration and daemon startup can race any individual
        // probe. A failed attempt is not a terminal connection result.
      }
      if (Date.now() >= deadline || this.disposed) break;
      await (
        this.options.wait ??
        ((delayMs: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
      )(pollMs);
    } while (!this.disposed);
    return false;
  }

  private async seedCookies(cookies: StellaBrowserExportedCookie[]) {
    if (!this.browserSession)
      throw new Error("Browser session is unavailable.");
    let failed = 0;
    let partitioned = 0;
    let preserved = 0;
    for (const cookie of cookies) {
      const url = cookieUrl(cookie);
      if (!url || !cookie.name) {
        failed += 1;
        continue;
      }
      if (cookie.partitionKey?.topLevelSite) {
        partitioned += 1;
        continue;
      }
      // Conservative re-seed: never clobber a healthy managed session. If the
      // managed store already holds a LIVE, trust-critical cookie (device trust /
      // session binding: __Secure-*, __Host-*, Google SID/…) for this name+host,
      // keep it instead of overwriting with the real browser's (possibly
      // mid-rotation) copy. The first-ever seed sees an empty store, so initial
      // login still seeds everything; only accumulated trust survives later
      // launches. See shouldPreserveExistingCookie for the full rule.
      if (isTrustCriticalCookieName(cookie.name)) {
        try {
          const existingForName = await this.browserSession.cookies.get({
            url,
            name: cookie.name,
          });
          const existing = existingForName.find(
            (candidate) => candidate.name === cookie.name,
          );
          if (shouldPreserveExistingCookie(existing, cookie)) {
            preserved += 1;
            continue;
          }
        } catch {
          // If we can't read the existing cookie, fall through and (re)seed it.
        }
      }
      try {
        await this.browserSession.cookies.set({
          url,
          name: cookie.name,
          value: cookie.value,
          ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
          path: cookie.path || "/",
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          ...(!cookie.session && typeof cookie.expirationDate === "number"
            ? { expirationDate: cookie.expirationDate }
            : {}),
        });
      } catch {
        failed += 1;
      }
    }
    await this.browserSession.cookies.flushStore();
    this.browserSession.flushStorageData();
    this.pendingPartitionedCookies = cookies.filter((cookie) =>
      Boolean(cookie.partitionKey?.topLevelSite),
    );
    if (failed > 0 || partitioned > 0 || preserved > 0) {
      console.warn(
        `[in-app-browser] Cookie seed completed with ${failed} failed, ${partitioned} partitioned, and ${preserved} preserved (trust-critical) cookie(s).`,
      );
    }
  }

  /**
   * Start the continuous cookie mirror. After the initial seed this re-pulls
   * the real browser's cookies on a cadence and re-applies them to the in-app
   * session, so the in-app store never goes stale. Uses a self-rescheduling
   * timeout (not setInterval) so a slow reseed can never overlap the next tick,
   * is unref'd so it does not keep the process alive, and is torn down in
   * dispose(). No-op if already running or disposed.
   */
  private startCookieMirror() {
    if (this.cookieMirrorTimer || this.disposed) return;
    const intervalMs = Math.max(
      MIN_COOKIE_MIRROR_INTERVAL_MS,
      this.options.cookieMirrorIntervalMs ?? DEFAULT_COOKIE_MIRROR_INTERVAL_MS,
    );
    const scheduleNext = () => {
      if (this.disposed) {
        this.cookieMirrorTimer = null;
        return;
      }
      const timer = setTimeout(() => {
        void this.reseedFromExtension()
          .catch(() => {})
          .finally(scheduleNext);
      }, intervalMs);
      timer.unref?.();
      this.cookieMirrorTimer = timer;
    };
    scheduleNext();
  }

  private stopCookieMirror() {
    if (this.cookieMirrorTimer) {
      clearTimeout(this.cookieMirrorTimer);
      this.cookieMirrorTimer = null;
    }
  }

  /**
   * Re-pull cookies from the real browser (via the extension) and re-apply them
   * to the in-app session. Safe to call repeatedly and concurrently: a
   * single-flight guard prevents overlapping writes to the shared cookie store,
   * and it only ever writes to `this.browserSession` (the in-app profile), never
   * to any other Electron session. No-op until the initial seed has run.
   */
  private async reseedFromExtension(): Promise<void> {
    if (this.disposed || !this.hasSeededOnce || !this.browserSession) return;
    if (this.reseedInFlight) return;
    this.reseedInFlight = true;
    try {
      const extensionConnected = await this.options
        .getExtensionStatus()
        .catch(() => false);
      if (!extensionConnected || this.disposed) return;
      let cookies: StellaBrowserExportedCookie[];
      try {
        cookies = await this.options.exportAllCookies();
      } catch (error) {
        const message = errorMessage(error);
        if (
          !/unknown (?:command|action): cookies_export_all/i.test(message) ||
          !this.options.exportCookiesForUrls
        ) {
          throw error;
        }
        cookies = await this.options.exportCookiesForUrls(
          readBrowserHistoryUrls(this.profilePath),
        );
      }
      if (this.disposed || !this.browserSession) return;
      await this.seedCookies(cookies);
      this.lastReseedAt = Date.now();
    } catch (error) {
      // A failed mirror pass must never kill the mirror loop; the next tick
      // retries. Transient bridge/daemon errors are expected during extension
      // wake or app shutdown.
      console.warn(
        `[in-app-browser] Cookie mirror refresh failed: ${errorMessage(error)}`,
      );
    } finally {
      this.reseedInFlight = false;
    }
  }

  /**
   * Reconcile-on-navigation: refresh cookies around a top-level navigation so
   * the target site sees a current session on its subresource / XHR / next-hop
   * requests. Non-blocking and throttled so rapid navigations don't each pull a
   * full cookie export.
   */
  private scheduleNavigationReseed() {
    if (this.disposed || !this.hasSeededOnce) return;
    const throttleMs =
      this.options.navigationReseedThrottleMs ??
      DEFAULT_NAVIGATION_RESEED_THROTTLE_MS;
    if (Date.now() - this.lastReseedAt < throttleMs) return;
    void this.reseedFromExtension().catch(() => {});
  }

  private async applyPendingPartitionedCookies(tab: ManagedTab) {
    if (this.pendingPartitionedCookies.length === 0) return;
    const sameSite = (value: StellaBrowserExportedCookie["sameSite"]) => {
      if (value === "no_restriction") return "None";
      if (value === "lax") return "Lax";
      if (value === "strict") return "Strict";
      return undefined;
    };
    const cookies = this.pendingPartitionedCookies.flatMap((cookie) => {
      const url = cookieUrl(cookie);
      if (!url || !cookie.name || !cookie.partitionKey?.topLevelSite) return [];
      const mappedSameSite = sameSite(cookie.sameSite);
      return [
        {
          name: cookie.name,
          value: cookie.value,
          url,
          ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
          path: cookie.path || "/",
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          ...(mappedSameSite ? { sameSite: mappedSameSite } : {}),
          ...(!cookie.session && typeof cookie.expirationDate === "number"
            ? { expires: cookie.expirationDate }
            : {}),
          partitionKey: cookie.partitionKey,
        },
      ];
    });
    if (cookies.length === 0) return;
    try {
      const tabDebugger = tab.view.webContents.debugger;
      if (!tabDebugger.isAttached()) tabDebugger.attach();
      await tabDebugger.sendCommand("Network.setCookies", { cookies });
      this.pendingPartitionedCookies = [];
    } catch (error) {
      console.warn(
        `[in-app-browser] Could not restore partitioned cookies: ${errorMessage(error)}`,
      );
    }
  }

  private bindTab(tab: ManagedTab) {
    const contents = tab.view.webContents;
    const refresh = () => this.syncState();
    contents.on("did-start-loading", () => {
      tab.loading = true;
      this.clearOwnerError(tab.ownerId, false);
      refresh();
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      refresh();
    });
    contents.on("did-navigate", () => {
      // Reconcile-on-navigation: freshen cookies for the site just navigated to
      // (non-blocking, throttled) before running the normal state refresh.
      this.scheduleNavigationReseed();
      refresh();
    });
    contents.on("did-navigate-in-page", refresh);
    contents.on("page-title-updated", (_event, title) => {
      tab.title = title || "New Tab";
      refresh();
    });
    contents.on("page-favicon-updated", (_event, favicons) => {
      tab.faviconUrl = favicons.find(isAllowedNavigationUrl);
      refresh();
    });
    contents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        tab.loading = false;
        this.setError(
          errorDescription || `Page failed to load (${errorCode}).`,
          tab.ownerId,
        );
      },
    );
    contents.on("render-process-gone", (_event, details) => {
      tab.loading = false;
      this.setError(`Browser page stopped: ${details.reason}.`, tab.ownerId);
    });
    contents.on("destroyed", () => {
      if (this.tabs.get(tab.id) !== tab) return;
      this.tabs.delete(tab.id);
      this.drawableLeases.delete(tab.id);
      const owner = this.owners.get(tab.ownerId);
      owner?.tabIds.delete(tab.id);
      if (owner?.activeTabId === tab.id) {
        owner.activeTabId = [...owner.tabIds].at(-1);
      }
      if (owner && owner.tabIds.size === 0) {
        this.owners.delete(tab.ownerId);
        this.errorsByOwner.delete(tab.ownerId);
        if (this.latestOwnerId === tab.ownerId) {
          this.latestOwnerId = [...this.owners.keys()]
            .filter((candidate) => candidate !== MANUAL_OWNER_ID)
            .at(-1);
        }
        if (this.visibleOwnerId === tab.ownerId) {
          this.visibleOwnerId = MANUAL_OWNER_ID;
        }
      }
      this.syncState();
      this.attachActiveView();
    });
    contents.on("will-navigate", (event) => {
      if (!isAllowedNavigationUrl(event.url)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      // Real auth / reauth popups (Google "confirm it's you", passkey, OAuth
      // consent) run as window.open and MUST open as a genuine child window that
      // keeps its opener, so the challenge can postMessage / redirect back to the
      // page that spawned it. Scope this to the auth-origin allowlist only.
      if (isAuthPopupUrl(url)) {
        return {
          action: "allow",
          outlivesOpener: false,
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: {
              session: this.browserSession ?? undefined,
              nodeIntegration: false,
              nodeIntegrationInSubFrames: false,
              nodeIntegrationInWorker: false,
              contextIsolation: true,
              sandbox: true,
              webSecurity: true,
              allowRunningInsecureContent: false,
              webviewTag: false,
            },
          },
        };
      }
      // Non-auth navigations keep the existing anti-junk-tab behavior: reroute a
      // normal web URL into an opener-less managed tab, and deny everything else.
      if (isAllowedNavigationUrl(url)) {
        void this.createTab({ url, ownerId: tab.ownerId }).catch((error) => {
          this.setError(errorMessage(error), tab.ownerId);
        });
      }
      return { action: "deny" };
    });
    contents.debugger.on("message", (_event, method, params, sessionId) => {
      const debuggerEvent: InAppBrowserDebuggerEvent = {
        tabId: tab.id,
        method,
        ...(params && typeof params === "object"
          ? { params: params as Record<string, unknown> }
          : {}),
      };
      for (const listener of this.debuggerListeners) listener(debuggerEvent);
    });
  }

  private requireTab(tabId: string, ownerId?: string) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) {
      throw new Error(`Browser tab not found: ${tabId}`);
    }
    if (ownerId !== undefined && tab.ownerId !== ownerId) {
      throw new Error(`Browser tab not found for owner: ${tabId}`);
    }
    return tab;
  }

  private closeTabInternal(tabId: string, ownerId: string) {
    const tab = this.requireTab(tabId, ownerId);
    const owner = this.owners.get(ownerId);
    const orderedIds = owner ? [...owner.tabIds] : [];
    const closedIndex = orderedIds.indexOf(tabId);
    if (this.attachedView === tab.view) this.detachAttachedView();
    this.unmountDrawableLease(tab);
    this.drawableLeases.delete(tabId);
    this.tabs.delete(tabId);
    owner?.tabIds.delete(tabId);
    if (owner?.activeTabId === tabId) {
      owner.activeTabId =
        orderedIds[closedIndex + 1] ?? orderedIds[closedIndex - 1];
    }
    if (owner && owner.tabIds.size === 0) {
      this.owners.delete(ownerId);
      this.errorsByOwner.delete(ownerId);
      if (this.latestOwnerId === ownerId) {
        this.latestOwnerId = [...this.owners.keys()]
          .filter((candidate) => candidate !== MANUAL_OWNER_ID)
          .at(-1);
      }
      if (this.visibleOwnerId === ownerId) {
        this.visibleOwnerId = MANUAL_OWNER_ID;
      }
    }
    const tabDebugger = tab.view.webContents.debugger;
    if (tabDebugger.isAttached()) tabDebugger.detach();
    tab.view.webContents.close();
    this.syncState();
    this.attachActiveView();
  }

  private readTabUrl(tab: ManagedTab) {
    try {
      return tab.view.webContents.getURL() || DEFAULT_URL;
    } catch {
      return DEFAULT_URL;
    }
  }

  private tabState(tab: ManagedTab): BrowserViewTabState {
    const history = tab.view.webContents.navigationHistory;
    return {
      id: tab.id,
      ownerId: tab.ownerId,
      url: this.readTabUrl(tab),
      title: tab.title || tab.view.webContents.getTitle() || "New Tab",
      ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
      loading: tab.loading,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
    };
  }

  private syncState() {
    const scopedOwnerId =
      typeof this.scopedOwnerId === "string"
        ? this.scopedOwnerId
        : this.scopedOwnerId === null
          ? this.resolveAvailableOwnerId(this.visibleOwnerId)
          : this.visibleOwnerId;
    this.visibleOwnerId = scopedOwnerId;
    const owner = this.owners.get(scopedOwnerId);
    this.state.visibleOwnerId = this.visibleOwnerId;
    this.state.owners = this.ownerStates();
    this.state.tabs = this.tabsForCurrentScope();
    this.state.activeTabId = owner?.activeTabId;
    this.syncErrorState();
    this.emitState();
  }

  private updateConnection(connection: BrowserViewConnection, error?: string) {
    this.state.connection = connection;
    this.connectionError = error;
    this.syncErrorState();
    this.emitState();
  }

  private setError(error: string, ownerId = this.visibleOwnerId) {
    this.errorsByOwner.set(ownerId, error);
    if (ownerId !== this.visibleOwnerId) return;
    this.syncErrorState();
    this.emitState();
  }

  private clearOwnerError(ownerId: string, emit = true) {
    if (
      !this.errorsByOwner.delete(ownerId) ||
      ownerId !== this.visibleOwnerId
    ) {
      return;
    }
    this.syncErrorState();
    if (emit) this.emitState();
  }

  private errorForOwner(ownerId: string) {
    return this.state.connection === "connected"
      ? this.errorsByOwner.get(ownerId)
      : this.connectionError;
  }

  private syncErrorState() {
    const error = this.errorForOwner(this.visibleOwnerId);
    if (error) this.state.error = error;
    else delete this.state.error;
  }

  private snapshot(ownerId?: string) {
    if (ownerId === undefined) return cloneState(this.state);
    const owner = this.owners.get(ownerId);
    const error = this.errorForOwner(ownerId);
    return cloneState({
      connection: this.state.connection,
      ...(this.state.profileName
        ? { profileName: this.state.profileName }
        : {}),
      visibleOwnerId: this.visibleOwnerId,
      owners: this.ownerStates(),
      tabs: owner
        ? [...owner.tabIds].flatMap((tabId) => {
            const tab = this.tabs.get(tabId);
            return tab && !tab.view.webContents.isDestroyed()
              ? [this.tabState(tab)]
              : [];
          })
        : [],
      ...(owner?.activeTabId ? { activeTabId: owner.activeTabId } : {}),
      ...(error ? { error } : {}),
    });
  }

  private emitState() {
    this.options.onStateChanged?.(this.snapshot());
  }

  private setLayoutInternal(layout: BrowserViewLayout) {
    this.layout = {
      pageBounds: normalizeBounds(layout.pageBounds),
      surfaceBounds: normalizeBounds(layout.surfaceBounds),
    };
    if (this.attachedView && this.attachedWindow && this.layout) {
      this.attachedView.setBounds(
        clampBoundsToWindow(this.layout.pageBounds, this.attachedWindow),
      );
    }
    for (const [tabId, lease] of this.drawableLeases) {
      if (!lease.mountedInHiddenHost) continue;
      this.tabs.get(tabId)?.view.setBounds(this.drawableBounds());
    }
  }

  private attachActiveView() {
    const activeTabId = this.state.activeTabId;
    if (!this.visible || !this.layout || !activeTabId) {
      this.detachAttachedView();
      return;
    }
    const tab = this.tabs.get(activeTabId);
    const window = this.options.getWindow();
    if (
      !tab ||
      tab.view.webContents.isDestroyed() ||
      !window ||
      window.isDestroyed()
    ) {
      this.detachAttachedView();
      return;
    }
    const drawableLease = this.drawableLeases.get(tab.id);
    if (drawableLease?.mountedInHiddenHost) {
      // The view remains drawable without stealing the visible surface. The
      // final lease release restores it if it is still the visible active tab.
      if (this.attachedView && this.attachedView !== tab.view) {
        this.detachAttachedView();
      }
      return;
    }
    if (this.attachedView !== tab.view || this.attachedWindow !== window) {
      this.detachAttachedView();
      window.contentView.addChildView(tab.view);
      this.attachedView = tab.view;
      this.attachedWindow = window;
    }
    tab.view.setBounds(clampBoundsToWindow(this.layout.pageBounds, window));
  }

  private detachAttachedView() {
    const view = this.attachedView;
    const window = this.attachedWindow;
    this.attachedView = null;
    this.attachedWindow = null;
    if (!view || !window || window.isDestroyed()) return;
    try {
      window.contentView.removeChildView(view);
    } catch {
      // Window teardown may have already detached its child views.
    }
    const tab = [...this.tabs.values()].find(
      (candidate) => candidate.view === view,
    );
    const drawableLease = tab ? this.drawableLeases.get(tab.id) : undefined;
    if (tab && drawableLease && drawableLease.count > 0) {
      this.mountLeaseInHiddenHost(tab, drawableLease);
    }
  }

  private resolveOwnerId(ownerId?: string) {
    const normalized = ownerId?.trim();
    return normalized || MANUAL_OWNER_ID;
  }

  private resolveShowOwnerId(ownerId?: string) {
    const normalized = ownerId?.trim();
    if (normalized) return normalized;
    if (typeof this.scopedOwnerId === "string") return this.scopedOwnerId;
    if ((this.owners.get(this.visibleOwnerId)?.tabIds.size ?? 0) > 0) {
      return this.visibleOwnerId;
    }
    if ((this.owners.get(MANUAL_OWNER_ID)?.tabIds.size ?? 0) > 0) {
      return MANUAL_OWNER_ID;
    }
    if (this.latestOwnerId && this.owners.has(this.latestOwnerId)) {
      return this.latestOwnerId;
    }
    return MANUAL_OWNER_ID;
  }

  private shouldActivateOwner(ownerId: string, requested?: boolean) {
    if (requested) return true;
    if (typeof this.scopedOwnerId === "string") {
      return this.scopedOwnerId === ownerId;
    }
    return this.scopedOwnerId === undefined && ownerId === MANUAL_OWNER_ID;
  }

  private resolveAvailableOwnerId(preferredOwnerId: string) {
    if ((this.owners.get(preferredOwnerId)?.tabIds.size ?? 0) > 0) {
      return preferredOwnerId;
    }
    if (this.latestOwnerId && this.owners.has(this.latestOwnerId)) {
      return this.latestOwnerId;
    }
    if ((this.owners.get(MANUAL_OWNER_ID)?.tabIds.size ?? 0) > 0) {
      return MANUAL_OWNER_ID;
    }
    return (
      [...this.owners.entries()].find(
        ([, owner]) => owner.tabIds.size > 0,
      )?.[0] ?? MANUAL_OWNER_ID
    );
  }

  private tabsForCurrentScope(): BrowserViewTabState[] {
    if (this.scopedOwnerId === null) {
      return [...this.tabs.values()].flatMap((tab) =>
        tab.view.webContents.isDestroyed() ? [] : [this.tabState(tab)],
      );
    }
    const ownerId =
      typeof this.scopedOwnerId === "string"
        ? this.scopedOwnerId
        : this.visibleOwnerId;
    const owner = this.owners.get(ownerId);
    return owner
      ? [...owner.tabIds].flatMap((tabId) => {
          const tab = this.tabs.get(tabId);
          return tab && !tab.view.webContents.isDestroyed()
            ? [this.tabState(tab)]
            : [];
        })
      : [];
  }

  private ownerStates(): BrowserViewOwnerState[] {
    const manual = this.owners.get(MANUAL_OWNER_ID);
    const result: BrowserViewOwnerState[] = [
      {
        id: MANUAL_OWNER_ID,
        kind: "manual",
        tabCount: manual?.tabIds.size ?? 0,
        ...(manual?.activeTabId ? { activeTabId: manual.activeTabId } : {}),
        latest: false,
      },
    ];
    for (const [ownerId, owner] of this.owners) {
      if (ownerId === MANUAL_OWNER_ID || owner.tabIds.size === 0) continue;
      result.push({
        id: ownerId,
        kind: "agent",
        tabCount: owner.tabIds.size,
        ...(owner.activeTabId ? { activeTabId: owner.activeTabId } : {}),
        latest: ownerId === this.latestOwnerId,
      });
    }
    return result;
  }

  private getOrCreateOwner(ownerId: string) {
    let owner = this.owners.get(ownerId);
    if (!owner) {
      owner = { tabIds: new Set() };
      this.owners.set(ownerId, owner);
    }
    return owner;
  }

  private isOwnedBy(tabId: string, ownerId: string) {
    return this.tabs.get(tabId)?.ownerId === ownerId;
  }

  private ensureDrawableHost() {
    if (this.drawableHost && !this.drawableHost.isDestroyed()) {
      return this.drawableHost;
    }
    const host =
      this.options.createDrawableHost?.() ??
      new BrowserWindow({
        ...DRAWABLE_HOST_BOUNDS,
        show: false,
        frame: false,
        focusable: false,
        opacity: 0,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
    host.setBounds(DRAWABLE_HOST_BOUNDS, false);
    host.setFocusable(false);
    host.setOpacity(0);
    host.setSkipTaskbar(true);
    host.once("closed", () => {
      if (this.drawableHost !== host) return;
      this.drawableHost = null;
      for (const lease of this.drawableLeases.values()) {
        lease.mountedInHiddenHost = false;
      }
    });
    host.showInactive();
    this.drawableHost = host;
    return host;
  }

  private drawableBounds(): Rectangle {
    const requested = this.layout?.pageBounds;
    return {
      x: 0,
      y: 0,
      width: Math.max(1, requested?.width ?? DRAWABLE_HOST_BOUNDS.width),
      height: Math.max(1, requested?.height ?? DRAWABLE_HOST_BOUNDS.height),
    };
  }

  private mountLeaseInHiddenHost(tab: ManagedTab, lease: DrawableLease) {
    if (lease.mountedInHiddenHost || tab.view.webContents.isDestroyed()) return;
    const host = this.ensureDrawableHost();
    host.contentView.addChildView(tab.view);
    tab.view.setBounds(this.drawableBounds());
    lease.mountedInHiddenHost = true;
  }

  private unmountDrawableLease(tab: ManagedTab) {
    const lease = this.drawableLeases.get(tab.id);
    const host = this.drawableHost;
    if (!lease?.mountedInHiddenHost || !host || host.isDestroyed()) return;
    lease.mountedInHiddenHost = false;
    try {
      host.contentView.removeChildView(tab.view);
    } catch {
      // Host teardown can race tab cleanup.
    }
  }

  private releaseDrawableHost(tabId: string) {
    const lease = this.drawableLeases.get(tabId);
    if (!lease) return;
    lease.count -= 1;
    if (lease.count > 0) return;
    const tab = this.tabs.get(tabId);
    if (tab) this.unmountDrawableLease(tab);
    this.drawableLeases.delete(tabId);
    this.attachActiveView();
  }

  private async settleDrawableHost(tabId: string) {
    const wait =
      this.options.wait ??
      ((delayMs: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    await wait(16);
    const tab = this.tabs.get(tabId);
    const lease = this.drawableLeases.get(tabId);
    if (!tab || !lease || this.attachedView === tab.view) return;
    if (!lease.mountedInHiddenHost || this.drawableHost?.isDestroyed()) {
      lease.mountedInHiddenHost = false;
      this.mountLeaseInHiddenHost(tab, lease);
      await wait(16);
    }
  }
}
