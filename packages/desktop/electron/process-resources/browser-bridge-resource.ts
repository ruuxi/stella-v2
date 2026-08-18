import { ProcessRuntime } from "../process-runtime.js";
import {
  isStellaExtensionInstalled,
  StellaBrowserBridgeService,
  type StellaBrowserAgentBackend,
  type StellaBrowserAgentCapability,
  type StellaBrowserExportedCookie,
} from "../services/stella-browser-bridge-service.js";
import { createManagedResource } from "../managed-resource.js";
import { BROWSER_BRIDGE_MISSING_ERROR } from "../utils/register-stella-native-messaging-host.js";

const TOAST_AFTER_RETRY_ATTEMPTS = 3;

type StellaBrowserBridgeState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "host_registration_failed";

export type StellaBrowserBridgeFailureReason =
  | "bridge_missing"
  | "authorization_failed"
  | "connection_lost"
  | "transient_failure";

export type StellaBrowserBridgeStatus = {
  state: StellaBrowserBridgeState;
  attempt: number;
  nextRetryMs?: number;
  error?: string;
  reason?: StellaBrowserBridgeFailureReason;
  notifyUser?: boolean;
};

export type StellaBrowserBridgeResource = {
  start: () => void;
  stop: () => Promise<void>;
  getStatus: () => StellaBrowserBridgeStatus;
  getExtensionStatus: () => Promise<boolean>;
  exportAllCookies: () => Promise<StellaBrowserExportedCookie[]>;
  exportCookiesForUrls: (
    urls: string[],
  ) => Promise<StellaBrowserExportedCookie[]>;
  connectCdp: (cdpUrl: string) => Promise<void>;
  connectAgentCdp: (
    capability: StellaBrowserAgentCapability,
    cdpUrl: string,
  ) => Promise<StellaBrowserAgentBackend>;
  subscribeCookieEvents: (
    onEvent: (event: Record<string, unknown>) => void,
  ) => () => void;
};

export const createStellaBrowserBridgeResource = (options: {
  stellaAppDir: string;
  processRuntime: ProcessRuntime;
  onStatus: (status: StellaBrowserBridgeStatus) => void;
}): StellaBrowserBridgeResource => {
  let currentStatus: StellaBrowserBridgeStatus = {
    state: "idle",
    attempt: 0,
  };
  let hasConnected = false;
  let toastShownForCurrentOutage = false;

  const publishStatus = (status: StellaBrowserBridgeStatus) => {
    currentStatus = status;
    options.onStatus(status);
  };

  const classifyFailure = (error: string): StellaBrowserBridgeFailureReason => {
    const normalized = error.toLowerCase();
    if (
      error.includes(BROWSER_BRIDGE_MISSING_ERROR) ||
      normalized.includes("browser bridge binary not found")
    ) {
      return "bridge_missing";
    }
    if (
      normalized.includes("eacces") ||
      normalized.includes("eperm") ||
      normalized.includes("permission denied") ||
      normalized.includes("not authorized") ||
      normalized.includes("authorization")
    ) {
      return "authorization_failed";
    }
    return hasConnected ? "connection_lost" : "transient_failure";
  };

  const shouldNotifyForOutage = (attempt: number) =>
    !toastShownForCurrentOutage &&
    attempt > TOAST_AFTER_RETRY_ATTEMPTS &&
    (hasConnected || isStellaExtensionInstalled());

  return createManagedResource<
    StellaBrowserBridgeService,
    Pick<
      StellaBrowserBridgeResource,
      | "getStatus"
      | "getExtensionStatus"
      | "exportAllCookies"
      | "exportCookiesForUrls"
      | "connectCdp"
      | "connectAgentCdp"
      | "subscribeCookieEvents"
    >
  >(
    {
      processRuntime: options.processRuntime,
      create: ({ onUnexpectedExit }) =>
        new StellaBrowserBridgeService({
          stellaAppDir: options.stellaAppDir,
          onUnexpectedExit,
        }),
      start: (s) => s.start(),
      stop: (s) => s.stop(),
      onAttempt: ({ attempt }) => {
        publishStatus({
          state: attempt === 0 ? "connecting" : "reconnecting",
          attempt,
        });
      },
      onStarted: () => {
        hasConnected = true;
        toastShownForCurrentOutage = false;
        publishStatus({ state: "connected", attempt: 0 });
      },
      onRetry: ({ attempt, delayMs, error }) => {
        const notifyUser = shouldNotifyForOutage(attempt);
        if (notifyUser) toastShownForCurrentOutage = true;
        publishStatus({
          state: "reconnecting",
          attempt,
          nextRetryMs: delayMs,
          error,
          reason: classifyFailure(error),
          notifyUser,
        });
      },
      onError: (error) => {
        const isHostRegistration =
          error.includes("browser extension connector") ||
          error.includes("Native messaging host registration") ||
          error.includes("Browser bridge is not installed");
        if (!isHostRegistration) {
          return;
        }
        const reason = classifyFailure(error);
        const notifyUser = hasConnected || isStellaExtensionInstalled();
        publishStatus({
          state: "host_registration_failed",
          attempt: 0,
          error,
          reason,
          notifyUser,
        });
      },
    },
    ({ getService }) => {
      const requireService = () => {
        const service = getService();
        if (!service) {
          throw new Error("Browser bridge service is not running.");
        }
        return service;
      };

      return {
        getStatus: () => currentStatus,
        getExtensionStatus: async () =>
          getService()?.getExtensionStatus() ?? false,
        exportAllCookies: async () => requireService().exportAllCookies(),
        exportCookiesForUrls: async (urls: string[]) =>
          requireService().exportCookiesForUrls(urls),
        connectCdp: async (cdpUrl: string) =>
          requireService().connectCdp(cdpUrl),
        connectAgentCdp: async (
          capability: StellaBrowserAgentCapability,
          cdpUrl: string,
        ) => requireService().connectAgentCdp(capability, cdpUrl),
        subscribeCookieEvents: (
          onEvent: (event: Record<string, unknown>) => void,
        ) => {
          // Delegates to the current service, which owns socket-level
          // reconnects to the daemon. If the bridge service has not started
          // yet, there is nothing to subscribe to; the in-app browser's
          // periodic reconcile is the backstop until a subscription exists.
          const service = getService();
          if (!service) {
            return () => {};
          }
          return service.subscribeToExtensionEvents(onEvent);
        },
      };
    },
  );
};
