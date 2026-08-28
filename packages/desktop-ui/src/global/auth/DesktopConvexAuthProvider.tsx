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
  clearCachedToken,
  getConvexTokenForIdentity,
} from "@/global/auth/services/auth-token";
import {
  getAuthSessionSnapshot,
  signInAnonymous,
  useDesktopAuthSession,
  waitForBrowserAuthHandoff,
} from "@/global/auth/services/auth-session";
import { convexClient } from "@/platform/convex/convex-client";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { getJwtExpMs } from "@/shared/lib/jwt";
import { decideAutomaticAnonymousBootstrap } from "./browser-auth-handoff";

const TOKEN_BOOTSTRAP_RETRY_BASE_MS = 3_000;
const TOKEN_BOOTSTRAP_RETRY_MAX_MS = 60_000;
const TOKEN_BOOTSTRAP_MAX_ATTEMPTS = 10;
const TOKEN_REFRESH_FALLBACK_MS = 3 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 90_000;
const TOKEN_MIN_REFRESH_MS = 15_000;
const CONVEX_TOKEN_ISSUER = readConfiguredConvexSiteUrl(
  import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
);

const expectedConvexTokenSubject = (userId: string | null): string | null => {
  const subject = userId?.trim();
  return CONVEX_TOKEN_ISSUER && subject
    ? `${CONVEX_TOKEN_ISSUER}|${subject}`
    : null;
};

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
  retryAuthBootstrap: () => void;
};

const AuthBootstrapContext = createContext<AuthBootstrapContextValue>({
  status: "loading_session",
  error: null,
  runtimeAuthReady: false,
  retryAuthBootstrap: () => {},
});

export function useAuthBootstrapState() {
  return useContext(AuthBootstrapContext);
}

const getHostTokenRefreshDelayMs = (token: string): number => {
  try {
    return Math.max(
      TOKEN_MIN_REFRESH_MS,
      getJwtExpMs(token) - Date.now() - TOKEN_REFRESH_MARGIN_MS,
    );
  } catch {
    return TOKEN_REFRESH_FALLBACK_MS;
  }
};

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
  const expectedTokenSubject = expectedConvexTokenSubject(sessionUserId);
  const identityRevision = session.identityRevision;
  const tokenIdentityKey = expectedTokenSubject
    ? [
        expectedTokenSubject,
        sessionIsAnonymous ? "anonymous" : "connected",
        String(identityRevision),
      ].join("\u0000")
    : null;
  const activeTokenIdentityKeyRef = useRef(tokenIdentityKey);
  activeTokenIdentityKeyRef.current = tokenIdentityKey;
  const hasValidSessionIdentity = Boolean(
    session.data && sessionUserId?.trim(),
  );

  const fetchAccessToken = useCallback(
    async ({
      forceRefreshToken = false,
    }: { forceRefreshToken?: boolean } = {}) => {
      if (
        !expectedTokenSubject ||
        !tokenIdentityKey ||
        activeTokenIdentityKeyRef.current !== tokenIdentityKey
      ) {
        return null;
      }
      const token = await getConvexTokenForIdentity(
        expectedTokenSubject,
        sessionIsAnonymous,
        {
          forceRefresh: forceRefreshToken,
          identityRevision,
        },
      );
      return activeTokenIdentityKeyRef.current === tokenIdentityKey
        ? token
        : null;
    },
    // Intentionally keyed on the full session identity so
    // ConvexProviderWithAuth re-calls setAuth when the signed-in identity
    // changes, including anonymous → real account links that preserve user.id.
    [
      expectedTokenSubject,
      identityRevision,
      sessionIsAnonymous,
      tokenIdentityKey,
    ],
  );

  return useMemo(
    () => ({
      isLoading: Boolean(session.isPending),
      isAuthenticated: hasValidSessionIdentity,
      fetchAccessToken,
    }),
    [fetchAccessToken, hasValidSessionIdentity, session.isPending],
  );
}

function DesktopAuthRuntimeEffects({
  retryAttempt,
  setAuthBootstrapState,
}: {
  retryAttempt: number;
  setAuthBootstrapState: (state: AuthBootstrapState) => void;
}) {
  const session = useDesktopAuthSession();
  const attemptedAnonAuthRef = useRef(false);
  const lastRetryAttemptRef = useRef(retryAttempt);
  const runtimeAuthRefreshHandlerRef = useRef<
    | ((args?: {
        forceRefreshToken?: boolean;
        requestId?: string;
      }) => Promise<void>)
    | null
  >(null);
  const sessionUser = (
    session.data as
      | { user?: { id?: string | null; isAnonymous?: boolean | null } }
      | null
      | undefined
  )?.user;
  const sessionUserId = sessionUser?.id ?? null;
  const sessionIsAnonymous = sessionUser?.isAnonymous === true;
  const sessionIdentityRevision = session.identityRevision;
  const expectedTokenSubject = expectedConvexTokenSubject(sessionUserId);
  const hasSession = Boolean(session.data);
  const hasConnectedAccount = hasSession && !sessionIsAnonymous;
  const isSessionPending = Boolean(session.isPending);

  useEffect(() => {
    if (lastRetryAttemptRef.current !== retryAttempt) {
      lastRetryAttemptRef.current = retryAttempt;
      attemptedAnonAuthRef.current = false;
    }

    let cancelled = false;
    void decideAutomaticAnonymousBootstrap(waitForBrowserAuthHandoff(), () =>
      Boolean(getAuthSessionSnapshot().data),
    ).then(async (decision) => {
      if (cancelled) return;
      if (decision === "handoff_failed") {
        setAuthBootstrapState({
          status: "failed",
          error: "Stella could not finish browser sign-in. Please try again.",
        });
        return;
      }

      // Re-read after the handoff barrier instead of trusting the render-time
      // snapshot. The OTT exchange and the cold-start revalidation can both
      // finish while this effect is waiting.
      const snapshot = getAuthSessionSnapshot();
      if (snapshot.isPending) {
        setAuthBootstrapState({ status: "loading_session", error: null });
        return;
      }
      if (snapshot.data) {
        const snapshotUserId = (
          snapshot.data as { user?: { id?: string | null } }
        ).user?.id?.trim();
        if (!snapshotUserId) {
          setAuthBootstrapState({
            status: "failed",
            error: "Stella could not verify the signed-in identity.",
          });
          return;
        }
        attemptedAnonAuthRef.current = false;
        // Browser shells have no desktop runtime token to synchronize. Their
        // ConvexProviderWithAuth exchange is the remaining authority barrier.
        if (!window.electronAPI) {
          setAuthBootstrapState({ status: "ready", error: null });
        }
        return;
      }

      if (attemptedAnonAuthRef.current) return;
      attemptedAnonAuthRef.current = true;
      setAuthBootstrapState({
        status: "creating_anonymous_session",
        error: null,
      });
      try {
        await signInAnonymous();
      } catch (error) {
        if (cancelled) return;
        attemptedAnonAuthRef.current = false;
        setAuthBootstrapState({
          status: "failed",
          error:
            error instanceof Error
              ? error.message
              : "Stella could not create an anonymous cloud session.",
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [retryAttempt, session.data, session.isPending, setAuthBootstrapState]);

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setCloudSyncEnabled) {
      return;
    }

    // Conversations are cloud-owned for anonymous and connected identities.
    // Older desktop hosts still consume this compatibility flag.
    void systemApi.setCloudSyncEnabled({ enabled: true });
  }, []);

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (
      !systemApi?.onRuntimeAuthRefreshRequested ||
      !systemApi.completeRuntimeAuthRefresh
    ) {
      return;
    }

    return systemApi.onRuntimeAuthRefreshRequested(({ requestId }) => {
      const syncToken = runtimeAuthRefreshHandlerRef.current;
      if (syncToken) {
        void syncToken({ forceRefreshToken: true, requestId });
        return;
      }
      void systemApi.completeRuntimeAuthRefresh({
        requestId,
        authenticated: false,
        hasConnectedAccount: false,
      });
    });
  }, []);

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setAuthState) {
      runtimeAuthRefreshHandlerRef.current = null;
      // Browser shells authenticate Convex directly. They have no desktop
      // runtime process to synchronize, so absence of this IPC method is
      // expected rather than an auth bootstrap failure.
      if (!window.electronAPI) return;
      setAuthBootstrapState({
        status: "failed",
        error: "Stella could not connect auth to the desktop runtime.",
      });
      return;
    }

    if (isSessionPending) {
      runtimeAuthRefreshHandlerRef.current = null;
      setAuthBootstrapState({ status: "loading_session", error: null });
      return;
    }

    if (!hasSession) {
      runtimeAuthRefreshHandlerRef.current = null;
      setAuthBootstrapState({
        status: "creating_anonymous_session",
        error: null,
      });
      void systemApi.setAuthState({
        authenticated: false,
        hasConnectedAccount: false,
      });
      return;
    }

    if (!sessionUserId?.trim() || !expectedTokenSubject) {
      runtimeAuthRefreshHandlerRef.current = null;
      void systemApi.setAuthState({
        authenticated: false,
        hasConnectedAccount: false,
      });
      setAuthBootstrapState({
        status: "failed",
        error: "Stella could not verify the signed-in identity.",
      });
      return;
    }

    setAuthBootstrapState({
      status: "syncing_runtime_token",
      error: null,
    });

    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let bootstrapAttempts = 0;

    const clearTimers = () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const scheduleRefresh = (token: string) => {
      if (cancelled) {
        return;
      }
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void syncToken({ forceRefreshToken: true });
      }, getHostTokenRefreshDelayMs(token));
    };

    const syncToken = async ({
      forceRefreshToken = false,
      requestId,
    }: { forceRefreshToken?: boolean; requestId?: string } = {}) => {
      let token: string | undefined;
      try {
        token =
          (await getConvexTokenForIdentity(
            expectedTokenSubject,
            sessionIsAnonymous,
            {
              forceRefresh: forceRefreshToken,
              identityRevision: sessionIdentityRevision,
            },
          )) ?? undefined;
      } catch {
        token = undefined;
      }
      if (cancelled) return;

      if (token) {
        const nextState = {
          authenticated: true,
          token,
          hasConnectedAccount,
        } as const;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        bootstrapAttempts = 0;
        void systemApi.setAuthState(nextState);
        if (requestId && systemApi.completeRuntimeAuthRefresh) {
          void systemApi.completeRuntimeAuthRefresh({
            requestId,
            ...nextState,
          });
        }
        scheduleRefresh(token);
        setAuthBootstrapState({ status: "ready", error: null });
        return;
      }

      const nextState = {
        authenticated: false,
        hasConnectedAccount: false,
      } as const;
      void systemApi.setAuthState(nextState);
      if (requestId && systemApi.completeRuntimeAuthRefresh) {
        void systemApi.completeRuntimeAuthRefresh({
          requestId,
          ...nextState,
        });
      }
      // A live refresh request (heartbeat/subscription) is not part of the
      // initial bootstrap loop — it can fail without poisoning startup.
      if (requestId) {
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
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void syncToken();
      }, getTokenBootstrapRetryDelayMs(bootstrapAttempts));
    };

    runtimeAuthRefreshHandlerRef.current = syncToken;
    // The identity-aware helper invalidates the generic cache synchronously on
    // a new identity. Do not clear it from this passive effect: that can race a
    // fresh token already fetched by ConvexProviderWithAuth.
    void syncToken();

    return () => {
      cancelled = true;
      runtimeAuthRefreshHandlerRef.current = null;
      clearTimers();
    };
  }, [
    expectedTokenSubject,
    hasConnectedAccount,
    hasSession,
    isSessionPending,
    sessionIsAnonymous,
    sessionIdentityRevision,
    sessionUserId,
    setAuthBootstrapState,
    retryAttempt,
  ]);

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setAuthState) {
      return;
    }

    return () => {
      void systemApi.setAuthState({
        authenticated: false,
        hasConnectedAccount: false,
      });
    };
  }, []);

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
  const [retryAttempt, setRetryAttempt] = useState(0);
  const retryAuthBootstrap = useCallback(() => {
    clearCachedToken();
    setAuthBootstrapState({ status: "loading_session", error: null });
    setRetryAttempt((attempt) => attempt + 1);
  }, []);
  const authBootstrapValue = useMemo(
    () => ({
      ...authBootstrapState,
      runtimeAuthReady: authBootstrapState.status === "ready",
      retryAuthBootstrap,
    }),
    [authBootstrapState, retryAuthBootstrap],
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
              retryAttempt={retryAttempt}
              setAuthBootstrapState={setAuthBootstrapState}
            />
          ) : null}
          {children}
        </MagicLinkAuthProvider>
      </AuthBootstrapContext.Provider>
    </ConvexProviderWithAuth>
  );
}
