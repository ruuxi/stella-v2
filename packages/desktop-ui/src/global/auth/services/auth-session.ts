import { useEffect, useSyncExternalStore } from "react";
import { configurePiRuntime } from "@/platform/electron/device";

type AuthSessionResult = {
  data: unknown | null;
  isPending: boolean;
  error: Error | null;
};

let currentSession: AuthSessionResult = {
  data: null,
  isPending: true,
  error: null,
};
const listeners = new Set<() => void>();
let inFlightRefresh: Promise<void> | null = null;

let refreshVersion = 0;

const emit = () => {
  for (const listener of listeners) {
    listener();
  }
};

type RefreshOptions = {

  allowCached?: boolean;

  silent?: boolean;
};

export const refreshAuthSession = async (options: RefreshOptions = {}) => {
  const allowCached = options.allowCached ?? false;

  if (inFlightRefresh && allowCached) {
    await inFlightRefresh;
    return;
  }
  if (inFlightRefresh) {
    await inFlightRefresh.catch(() => {});
  }
  const systemApi = window.electronAPI?.system;
  if (!systemApi?.getAuthSession) {
    currentSession = {
      data: null,
      isPending: false,
      error: new Error("Desktop auth API is unavailable."),
    };
    emit();
    return;
  }
  const version = ++refreshVersion;
  if (!options.silent) {
    currentSession = { ...currentSession, isPending: true, error: null };
    emit();
  }
  inFlightRefresh = configurePiRuntime()
    .then(async () => {

      const first = await systemApi.getAuthSession();
      if (version !== refreshVersion) {
        return;
      }
      if (allowCached && first) {

        currentSession = { data: first, isPending: false, error: null };
        emit();
      }

      const revalidated = await systemApi.getAuthSession();
      if (version !== refreshVersion) {
        return;
      }
      currentSession = { data: revalidated, isPending: false, error: null };
    })
    .catch((error) => {
      if (version !== refreshVersion) {
        return;
      }
      currentSession = {
        data: null,
        isPending: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    })
    .finally(() => {
      inFlightRefresh = null;
      if (version === refreshVersion) {
        emit();
      }
    });
  await inFlightRefresh;
};

export const signInAnonymous = async () => {
  await configurePiRuntime();
  await window.electronAPI?.system.signInAnonymous?.();
  await refreshAuthSession();
};

export const signOutAuthSession = async () => {
  await window.electronAPI?.system.signOutAuth?.();

  refreshVersion += 1;
  currentSession = { data: null, isPending: false, error: null };
  emit();
};

export const deleteAuthUser = async () => {
  await window.electronAPI?.system.deleteAuthUser?.();
  refreshVersion += 1;
  currentSession = { data: null, isPending: false, error: null };
  emit();
};

export function getAuthSessionSnapshot(): AuthSessionResult {
  return currentSession;
}

function subscribeAuthSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const EVENT_REVALIDATE_THROTTLE_MS = 60_000;
let lastEventRevalidateAt = 0;
let revalidationListenersBound = false;

const revalidateAuthSessionFromEvent = () => {

  if (inFlightRefresh) {
    return;
  }
  const now = Date.now();
  if (now - lastEventRevalidateAt < EVENT_REVALIDATE_THROTTLE_MS) {
    return;
  }
  lastEventRevalidateAt = now;

  void refreshAuthSession({ silent: true });
};

const handleVisibilityChange = () => {
  if (document.visibilityState === "visible") {
    revalidateAuthSessionFromEvent();
  }
};

function ensureAuthSessionRevalidationListeners() {
  if (revalidationListenersBound || typeof window === "undefined") {
    return;
  }
  revalidationListenersBound = true;
  window.addEventListener("focus", revalidateAuthSessionFromEvent);
  window.addEventListener("online", revalidateAuthSessionFromEvent);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }
}

export function useDesktopAuthSession() {

  const snapshot = useSyncExternalStore(
    subscribeAuthSession,
    getAuthSessionSnapshot,
  );

  useEffect(() => {
    if (currentSession.isPending && !inFlightRefresh) {
      void refreshAuthSession({ allowCached: true });
    }
    ensureAuthSessionRevalidationListeners();
  }, []);

  return snapshot;
}
