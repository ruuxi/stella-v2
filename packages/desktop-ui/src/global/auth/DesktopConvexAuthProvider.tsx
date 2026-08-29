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
  refreshAuthSession,
  signInAnonymous,
  useDesktopAuthSession,
  waitForBrowserAuthHandoff,
} from "@/global/auth/services/auth-session";
import { convexClient } from "@/platform/convex/convex-client";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { decideAutomaticAnonymousBootstrap } from "./browser-auth-handoff";

const CONVEX_TOKEN_ISSUER = readConfiguredConvexSiteUrl(
  import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
);

const expectedConvexTokenSubject = (userId: string | null): string | null => {
  const subject = userId?.trim();
  return CONVEX_TOKEN_ISSUER && subject
    ? `${CONVEX_TOKEN_ISSUER}|${subject}`
    : null;
};

export type AuthBootstrapStatus =
  | "loading_session"
  | "creating_anonymous_session"
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
        // A verified session identity is the whole barrier now. Electron main
        // owns Convex token minting and refresh, and a browser shell mints
        // through `ConvexProviderWithAuth`; neither needs the renderer to
        // hand a token anywhere before the shell may open.
        setAuthBootstrapState({ status: "ready", error: null });
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

  // Main pushes this when it discovers the stored bearer is gone or rejected
  // (local sign-out, revoked session). Drop the cached Convex JWT and re-read
  // the session so the shell converges instead of holding a dead identity.
  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.onAuthSessionInvalidated) {
      return;
    }

    return systemApi.onAuthSessionInvalidated(() => {
      clearCachedToken();
      void refreshAuthSession({ silent: true });
    });
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
