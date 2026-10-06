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
  /** Start Claude Code's own sign-in in the owner's cloud container. */
  startClaudeCloudLogin: (email?: string) =>
    backendClient.call("engines.startClaudeCloudLogin", email ? { email } : {}),
  /** Hand the code Anthropic showed to the cloud's waiting `claude auth login`. */
  finishClaudeCloudLogin: (loginId: string, code: string) =>
    backendClient.call("engines.finishClaudeCloudLogin", { loginId, code }),
  cancelClaudeCloudLogin: (loginId: string) =>
    backendClient.call("engines.cancelClaudeCloudLogin", { loginId }),
  signOutClaudeCloud: (accountId: string) =>
    backendClient.call("engines.signOutClaudeCloud", { accountId }),
  setExecution: (execution: CloudExecutionSelection) =>
    backendClient.call("engines.setExecution", { execution }),
};
