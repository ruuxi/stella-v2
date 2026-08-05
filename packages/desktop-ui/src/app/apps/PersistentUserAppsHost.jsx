import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LoaderCircle } from "@/ui/icons";
import {
  getServerSnapshot,
  getSnapshot,
  subscribe,
} from "./user-apps-registry";
import {
  useActiveSidebarSection,
  useSidebarSectionLocation,
} from "@/features/workspace-display/sidebar-sections";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
import {
  countingDownUserApps,
  onScreenUserAppSlug,
  mountedUserApps,
  promoteRetainedUserApp,
  USER_APP_TEARDOWN_MS,
} from "./user-app-keep-alive";

const appLeases = new Map();

const startApp = (slug) => {
  const api = window.electronAPI?.userApps;
  if (typeof api?.start !== "function") {
    return Promise.reject(new Error("Apps are unavailable on this device."));
  }
  return Promise.resolve(api.start(slug)).then((result) => {
    if (!result || typeof result.url !== "string" || !result.url.trim()) {
      throw new Error(
        result?.error || "The app did not provide a usable address.",
      );
    }
    if (result.status === "error") {
      throw new Error(result.error || "The app failed to start.");
    }
    return result.url;
  });
};

const acquireApp = (slug) => {
  let lease = appLeases.get(slug);
  if (lease?.failed) {
    if (lease.stopTimer !== null) window.clearTimeout(lease.stopTimer);
    appLeases.delete(slug);
    lease = null;
  }
  if (!lease) {
    lease = {
      refs: 0,
      stopTimer: null,
      failed: false,
      startPromise: null,
    };
    lease.startPromise = startApp(slug).catch((error) => {
      lease.failed = true;
      throw error;
    });
    appLeases.set(slug, lease);
  }
  lease.refs += 1;
  if (lease.stopTimer !== null) {
    window.clearTimeout(lease.stopTimer);
    lease.stopTimer = null;
  }
  return lease.startPromise;
};

const releaseApp = (slug) => {
  const lease = appLeases.get(slug);
  if (!lease) return;
  lease.refs = Math.max(0, lease.refs - 1);
  if (lease.refs > 0 || lease.stopTimer !== null) return;
  // Delay the final release by one task. React StrictMode deliberately runs
  // effect setup → cleanup → setup; the second acquire cancels this stop so
  // development never races a fresh start against its stale cleanup.
  lease.stopTimer = window.setTimeout(() => {
    lease.stopTimer = null;
    if (lease.refs > 0 || appLeases.get(slug) !== lease) return;
    void lease.startPromise
      .catch(() => null)
      .then(() => window.electronAPI?.userApps?.stop?.(slug))
      .catch(() => undefined)
      .finally(() => {
        if (lease.refs === 0 && appLeases.get(slug) === lease) {
          appLeases.delete(slug);
        }
      });
  }, 0);
};

function UserAppFrame({ app, active }) {
  const iframeRef = useRef(null);
  const [load, setLoad] = useState({
    status: "loading",
    url: null,
    error: null,
  });
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading", url: null, error: null });
    void acquireApp(app.slug).then(
      (url) => {
        if (!cancelled) setLoad({ status: "loading", url, error: null });
      },
      (error) => {
        if (!cancelled) {
          setLoad({
            status: "error",
            url: null,
            error:
              error instanceof Error
                ? error.message
                : "The app failed to start.",
          });
        }
      },
    );
    return () => {
      cancelled = true;
      releaseApp(app.slug);
    };
  }, [app.slug, retryKey]);

  useEffect(() => {
    if (!active) iframeRef.current?.blur();
  }, [active]);

  useEffect(() => {
    if (!load.url || load.status !== "loading") return;
    const timer = window.setTimeout(() => {
      setLoad((current) =>
        current.status === "loading"
          ? {
              ...current,
              status: "error",
              error: "The app took too long to load.",
            }
          : current,
      );
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [load.status, load.url]);

  return (
    <>
      {load.url ? (
        <iframe
          ref={iframeRef}
          className="persistent-user-app-frame"
          src={load.url}
          title={app.meta.label}
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-same-origin"
          onLoad={() =>
            setLoad((current) => ({ ...current, status: "ready", error: null }))
          }
          onError={() =>
            setLoad((current) => ({
              ...current,
              status: "error",
              error: "The app couldn’t be loaded.",
            }))
          }
        />
      ) : null}
      {load.status === "loading" ? (
        <div
          className="persistent-user-app-status"
          role="status"
          aria-live="polite"
        >
          <LoaderCircle
            className="stella-loader-circle"
            size={18}
            strokeWidth={2}
            aria-hidden="true"
          />
          <span>Loading {app.meta.label}…</span>
        </div>
      ) : null}
      {load.status === "error" ? (
        <div className="persistent-user-app-status" role="alert">
          <strong>Couldn’t open {app.meta.label}</strong>
          <span>{load.error}</span>
          <button
            type="button"
            className="pill-btn pill-btn--primary"
            onClick={() => setRetryKey((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      ) : null}
    </>
  );
}

/**
 * Keeps each started webapp's iframe mounted in its final sidebar location.
 * Hidden apps retain their browsing context until MRU eviction or the
 * 30-minute teardown, at which point their loopback server lease is stopped.
 */
export function PersistentUserAppsHost() {
  const registry = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const apps = registry.apps;
  const openSlug = useSidebarSectionLocation("apps");
  const activeSection = useActiveSidebarSection();
  const panelOpen = useDisplayPanelOpen();
  const activeSlug =
    openSlug !== null && apps.some((app) => app.slug === openSlug)
      ? openSlug
      : null;
  const [retained, setRetained] = useState([]);
  const teardownTimersRef = useRef(new Map());
  const onScreenSlug = onScreenUserAppSlug({
    activeSlug,
    activeSection,
    panelOpen,
  });

  useEffect(() => {
    if (onScreenSlug === null) return;
    setRetained((previous) => promoteRetainedUserApp(previous, onScreenSlug));
  }, [onScreenSlug]);

  useEffect(() => {
    const timers = teardownTimersRef.current;
    const countingDown = new Set(countingDownUserApps(retained, onScreenSlug));
    for (const [slug, id] of timers) {
      if (countingDown.has(slug)) continue;
      window.clearTimeout(id);
      timers.delete(slug);
    }
    for (const slug of countingDown) {
      if (timers.has(slug)) continue;
      const id = window.setTimeout(() => {
        timers.delete(slug);
        setRetained((previous) => previous.filter((entry) => entry !== slug));
      }, USER_APP_TEARDOWN_MS);
      timers.set(slug, id);
    }
  }, [onScreenSlug, retained]);

  useEffect(() => {
    const timers = teardownTimersRef.current;
    return () => {
      for (const id of timers.values()) window.clearTimeout(id);
      timers.clear();
    };
  }, []);

  return (
    <>
      {mountedUserApps(retained, onScreenSlug).map((slug) => {
        const app = apps.find((entry) => entry.slug === slug);
        if (!app) return null;
        const isActive = slug === onScreenSlug;
        return (
          <div
            key={slug}
            className={`persistent-user-app-surface${isActive ? " persistent-user-app-surface--active" : ""}`}
            aria-hidden={!isActive}
            inert={!isActive}
          >
            <UserAppFrame app={app} active={isActive} />
          </div>
        );
      })}
    </>
  );
}

export const __resetUserAppLeasesForTests = () => {
  for (const lease of appLeases.values()) {
    if (lease.stopTimer !== null) window.clearTimeout(lease.stopTimer);
  }
  appLeases.clear();
};
