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
  resolveBrowserProfileSelection,
  type BrowserProfileImportResult,
} from "./in-app-browser-profile.js";
import {
  buildInAppBrowserUserAgent,
  isAuthOrigin,
  isAuthPermission,
  isAuthPopupUrl,
  shouldAllowAuthDevice,
} from "./in-app-browser-auth-policy.js";
import type {
  InAppBrowserDebuggerEvent,
  InAppBrowserDebuggerRecovery,
  InAppBrowserDebuggerTarget,
} from "./in-app-browser-cdp-adapter.js";
import type { StellaBrowserBridgeStatus } from "../process-resources/browser-bridge-resource.js";
import type {
  BrowserViewConnection,
  BrowserViewLayout,
  BrowserViewOwnerState,
  BrowserViewState,
  BrowserViewTabState,
  BrowserViewUnavailableReason,
  StellaBrowserExportedCookie,
} from "@stella/contracts/desktop/browser-view";
import { BROWSER_BRIDGE_MISSING_ERROR } from "../utils/register-stella-native-messaging-host.js";
import { STELLA_BROWSER_EXTENSION_STORE_URL } from "@stella/runtime/kernel/tools/stella-browser-bridge-config";
import { CookieMirror } from "./in-app-browser/cookie-mirror.js";
import {
  DebuggerTargetProxy,
  isRendererUrl,
} from "./in-app-browser/debugger-target-proxy.js";
import {
  BrowserTabRegistry,
  DEFAULT_URL,
  MANUAL_OWNER_ID,
  resolveOwnerId,
  type ManagedTab,
} from "./in-app-browser/tab-registry.js";

export type { StellaBrowserExportedCookie };

/**
 * A single real-browser cookie change pushed in real time by the extension.
 * `removed` distinguishes a deletion from a set; `cookie` carries the same shape
 * as an exported cookie.
 */
export type StellaBrowserCookieChange = {
  removed?: boolean;
  cause?: string;
  cookie?: StellaBrowserExportedCookie;
};

/** An unsolicited event object pushed over the bridge subscription. */
export type StellaBrowserBridgeEvent = {
  event?: string;
  changes?: StellaBrowserCookieChange[];
  [key: string]: unknown;
};

export type InAppBrowserPreview = {
  view: WebContentsView;
  url: string;
  dispose: () => void;
};

export type InAppBrowserDrawableLease = {
  release: () => void;
};

type InAppBrowserServiceOptions = {
  stellaDataDir: string;
  getWindow: () => BrowserWindow | null;
  ensureBrowserBridgeStarted: () => void | Promise<void>;
  openExtensionStore?: () => void | Promise<void>;
  getBrowserSetupStatus?: () => {
    bridgeBinaryInstalled: boolean;
    extensionInstalled: boolean;
  };
  getBrowserBridgeStatus?: () => StellaBrowserBridgeStatus | undefined;
  /**
   * Which bridge this instance runs. An isolated bridge has no
   * native-messaging registration and a private loopback port, so the user's
   * browser extension cannot attach to it at all — a state no amount of
   * clicking "connect" can fix, and one the error text has to own up to
   * instead of blaming the extension.
   */
  getBrowserBridgeNamespace?: () =>
    | { mode: "shared" | "isolated"; ownsExtensionChannel: boolean }
    | undefined;
  getExtensionStatus: () => Promise<boolean>;
  exportAllCookies: () => Promise<StellaBrowserExportedCookie[]>;
  exportCookiesForUrls?: (
    urls: string[],
  ) => Promise<StellaBrowserExportedCookie[]>;
  /**
   * Subscribe to real-time cookie-change events pushed by the extension. The
   * returned function unsubscribes. When present, this is the PRIMARY freshness
   * mechanism; the periodic reconcile below is only a backstop for events
   * missed while the extension's service worker was asleep or the subscription
   * was reconnecting.
   */
  subscribeCookieEvents?: (
    onEvent: (event: StellaBrowserBridgeEvent) => void,
  ) => () => void;
  onStateChanged?: (state: BrowserViewState) => void;
  connectionTimeoutMs?: number;
  connectionPollMs?: number;
  automaticConnectionTimeoutMs?: number;
  /** Total budget for reconnect-on-demand, across retries. Defaults to 30s. */
  demandConnectionTimeoutMs?: number;
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
  /**
   * Keep the drawable host unmapped and force frames on demand instead of
   * showing it offscreen. Defaults to true on Linux (see `ensureDrawableHost`).
   */
  hideDrawableHost?: boolean;
  createId?: () => string;
  wait?: (delayMs: number) => Promise<void>;
  debuggerRecoveryTimeoutMs?: number;
  runtimeUserAgent?: string;
  /**
   * Opens `stella-preview://<draft>` for agents. Only set when Stella runs
   * from source.
   */
  openPreview?: (name: string) => Promise<InAppBrowserPreview>;
};

const PREVIEW_URL_PREFIX = "stella-preview://";
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECTION_POLL_MS = 250;
// Extension wake (MV3 service worker) plus native-host/daemon spawn can take
// several seconds on a cold start. 1.5s was too tight and routinely produced a
// "connected extension but no seed" state; give the first automatic connect a
// more forgiving window. Repeated getState polls also retry the seed, so this
// is only the first-attempt budget.
const DEFAULT_AUTOMATIC_CONNECTION_TIMEOUT_MS = 5_000;
// Reconnect-on-demand: when something actually asks for a web tab, a cold or
// dead transport is a thing to repair, not to report. The daemon is restarted
// and the extension re-polled across this budget before the call gives up, so
// a slept service worker, an exited daemon or an app that outlived its bridge
// recovers without a browser restart or a fresh agent run.
const DEFAULT_DEMAND_CONNECTION_TIMEOUT_MS = 30_000;
// Per-attempt poll windows inside that budget. Short first so a merely-asleep
// service worker costs little, longer after so a full daemon respawn fits.
const DEMAND_ATTEMPT_WINDOWS_MS = [2_000, 5_000, 10_000] as const;
// Gap between attempts, so a daemon that is still booting is not hammered.
const DEMAND_RETRY_BACKOFF_MS = [250, 1_000, 2_000] as const;
const MAX_FAVICON_BYTES = 256 * 1024;

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

/** How hard one `connect()` should try, and whether it may re-handshake. */
type ConnectionAttemptOptions = {
  /** Poll window for this attempt; defaults to the automatic-connect budget. */
  timeoutMs?: number;
  /**
   * Run the full handshake even though a seed already completed, so a bridge
   * whose daemon died is restarted instead of merely re-probed.
   */
  recover?: boolean;
};

export class InAppBrowserService {
  private readonly options: InAppBrowserServiceOptions;
  private readonly tabs = new BrowserTabRegistry();
  private readonly cookies: CookieMirror;
  private readonly debuggerProxy: DebuggerTargetProxy;
  private readonly errorsByOwner = new Map<string, string>();
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
  private visible = false;
  private layout: BrowserViewLayout | null = null;
  private attachedView: WebContentsView | null = null;
  private attachedWindow: BrowserWindow | null = null;
  private disposed = false;
  private connectionError: string | undefined;
  private connectionUnavailableReason: BrowserViewUnavailableReason | undefined;
  private browserUserAgent = buildInAppBrowserUserAgent(undefined);

  constructor(options: InAppBrowserServiceOptions) {
    this.options = options;
    this.profilePath =
      options.profilePath ??
      path.join(options.stellaDataDir, "browser", "profile-v1");
    this.cookies = new CookieMirror({
      profilePath: this.profilePath,
      getExtensionStatus: options.getExtensionStatus,
      exportAllCookies: options.exportAllCookies,
      exportCookiesForUrls: options.exportCookiesForUrls,
      subscribeCookieEvents: options.subscribeCookieEvents,
      awaitConnection: async () => {
        if (this.connectPromise) {
          await this.connectPromise.catch(() => undefined);
        }
        if (!this.cookies.hasSeededOnce) {
          await this.connect().catch(() => undefined);
        }
      },
      getSeedTabContents: () => this.tabs.first()?.view.webContents,
      cookieMirrorIntervalMs: options.cookieMirrorIntervalMs,
      navigationReseedThrottleMs: options.navigationReseedThrottleMs,
    });
    this.debuggerProxy = new DebuggerTargetProxy({
      tabs: this.tabs,
      getAttachedView: () => this.attachedView,
      getPageBounds: () => this.layout?.pageBounds,
      attachActiveView: () => this.attachActiveView(),
      createDrawableHost: options.createDrawableHost,
      hideDrawableHost:
        options.hideDrawableHost ?? process.platform === "linux",
      wait: options.wait,
      debuggerRecoveryTimeoutMs: options.debuggerRecoveryTimeoutMs,
    });
  }

  async getState(ownerId?: string): Promise<BrowserViewState> {
    const resolvedOwnerId =
      ownerId === undefined ? undefined : resolveOwnerId(ownerId);
    if (this.disposed) return this.snapshot(resolvedOwnerId);
    if (this.cookies.hasSeededOnce) {
      // A completed seed is durable profile state, not a live transport
      // handshake. Re-probe the daemon/extension generation so the UI cannot
      // remain green while a fresh agent call is unauthorized.
      try {
        if (await this.options.getExtensionStatus()) {
          this.updateConnection("connected");
        } else {
          this.updateUnavailableConnection(
            this.readConnectionFailure("extension_disconnected"),
          );
        }
      } catch {
        this.updateUnavailableConnection(
          this.readConnectionFailure("transient_failure"),
        );
      }
      return this.snapshot(resolvedOwnerId);
    }
    const setupRequirement = this.readSetupRequirement();
    if (setupRequirement) {
      this.updateUnavailableConnection(setupRequirement);
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
        this.updateUnavailableConnection(
          this.readConnectionFailure("extension_disconnected"),
        );
      }
    } catch {
      this.updateUnavailableConnection(
        this.readConnectionFailure("transient_failure"),
      );
    }
    return this.snapshot(resolvedOwnerId);
  }

  async requestExtensionConnect(): Promise<BrowserViewState> {
    if (this.disposed) throw new Error("The in-app browser has been closed.");
    if (this.cookies.hasSeededOnce) {
      return await this.getState();
    }
    const setupRequirement = this.readSetupRequirement({ extension: false });
    if (setupRequirement) {
      this.updateUnavailableConnection(setupRequirement);
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
      this.updateUnavailableConnection(
        this.readConnectionFailure("extension_not_installed"),
      );
    } catch (error) {
      this.updateUnavailableConnection(
        this.readConnectionFailure("transient_failure", errorMessage(error)),
      );
    }
    return this.snapshot();
  }

  connect(
    options: {
      browserType?: string;
      profileId?: string;
    } = {},
    attempt: ConnectionAttemptOptions = {},
  ): Promise<BrowserViewState> {
    if (this.connectPromise) return this.connectPromise;
    const promise = this.connectInternal(options, attempt).finally(() => {
      if (this.connectPromise === promise) this.connectPromise = null;
    });
    this.connectPromise = promise;
    return promise;
  }

  private async connectInternal(
    options: {
      browserType?: string;
      profileId?: string;
    },
    attempt: ConnectionAttemptOptions = {},
  ): Promise<BrowserViewState> {
    // A completed seed used to end this method: callers got a re-probe of the
    // extension and nothing else, so a bridge whose daemon had since exited
    // could never be restarted. `recover` is how a caller that needs the
    // transport now asks for the real handshake again.
    if (this.cookies.hasSeededOnce && !attempt.recover) {
      return await this.getState();
    }
    await this.runConnectionAttempt(options, {
      timeoutMs:
        attempt.timeoutMs ??
        this.options.automaticConnectionTimeoutMs ??
        DEFAULT_AUTOMATIC_CONNECTION_TIMEOUT_MS,
    });
    return this.snapshot();
  }

  /**
   * One full bridge handshake: start the daemon, wait for the extension, open
   * the in-app session, then seed (or refresh) the cookie mirror. Idempotent
   * and reusable, so recovering a bridge that was once up takes the same path
   * as the first connect instead of a separate half-path that could only
   * report failure.
   */
  private async runConnectionAttempt(
    options: { browserType?: string; profileId?: string },
    attempt: { timeoutMs: number },
  ): Promise<boolean> {
    const setupRequirement = this.readSetupRequirement();
    if (setupRequirement) {
      this.updateUnavailableConnection(setupRequirement);
      return false;
    }
    try {
      await this.options.ensureBrowserBridgeStarted();
      const connected = await this.pollExtensionStatus(
        attempt.timeoutMs,
        this.options.connectionPollMs ?? DEFAULT_CONNECTION_POLL_MS,
      );
      if (!connected) {
        this.updateUnavailableConnection(
          this.readConnectionFailure("extension_disconnected"),
        );
        return false;
      }
      this.updateConnection("checking");
      await this.ensureSessionInitialized(options);
      await this.cookies.seedOrRefresh();
      this.updateConnection("connected");
      this.cookies.start();
      return true;
    } catch (error) {
      this.updateUnavailableConnection(
        this.readConnectionFailure("transient_failure", errorMessage(error)),
      );
      return false;
    }
  }

  /**
   * Bring the bridge up for a caller that needs it right now, repairing a cold
   * or dead transport rather than reporting it.
   *
   * Three things made the old path give up when it did not have to. It
   * short-circuited on `hasSeededOnce`, so a bridge that had worked earlier and
   * then lost its daemon was only ever re-probed, never restarted. It had a
   * single poll window, so one unlucky window (an asleep MV3 service worker, a
   * daemon mid-respawn) was a terminal answer. And `connect()`'s dedupe handed
   * the caller whatever attempt happened to be in flight, including a
   * background poll whose window opened before the extension woke up. Here the
   * caller waits out any in-flight attempt, then drives its own attempts with
   * backoff until the budget runs out.
   */
  private async ensureConnectionOnDemand(): Promise<boolean> {
    if (this.disposed) return false;
    const pending = this.connectPromise;
    if (pending) {
      await pending.catch(() => undefined);
      if (this.state.connection === "connected") return true;
    }
    const budgetMs =
      this.options.demandConnectionTimeoutMs ??
      DEFAULT_DEMAND_CONNECTION_TIMEOUT_MS;
    const deadline = Date.now() + Math.max(0, budgetMs);
    const wait =
      this.options.wait ??
      ((delayMs: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    for (let index = 0; !this.disposed; index += 1) {
      const remainingMs = deadline - Date.now();
      if (index > 0 && remainingMs <= 0) break;
      const windowMs =
        DEMAND_ATTEMPT_WINDOWS_MS[
          Math.min(index, DEMAND_ATTEMPT_WINDOWS_MS.length - 1)
        ]!;
      const state = await this.connect(
        {},
        {
          timeoutMs: Math.min(windowMs, Math.max(remainingMs, 0)),
          recover: true,
        },
      );
      if (state.connection === "connected") return true;
      // A requirement the user has to satisfy (no bridge binary, no extension
      // installed) does not become true by retrying.
      if (!this.isRecoverableFailure()) return false;
      const backoffMs =
        DEMAND_RETRY_BACKOFF_MS[
          Math.min(index, DEMAND_RETRY_BACKOFF_MS.length - 1)
        ]!;
      if (deadline - Date.now() <= backoffMs) break;
      await wait(backoffMs);
    }
    return this.state.connection === "connected";
  }

  /** Whether another attempt could plausibly succeed. */
  private isRecoverableFailure(): boolean {
    const reason = this.connectionUnavailableReason;
    if (!reason) return true;
    return reason !== "bridge_missing" && reason !== "extension_not_installed";
  }

  async show(
    layout: BrowserViewLayout,
    ownerId?: string,
  ): Promise<BrowserViewState> {
    this.tabs.visibleOwnerId = this.tabs.resolveShowOwnerId(ownerId);
    this.visible = true;
    this.setLayoutInternal(layout);
    this.syncState();
    this.attachActiveView();
    return this.snapshot();
  }

  setVisibleOwner(ownerId?: string): BrowserViewState {
    const resolvedOwnerId = resolveOwnerId(ownerId);
    if (
      resolvedOwnerId !== MANUAL_OWNER_ID &&
      !this.tabs.hasOwner(resolvedOwnerId)
    ) {
      throw new Error(`Browser owner not found: ${resolvedOwnerId}`);
    }
    this.tabs.scopedOwnerId = undefined;
    this.tabs.visibleOwnerId = resolvedOwnerId;
    this.syncState();
    this.attachActiveView();
    return this.snapshot();
  }

  setOwnerScope(ownerId?: string): BrowserViewState {
    const normalizedOwnerId = ownerId?.trim();
    this.tabs.scopedOwnerId = normalizedOwnerId || null;
    if (normalizedOwnerId) {
      this.tabs.visibleOwnerId = normalizedOwnerId;
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
    const ownerId = resolveOwnerId(options.ownerId);
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
    // outgoing request headers present the same runtime Chromium version.
    try {
      view.webContents.setUserAgent(this.browserUserAgent);
    } catch {
      // Injected/mock views in tests may not implement setUserAgent.
    }
    const tab = this.addTab({ id, view, ownerId, activate: options.activate });
    try {
      const url = normalizeWebUrl(options.url);
      await this.cookies.prepareGoogleNavigation(view.webContents.id, url);
      await this.cookies.applyPendingPartitionedCookies(view.webContents);
      await view.webContents.loadURL(url);
    } catch (error) {
      if (!view.webContents.isDestroyed()) {
        this.setError(errorMessage(error), ownerId);
      }
    }
    this.syncState();
    return this.snapshot(ownerId);
  }

  private addTab(options: {
    id: string;
    view: WebContentsView;
    ownerId: string;
    activate?: boolean;
    preview?: ManagedTab["preview"];
  }): ManagedTab {
    const { id, view, ownerId } = options;
    const tab: ManagedTab = {
      id,
      ownerId,
      view,
      title: options.preview ? `Preview: ${options.preview.name}` : "New Tab",
      faviconLoadId: 0,
      loading: false,
      ...(options.preview ? { preview: options.preview } : {}),
    };
    this.tabs.add(tab, options.activate);
    this.bindTab(tab);
    this.syncState();
    this.attachActiveView();
    return tab;
  }

  /**
   * The app's own UI from a draft worktree, as an ordinary tab of the owner,
   * so drawable mounting, screenshots, CDP and the browser panel all apply.
   */
  private async createPreviewTab(name: string, ownerId: string) {
    const openPreview = this.options.openPreview;
    if (!openPreview) {
      throw new Error(
        "Stella previews are available only when Stella runs from source.",
      );
    }
    // One preview per draft: its session serves one source tree.
    for (const existing of this.tabs.all()) {
      if (existing.preview?.name !== name) continue;
      existing.preview.dispose();
      this.closeTabInternal(existing.id, existing.ownerId);
    }
    const preview = await openPreview(name);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      preview.dispose();
    };
    const contents = preview.view.webContents;
    contents.once("destroyed", dispose);
    const tab = this.addTab({
      id: (this.options.createId ?? randomUUID)(),
      view: preview.view,
      ownerId,
      preview: { name, dispose },
    });
    try {
      await contents.loadURL(preview.url);
    } catch (error) {
      if (!contents.isDestroyed()) this.setError(errorMessage(error), ownerId);
    }
    this.syncState();
    return tab.id;
  }

  /** Agent web tabs need the extension's cookie mirror; previews do not. */
  private async requireAgentWebConnection() {
    if (await this.ensureConnectionOnDemand()) return;
    // `updateUnavailableConnection` already described the real failure, so
    // there is no guess left to make here.
    throw new Error(
      this.connectionError ??
        this.describeConnectionFailure(
          this.connectionUnavailableReason,
          undefined,
        ),
    );
  }

  /**
   * What is actually wrong, in words the reader can act on.
   *
   * The old text was one hard-coded sentence — "Connect the Stella browser
   * extension before using Stella Browser." — reached whenever the connection
   * was not green and no error string happened to be set. Most failure reasons
   * set no error string (`extension_disconnected` and friends pass `error:
   * undefined`), so that one sentence was the normal output for a daemon that
   * never started, a bridge the extension cannot reach, an authorization
   * failure and a genuinely missing extension alike. It named the one cause
   * that is usually NOT the problem, and the extension was often installed and
   * enabled the whole time.
   */
  private describeConnectionFailure(
    reason: BrowserViewUnavailableReason | undefined,
    error: string | undefined,
  ): string {
    const detail = error?.trim();
    const withDetail = (message: string) =>
      detail && detail !== message ? `${message} (${detail})` : message;
    const namespace = this.options.getBrowserBridgeNamespace?.();
    // An isolated bridge has no native-messaging host and a private loopback
    // port, so the extension cannot attach to it however many times it is
    // reinstalled or reconnected. Say so instead of blaming the extension.
    if (
      namespace &&
      namespace.mode === "isolated" &&
      !namespace.ownsExtensionChannel &&
      (reason === "extension_disconnected" ||
        reason === "extension_not_installed" ||
        reason === undefined)
    ) {
      return withDetail(
        "Stella Browser is unavailable because this Stella instance runs an " +
          "isolated browser bridge, which the browser extension cannot reach " +
          "(no native-messaging host, private loopback port). This is a Stella " +
          "instance configuration, not a problem with your extension. Run the " +
          "installed Stella app, or start this instance with " +
          "STELLA_BROWSER_BRIDGE=shared to claim the shared bridge.",
      );
    }
    switch (reason) {
      case "bridge_missing":
        return withDetail(
          "Stella Browser is unavailable because the stella-browser bridge " +
            "binary is not installed for this platform, so no bridge daemon " +
            "can start. Reinstall or rehydrate stella-browser.",
        );
      case "extension_not_installed":
        return withDetail(
          "Stella Browser needs the Stella browser extension, which is not " +
            `installed in any supported browser. Install it from ${STELLA_BROWSER_EXTENSION_STORE_URL}, ` +
            "then open Browser in Stella's sidebar and press Connect.",
        );
      case "extension_disconnected":
        return withDetail(
          "Stella Browser could not reach the Stella browser extension: the " +
            "bridge daemon is running but no extension attached within the " +
            "retry window. The extension is installed, so this is usually its " +
            "background service worker not waking. Open or focus a tab in the " +
            "browser where it is installed, or open Browser in Stella's " +
            "sidebar and press Connect.",
        );
      case "authorization_failed":
        return withDetail(
          "Stella Browser could not authorize against the browser bridge " +
            "daemon, so its token is stale. Restarting Stella reissues it.",
        );
      case "connection_lost":
        return withDetail(
          "Stella Browser lost its connection to the browser bridge daemon " +
            "and could not re-establish it within the retry window.",
        );
      default:
        return withDetail(
          "Stella Browser could not connect to the browser bridge. Stella " +
            "restarted the bridge and retried; it did not come up.",
        );
    }
  }

  async selectTab(options: {
    tabId: string;
    ownerId?: string;
    activate?: boolean;
  }): Promise<BrowserViewState> {
    const ownerId = resolveOwnerId(options.ownerId);
    this.tabs.require(options.tabId, ownerId);
    this.tabs.select(options.tabId, ownerId, options.activate);
    this.syncState();
    this.attachActiveView();
    return this.snapshot(ownerId);
  }

  async closeTab(options: {
    tabId: string;
    ownerId?: string;
  }): Promise<BrowserViewState> {
    const ownerId = resolveOwnerId(options.ownerId);
    this.closeTabInternal(options.tabId, ownerId);
    return this.snapshot(ownerId);
  }

  async navigate(options: {
    tabId: string;
    url: string;
    ownerId?: string;
  }): Promise<BrowserViewState> {
    const ownerId = resolveOwnerId(options.ownerId);
    const tab = this.tabs.require(options.tabId, ownerId);
    if (tab.preview) throw new Error("A Stella preview tab only shows Stella.");
    this.clearOwnerError(ownerId);
    const url = normalizeWebUrl(options.url);
    await this.cookies.prepareGoogleNavigation(tab.view.webContents.id, url);
    await this.cookies.applyPendingPartitionedCookies(tab.view.webContents);
    await tab.view.webContents.loadURL(url);
    this.syncState();
    return this.snapshot(ownerId);
  }

  async goBack(options: {
    tabId: string;
    ownerId?: string;
  }): Promise<BrowserViewState> {
    const ownerId = resolveOwnerId(options.ownerId);
    const history = this.tabs.require(options.tabId, ownerId).view.webContents
      .navigationHistory;
    if (history.canGoBack()) history.goBack();
    this.syncState();
    return this.snapshot(ownerId);
  }

  async goForward(options: {
    tabId: string;
    ownerId?: string;
  }): Promise<BrowserViewState> {
    const ownerId = resolveOwnerId(options.ownerId);
    const history = this.tabs.require(options.tabId, ownerId).view.webContents
      .navigationHistory;
    if (history.canGoForward()) history.goForward();
    this.syncState();
    return this.snapshot(ownerId);
  }

  async reload(options: {
    tabId: string;
    ownerId?: string;
  }): Promise<BrowserViewState> {
    const ownerId = resolveOwnerId(options.ownerId);
    this.clearOwnerError(ownerId);
    this.tabs.require(options.tabId, ownerId).view.webContents.reload();
    this.syncState();
    return this.snapshot(ownerId);
  }

  listDebuggerTargets(ownerId?: string): InAppBrowserDebuggerTarget[] {
    return this.debuggerProxy.listTargets(ownerId);
  }

  async createDebuggerTarget(
    url = DEFAULT_URL,
    ownerId?: string,
  ): Promise<InAppBrowserDebuggerTarget> {
    const resolvedOwnerId = resolveOwnerId(ownerId);
    let tabId: string | undefined;
    if (url.startsWith(PREVIEW_URL_PREFIX)) {
      tabId = await this.createPreviewTab(
        url.slice(PREVIEW_URL_PREFIX.length).replace(/\/$/, ""),
        resolvedOwnerId,
      );
    } else {
      await this.requireAgentWebConnection();
      tabId = (await this.createTab({ url, ownerId: resolvedOwnerId }))
        .activeTabId;
    }
    const target = tabId
      ? this.listDebuggerTargets(resolvedOwnerId).find(
          (candidate) => candidate.id === tabId,
        )
      : undefined;
    if (!target) throw new Error("Failed to create browser target.");
    return target;
  }

  async closeDebuggerTarget(tabId: string, ownerId?: string): Promise<boolean> {
    const resolvedOwnerId = resolveOwnerId(ownerId);
    if (!this.tabs.isOwnedBy(tabId, resolvedOwnerId)) return false;
    this.closeTabInternal(tabId, resolvedOwnerId);
    return true;
  }

  async activateDebuggerTarget(tabId: string, ownerId?: string): Promise<void> {
    await this.selectTab({ tabId, ownerId: resolveOwnerId(ownerId) });
  }

  sendDebuggerCommand(
    tabId: string,
    method: string,
    params?: Record<string, unknown>,
    ownerId?: string,
    debuggerSessionId?: string,
  ): Promise<unknown> {
    return this.debuggerProxy.sendCommand(
      tabId,
      method,
      params,
      ownerId,
      debuggerSessionId,
    );
  }

  recoverDebuggerTarget(
    tabId: string,
    ownerId?: string,
    debuggerSessionId?: string,
  ): Promise<InAppBrowserDebuggerRecovery> {
    return this.debuggerProxy.recoverTarget(tabId, ownerId, debuggerSessionId);
  }

  acquireDrawableHost(
    tabId: string,
    ownerId?: string,
  ): InAppBrowserDrawableLease {
    return this.debuggerProxy.acquireDrawableHost(tabId, ownerId);
  }

  closeOwnerTabs(ownerId: string): void {
    const resolvedOwnerId = resolveOwnerId(ownerId);
    const tabIds = this.tabs.ownerTabIds(resolvedOwnerId);
    if (!tabIds) return;
    const wasVisibleOwner = this.tabs.visibleOwnerId === resolvedOwnerId;
    if (wasVisibleOwner) this.tabs.visibleOwnerId = MANUAL_OWNER_ID;
    for (const tabId of tabIds) {
      if (this.tabs.has(tabId)) this.closeTabInternal(tabId, resolvedOwnerId);
    }
    this.tabs.deleteOwner(resolvedOwnerId);
    this.errorsByOwner.delete(resolvedOwnerId);
    if (wasVisibleOwner) {
      this.syncState();
      this.attachActiveView();
    }
  }

  subscribeDebuggerEvents(
    listener: (event: InAppBrowserDebuggerEvent) => void,
  ): () => void {
    return this.debuggerProxy.subscribe(listener);
  }

  getDebuggerUserAgent(): string {
    return this.browserUserAgent;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.visible = false;
    this.cookies.dispose();
    this.detachAttachedView();
    for (const tab of this.tabs.all()) {
      this.closeTabInternal(tab.id, tab.ownerId);
    }
    this.debuggerProxy.dispose();
    this.tabs.clearOwners();
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
      // Derive from Electron's actual runtime UA. A hardcoded Chrome version
      // diverges from Sec-CH-UA as soon as Electron updates.
      const runtimeUserAgent =
        this.options.runtimeUserAgent ?? this.browserSession.getUserAgent?.();
      this.browserUserAgent = buildInAppBrowserUserAgent(runtimeUserAgent);
      this.browserSession.setUserAgent(this.browserUserAgent);
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
      this.cookies.attachSession(this.browserSession);
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
      const bridgeFailure = this.options.getBrowserBridgeStatus?.()?.reason;
      if (
        bridgeFailure === "bridge_missing" ||
        bridgeFailure === "authorization_failed"
      ) {
        break;
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

  private async loadFaviconDataUrl(url: string): Promise<string | undefined> {
    const browserSession = this.browserSession;
    if (!browserSession?.fetch) return undefined;
    try {
      const response = await browserSession.fetch(url, {
        cache: "force-cache",
      });
      if (!response.ok) return undefined;
      const mimeType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (!mimeType?.startsWith("image/")) return undefined;
      const declaredSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > MAX_FAVICON_BYTES) {
        return undefined;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_FAVICON_BYTES) return undefined;
      return `data:${mimeType};base64,${bytes.toString("base64")}`;
    } catch {
      return undefined;
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
      this.cookies.scheduleNavigationReseed();
      refresh();
    });
    contents.on("did-navigate-in-page", refresh);
    contents.on("page-title-updated", (_event, title) => {
      tab.title = title || "New Tab";
      refresh();
    });
    contents.on("page-favicon-updated", (_event, favicons) => {
      const faviconUrl = favicons.find(isAllowedNavigationUrl);
      const loadId = ++tab.faviconLoadId;
      tab.faviconUrl = undefined;
      refresh();
      if (!faviconUrl) return;
      void this.loadFaviconDataUrl(faviconUrl).then((dataUrl) => {
        if (
          !dataUrl ||
          this.tabs.get(tab.id) !== tab ||
          tab.faviconLoadId !== loadId
        ) {
          return;
        }
        tab.faviconUrl = dataUrl;
        refresh();
      });
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
      this.cookies.forgetContents(contents.id);
      if (this.tabs.get(tab.id) !== tab) return;
      this.debuggerProxy.forgetTab(tab.id);
      if (this.tabs.remove(tab, "last")) {
        this.errorsByOwner.delete(tab.ownerId);
      }
      this.syncState();
      this.attachActiveView();
    });
    contents.on("will-navigate", (event) => {
      const allowed = tab.preview
        ? isRendererUrl(event.url)
        : isAllowedNavigationUrl(event.url);
      if (!allowed) event.preventDefault();
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
    this.debuggerProxy.forwardEvents(tab);
  }

  private closeTabInternal(tabId: string, ownerId: string) {
    const tab = this.tabs.require(tabId, ownerId);
    if (this.attachedView === tab.view) this.detachAttachedView();
    this.debuggerProxy.releaseTab(tab);
    if (this.tabs.remove(tab, "neighbor")) this.errorsByOwner.delete(ownerId);
    const tabDebugger = tab.view.webContents.debugger;
    if (tabDebugger.isAttached()) tabDebugger.detach();
    tab.view.webContents.close();
    this.syncState();
    this.attachActiveView();
  }

  private syncState() {
    const scopedOwnerId = this.tabs.settleScopedOwner();
    this.state.visibleOwnerId = scopedOwnerId;
    this.state.owners = this.tabs.ownerStates();
    this.state.tabs = this.tabs.tabsForCurrentScope();
    this.state.activeTabId = this.tabs.activeTabId(scopedOwnerId);
    this.syncErrorState();
    this.emitState();
  }

  private updateConnection(connection: BrowserViewConnection, error?: string) {
    this.state.connection = connection;
    this.connectionError = error;
    this.connectionUnavailableReason = undefined;
    delete this.state.unavailableReason;
    this.syncErrorState();
    this.emitState();
  }

  private readSetupRequirement(
    options: { extension?: boolean } = {},
  ): { reason: BrowserViewUnavailableReason; error?: string } | undefined {
    const setup = this.options.getBrowserSetupStatus?.();
    if (!setup) return undefined;
    if (!setup.bridgeBinaryInstalled) {
      return { reason: "bridge_missing", error: BROWSER_BRIDGE_MISSING_ERROR };
    }
    if (options.extension !== false && !setup.extensionInstalled) {
      return { reason: "extension_not_installed" };
    }
    return undefined;
  }

  private readConnectionFailure(
    fallback: BrowserViewUnavailableReason,
    error?: string,
  ): { reason: BrowserViewUnavailableReason; error?: string } {
    const bridgeStatus = this.options.getBrowserBridgeStatus?.();
    if (bridgeStatus?.reason && bridgeStatus.state !== "connected") {
      return {
        reason: bridgeStatus.reason,
        error: bridgeStatus.error ?? error,
      };
    }
    if (fallback === "extension_not_installed") {
      const setup = this.options.getBrowserSetupStatus?.();
      if (setup?.extensionInstalled) {
        return { reason: "extension_disconnected", error };
      }
    }
    return { reason: fallback, error };
  }

  private updateUnavailableConnection(failure: {
    reason: BrowserViewUnavailableReason;
    error?: string;
  }) {
    this.state.connection = "disconnected";
    // Always carry a description of what is actually wrong. Most reasons
    // arrive with no error string, which used to leave `state.error` empty —
    // and an empty error is what made every caller fall back to its own
    // guess ("connect the extension") regardless of the real reason.
    this.connectionError = this.describeConnectionFailure(
      failure.reason,
      failure.error,
    );
    this.connectionUnavailableReason = failure.reason;
    this.state.unavailableReason = failure.reason;
    this.syncErrorState();
    this.emitState();
  }

  private setError(error: string, ownerId = this.tabs.visibleOwnerId) {
    this.errorsByOwner.set(ownerId, error);
    if (ownerId !== this.tabs.visibleOwnerId) return;
    this.syncErrorState();
    this.emitState();
  }

  private clearOwnerError(ownerId: string, emit = true) {
    if (
      !this.errorsByOwner.delete(ownerId) ||
      ownerId !== this.tabs.visibleOwnerId
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
    const error = this.errorForOwner(this.tabs.visibleOwnerId);
    if (error) this.state.error = error;
    else delete this.state.error;
  }

  private snapshot(ownerId?: string) {
    if (ownerId === undefined) return cloneState(this.state);
    const activeTabId = this.tabs.activeTabId(ownerId);
    const error = this.errorForOwner(ownerId);
    return cloneState({
      connection: this.state.connection,
      ...(this.state.profileName
        ? { profileName: this.state.profileName }
        : {}),
      visibleOwnerId: this.tabs.visibleOwnerId,
      owners: this.tabs.ownerStates(),
      tabs: this.tabs.ownerTabStates(ownerId),
      ...(activeTabId ? { activeTabId } : {}),
      ...(error ? { error } : {}),
      ...(this.connectionUnavailableReason
        ? { unavailableReason: this.connectionUnavailableReason }
        : {}),
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
    this.debuggerProxy.resizeHiddenMounts();
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
    if (this.debuggerProxy.isMountedInHiddenHost(tab.id)) {
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
    const tab = this.tabs.findByView(view);
    if (tab) this.debuggerProxy.remountLeased(tab);
  }
}
