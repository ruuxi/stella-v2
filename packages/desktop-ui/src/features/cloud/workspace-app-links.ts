import {
  parseWorkspaceApps,
  type WorkspaceApp,
} from "@stella/contracts/workspace-apps";
import { useEffect, useSyncExternalStore } from "react";
import { getAuthHeaders } from "@/global/auth/services/auth-token";
import { backendUrl } from "@/platform/backend/backend-client";

/**
 * The cloud apps a reply links (`stella://app/<slug>`): one shared app list
 * for every card in the transcript, refetched when a reply names an app the
 * list does not have yet, plus each app's preview still as an object URL.
 */

const REFRESH_AFTER_MS = 15_000;

type AppsState = { apps: WorkspaceApp[] | null; loading: boolean };
let state: AppsState = { apps: null, loading: false };
let fetchedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const setState = (next: Partial<AppsState>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function refreshApps(): Promise<void> {
  if (inflight) return inflight;
  if (!backendUrl) return Promise.resolve();
  setState({ loading: true });
  inflight = (async () => {
    try {
      const response = await fetch(`${backendUrl}/owners/me/apps`, {
        headers: await getAuthHeaders(),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return;
      const apps = parseWorkspaceApps((await response.json()).apps);
      fetchedAt = Date.now();
      setState({ apps });
    } catch {
      // The card keeps its loading look; the next mount retries.
    } finally {
      inflight = null;
      setState({ loading: false });
    }
  })();
  return inflight;
}

/** The linked app, `undefined` while loading, `null` when not a ready app. */
export function useLinkedCloudApp(
  slug: string,
): WorkspaceApp | null | undefined {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  const app = snapshot.apps?.find((entry) => entry.slug === slug);
  const known = app !== undefined;
  useEffect(() => {
    if (!known || Date.now() - fetchedAt > REFRESH_AFTER_MS)
      void refreshApps();
  }, [slug, known]);
  if (app) return app.status === "ready" ? app : null;
  return snapshot.apps === null || snapshot.loading ? undefined : null;
}

const previews = new Map<string, Promise<string | null>>();

/**
 * The app's preview still for its current revision. The backend captures it
 * on the first request, so the first load can take several seconds.
 */
export function loadCloudAppPreview(app: WorkspaceApp): Promise<string | null> {
  const key = `${app.slug}:${app.revision}`;
  let pending = previews.get(key);
  if (!pending) {
    pending = (async () => {
      if (!backendUrl) return null;
      const response = await fetch(
        `${backendUrl}/owners/me/apps/${encodeURIComponent(app.slug)}/preview?v=${encodeURIComponent(app.revision)}`,
        {
          headers: await getAuthHeaders(),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!response.ok) throw new Error("Preview unavailable");
      return URL.createObjectURL(await response.blob());
    })().catch(() => {
      // Let a later mount try again.
      previews.delete(key);
      return null;
    });
    previews.set(key, pending);
  }
  return pending;
}
