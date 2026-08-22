import type {
  RuntimeActiveRun,
  RuntimeAutomationTurnRequest,
  RuntimeAutomationTurnResult,
} from "@stella/contracts/protocol";

type Awaitable<T> = T | Promise<T>;

export type PiRunnerAuthHandle = {
  setAuthToken: (value: string | null) => void;
  setHasConnectedAccount: (value: boolean) => void;
  setConvexUrl: (value: string | null) => void;
  setConvexSiteUrl: (value: string | null) => void;
  /**
   * P1 dual-write: mirror the desktop-owned Better Auth session into the
   * runtime worker's AuthOwner store. Optional so older runner adapters
   * (detached-worker version skew) simply skip the mirror.
   */
  importAuthSession?: (payload: {
    cookie: string | null;
    sessionData: string | null;
  }) => Promise<unknown>;
  /**
   * P2 token distribution: pull a Convex JWT / session from the runtime
   * AuthOwner. Optional for detached-worker version skew; callers fall back
   * to the legacy desktop-owned mint when unavailable.
   */
  getRuntimeConvexToken?: (payload?: { forceRefresh?: boolean }) => Promise<{
    authenticated: boolean;
    token: string | null;
    hasConnectedAccount: boolean;
  }>;
  getRuntimeAuthSession?: () => Promise<unknown>;
  /**
   * P3 sign-in mutations: proxied to the worker AuthOwner so the runtime is
   * the single /api/auth/* writer. Optional for version skew; the desktop
   * falls back to its legacy in-main implementation when unavailable.
   */
  authSignInAnonymous?: () => Promise<unknown>;
  authSignOut?: () => Promise<{ ok: boolean }>;
  authDeleteUser?: () => Promise<{ ok: boolean }>;
  authApplySessionCookie?: (payload: {
    sessionCookie: string;
  }) => Promise<{ ok: boolean }>;
  authHandleCallback?: (payload: {
    url: string;
    protocol: string;
  }) => Promise<{ ok: boolean }>;
  authMagicLinkSend?: (payload: { email: string }) => Promise<
    | { ok: true; requestId: string }
    | { ok: false; code: "rate_limited"; retryAfterSeconds: number }
    | { ok: false; code: "send_failed"; error?: string }
  >;
  authMagicLinkStatus?: (payload: { requestId: string }) => Promise<{
    status: "pending" | "completed" | "expired";
    applied: boolean;
  }>;
};

export type WindowManagerLike<TWindow = unknown> = {
  getFullWindow: () => TWindow | null;
};

export type WindowManagerTarget<TWindow = unknown> = {
  getWindowManager: () => WindowManagerLike<TWindow> | null;
};

export type StellaAppDirTarget = {
  getStellaAppDir: () => string | null;
};

export type StellaHostRunnerTarget = {
  getRunner: () => {
    runAutomationTurn: (
      payload: RuntimeAutomationTurnRequest,
    ) => Promise<RuntimeAutomationTurnResult>;
    getActiveOrchestratorRun: () => Awaitable<RuntimeActiveRun | null>;
  } | null;
};

export type PiRunnerTarget = {
  getRunner: () => PiRunnerAuthHandle | null;
};
