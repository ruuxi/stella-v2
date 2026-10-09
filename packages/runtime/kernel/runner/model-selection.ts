import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  canResolveLlmRoute,
  resolveLlmRoute,
  resolveLlmRouteForCatalogEnrichment,
  type ResolvedLlmRoute,
} from "../model-routing.js";
import { withStellaModelCatalogMetadata } from "../stella-model-catalog.js";
import type { RunnerContext } from "./types.js";

export const createRunnerSiteConfig = (context: RunnerContext) => ({
  baseUrl: context.state.backendUrl,
  getAuthToken: () => context.state.authToken?.trim(),
  hasConnectedAccount: () => context.state.hasConnectedAccount,
  getChallengeToken: context.requestChallengeToken,
  getDeviceSigner:
    context.getDeviceSigner ??
    (() => {
      throw new Error("Stella device signing is not configured.");
    }),
  refreshAuthToken: async () => {
    const result = await context.requestRuntimeAuthRefresh?.({
      source: "stella_provider",
    });
    return result?.authenticated ? result.token : null;
  },
});

export const resolveRunnerLlmRoute = (
  context: RunnerContext,
  agentType: string,
  modelName: string | undefined,
  reasoningEffort?: string,
): ResolvedLlmRoute =>
  resolveLlmRoute({
    stellaAppDir: context.stellaDataDir,
    modelName,
    agentType,
    site: createRunnerSiteConfig(context),
    reasoningEffort,
  });

export const resolveRunnerLlmRouteWithMetadata = async (
  context: RunnerContext,
  agentType: string,
  modelName: string | undefined,
  reasoningEffort?: string,
): Promise<ResolvedLlmRoute> => {
  const site = createRunnerSiteConfig(context);
  const route = resolveLlmRouteForCatalogEnrichment({
    stellaAppDir: context.stellaDataDir,
    modelName,
    agentType,
    site,
    reasoningEffort,
  });
  return await withStellaModelCatalogMetadata({
    route,
    agentType,
    site,
    deviceId: context.deviceId,
    backendUrl: context.state.backendUrl,
    stellaDataDir: context.stellaDataDir,
    reasoningEffort,
  });
};

export const canResolveRunnerLlmRoute = (
  context: RunnerContext,
  modelName: string | undefined,
  agentType = AGENT_IDS.ORCHESTRATOR,
): boolean =>
  canResolveLlmRoute({
    stellaAppDir: context.stellaDataDir,
    modelName,
    agentType,
    site: createRunnerSiteConfig(context),
  });
