import { ProcessRuntime } from "../process-runtime.js";
import {
  StellaBrowserBridgeService,
  type StellaBrowserAgentBackend,
  type StellaBrowserAgentCapability,
  type StellaBrowserExportedCookie,
} from "../services/stella-browser-bridge-service.js";
import { createManagedResource } from "../managed-resource.js";

const TOAST_AFTER_RETRY_ATTEMPTS = 3;

type StellaBrowserBridgeState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "host_registration_failed";

export type StellaBrowserBridgeStatus = {
  state: StellaBrowserBridgeState;
  attempt: number;
  nextRetryMs?: number;
  error?: string;
  notifyUser?: boolean;
};

export type StellaBrowserBridgeResource = {
  start: () => void;
  stop: () => Promise<void>;
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
};

export const createStellaBrowserBridgeResource = (options: {
  stellaAppDir: string;
  processRuntime: ProcessRuntime;
  onStatus: (status: StellaBrowserBridgeStatus) => void;
}): StellaBrowserBridgeResource => {
  let toastShownForCurrentOutage = false;

  return createManagedResource<
    StellaBrowserBridgeService,
    Pick<
      StellaBrowserBridgeResource,
      | "getExtensionStatus"
      | "exportAllCookies"
      | "exportCookiesForUrls"
      | "connectCdp"
      | "connectAgentCdp"
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
        options.onStatus({
          state: attempt === 0 ? "connecting" : "reconnecting",
          attempt,
        });
      },
      onStarted: () => {
        toastShownForCurrentOutage = false;
        options.onStatus({ state: "connected", attempt: 0 });
      },
      onRetry: ({ attempt, delayMs, error }) => {
        const notifyUser =
          !toastShownForCurrentOutage && attempt > TOAST_AFTER_RETRY_ATTEMPTS;
        if (notifyUser) toastShownForCurrentOutage = true;
        options.onStatus({
          state: "reconnecting",
          attempt,
          nextRetryMs: delayMs,
          error,
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
        options.onStatus({
          state: "host_registration_failed",
          attempt: 0,
          error,
          notifyUser: true,
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
      };
    },
  );
};
