import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type {
  EngineProvider,
  EngineSettings,
} from "@stella/contracts/backend/engines";
import { backendClient } from "@/platform/backend/backend-client";
import { useBackendValue } from "@/platform/backend/use-backend-view";

export type CloudEngineSettings = EngineSettings;

/** The account's live engine settings; undefined while loading or skipped. */
export const useCloudEngines = (enabled: boolean): EngineSettings | undefined =>
  useBackendValue("engines.get", enabled ? {} : "skip");

export const cloudEnginesApi = {
  disconnect: (provider: EngineProvider, accountId?: string, options?: { forget?: boolean }) =>
    backendClient.call("engines.disconnect", {
      provider,
      ...(accountId ? { accountId } : {}),
      ...(options?.forget ? { forget: true } : {}),
    }),
  setActiveAccount: (provider: EngineProvider, accountId: string) =>
    backendClient.call("engines.setActiveAccount", { provider, accountId }),
  setAutoSwitch: (provider: EngineProvider, enabled: boolean) =>
    backendClient.call("engines.setAutoSwitch", { provider, enabled }),
  setExecution: (execution: CloudExecutionSelection) =>
    backendClient.call("engines.setExecution", { execution }),
};
