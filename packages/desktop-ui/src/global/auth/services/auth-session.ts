import { useEffect, useSyncExternalStore } from "react";
import { configurePiRuntime } from "@/platform/electron/device";
import { authClient } from "@/global/auth/lib/auth-client";
import { ensureBrowserAuthBootstrapCookie } from "./auth-storage";
import {
  consumeBrowserAuthHandoffToken,
  type BrowserAuthHandoffResult,
} from "../browser-auth-handoff";
import {
  advanceAuthIdentityRevision,
  resolveAuthSessionCacheScope,
  type AuthSessionScopeData,
} from "../lib/auth-session-scope";

type AuthSessionResult = {
  data: unknown | null;
  isPending: boolean;
  error: Error | null;
  /** Monotonic nonce that changes whenever the durable owner identity changes. */
  identityRevision: number;
};

let identityRevision = 0;
let currentIdentityScope = resolveAuthSessionCacheScope(null);
let currentSession: AuthSessionResult = {
  data: null,
  isPending: true,
  error: null,
  identityRevision,
};
const listeners = new Set<() => void>();
let inFlightRefresh: Promise<void> | null = null;
// Monotonic guard so a slow optimistic-then-revalidate sequence can never
// clobber the result of a newer refresh (e.g. a sign-in fired mid-revalidation).
let refreshVersion = 0;

const setCurrentSession = (
  next: Omit<AuthSessionResult, "identityRevision">,
): void => {
  const nextIdentity = advanceAuthIdentityRevision({
    currentScope: currentIdentityScope,
    currentRevision: identityRevision,
    nextSessionData: next.data as AuthSessionScopeData,
  });
  currentIdentityScope = nextIdentity.scope;
  identityRevision = nextIdentity.revision;
  currentSession = { ...next, identityRevision };
};

const emit = () => {
  for (const listener of listeners) {
    listener();
  }
};

type RefreshOptions = {
  // When true, accept the host's optimistically-hydrated (cached) session on the
  // first read so `isAuthenticated` can flip before the network settles, then
  // re-read for the authoritative (revalidated) session. Used by the cold-start
  // mount path. Sign-in / magic-link / deep-link callers leave this false so
  // they always observe the authoritative network result directly.
  allowCached?: boolean;
};

export const refreshAuthSession = async (options: RefreshOptions = {}) => {
  const allowCached = options.allowCached ?? false;
  // Coalesce concurrent optimistic refreshes, but never let an authoritative
  // refresh (e.g. post-sign-in) be swallowed by an in-flight optimistic one.
  if (inFlightRefresh && allowCached) {
    await inFlightRefresh;
    return;
  }
  if (inFlightRefresh) {
    await inFlightRefresh.catch(() => {});
  }
  const systemApi = window.electronAPI?.system;
  if (!systemApi?.getAuthSession) {
    const version = ++refreshVersion;
    setCurrentSession({
      data: currentSession.data,
      isPending: true,
      error: null,
    });
    emit();
    try {
      const result = await authClient.getSession();
      if (version !== refreshVersion) return;
      setCurrentSession({
        data: result.data ?? null,
        isPending: false,
        error: result.error
          ? new Error(
              result.error.message ?? "Could not read the browser session.",
            )
          : null,
      });
    } catch (error) {
      if (version !== refreshVersion) return;
      setCurrentSession({
        data: null,
        isPending: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
    emit();
    return;
  }
  const version = ++refreshVersion;
  setCurrentSession({
    data: currentSession.data,
    isPending: true,
    error: null,
  });
  emit();
  inFlightRefresh = configurePiRuntime()
    .then(async () => {
      // First read. With optimistic hydration the host may return a persisted
      // session immediately (no network) while it revalidates in the background.
      const first = await systemApi.getAuthSession();
      if (version !== refreshVersion) {
        return;
      }
      if (allowCached && first) {
        // Surface the cached session right away (isPending:false) so Convex sees
        // isAuthenticated && !isLoading and starts fetching the access token /
        // running authenticated queries before get-session revalidation settles.
        setCurrentSession({ data: first, isPending: false, error: null });
        emit();
      }
      // Authoritative follow-up read. The host returns the revalidated session
      // here (joining its in-flight revalidation, or the recorded result),
      // downgrading to null if it rejected the revalidation (401/403/404). This
      // also protects authoritative callers (sign-in / link) from ever emitting
      // a stale optimistic value: they skip the early emit above and only commit
      // this revalidated result.
      const revalidated = await systemApi.getAuthSession();
      if (version !== refreshVersion) {
        return;
      }
      setCurrentSession({
        data: revalidated,
        isPending: false,
        error: null,
      });
    })
    .catch((error) => {
      if (version !== refreshVersion) {
        return;
      }
      setCurrentSession({
        data: null,
        isPending: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    })
    .finally(() => {
      inFlightRefresh = null;
      if (version === refreshVersion) {
        emit();
      }
    });
  await inFlightRefresh;
};

const consumePendingBrowserAuthHandoffToken = (): string | null => {
  if (typeof window === "undefined" || window.electronAPI) return null;
  const params = new URLSearchParams(window.location.search);
  if (
    window.location.pathname === "/auth/callback" &&
    params.get("client") === "desktop"
  ) {
    return null;
  }
  return consumeBrowserAuthHandoffToken(window.location, window.history);
};

const redeemPendingBrowserAuthHandoff =
  async (): Promise<BrowserAuthHandoffResult> => {
    const token = consumePendingBrowserAuthHandoffToken();
    if (!token) {
      return "none";
    }

    try {
      ensureBrowserAuthBootstrapCookie();
      const result = await authClient.crossDomain.oneTimeToken.verify({
        token,
      });
      if (result.error) {
        throw new Error("Browser auth handoff verification failed.");
      }
      if (!authClient.getCookie().includes("session_token=")) {
        throw new Error("Browser auth handoff did not establish a session.");
      }
      authClient.updateSession();
      await refreshAuthSession();
      if (!currentSession.data) {
        throw new Error("Browser auth handoff session could not be verified.");
      }
      return "redeemed";
    } catch {
      // The credential has already been removed from the URL. Do not log it,
      // retry it implicitly, or fall through to anonymous-session creation:
      // an ambiguous POST failure may still have redeemed it server-side.
      console.error("Failed to finish browser sign-in.");
      return "failed";
    }
  };

// Module initialization starts this before React mounts. Automatic anonymous
// bootstrap awaits the same promise, so it cannot race or overwrite a valid
// cross-domain session handoff.
const browserAuthHandoffPromise = redeemPendingBrowserAuthHandoff();

export const waitForBrowserAuthHandoff =
  (): Promise<BrowserAuthHandoffResult> => browserAuthHandoffPromise;

export const signInAnonymous = async () => {
  if (!window.electronAPI?.system.signInAnonymous) {
    ensureBrowserAuthBootstrapCookie();
    const result = await authClient.signIn.anonymous();
    if (result.error) {
      throw new Error(
        result.error.message ?? "Could not start a browser session.",
      );
    }
    const mirroredCookie = authClient.getCookie();
    if (!mirroredCookie.includes("session_token=")) {
      throw new Error(
        "The browser session cookie was not mirrored by the auth service.",
      );
    }
    await refreshAuthSession();
    if (!currentSession.data) {
      throw new Error(
        "The browser session could not be verified after sign-in.",
      );
    }
    return;
  }
  await configurePiRuntime();
  await window.electronAPI.system.signInAnonymous();
  await refreshAuthSession();
};

export const signOutAuthSession = async () => {
  if (window.electronAPI?.system.signOutAuth) {
    await window.electronAPI.system.signOutAuth();
  } else {
    await authClient.signOut();
  }
  // Invalidate any in-flight optimistic refresh so a late revalidated emit
  // can't resurrect the signed-out session.
  refreshVersion += 1;
  setCurrentSession({ data: null, isPending: false, error: null });
  emit();
};

export const deleteAuthUser = async () => {
  if (window.electronAPI?.system.deleteAuthUser) {
    await window.electronAPI.system.deleteAuthUser();
  } else {
    await authClient.deleteUser();
  }
  refreshVersion += 1;
  setCurrentSession({ data: null, isPending: false, error: null });
  emit();
};

export function getAuthSessionSnapshot(): AuthSessionResult {
  return currentSession;
}

// Stable subscribe for `useSyncExternalStore`: registers the store listener
// and returns its unsubscribe. Defined at module scope so its identity never
// changes across renders.
function subscribeAuthSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDesktopAuthSession() {
  // useSyncExternalStore subscribes and reads the snapshot in one atomic step,
  // so an emit that lands between render and the mount effect can't be missed
  // (React re-reads getSnapshot after subscribing) — the stale-snapshot /
  // stuck-isPending gap of the old useState+useEffect pair is gone.
  const snapshot = useSyncExternalStore(
    subscribeAuthSession,
    getAuthSessionSnapshot,
  );

  // Kick off a cold-start refresh when we mount still pending. The guard keeps
  // this from stacking on an in-flight refresh. Browser session discovery also
  // waits for an OTT handoff to settle so an older cached/anonymous identity is
  // never surfaced while the intended account exchange is still in flight.
  useEffect(() => {
    if (currentSession.isPending && !inFlightRefresh) {
      void waitForBrowserAuthHandoff().then(() => {
        if (currentSession.isPending && !inFlightRefresh) {
          void refreshAuthSession({ allowCached: true });
        }
      });
    }
  }, []);

  return snapshot;
}
