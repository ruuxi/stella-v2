import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  BROWSER_PROFILE_KEY,
  BROWSER_SELECTION_KEY,
} from "@stella/contracts/discovery";
import { uiState } from "@/platform/ui-state";
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

type BrowserTab = {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

type BrowserViewState = {
  connection: BrowserConnection;
  profileName?: string;
  tabs: BrowserTab[];
  activeTabId?: string;
  error?: string;
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
  setLayout: (layout: BrowserLayout) => Promise<unknown> | unknown;
  hide: () => Promise<unknown> | unknown;
  createTab: (options: { url?: string }) => Promise<unknown>;
  selectTab: (options: { tabId: string }) => Promise<unknown>;
  closeTab: (options: { tabId: string }) => Promise<unknown>;
  navigate: (options: { tabId: string; url: string }) => Promise<unknown>;
  goBack: (options: { tabId: string }) => Promise<unknown>;
  goForward: (options: { tabId: string }) => Promise<unknown>;
  reload: (options: { tabId: string }) => Promise<unknown>;
  requestExtensionConnect: () => Promise<unknown>;
  onState: (callback: (state: BrowserViewState) => void) => () => void;
};

const EMPTY_STATE: BrowserViewState = {
  connection: "checking",
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
    Array.isArray(candidate.tabs)
  );
};

function BrowserStatus({
  kind,
  profileName,
  error,
  connectingExtension,
  onConnect,
  onRetry,
}: {
  kind: "checking" | "disconnected" | "connected" | "preparing" | "error";
  profileName?: string;
  error?: string;
  connectingExtension: boolean;
  onConnect: () => void;
  onRetry: () => void;
}) {
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

  if (kind === "error") {
    return (
      <div className="browser-section__status" role="alert">
        <AlertCircle size={22} strokeWidth={1.75} aria-hidden="true" />
        <p className="browser-section__status-title">
          Couldn’t open the browser
        </p>
        <p className="browser-section__status-body">
          {error || "Stella couldn’t prepare the in-app browser."}
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

  if (kind === "disconnected") {
    return (
      <div className="browser-section__status" role="status">
        <span className="browser-section__status-icon" aria-hidden="true">
          <Globe size={21} strokeWidth={1.75} />
        </span>
        <p className="browser-section__status-title">Connect your browser</p>
        <p className="browser-section__status-body">
          Add or enable the Stella browser extension to bring your logged-in
          sites into Stella.
        </p>
        <button
          type="button"
          className="pill-btn pill-btn--primary"
          disabled={connectingExtension}
          onClick={onConnect}
        >
          {connectingExtension ? "Waiting for extension…" : "Connect browser"}
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
    </div>
  );
}

export function BrowserSection() {
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
      setState({ connection: "disconnected", tabs: [] });
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

    let frame = 0;
    const syncLayout = () => {
      frame = 0;
      const layout = {
        pageBounds: toBounds(page.getBoundingClientRect()),
        surfaceBounds: toBounds(surface.getBoundingClientRect()),
      };
      if (
        layout.pageBounds.width <= 0 ||
        layout.pageBounds.height <= 0 ||
        layout.surfaceBounds.width <= 0 ||
        layout.surfaceBounds.height <= 0
      ) {
        return;
      }
      if (shownRef.current) void api.setLayout(layout);
      else {
        shownRef.current = true;
        void api.show(layout);
      }
    };
    const scheduleLayout = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncLayout);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleLayout);
    observer?.observe(surface);
    observer?.observe(page);
    window.addEventListener("resize", scheduleLayout);
    scheduleLayout();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", scheduleLayout);
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
    (action: (api: BrowserViewApi, tabId: string) => Promise<unknown>) => {
      if (!activeTab) return;
      const api = browserViewApi();
      if (!api) return;
      setLocalError(null);
      void action(api, activeTab.id).catch((error: unknown) => {
        if (mountedRef.current) {
          setLocalError(
            error instanceof Error ? error.message : "Browser action failed.",
          );
        }
      });
    },
    [activeTab],
  );

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const url = normalizeAddress(address);
    if (!url) return;
    runTabAction((api, tabId) => api.navigate({ tabId, url }));
  };

  const error = localError ?? state.error;
  const statusKind = error
    ? "error"
    : state.connection === "checking"
      ? "checking"
      : state.connection === "disconnected"
        ? "disconnected"
        : preparing && state.tabs.length === 0
          ? "preparing"
          : "connected";

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
                        void browserViewApi()?.selectTab({ tabId: tab.id })
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
                        void browserViewApi()?.closeTab({ tabId: tab.id })
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
                onClick={() => void browserViewApi()?.createTab({})}
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
                  runTabAction((api, tabId) => api.goBack({ tabId }))
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
                  runTabAction((api, tabId) => api.goForward({ tabId }))
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
                  runTabAction((api, tabId) => api.reload({ tabId }))
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
        />
      )}
    </section>
  );
}
