import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  session,
  WebContentsView,
  type BrowserWindow,
  type Rectangle,
  type Session,
} from "electron";
import {
  importBrowserProfileSnapshot,
  readBrowserHistoryUrls,
  resolveBrowserProfileSelection,
  type BrowserProfileImportResult,
} from "./in-app-browser-profile.js";
import type {
  InAppBrowserDebuggerEvent,
  InAppBrowserDebuggerTarget,
} from "./in-app-browser-cdp-adapter.js";

export type BrowserViewConnection =
  | "checking"
  | "disconnected"
  | "connected";

export type BrowserViewTabState = {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type BrowserViewState = {
  connection: BrowserViewConnection;
  profileName?: string;
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
  view: WebContentsView;
  title: string;
  faviconUrl?: string;
  loading: boolean;
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
  profilePath?: string;
  resolveProfile?: typeof resolveBrowserProfileSelection;
  importProfile?: typeof importBrowserProfileSnapshot;
  sessionFromPath?: typeof session.fromPath;
  createView?: (browserSession: Session) => WebContentsView;
  createId?: () => string;
  wait?: (delayMs: number) => Promise<void>;
};

const DEFAULT_URL = "about:blank";
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECTION_POLL_MS = 250;

const cloneState = (state: BrowserViewState): BrowserViewState => ({
  ...state,
  tabs: state.tabs.map((tab) => ({ ...tab })),
});

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const normalizeWebUrl = (input: string | undefined) => {
  const raw = input?.trim() || DEFAULT_URL;
  if (raw === DEFAULT_URL) return raw;
  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(raw)
    ? raw
    : `https://${raw}`;
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
  width: Math.max(0, Math.round(Number.isFinite(bounds.width) ? bounds.width : 0)),
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
  private readonly debuggerListeners = new Set<
    (event: InAppBrowserDebuggerEvent) => void
  >();
  private readonly profilePath: string;

  private state: BrowserViewState = {
    connection: "checking",
    tabs: [],
  };
  private browserSession: Session | null = null;
  private profileImport: BrowserProfileImportResult | null = null;
  private initializePromise: Promise<void> | null = null;
  private connectPromise: Promise<BrowserViewState> | null = null;
  private activeTabId: string | undefined;
  private visible = false;
  private layout: BrowserViewLayout | null = null;
  private attachedView: WebContentsView | null = null;
  private attachedWindow: BrowserWindow | null = null;
  private disposed = false;
  private seeded = false;
  private pendingPartitionedCookies: StellaBrowserExportedCookie[] = [];

  constructor(options: InAppBrowserServiceOptions) {
    this.options = options;
    this.profilePath =
      options.profilePath ??
      path.join(options.stellaDataDir, "browser", "profile-v1");
  }

  async getState(): Promise<BrowserViewState> {
    if (this.disposed) return this.snapshot();
    if (this.seeded) {
      this.updateConnection("connected");
      return this.snapshot();
    }
    try {
      const extensionConnected = await this.options.getExtensionStatus();
      // Extension presence is only the first half of connection. Do not claim
      // readiness until profile/cookie seeding and in-app CDP routing finish.
      this.updateConnection(extensionConnected ? "checking" : "disconnected");
    } catch {
      // The bridge socket commonly isn't ready during app startup. That is a
      // normal disconnected state, not a fatal Browser-tab error.
      this.updateConnection("disconnected");
    }
    return this.snapshot();
  }

  async requestExtensionConnect(): Promise<BrowserViewState> {
    if (this.disposed) throw new Error("The in-app browser has been closed.");
    if (this.seeded) {
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
      const pollMs = this.options.connectionPollMs ?? DEFAULT_CONNECTION_POLL_MS;
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

  connect(options: {
    browserType?: string;
    profileId?: string;
  } = {}): Promise<BrowserViewState> {
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
    if (this.seeded) {
      this.updateConnection("connected");
      return this.snapshot();
    }
    try {
      await this.options.ensureBrowserBridgeStarted();
      const connected = await this.pollExtensionStatus(
        this.options.automaticConnectionTimeoutMs ?? 1_500,
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
      this.seeded = true;
      this.updateConnection("connected");
    } catch (error) {
      this.updateConnection("disconnected", errorMessage(error));
    }
    return this.snapshot();
  }

  async show(layout: BrowserViewLayout): Promise<BrowserViewState> {
    this.visible = true;
    this.setLayoutInternal(layout);
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

  async createTab(options: { url?: string } = {}): Promise<BrowserViewState> {
    await this.ensureSessionInitialized({});
    const browserSession = this.browserSession;
    if (!browserSession) throw new Error("Browser session is unavailable.");
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
    const tab: ManagedTab = {
      id,
      view,
      title: "New Tab",
      loading: false,
    };
    this.tabs.set(id, tab);
    this.bindTab(tab);
    this.activeTabId = id;
    this.syncState();
    this.attachActiveView();
    try {
      await this.applyPendingPartitionedCookies(tab);
      await view.webContents.loadURL(normalizeWebUrl(options.url));
    } catch (error) {
      if (!view.webContents.isDestroyed()) {
        this.setError(errorMessage(error));
      }
    }
    this.syncState();
    return this.snapshot();
  }

  async selectTab(options: { tabId: string }): Promise<BrowserViewState> {
    this.requireTab(options.tabId);
    this.activeTabId = options.tabId;
    this.syncState();
    this.attachActiveView();
    return this.snapshot();
  }

  async closeTab(options: { tabId: string }): Promise<BrowserViewState> {
    this.closeTabInternal(options.tabId);
    return this.snapshot();
  }

  async navigate(options: {
    tabId: string;
    url: string;
  }): Promise<BrowserViewState> {
    const tab = this.requireTab(options.tabId);
    await tab.view.webContents.loadURL(normalizeWebUrl(options.url));
    this.syncState();
    return this.snapshot();
  }

  async goBack(options: { tabId: string }): Promise<BrowserViewState> {
    const history = this.requireTab(options.tabId).view.webContents
      .navigationHistory;
    if (history.canGoBack()) history.goBack();
    this.syncState();
    return this.snapshot();
  }

  async goForward(options: { tabId: string }): Promise<BrowserViewState> {
    const history = this.requireTab(options.tabId).view.webContents
      .navigationHistory;
    if (history.canGoForward()) history.goForward();
    this.syncState();
    return this.snapshot();
  }

  async reload(options: { tabId: string }): Promise<BrowserViewState> {
    this.requireTab(options.tabId).view.webContents.reload();
    this.syncState();
    return this.snapshot();
  }

  listDebuggerTargets(): InAppBrowserDebuggerTarget[] {
    return [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      url: this.readTabUrl(tab),
      title: tab.title,
    }));
  }

  async createDebuggerTarget(
    url = DEFAULT_URL,
  ): Promise<InAppBrowserDebuggerTarget> {
    const state = await this.createTab({ url });
    const tabId = state.activeTabId;
    const target = tabId
      ? this.listDebuggerTargets().find((candidate) => candidate.id === tabId)
      : undefined;
    if (!target) throw new Error("Failed to create browser target.");
    return target;
  }

  async closeDebuggerTarget(tabId: string): Promise<boolean> {
    if (!this.tabs.has(tabId)) return false;
    this.closeTabInternal(tabId);
    return true;
  }

  async activateDebuggerTarget(tabId: string): Promise<void> {
    await this.selectTab({ tabId });
  }

  async sendDebuggerCommand(
    tabId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const tab = this.requireTab(tabId);
    const tabDebugger = tab.view.webContents.debugger;
    if (!tabDebugger.isAttached()) tabDebugger.attach();
    return await tabDebugger.sendCommand(method, params);
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
    this.detachAttachedView();
    for (const tabId of [...this.tabs.keys()]) this.closeTabInternal(tabId);
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
      this.browserSession = (
        this.options.sessionFromPath ?? session.fromPath
      )(this.profilePath, { cache: true });
      this.browserSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      );
      this.browserSession.setPermissionCheckHandler(() => false);
      this.browserSession.setDevicePermissionHandler(() => false);
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
      await (this.options.wait ??
        ((delayMs: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, delayMs))))(
        pollMs,
      );
    } while (!this.disposed);
    return false;
  }

  private async seedCookies(cookies: StellaBrowserExportedCookie[]) {
    if (!this.browserSession) throw new Error("Browser session is unavailable.");
    let failed = 0;
    let partitioned = 0;
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
    this.pendingPartitionedCookies = cookies.filter(
      (cookie) => Boolean(cookie.partitionKey?.topLevelSite),
    );
    if (failed > 0 || partitioned > 0) {
      console.warn(
        `[in-app-browser] Cookie seed completed with ${failed} failed and ${partitioned} partitioned cookie(s).`,
      );
    }
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
      refresh();
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      refresh();
    });
    contents.on("did-navigate", refresh);
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
        this.setError(errorDescription || `Page failed to load (${errorCode}).`);
      },
    );
    contents.on("render-process-gone", (_event, details) => {
      tab.loading = false;
      this.setError(`Browser page stopped: ${details.reason}.`);
    });
    contents.on("destroyed", () => {
      if (this.tabs.get(tab.id) !== tab) return;
      this.tabs.delete(tab.id);
      if (this.activeTabId === tab.id) {
        this.activeTabId = this.tabs.keys().next().value;
      }
      this.syncState();
      this.attachActiveView();
    });
    contents.on("will-navigate", (event) => {
      if (!isAllowedNavigationUrl(event.url)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedNavigationUrl(url)) {
        void this.createTab({ url }).catch((error) => {
          this.setError(errorMessage(error));
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

  private requireTab(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) {
      throw new Error(`Browser tab not found: ${tabId}`);
    }
    return tab;
  }

  private closeTabInternal(tabId: string) {
    const tab = this.requireTab(tabId);
    const orderedIds = [...this.tabs.keys()];
    const closedIndex = orderedIds.indexOf(tabId);
    if (this.attachedView === tab.view) this.detachAttachedView();
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId =
        orderedIds[closedIndex + 1] ?? orderedIds[closedIndex - 1];
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
      url: this.readTabUrl(tab),
      title: tab.title || tab.view.webContents.getTitle() || "New Tab",
      ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
      loading: tab.loading,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
    };
  }

  private syncState() {
    this.state.tabs = [...this.tabs.values()]
      .filter((tab) => !tab.view.webContents.isDestroyed())
      .map((tab) => this.tabState(tab));
    this.state.activeTabId = this.activeTabId;
    this.emitState();
  }

  private updateConnection(
    connection: BrowserViewConnection,
    error?: string,
  ) {
    this.state.connection = connection;
    if (error) this.state.error = error;
    else delete this.state.error;
    this.emitState();
  }

  private setError(error: string) {
    this.state.error = error;
    this.emitState();
  }

  private snapshot() {
    return cloneState(this.state);
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
  }

  private attachActiveView() {
    if (!this.visible || !this.layout || !this.activeTabId) {
      this.detachAttachedView();
      return;
    }
    const tab = this.tabs.get(this.activeTabId);
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
  }
}
