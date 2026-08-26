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
  // Background revalidation (window focus / regain, network reconnect): keep the
  // last-known session visible instead of flipping `isPending` to true, so the
  // signed-in/out gating and UI don't flash "loading" while we re-check with the
  // server. The committed result is still the authoritative revalidated session
  // (it can downgrade to signed-out if the server rejected the session).
  silent?: boolean;
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
  const version = ++refreshVersion;
  if (!options.silent) {
    setCurrentSession({
      data: currentSession.data,
      isPending: true,
      error: null,
    });
    emit();
  }
  if (!systemApi?.getAuthSession) {
    inFlightRefresh = Promise.resolve()
      .then(async () => {
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
      })
      .catch((error) => {
        if (version !== refreshVersion) return;
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
    return;
  }
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

type PendingBrowserAuthHandoff =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "token"; token: string };

const consumePendingBrowserAuthHandoff = (): PendingBrowserAuthHandoff => {
  if (typeof window === "undefined" || window.electronAPI) {
    return { kind: "none" };
  }
  const query = new URLSearchParams(window.location.search);
  if (
    window.location.pathname === "/auth/callback" &&
    query.get("client") === "desktop"
  ) {
    return { kind: "none" };
  }

  const rawFragment = window.location.hash.replace(/^#\??/, "");
  const hasHandoffCredential =
    rawFragment.length > 0 && new URLSearchParams(rawFragment).has("ott");
  const token = consumeBrowserAuthHandoffToken(window.location, window.history);
  if (token) {
    return { kind: "token", token };
  }
  return hasHandoffCredential ? { kind: "invalid" } : { kind: "none" };
};

const redeemPendingBrowserAuthHandoff =
  async (): Promise<BrowserAuthHandoffResult> => {
    const handoff = consumePendingBrowserAuthHandoff();
    if (handoff.kind === "none") {
      return "none";
    }
    if (handoff.kind === "invalid") {
      // The malformed credential was already erased. Treat it as a terminal
      // handoff failure so anonymous bootstrap cannot overwrite the intended
      // account transition.
      console.error("Failed to finish browser sign-in.");
      return "failed";
    }

    try {
      ensureBrowserAuthBootstrapCookie();
      const result = await authClient.crossDomain.oneTimeToken.verify({
        token: handoff.token,
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
  if (!window.electronAPI) {
    ensureBrowserAuthBootstrapCookie();
    const result = await authClient.signIn.anonymous();
    if (result.error) {
      throw new Error(
        result.error.message ?? "Could not start a browser session.",
      );
    }
    if (!authClient.getCookie().includes("session_token=")) {
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
  if (!window.electronAPI.system.signInAnonymous) {
    throw new Error("Desktop anonymous sign-in is unavailable.");
  }
  await configurePiRuntime();
  await window.electronAPI.system.signInAnonymous();
  await refreshAuthSession();
};

export const signOutAuthSession = async () => {
  if (!window.electronAPI) {
    await authClient.signOut();
  } else {
    if (!window.electronAPI.system.signOutAuth) {
      throw new Error("Desktop sign-out is unavailable.");
    }
    await window.electronAPI.system.signOutAuth();
  }
  // Invalidate any in-flight optimistic refresh so a late revalidated emit
  // can't resurrect the signed-out session.
  refreshVersion += 1;
  setCurrentSession({ data: null, isPending: false, error: null });
  emit();
};

export const deleteAuthUser = async () => {
  if (!window.electronAPI) {
    await authClient.deleteUser();
  } else {
    if (!window.electronAPI.system.deleteAuthUser) {
      throw new Error("Desktop account deletion is unavailable.");
    }
    await window.electronAPI.system.deleteAuthUser();
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

// Background revalidation is event-driven rather than polled: the desktop
// session store issues NO periodic `/api/auth/get-session` traffic while idle.
// Instead we re-check the session on the events that can actually change auth
// state out from under an idle window — the window/tab regaining focus and the
// network coming back — plus the explicit auth mutations (sign-in / sign-out /
// magic-link / deep-link) that already call `refreshAuthSession` directly. This
// keeps sign-out (incl. from another device / server-side expiry) and
// subscription/plan changes propagating promptly without a tight interval.
//
// Focus / visibility / online can fire in quick bursts (alt-tab storms, flaky
// networks), so collapse them into at most one authoritative revalidation per
// this window.
const EVENT_REVALIDATE_THROTTLE_MS = 60_000;
let lastEventRevalidateAt = 0;
let revalidationListenersBound = false;

const revalidateAuthSessionFromEvent = () => {
  // Skip if a refresh (cold-start, mutation, or a prior event) is already in
  // flight — that pending result is at least as fresh as this event.
  if (inFlightRefresh) {
    return;
  }
  const now = Date.now();
  if (now - lastEventRevalidateAt < EVENT_REVALIDATE_THROTTLE_MS) {
    return;
  }
  lastEventRevalidateAt = now;
  // Silent so the session gating never flashes back to "loading" on a routine
  // focus/reconnect re-check.
  void refreshAuthSession({ silent: true });
};

const handleVisibilityChange = () => {
  if (document.visibilityState === "visible") {
    revalidateAuthSessionFromEvent();
  }
};

// Bind the focus/visibility/reconnect revalidation listeners exactly once for
// this renderer. Intentionally never unbound: the listeners live for the app's
// lifetime, and many components consume `useDesktopAuthSession`, so tying
// removal to any single consumer's unmount would be wrong.
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
      void waitForBrowserAuthHandoff().then((handoff) => {
        if (
          handoff !== "failed" &&
          currentSession.isPending &&
          !inFlightRefresh
        ) {
          void refreshAuthSession({ allowCached: true });
        }
      });
    }
    ensureAuthSessionRevalidationListeners();
  }, []);

  return snapshot;
}
