import { useEffect, useSyncExternalStore } from "react";
import {
  getAuthSessionIdentityIntent,
  getAuthSnapshotSession,
  isRecognizedAuthRejection,
  resolveAuthSessionObservation,
  type AuthSessionSnapshot,
} from "@stella/contracts/auth-session";
import { configurePiRuntime } from "@/platform/electron/device";
import {
  captchaHeaders,
  getPlatformChallengeToken,
} from "@/platform/auth/challenge-token";
import { getStellaInteriorBridge } from "@/platform/interior/interior-bridge";
import { authClient } from "@/global/auth/lib/auth-client";
import {
  clearBrowserSessionToken,
  readBrowserCachedSession,
  readBrowserIdentityIntent,
  readBrowserSessionToken,
  writeBrowserCachedSession,
  writeBrowserIdentityIntent,
} from "./auth-storage";
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
  snapshot: AuthSessionSnapshot;
  status: AuthSessionSnapshot["status"];
  data: unknown | null;
  isPending: boolean;
  error: Error | null;
  /** Monotonic nonce that changes whenever the durable owner identity changes. */
  identityRevision: number;
};

let identityRevision = 0;
const initialCachedSession =
  typeof window !== "undefined" &&
  !window.electronAPI &&
  !getStellaInteriorBridge()
    ? readBrowserCachedSession()
    : null;
const initialIdentityIntent =
  typeof window !== "undefined" &&
  !window.electronAPI &&
  !getStellaInteriorBridge()
    ? (readBrowserIdentityIntent() ??
      getAuthSessionIdentityIntent(initialCachedSession))
    : null;
let currentIdentityScope = resolveAuthSessionCacheScope(
  initialCachedSession as AuthSessionScopeData,
);
if (initialCachedSession) identityRevision = 1;
const initialSnapshot: AuthSessionSnapshot = {
  status: "unknown",
  identityIntent: initialIdentityIntent,
  staleSession: initialCachedSession,
  error: { kind: "ipc", message: "Auth session initialization is pending." },
};
let currentSession: AuthSessionResult = {
  snapshot: initialSnapshot,
  status: initialSnapshot.status,
  data: initialCachedSession,
  isPending: !initialCachedSession,
  error: null,
  identityRevision,
};
const listeners = new Set<() => void>();
let inFlightRefresh: Promise<void> | null = null;
let initialRefreshRequested = false;
// Monotonic guard so a slow optimistic-then-revalidate sequence can never
// clobber the result of a newer refresh (e.g. a sign-in fired mid-revalidation).
let refreshVersion = 0;
let browserRetryTimer: ReturnType<typeof setTimeout> | null = null;
let browserRetryAttempt = 0;
let ipcRetryTimer: ReturnType<typeof setTimeout> | null = null;
let ipcRetryAttempt = 0;

const browserErrorObservation = (error: unknown) => {
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  } | null;
  const statusValue = value?.status ?? value?.statusCode;
  const status =
    typeof statusValue === "number"
      ? statusValue
      : typeof statusValue === "string"
        ? Number.parseInt(statusValue, 10)
        : undefined;
  const code =
    typeof value?.code === "string" ? value.code.slice(0, 80) : undefined;
  if (isRecognizedAuthRejection({ status, code })) {
    return { kind: "rejected" as const };
  }
  return {
    kind: "unknown" as const,
    error: {
      kind: status ? ("http" as const) : ("network" as const),
      message:
        typeof value?.message === "string"
          ? value.message.slice(0, 160)
          : "Could not read the browser session.",
      ...(status ? { status } : {}),
      ...(code ? { code } : {}),
    },
  };
};

const setCurrentSession = (args: {
  snapshot: AuthSessionSnapshot;
  isPending?: boolean;
}): void => {
  const data = getAuthSnapshotSession(args.snapshot);
  const nextIdentity = advanceAuthIdentityRevision({
    currentScope: currentIdentityScope,
    currentRevision: identityRevision,
    nextSessionData: data as AuthSessionScopeData,
  });
  currentIdentityScope = nextIdentity.scope;
  identityRevision = nextIdentity.revision;
  currentSession = {
    snapshot: args.snapshot,
    status: args.snapshot.status,
    data,
    isPending: args.isPending ?? (args.snapshot.status === "unknown" && !data),
    error:
      args.snapshot.status === "unknown"
        ? new Error(args.snapshot.error.message)
        : null,
    identityRevision,
  };
};

const commitBrowserSnapshot = (snapshot: AuthSessionSnapshot): void => {
  if (getStellaInteriorBridge()) {
    setCurrentSession({ snapshot });
    return;
  }
  if (snapshot.status === "authenticated") {
    writeBrowserIdentityIntent(snapshot.identityIntent);
    writeBrowserCachedSession(snapshot.session);
    browserRetryAttempt = 0;
    if (browserRetryTimer) clearTimeout(browserRetryTimer);
    browserRetryTimer = null;
  } else if (snapshot.status === "reauth_required") {
    clearBrowserSessionToken();
    writeBrowserIdentityIntent("connected");
  } else if (snapshot.status === "anonymous_required") {
    clearBrowserSessionToken();
    writeBrowserIdentityIntent("anonymous");
    writeBrowserCachedSession(null);
  }
  setCurrentSession({ snapshot });
};

const scheduleBrowserRetry = (version: number): void => {
  if (
    window.electronAPI ||
    getStellaInteriorBridge() ||
    browserRetryTimer ||
    !readBrowserSessionToken()
  ) {
    return;
  }
  const ceiling = Math.min(
    60_000,
    2_000 * 2 ** Math.min(browserRetryAttempt, 5),
  );
  browserRetryAttempt += 1;
  const jitter = 0.8 + Math.random() * 0.4;
  browserRetryTimer = setTimeout(
    () => {
      browserRetryTimer = null;
      if (version === refreshVersion) void refreshAuthSession({ silent: true });
    },
    Math.round(ceiling * jitter),
  );
};

const scheduleIpcRetry = (version: number): void => {
  if (ipcRetryTimer) return;
  const ceiling = Math.min(60_000, 2_000 * 2 ** Math.min(ipcRetryAttempt, 5));
  ipcRetryAttempt += 1;
  const jitter = 0.8 + Math.random() * 0.4;
  ipcRetryTimer = setTimeout(
    () => {
      ipcRetryTimer = null;
      if (version === refreshVersion) void refreshAuthSession({ silent: true });
    },
    Math.round(ceiling * jitter),
  );
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
  // server. The committed result only changes identity after a recognized
  // server verdict; transport failures preserve the cached owner.
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
    setCurrentSession({ snapshot: currentSession.snapshot, isPending: true });
    emit();
  }
  const interiorBridge = getStellaInteriorBridge();
  if (interiorBridge) {
    inFlightRefresh = Promise.resolve()
      .then(async () => {
        let session = await interiorBridge.getSession();
        if (session.expiresAt <= Date.now() + 5_000) {
          await interiorBridge.getToken({ forceRefresh: true });
          session = await interiorBridge.getSession();
        }
        if (session.expiresAt <= Date.now()) {
          throw new Error("The Stella interior session is expired.");
        }
        if (version !== refreshVersion) return;
        const snapshot = resolveAuthSessionObservation({
          observation: { kind: "authenticated", session },
          identityIntent: getAuthSessionIdentityIntent(session),
          staleSession: getAuthSnapshotSession(currentSession.snapshot),
        });
        setCurrentSession({ snapshot, isPending: false });
      })
      .catch((error) => {
        if (version !== refreshVersion) return;
        setCurrentSession({
          snapshot: {
            status: "unknown",
            identityIntent: currentSession.snapshot.identityIntent,
            staleSession: getAuthSnapshotSession(currentSession.snapshot),
            error: {
              kind: "network",
              message: error instanceof Error ? error.message : String(error),
            },
          },
          isPending: !currentSession.data,
        });
      })
      .finally(() => {
        inFlightRefresh = null;
        if (version === refreshVersion) emit();
      });
    await inFlightRefresh;
    return;
  }
  if (!systemApi?.getAuthSession) {
    inFlightRefresh = Promise.resolve()
      .then(async () => {
        const result = await authClient.getSession();
        if (version !== refreshVersion) return;
        const identityIntent =
          readBrowserIdentityIntent() ??
          getAuthSessionIdentityIntent(readBrowserCachedSession());
        const snapshot = resolveAuthSessionObservation({
          observation: result.error
            ? browserErrorObservation(result.error)
            : result.data === null || result.data === undefined
              ? { kind: "no_session" }
              : { kind: "authenticated", session: result.data },
          identityIntent,
          staleSession: readBrowserCachedSession(),
        });
        commitBrowserSnapshot(snapshot);
        if (snapshot.status === "unknown") scheduleBrowserRetry(version);
      })
      .catch((error) => {
        if (version !== refreshVersion) return;
        const snapshot = resolveAuthSessionObservation({
          observation: {
            kind: "unknown",
            error: {
              kind: "network",
              message: error instanceof Error ? error.message : String(error),
            },
          },
          identityIntent:
            readBrowserIdentityIntent() ??
            currentSession.snapshot.identityIntent,
          staleSession:
            readBrowserCachedSession() ??
            getAuthSnapshotSession(currentSession.snapshot),
        });
        commitBrowserSnapshot(snapshot);
        scheduleBrowserRetry(version);
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
      const first = await systemApi.getAuthSession({ allowCached });
      if (version !== refreshVersion) {
        return;
      }
      if (allowCached && getAuthSnapshotSession(first)) {
        // Surface the cached session right away (isPending:false) so Convex sees
        // isAuthenticated && !isLoading and starts fetching the access token /
        // running authenticated queries before get-session revalidation settles.
        setCurrentSession({ snapshot: first, isPending: false });
        emit();
      }
      // Authoritative follow-up read. The host returns the revalidated session
      // here (joining its in-flight revalidation, or the recorded result),
      // moving to reauth/anonymous-required only after a recognized verdict.
      // This also protects authoritative callers (sign-in / link) from ever
      // emitting a stale optimistic value: they skip the early emit above and
      // only commit this revalidated result.
      const revalidated = await systemApi.getAuthSession();
      if (version !== refreshVersion) {
        return;
      }
      setCurrentSession({ snapshot: revalidated, isPending: false });
      ipcRetryAttempt = 0;
      if (ipcRetryTimer) clearTimeout(ipcRetryTimer);
      ipcRetryTimer = null;
    })
    .catch((error) => {
      if (version !== refreshVersion) {
        return;
      }
      setCurrentSession({
        snapshot: {
          status: "unknown",
          identityIntent: currentSession.snapshot.identityIntent,
          staleSession: getAuthSnapshotSession(currentSession.snapshot),
          error: {
            kind: "ipc",
            message: error instanceof Error ? error.message : String(error),
          },
        },
        isPending: !currentSession.data,
      });
      scheduleIpcRetry(version);
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
  if (
    typeof window === "undefined" ||
    window.electronAPI ||
    getStellaInteriorBridge()
  ) {
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
      const result = await authClient.oneTimeToken.verify({
        token: handoff.token,
      });
      if (result.error) {
        throw new Error("Browser auth handoff verification failed.");
      }
      // The `bearer` plugin returns the session credential in
      // `set-auth-token`, which the client's success hook has already written
      // to local storage. Its absence means the exchange produced no session.
      if (!readBrowserSessionToken()) {
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
// one-time-token session handoff.
const browserAuthHandoffPromise = redeemPendingBrowserAuthHandoff();

export const waitForBrowserAuthHandoff =
  (): Promise<BrowserAuthHandoffResult> => browserAuthHandoffPromise;

export const signInAnonymous = async () => {
  const interiorBridge = getStellaInteriorBridge();
  if (interiorBridge) {
    await interiorBridge.getToken({ forceRefresh: true });
    await refreshAuthSession();
    if (!currentSession.data) {
      throw new Error("The Stella interior session could not be refreshed.");
    }
    return;
  }
  if (!window.electronAPI) {
    if (
      readBrowserSessionToken() ||
      readBrowserIdentityIntent() === "connected"
    ) {
      throw new Error(
        "Anonymous sign-in is not allowed while an existing identity is present.",
      );
    }
    const turnstileToken = await getPlatformChallengeToken();
    const result = await authClient.signIn.anonymous({
      fetchOptions: {
        headers: captchaHeaders(turnstileToken),
      },
    });
    if (result.error) {
      const failure = browserErrorObservation(result.error);
      console.warn("[auth] Browser anonymous sign-in failed.", {
        kind: failure.kind,
        ...(failure.kind === "unknown"
          ? {
              status: failure.error.status,
              code: failure.error.code,
            }
          : {}),
      });
      throw new Error(
        result.error.message ?? "Could not start a browser session.",
      );
    }
    if (!readBrowserSessionToken()) {
      throw new Error(
        "The browser session token was not returned by the auth service.",
      );
    }
    writeBrowserIdentityIntent("anonymous");
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
  if (getStellaInteriorBridge()) {
    throw new Error(
      "Sign out must be completed by the trusted Stella browser shell.",
    );
  }
  if (!window.electronAPI) {
    // Send the credential first so the server can revoke the session row, then
    // drop the local copy. Reversing the order would leave a live session with
    // no client able to sign it out.
    await authClient.signOut();
    clearBrowserSessionToken();
    writeBrowserIdentityIntent("anonymous");
    writeBrowserCachedSession(null);
  } else {
    if (!window.electronAPI.system.signOutAuth) {
      throw new Error("Desktop sign-out is unavailable.");
    }
    await window.electronAPI.system.signOutAuth();
  }
  // Invalidate any in-flight optimistic refresh so a late revalidated emit
  // can't resurrect the signed-out session.
  refreshVersion += 1;
  setCurrentSession({
    snapshot: {
      status: "anonymous_required",
      identityIntent: "anonymous",
      reason: "explicit_sign_out",
    },
    isPending: false,
  });
  emit();
};

export const deleteAuthUser = async () => {
  if (getStellaInteriorBridge()) {
    throw new Error(
      "Account deletion must be completed by the trusted Stella browser shell.",
    );
  }
  if (!window.electronAPI) {
    await authClient.deleteUser();
    clearBrowserSessionToken();
    writeBrowserIdentityIntent("anonymous");
    writeBrowserCachedSession(null);
  } else {
    if (!window.electronAPI.system.deleteAuthUser) {
      throw new Error("Desktop account deletion is unavailable.");
    }
    await window.electronAPI.system.deleteAuthUser();
  }
  refreshVersion += 1;
  setCurrentSession({
    snapshot: {
      status: "anonymous_required",
      identityIntent: "anonymous",
      reason: "explicit_sign_out",
    },
    isPending: false,
  });
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
    if (!initialRefreshRequested) {
      initialRefreshRequested = true;
      void waitForBrowserAuthHandoff().then(() => {
        if (!inFlightRefresh) {
          void refreshAuthSession({ allowCached: true });
        }
      });
    }
    ensureAuthSessionRevalidationListeners();
  }, []);

  return snapshot;
}
