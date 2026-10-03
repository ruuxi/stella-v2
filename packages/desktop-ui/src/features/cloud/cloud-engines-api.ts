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
  startConnect: (provider: EngineProvider) =>
    backendClient.call("engines.startConnect", { provider }),
  finishConnect: (connectId: string, pastedInput: string) =>
    backendClient.call("engines.finishConnect", { connectId, pastedInput }),
  disconnect: (provider: EngineProvider) =>
    backendClient.call("engines.disconnect", { provider }),
  setExecution: (execution: CloudExecutionSelection) =>
    backendClient.call("engines.setExecution", { execution }),
};
