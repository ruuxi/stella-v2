import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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

type AuthBootstrapContextValue = {
  runtimeAuthReady: boolean;
};

const AuthBootstrapContext = createContext<AuthBootstrapContextValue>({
  runtimeAuthReady: false,
});

export function useAuthBootstrapState() {
  return useContext(AuthBootstrapContext);
}

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

function DesktopAuthRuntimeEffects() {
  const session = useDesktopAuthSession();
  const attemptedAnonAuthRef = useRef(false);

  useEffect(() => {
    if (session.isPending) {
      return;
    }

    if (session.data) {
      attemptedAnonAuthRef.current = false;
      return;
    }

    if (attemptedAnonAuthRef.current) return;
    attemptedAnonAuthRef.current = true;

    void signInAnonymous().catch(() => {
      attemptedAnonAuthRef.current = false;
    });
  }, [session.data, session.isPending]);

  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setCloudSyncEnabled) {
      return;
    }

    void systemApi.setCloudSyncEnabled({ enabled: false });

    return () => {
      void systemApi.setCloudSyncEnabled({ enabled: false });
    };
  }, []);

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
  return (
    <ConvexProviderWithAuth
      client={convexClient}
      useAuth={useDesktopConvexAuth}
    >
      <AuthBootstrapGate enableRuntimeEffects={enableRuntimeEffects}>
        <MagicLinkAuthProvider>
          {enableRuntimeEffects ? <DesktopAuthRuntimeEffects /> : null}
          {children}
        </MagicLinkAuthProvider>
      </AuthBootstrapGate>
    </ConvexProviderWithAuth>
  );
}

function AuthBootstrapGate({
  children,
  enableRuntimeEffects,
}: {
  children: ReactNode;
  enableRuntimeEffects: boolean;
}) {
  const session = useDesktopAuthSession();

  const runtimeAuthReady =
    !enableRuntimeEffects || (!session.isPending && Boolean(session.data));
  const value = useMemo(() => ({ runtimeAuthReady }), [runtimeAuthReady]);

  return (
    <AuthBootstrapContext.Provider value={value}>
      {children}
    </AuthBootstrapContext.Provider>
  );
}
