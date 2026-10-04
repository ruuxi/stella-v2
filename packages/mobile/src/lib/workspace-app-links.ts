import {
  parseWorkspaceApps,
  type WorkspaceApp,
} from "@stella/contracts/workspace-apps";
import { router } from "expo-router";
import { useEffect, useSyncExternalStore } from "react";
import { env } from "../config/env";
import { getAuthToken } from "./auth-token";

/**
 * What the chat knows about the owner's cloud apps: the app list behind the
 * cards a reply's `stella://app/<slug>` links become, and a pending "open this
 * app" request the Apps tab picks up. The Apps tab shares its own list here so
 * the two never disagree for long.
 */

const REFRESH_AFTER_MS = 15_000;

type AppsState = { apps: WorkspaceApp[] | null; loading: boolean };
let state: AppsState = { apps: null, loading: false };
let fetchedAt = 0;
let inflight: Promise<void> | null = null;
let pendingOpen: string | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The Apps tab's freshly loaded list. */
export function shareWorkspaceApps(list: WorkspaceApp[]) {
  state = { ...state, apps: list };
  fetchedAt = Date.now();
  notify();
}

const setLoading = (loading: boolean) => {
  state = { ...state, loading };
  notify();
};

function refreshWorkspaceApps(): Promise<void> {
  if (inflight) return inflight;
  if (!env.backendUrl) return Promise.resolve();
  setLoading(true);
  inflight = (async () => {
    try {
      const token = await getAuthToken();
      const response = await fetch(`${env.backendUrl}/owners/me/apps`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return;
      shareWorkspaceApps(parseWorkspaceApps((await response.json()).apps));
    } catch {
      // A card stays in its loading look; the next mount retries.
    } finally {
      inflight = null;
      setLoading(false);
    }
  })();
  return inflight;
}

/**
 * The app a reply links: the app, `undefined` while the list loads, or `null`
 * when the owner has no ready app by that slug.
 */
export function useWorkspaceApp(slug: string): WorkspaceApp | null | undefined {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  const app = snapshot.apps?.find((entry) => entry.slug === slug);
  const known = app !== undefined;
  useEffect(() => {
    // A reply can link an app the cached list predates, so a missing slug
    // refetches once; a known one refreshes when the list has gone stale.
    if (!known || Date.now() - fetchedAt > REFRESH_AFTER_MS)
      void refreshWorkspaceApps();
  }, [slug, known]);
  if (app) return app.status === "ready" ? app : null;
  return snapshot.apps === null || snapshot.loading ? undefined : null;
}

/** Open an app from the chat: the Apps tab takes the request and opens it. */
export function requestOpenApp(slug: string) {
  pendingOpen = slug;
  notify();
  router.push("/apps");
}

export function usePendingAppOpen(): string | null {
  return useSyncExternalStore(subscribe, () => pendingOpen);
}

export function clearPendingAppOpen() {
  pendingOpen = null;
  notify();
}

/** Signed-in fetch of the app's preview still, keyed by revision. */
export const workspaceAppPreviewUrl = (app: WorkspaceApp): string | null =>
  env.backendUrl
    ? `${env.backendUrl}/owners/me/apps/${encodeURIComponent(app.slug)}/preview?v=${encodeURIComponent(app.revision)}`
    : null;
