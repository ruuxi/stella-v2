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
