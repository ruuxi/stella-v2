import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConvexProviderWithAuth } from "convex/react";
import { MagicLinkAuthProvider } from "@/global/auth/useMagicLinkAuth";
import {
  getConvexToken,
  clearCachedToken,
} from "@/global/auth/services/auth-token";
import {
  refreshAuthSession,
  signInAnonymous,
  useDesktopAuthSession,
} from "@/global/auth/services/auth-session";
import { convexClient } from "@/platform/convex/convex-client";

const TOKEN_BOOTSTRAP_RETRY_BASE_MS = 3_000;
const TOKEN_BOOTSTRAP_RETRY_MAX_MS = 60_000;
const TOKEN_BOOTSTRAP_MAX_ATTEMPTS = 10;

const getTokenBootstrapRetryDelayMs = (attempt: number) => {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(
    TOKEN_BOOTSTRAP_RETRY_MAX_MS,
    TOKEN_BOOTSTRAP_RETRY_BASE_MS * 2 ** exponent,
  );
};

export type AuthBootstrapStatus =
  | "loading_session"
  | "creating_anonymous_session"
  | "syncing_runtime_token"
  | "ready"
  | "failed";

type AuthBootstrapState = {
  status: AuthBootstrapStatus;
  error: string | null;
};

type AuthBootstrapContextValue = AuthBootstrapState & {
  runtimeAuthReady: boolean;
};

const AuthBootstrapContext = createContext<AuthBootstrapContextValue>({
  status: "loading_session",
  error: null,
  runtimeAuthReady: false,
});

export function useAuthBootstrapState() {
  return useContext(AuthBootstrapContext);
}

/**
 * `useAuth` hook for `ConvexProviderWithAuth`. Exported so secondary
 * windows (e.g. the floating pet overlay) can wire Convex auth without
 * the full `DesktopConvexAuthProvider` bootstrap chain (anonymous-session
 * creation, magic-link layer, runtime token sync). Those side effects
 * only belong in the primary shell window.
 */
export function useDesktopConvexAuth() {
  const session = useDesktopAuthSession();

  const sessionUserId =
    (session.data as { user?: { id?: string } } | null | undefined)?.user?.id ??
    null;
  const sessionIsAnonymous =
    (
      session.data as
        | { user?: { isAnonymous?: boolean | null } }
        | null
        | undefined
    )?.user?.isAnonymous === true;

  useEffect(() => {
    clearCachedToken();
  }, [sessionIsAnonymous, sessionUserId]);

  const fetchAccessToken = useCallback(
    async ({
      forceRefreshToken = false,
    }: { forceRefreshToken?: boolean } = {}) => {
      return await getConvexToken({ forceRefresh: forceRefreshToken });
    },
    // Intentionally keyed on sessionUserId and sessionIsAnonymous so
    // ConvexProviderWithAuth re-calls setAuth when the signed-in identity
    // changes, including anonymous → real account links that preserve user.id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionIsAnonymous, sessionUserId],
  );

  return useMemo(
    () => ({
      isLoading: Boolean(session.isPending),
      isAuthenticated: Boolean(session.data),
      fetchAccessToken,
    }),
    [fetchAccessToken, session.data, session.isPending],
  );
}

/**
 * Auth-inversion P2: the renderer no longer schedules token refreshes or
 * pushes tokens into the main process. The runtime AuthOwner owns the single
 * refresh timer; this component only
 *   1. creates the anonymous session on first boot,
 *   2. probes that a Convex JWT is obtainable before declaring bootstrap
 *      "ready" (bounded retry, no timers beyond the retry backoff), and
 *   3. re-pulls token/session state when the runtime broadcasts
 *      `auth:changed`.
 */
function DesktopAuthRuntimeEffects({
  setAuthBootstrapState,
}: {
  setAuthBootstrapState: (state: AuthBootstrapState) => void;
}) {
  const session = useDesktopAuthSession();
  const attemptedAnonAuthRef = useRef(false);
  const runtimeIdentityKeyRef = useRef<string | null>(null);
  const sessionUser = (
    session.data as
      | { user?: { id?: string | null; isAnonymous?: boolean | null } }
      | null
      | undefined
  )?.user;
  const sessionUserId = sessionUser?.id ?? null;
  const sessionIsAnonymous = sessionUser?.isAnonymous === true;
  const hasSession = Boolean(session.data);
  const isSessionPending = Boolean(session.isPending);

  useEffect(() => {
    if (session.isPending) {
      setAuthBootstrapState({ status: "loading_session", error: null });
      return;
    }

    if (session.data) {
      attemptedAnonAuthRef.current = false;
      return;
    }

    if (attemptedAnonAuthRef.current) return;
    attemptedAnonAuthRef.current = true;
    setAuthBootstrapState({
      status: "creating_anonymous_session",
      error: null,
    });

    void signInAnonymous().catch(() => {
      attemptedAnonAuthRef.current = false;
      setAuthBootstrapState({
        status: "failed",
        error: "Stella could not create a local sign-in session.",
      });
    });
  }, [session.data, session.isPending, setAuthBootstrapState]);

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setCloudSyncEnabled) {
      return;
    }

    // Cloud sync stays intentionally disabled; auth sessions are local-only for now.
    void systemApi.setCloudSyncEnabled({ enabled: false });

    return () => {
      void systemApi.setCloudSyncEnabled({ enabled: false });
    };
  }, []);

  // Runtime AuthOwner state changed (token minted after an import, sign-out
  // from another surface): drop the renderer token cache and revalidate the
  // session silently so gating updates without a loading flash.
  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.onAuthChanged) {
      return;
    }
    return systemApi.onAuthChanged((event) => {
      clearCachedToken();
      if (event.reason !== "refresh") {
        void refreshAuthSession({ silent: true });
      }
    });
  }, []);

  useEffect(() => {
    if (isSessionPending) {
      setAuthBootstrapState({ status: "loading_session", error: null });
      return;
    }

    if (!hasSession) {
      setAuthBootstrapState({
        status: "creating_anonymous_session",
        error: null,
      });
      return;
    }

    setAuthBootstrapState({
      status: "syncing_runtime_token",
      error: null,
    });

    const runtimeIdentityKey = [
      sessionUserId ?? "unknown",
      sessionIsAnonymous ? "anonymous" : "connected",
    ].join(":");
    const runtimeIdentityChanged =
      runtimeIdentityKeyRef.current !== runtimeIdentityKey;
    runtimeIdentityKeyRef.current = runtimeIdentityKey;
    if (runtimeIdentityChanged) {
      clearCachedToken();
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let bootstrapAttempts = 0;

    // Readiness probe: confirm a Convex JWT is obtainable from the runtime
    // proxy before flipping to "ready". No refresh scheduling — expiry is
    // the AuthOwner's job; ConvexProviderWithAuth re-pulls on demand.
    const probeToken = async ({
      forceRefreshToken = false,
    }: { forceRefreshToken?: boolean } = {}) => {
      let token: string | null = null;
      try {
        token = await getConvexToken({ forceRefresh: forceRefreshToken });
      } catch {
        token = null;
      }
      if (cancelled) return;

      if (token) {
        bootstrapAttempts = 0;
        setAuthBootstrapState({ status: "ready", error: null });
        return;
      }

      if (retryTimer) {
        return;
      }
      bootstrapAttempts += 1;
      if (bootstrapAttempts >= TOKEN_BOOTSTRAP_MAX_ATTEMPTS) {
        setAuthBootstrapState({
          status: "failed",
          error:
            "Stella couldn't reach the auth runtime. Check your connection and try again.",
        });
        return;
      }
      setAuthBootstrapState({
        status: "syncing_runtime_token",
        error: null,
      });
      retryTimer = setTimeout(
        () => {
          retryTimer = null;
          void probeToken();
        },
        getTokenBootstrapRetryDelayMs(bootstrapAttempts),
      );
    };

    void probeToken({ forceRefreshToken: runtimeIdentityChanged });

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
  }, [
    hasSession,
    isSessionPending,
    sessionIsAnonymous,
    sessionUserId,
    setAuthBootstrapState,
  ]);

  return null;
}

export function DesktopConvexAuthProvider({
  children,
  enableRuntimeEffects = true,
}: {
  children: ReactNode;
  enableRuntimeEffects?: boolean;
}) {
  const [authBootstrapState, setAuthBootstrapState] =
    useState<AuthBootstrapState>(() =>
      enableRuntimeEffects
        ? {
            status: "loading_session",
            error: null,
          }
        : {
            status: "ready",
            error: null,
          },
    );
  const authBootstrapValue = useMemo(
    () => ({
      ...authBootstrapState,
      runtimeAuthReady: authBootstrapState.status === "ready",
    }),
    [authBootstrapState],
  );

  return (
    <ConvexProviderWithAuth
      client={convexClient}
      useAuth={useDesktopConvexAuth}
    >
      <AuthBootstrapContext.Provider value={authBootstrapValue}>
        <MagicLinkAuthProvider>
          {enableRuntimeEffects ? (
            <DesktopAuthRuntimeEffects
              setAuthBootstrapState={setAuthBootstrapState}
            />
          ) : null}
          {children}
        </MagicLinkAuthProvider>
      </AuthBootstrapContext.Provider>
    </ConvexProviderWithAuth>
  );
}
