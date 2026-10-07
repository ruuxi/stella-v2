import { useChatStorageMode } from "@/features/chat/services/chat-storage-preference";
import type { ReactNode } from "react";
import { canBootstrapAnonymous } from "@stella/contracts/auth-session";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MagicLinkAuthProvider } from "@/global/auth/useMagicLinkAuth";
import { clearCachedToken } from "@/global/auth/services/auth-token";
import {
  getAuthSessionSnapshot,
  refreshAuthSession,
  signInAnonymous,
  useDesktopAuthSession,
  waitForBrowserAuthHandoff,
} from "@/global/auth/services/auth-session";
import { SIGN_IN_TOAST_ACTION } from "@/shared/lib/auth-cta";
import { showToast } from "@/ui/toast";

export type AuthBootstrapStatus =
  | "loading_session"
  | "creating_anonymous_session"
  | "ready"
  | "reauth_required"
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
 * Whether the renderer holds a verified session identity. Backend calls
 * authenticate with the owner JWT minted from that session, so this is the
 * gate for every account-bound view.
 */
export function useAuthState() {
  const session = useDesktopAuthSession();
  const sessionUserId =
    (session.data as { user?: { id?: string } } | null | undefined)?.user?.id ??
    null;
  const isAuthenticated = Boolean(session.data && sessionUserId?.trim());
  const isLoading = Boolean(session.isPending);
  return useMemo(
    () => ({ isLoading, isAuthenticated }),
    [isAuthenticated, isLoading],
  );
}

function DesktopAuthRuntimeEffects({
  retryAttempt,
  scheduleRetry,
  setAuthBootstrapState,
}: {
  retryAttempt: number;
  scheduleRetry: () => void;
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
    let retryTimer: number | null = null;
    void waitForBrowserAuthHandoff().then(async (handoff) => {
      if (cancelled) return;
      if (handoff === "failed") {
        showToast({
          title: "Couldn’t finish sign in",
          description:
            "Your existing Stella session is still active. You can try signing in again.",
          variant: "error",
          action: SIGN_IN_TOAST_ACTION,
        });
      }

      // Re-read after the handoff barrier instead of trusting the render-time
      // snapshot. The OTT exchange and the cold-start revalidation can both
      // finish while this effect is waiting.
      const snapshot = getAuthSessionSnapshot();
      if (snapshot.isPending && !snapshot.data) {
        setAuthBootstrapState({ status: "loading_session", error: null });
        return;
      }
      if (snapshot.status === "reauth_required") {
        setAuthBootstrapState({ status: "reauth_required", error: null });
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
        // owns token minting and refresh, and a browser shell mints through
        // Better Auth's JWT plugin; neither needs the renderer to hand a token
        // anywhere before the shell may open.
        setAuthBootstrapState({ status: "ready", error: null });
        return;
      }

      if (!canBootstrapAnonymous(snapshot.snapshot)) {
        setAuthBootstrapState({ status: "loading_session", error: null });
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
      } catch {
        if (cancelled) return;
        attemptedAnonAuthRef.current = false;
        setAuthBootstrapState({
          status: "loading_session",
          error: null,
        });
        retryTimer = window.setTimeout(scheduleRetry, 2_000);
      }
    });

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [
    retryAttempt,
    scheduleRetry,
    session.data,
    session.isPending,
    session.status,
    setAuthBootstrapState,
  ]);

  const chatStorageMode = useChatStorageMode();
  useEffect(() => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.setCloudSyncEnabled) {
      return;
    }

    // Restore the device preference when the authenticated runtime becomes available.
    void systemApi.setCloudSyncEnabled({ enabled: chatStorageMode === "cloud" });
  }, [chatStorageMode]);

  // Main pushes this when a background retry reaches a new verdict. Drop the
  // cached owner JWT and re-read the snapshot so the shell converges without
  // interpreting the notification itself as a sign-out.
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

export function BackendAuthProvider({
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
  const scheduleRetry = useCallback(() => {
    setRetryAttempt((attempt) => attempt + 1);
  }, []);
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
    <AuthBootstrapContext.Provider value={authBootstrapValue}>
      <MagicLinkAuthProvider>
        {enableRuntimeEffects ? (
          <DesktopAuthRuntimeEffects
            retryAttempt={retryAttempt}
            scheduleRetry={scheduleRetry}
            setAuthBootstrapState={setAuthBootstrapState}
          />
        ) : null}
        {children}
      </MagicLinkAuthProvider>
    </AuthBootstrapContext.Provider>
  );
}
