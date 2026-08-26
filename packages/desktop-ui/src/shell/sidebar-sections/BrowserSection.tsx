import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  BROWSER_PROFILE_KEY,
  BROWSER_SELECTION_KEY,
} from "@stella/contracts/discovery";
import { uiState } from "@/platform/ui-state";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useT } from "@/shared/i18n";
import { useActiveSidebarSection } from "@/features/workspace-display/sidebar-sections";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Globe,
  LoaderCircle,
  Plus,
  RefreshCw,
  X,
} from "@/ui/icons";
import "./browser-section.css";

type BrowserConnection = "checking" | "disconnected" | "connected";
type BrowserUnavailableReason =
  | "extension_not_installed"
  | "extension_disconnected"
  | "bridge_missing"
  | "authorization_failed"
  | "connection_lost"
  | "transient_failure";
type BrowserStatusKind =
  | "checking"
  | "setup_required"
  | Exclude<BrowserUnavailableReason, "extension_not_installed">
  | "connected"
  | "preparing"
  | "error";

type BrowserTab = {
  id: string;
  ownerId: string;
  url: string;
  title: string;
  faviconUrl?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

type BrowserOwner = {
  id: string;
  kind: "manual" | "agent";
  tabCount: number;
  activeTabId?: string;
  latest: boolean;
};

type BrowserViewState = {
  connection: BrowserConnection;
  profileName?: string;
  visibleOwnerId: string;
  owners: BrowserOwner[];
  tabs: BrowserTab[];
  activeTabId?: string;
  error?: string;
  unavailableReason?: BrowserUnavailableReason;
};

type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type BrowserLayout = {
  pageBounds: BrowserBounds;
  surfaceBounds: BrowserBounds;
};

type BrowserViewApi = {
  getState: () => Promise<BrowserViewState>;
  connect: (options: {
    browserType?: string;
    profileId?: string;
  }) => Promise<BrowserViewState | void>;
  show: (layout: BrowserLayout) => Promise<unknown> | unknown;
  setOwnerScope: (options?: {
    ownerId?: string;
  }) => Promise<BrowserViewState>;
  setLayout: (layout: BrowserLayout) => Promise<unknown> | unknown;
  hide: () => Promise<unknown> | unknown;
  createTab: (options: {
    url?: string;
    ownerId?: string;
    activate?: boolean;
  }) => Promise<unknown>;
  selectTab: (options: {
    tabId: string;
    ownerId?: string;
    activate?: boolean;
  }) => Promise<unknown>;
  closeTab: (options: { tabId: string; ownerId?: string }) => Promise<unknown>;
  navigate: (options: {
    tabId: string;
    url: string;
    ownerId?: string;
  }) => Promise<unknown>;
  goBack: (options: { tabId: string; ownerId?: string }) => Promise<unknown>;
  goForward: (options: { tabId: string; ownerId?: string }) => Promise<unknown>;
  reload: (options: { tabId: string; ownerId?: string }) => Promise<unknown>;
  requestExtensionConnect: () => Promise<unknown>;
  onState: (callback: (state: BrowserViewState) => void) => () => void;
};

const MANUAL_OWNER_ID = "stella:manual";

const EMPTY_STATE: BrowserViewState = {
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

const browserViewApi = (): BrowserViewApi | null =>
  (
    window.electronAPI as unknown as
      | { browserView?: BrowserViewApi }
      | undefined
  )?.browserView ?? null;

const toBounds = (rect: DOMRect): BrowserBounds => ({
  x: Math.round(rect.x),
  y: Math.round(rect.y),
  width: Math.max(0, Math.round(rect.width)),
  height: Math.max(0, Math.round(rect.height)),
});

const boundsKey = (layout: BrowserLayout) =>
  `${layout.pageBounds.x},${layout.pageBounds.y},${layout.pageBounds.width},${layout.pageBounds.height}|` +
  `${layout.surfaceBounds.x},${layout.surfaceBounds.y},${layout.surfaceBounds.width},${layout.surfaceBounds.height}`;

/* How long to keep re-reading the rects after something disturbs the
   layout, and how many identical frames end the watch. Sized for the
   panel's 460ms open/close ease (`.right-sidebar` in right-sidebar.css)
   with headroom for a slow frame. */
const LAYOUT_SETTLE_MS = 900;
const LAYOUT_SETTLE_FRAMES = 3;

/* WebContentsView is composited above the renderer, so any part of it that
   overlaps the DOM resize handle wins hit-testing. Keep the native page clear
   of the handle's full hit target; the browser chrome remains renderer-owned
   and does not need this inset. Keep this in sync with
   `.right-sidebar__resize-handle` in right-sidebar.css. */
const SIDEBAR_RESIZE_HANDLE_WIDTH = 12;

const browserPageBounds = (rect: DOMRect): BrowserBounds => {
  const bounds = toBounds(rect);
  const inset = document.documentElement.dataset.displayPanelTakeover
    ? 0
    : Math.min(SIDEBAR_RESIZE_HANDLE_WIDTH, bounds.width);
  return {
    ...bounds,
    x: bounds.x + inset,
    width: bounds.width - inset,
  };
};

const normalizeAddress = (raw: string): string | null => {
  const value = raw.trim();
  if (!value) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
  if (/^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/|$)/i.test(value)) {
    return `http://${value}`;
  }
  if (/^[^\s/]+\.[^\s]+/.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
};

const isBrowserViewState = (value: unknown): value is BrowserViewState => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BrowserViewState>;
  return (
    (candidate.connection === "checking" ||
      candidate.connection === "disconnected" ||
      candidate.connection === "connected") &&
    typeof candidate.visibleOwnerId === "string" &&
    Array.isArray(candidate.owners) &&
    Array.isArray(candidate.tabs)
  );
};

const sanitizeOwnerSegment = (value: string) =>
  value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

const conversationOwnerId = (conversationId: string | null | undefined) => {
  const ownerSegment = sanitizeOwnerSegment(
    conversationId ? `conversation-${conversationId}` : "",
  );
  return ownerSegment
    ? `orchestrator-${ownerSegment}`.slice(0, 120)
    : MANUAL_OWNER_ID;
};

function BrowserStatus({
  kind,
  profileName,
  error,
  connectingExtension,
  onConnect,
  onRetry,
  onCreateTab,
}: {
  kind: BrowserStatusKind;
  profileName?: string;
  error?: string;
  connectingExtension: boolean;
  onConnect: () => void;
  onRetry: () => void;
  onCreateTab: () => void;
}) {
  const t = useT();

  if (kind === "checking" || kind === "preparing") {
    return (
      <div className="browser-section__status" role="status" aria-live="polite">
        <LoaderCircle
          className="stella-loader-circle"
          size={19}
          strokeWidth={2}
          aria-hidden="true"
        />
        <p className="browser-section__status-title">
          {kind === "checking"
            ? "Checking browser connection…"
            : "Preparing your browser…"}
        </p>
      </div>
    );
  }

  if (
    kind === "extension_disconnected" ||
    kind === "bridge_missing" ||
    kind === "authorization_failed" ||
    kind === "connection_lost" ||
    kind === "transient_failure" ||
    kind === "error"
  ) {
    const copy = {
      extension_disconnected: {
        title: "Extension isn’t connected",
        body: "Stella found the browser extension, but it isn’t currently connected. Enable it in Chrome, then try again.",
      },
      bridge_missing: {
        title: "Browser service is missing",
        body: "Reinstall Stella, or run the desktop build, so the browser bridge binary is present.",
      },
      authorization_failed: {
        title: "Browser access is blocked",
        body: "Stella couldn’t authorize the browser bridge. Check system permissions, then try again.",
      },
      connection_lost: {
        title: "Browser connection lost",
        body: "The browser bridge stopped responding. Stella is retrying in the background.",
      },
      transient_failure: {
        title: "Couldn’t connect to the browser",
        body: "The browser bridge didn’t start successfully. Try again in a moment.",
      },
      error: {
        title: "Couldn’t open the browser",
        body: "Stella couldn’t prepare the in-app browser.",
      },
    }[kind];
    return (
      <div className="browser-section__status" role="alert">
        <AlertCircle size={22} strokeWidth={1.75} aria-hidden="true" />
        <p className="browser-section__status-title">{copy.title}</p>
        <p className="browser-section__status-body">
          {error || copy.body}
        </p>
        <button
          type="button"
          className="pill-btn pill-btn--primary"
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    );
  }

  if (kind === "setup_required") {
    return (
      <div className="browser-section__status" role="status">
        <span className="browser-section__status-icon" aria-hidden="true">
          <Globe size={21} strokeWidth={1.75} />
        </span>
        <p className="browser-section__status-title">
          {t("settings.browserExtension.title")}
        </p>
        <p className="browser-section__status-body">
          {t("settings.browserExtension.description")}
        </p>
        <button
          type="button"
          className="pill-btn pill-btn--primary"
          disabled={connectingExtension}
          onClick={onConnect}
        >
          {connectingExtension
            ? "Waiting for extension…"
            : t("settings.browserExtension.action")}
        </button>
      </div>
    );
  }

  return (
    <div className="browser-section__status" role="status">
      <span
        className="browser-section__status-icon browser-section__status-icon--connected"
        aria-hidden="true"
      >
        <CheckCircle2 size={21} strokeWidth={1.8} />
      </span>
      <p className="browser-section__status-title">Browser connected</p>
      {profileName ? (
        <p className="browser-section__status-body">{profileName}</p>
      ) : null}
      <button
        type="button"
        className="pill-btn pill-btn--primary"
        onClick={onCreateTab}
      >
        Open a new tab
      </button>
    </div>
  );
}

export function BrowserSection() {
  const chat = useChatRuntime();
  const activeSection = useActiveSidebarSection();
  const panelOpen = useDisplayPanelOpen();
  const visible = panelOpen && activeSection === "browser";
  const [state, setState] = useState<BrowserViewState>(EMPTY_STATE);
  const [preparing, setPreparing] = useState(false);
  const [connectingExtension, setConnectingExtension] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const surfaceRef = useRef<HTMLElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const shownRef = useRef(false);
  const mountedRef = useRef(true);
  const scopedOwnerId = useMemo(
    () => conversationOwnerId(chat.conversation.conversationId),
    [chat.conversation.conversationId],
  );

  const activeTab = useMemo(
    () =>
      state.tabs.find((tab) => tab.id === state.activeTabId) ??
      state.tabs[0] ??
      null,
    [state.activeTabId, state.tabs],
  );
  const activeTabId = activeTab?.id ?? null;

  useEffect(() => {
    setAddress(activeTab?.url ?? "");
  }, [activeTab?.id, activeTab?.url]);

  useEffect(() => {
    mountedRef.current = true;
    const api = browserViewApi();
    if (!api) {
      setState({ ...EMPTY_STATE, connection: "disconnected" });
      return () => {
        mountedRef.current = false;
      };
    }

    const unsubscribe = api.onState((next) => {
      if (!mountedRef.current) return;
      setState(next);
      setLocalError(null);
    });
    void api
      .getState()
      .then((next) => {
        if (mountedRef.current) setState(next);
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setLocalError(
          error instanceof Error
            ? error.message
            : "Couldn’t check the browser.",
        );
      });

    return () => {
      mountedRef.current = false;
      unsubscribe();
      if (shownRef.current) void api.hide();
      shownRef.current = false;
    };
  }, []);

  useEffect(() => {
    const api = browserViewApi();
    if (!api) return;
    void api
      .setOwnerScope({})
      .then((next) => {
        if (mountedRef.current && isBrowserViewState(next)) setState(next);
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setLocalError(
          error instanceof Error
            ? error.message
            : "Couldn’t select this chat’s browser tabs.",
        );
      });
  }, []);

  const connect = useCallback(async () => {
    const api = browserViewApi();
    if (!api) return;
    setPreparing(true);
    setLocalError(null);
    try {
      const next = await api.connect({
        browserType: uiState.getItem(BROWSER_SELECTION_KEY) ?? undefined,
        profileId: uiState.getItem(BROWSER_PROFILE_KEY) ?? undefined,
      });
      if (mountedRef.current && isBrowserViewState(next)) setState(next);
    } catch (error) {
      if (mountedRef.current) {
        setLocalError(
          error instanceof Error
            ? error.message
            : "Stella couldn’t prepare the browser.",
        );
      }
    } finally {
      if (mountedRef.current) setPreparing(false);
    }
  }, []);

  useEffect(() => {
    if (visible) void connect();
  }, [connect, visible]);

  useEffect(() => {
    const api = browserViewApi();
    const surface = surfaceRef.current;
    const page = pageRef.current;
    const shouldShow =
      visible && Boolean(activeTabId) && !state.error && !localError;
    if (!api || !surface || !page || !shouldShow) {
      if (api && shownRef.current) void api.hide();
      shownRef.current = false;
      return;
    }

    /*
     * The page rect has to be watched for MOVEment, not just resize.
     *
     * The panel opens by easing `.right-sidebar`'s width 0 → N with
     * `overflow: hidden`, while the inner frame keeps a fixed width — a
     * clip-reveal (see right-sidebar-panel.css). Because the aside is
     * `margin-left: auto` in a flex row, the inner frame's *size never
     * changes* during that 460ms; only its x slides leftward into place.
     *
     * ResizeObserver reports size, not position, so it stays silent for
     * the whole animation. Syncing once on the opening frame therefore
     * pinned the WebContentsView to the frame's mid-animation x — far to
     * the right of where the panel finally lands — and nothing ever
     * corrected it. That's the "content pushed to the right" you only see
     * after a close/reopen (selecting the tab while the panel is already
     * open never animates).
     *
     * So: after anything disturbs the layout, keep re-reading the rects
     * each frame until they hold still, and push only real changes.
     */
    let frame = 0;
    let settleDeadline = 0;
    let stableFrames = 0;
    let lastKey = "";

    const syncLayout = () => {
      frame = 0;
      const layout = {
        pageBounds: browserPageBounds(page.getBoundingClientRect()),
        surfaceBounds: toBounds(surface.getBoundingClientRect()),
      };
      const collapsed =
        layout.pageBounds.width <= 0 ||
        layout.pageBounds.height <= 0 ||
        layout.surfaceBounds.width <= 0 ||
        layout.surfaceBounds.height <= 0;

      if (!collapsed) {
        const key = boundsKey(layout);
        if (key === lastKey) {
          stableFrames += 1;
        } else {
          lastKey = key;
          stableFrames = 0;
          if (shownRef.current) void api.setLayout(layout);
          else {
            shownRef.current = true;
            void api.show(layout);
          }
        }
      }

      // A collapsed rect means the panel hasn't opened far enough to
      // measure yet — keep watching rather than counting it as settled.
      if (
        (collapsed || stableFrames < LAYOUT_SETTLE_FRAMES) &&
        performance.now() < settleDeadline
      ) {
        scheduleFrame();
      }
    };

    const scheduleFrame = () => {
      if (!frame) frame = requestAnimationFrame(syncLayout);
    };
    const watchLayout = () => {
      settleDeadline = performance.now() + LAYOUT_SETTLE_MS;
      stableFrames = 0;
      scheduleFrame();
    };

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(watchLayout);
    observer?.observe(surface);
    observer?.observe(page);
    window.addEventListener("resize", watchLayout);
    /* The width ease is the common case and the settle window above
       already covers it, but a transition that starts later (expand
       toggle, breakpoint swap) moves the frame after we've stopped
       watching. Bind on the animating ancestor itself — `transitionend`
       bubbles up from descendants, never down from an ancestor, so a
       listener on `surface` would never hear the panel's own ease. */
    const panel = surface.closest(".right-sidebar");
    panel?.addEventListener("transitionend", watchLayout);
    watchLayout();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", watchLayout);
      panel?.removeEventListener("transitionend", watchLayout);
      if (shownRef.current) void api.hide();
      shownRef.current = false;
    };
  }, [activeTabId, localError, state.error, visible]);

  const requestExtension = useCallback(async () => {
    const api = browserViewApi();
    if (!api || connectingExtension) return;
    setConnectingExtension(true);
    setLocalError(null);
    try {
      await api.requestExtensionConnect();
      await connect();
    } catch (error) {
      if (mountedRef.current) {
        setLocalError(
          error instanceof Error
            ? error.message
            : "Couldn’t connect the extension.",
        );
      }
    } finally {
      if (mountedRef.current) setConnectingExtension(false);
    }
  }, [connect, connectingExtension]);

  const runTabAction = useCallback(
    (
      action: (
        api: BrowserViewApi,
        tabId: string,
        ownerId: string,
      ) => Promise<unknown>,
    ) => {
      if (!activeTab) return;
      const api = browserViewApi();
      if (!api) return;
      setLocalError(null);
      void action(api, activeTab.id, activeTab.ownerId).catch(
        (error: unknown) => {
          if (mountedRef.current) {
            setLocalError(
              error instanceof Error ? error.message : "Browser action failed.",
            );
          }
        },
      );
    },
    [activeTab],
  );

  const createConversationTab = useCallback(() => {
    const api = browserViewApi();
    if (!api) return;
    setLocalError(null);
    void api
      .createTab({ ownerId: scopedOwnerId, activate: true })
      .then((next) => {
        if (mountedRef.current && isBrowserViewState(next)) setState(next);
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setLocalError(
          error instanceof Error ? error.message : "Couldn’t create a tab.",
        );
      });
  }, [scopedOwnerId]);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const url = normalizeAddress(address);
    if (!url) return;
    runTabAction((api, tabId, ownerId) =>
      api.navigate({ tabId, url, ownerId }),
    );
  };

  const error = localError ?? state.error;
  let statusKind: BrowserStatusKind = "connected";
  if (localError) statusKind = "error";
  else if (connectingExtension) statusKind = "setup_required";
  else if (state.connection === "checking") statusKind = "checking";
  else if (state.connection === "disconnected") {
    statusKind =
      !state.unavailableReason ||
      state.unavailableReason === "extension_not_installed"
        ? "setup_required"
        : state.unavailableReason;
  } else if (error) statusKind = "error";
  else if (preparing && state.tabs.length === 0) statusKind = "preparing";

  return (
    <section
      ref={surfaceRef}
      className="browser-section"
      data-connection={state.connection}
      aria-label="Browser"
    >
      {activeTab && !error ? (
        <>
          <div className="browser-section__chrome">
            <div
              className="browser-section__tabs"
              role="tablist"
              aria-label="Browser tabs"
            >
              {state.tabs.map((tab) => {
                const active = tab.id === activeTab.id;
                return (
                  <div
                    key={tab.id}
                    className="browser-section__tab-shell"
                    data-active={active || undefined}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className="browser-section__tab"
                      title={tab.title || tab.url || "New tab"}
                      onClick={() =>
                        void browserViewApi()?.selectTab({
                          tabId: tab.id,
                          ownerId: tab.ownerId,
                          activate: true,
                        })
                      }
                    >
                      {tab.faviconUrl ? (
                        <img
                          className="browser-section__favicon"
                          src={tab.faviconUrl}
                          alt=""
                        />
                      ) : (
                        <Globe
                          size={13}
                          strokeWidth={1.75}
                          aria-hidden="true"
                        />
                      )}
                      <span>{tab.title || "New tab"}</span>
                    </button>
                    <button
                      type="button"
                      className="browser-section__tab-close"
                      aria-label={`Close ${tab.title || "tab"}`}
                      onClick={() =>
                        void browserViewApi()?.closeTab({
                          tabId: tab.id,
                          ownerId: tab.ownerId,
                        })
                      }
                    >
                      <X size={12} strokeWidth={1.8} />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="browser-section__chrome-button browser-section__new-tab"
                aria-label="New tab"
                title="New tab"
                onClick={createConversationTab}
              >
                <Plus size={14} strokeWidth={1.8} />
              </button>
            </div>

            <form className="browser-section__navigation" onSubmit={navigate}>
              <button
                type="button"
                className="browser-section__chrome-button"
                aria-label="Go back"
                title="Back"
                disabled={!activeTab.canGoBack}
                onClick={() =>
                  runTabAction((api, tabId, ownerId) =>
                    api.goBack({ tabId, ownerId }),
                  )
                }
              >
                <ArrowLeft size={14} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="browser-section__chrome-button"
                aria-label="Go forward"
                title="Forward"
                disabled={!activeTab.canGoForward}
                onClick={() =>
                  runTabAction((api, tabId, ownerId) =>
                    api.goForward({ tabId, ownerId }),
                  )
                }
              >
                <ArrowRight size={14} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="browser-section__chrome-button"
                aria-label="Reload page"
                title="Reload"
                onClick={() =>
                  runTabAction((api, tabId, ownerId) =>
                    api.reload({ tabId, ownerId }),
                  )
                }
              >
                <RefreshCw
                  className={
                    activeTab.loading ? "stella-loader-circle" : undefined
                  }
                  size={14}
                  strokeWidth={1.8}
                />
              </button>
              <div className="browser-section__address-wrap">
                <Globe size={13} strokeWidth={1.7} aria-hidden="true" />
                <input
                  value={address}
                  onChange={(event) => setAddress(event.currentTarget.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label="Address and search"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
            </form>
            {activeTab.loading ? (
              <div
                className="browser-section__loading-track"
                aria-hidden="true"
              >
                <span />
              </div>
            ) : null}
          </div>
          <div
            ref={pageRef}
            className="browser-section__page"
            aria-busy={activeTab.loading || undefined}
          />
        </>
      ) : (
        <BrowserStatus
          kind={statusKind}
          profileName={state.profileName}
          error={error ?? undefined}
          connectingExtension={connectingExtension}
          onConnect={() => void requestExtension()}
          onRetry={() => void connect()}
          onCreateTab={createConversationTab}
        />
      )}
    </section>
  );
}
