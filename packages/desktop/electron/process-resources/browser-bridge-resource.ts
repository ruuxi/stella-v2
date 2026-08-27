import { ProcessRuntime } from "../process-runtime.js";
import {
  StellaBrowserBridgeService,
  type StellaBrowserAgentBackend,
  type StellaBrowserAgentCapability,
  type StellaBrowserExportedCookie,
} from "../services/stella-browser-bridge-service.js";
import { createManagedResource } from "../managed-resource.js";
import { BROWSER_BRIDGE_MISSING_ERROR } from "../utils/register-stella-native-messaging-host.js";
import {
  shouldEmitBrowserBridgeGlobalToast,
  type StellaBrowserBridgeFailureReason,
  type StellaBrowserBridgeStatus,
} from "@stella/contracts/browser-bridge-status";

export type {
  StellaBrowserBridgeFailureReason,
  StellaBrowserBridgeStatus,
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

  const publishStatus = (status: StellaBrowserBridgeStatus) => {
    currentStatus = {
      ...status,
      notifyUser: shouldEmitBrowserBridgeGlobalToast(status),
    };
    options.onStatus(currentStatus);
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
        publishStatus({ state: "connected", attempt: 0 });
      },
      onRetry: ({ attempt, delayMs, error }) => {
        publishStatus({
          state: "reconnecting",
          attempt,
          nextRetryMs: delayMs,
          error,
          reason: classifyFailure(error),
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
        publishStatus({
          state: "host_registration_failed",
          attempt: 0,
          error,
          reason: classifyFailure(error),
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
