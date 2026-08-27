import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type { AgentModelConfigSnapshot } from "@stella/contracts/agent-engine";
import { shouldUseClaudeCodeAgentRuntime } from "../integrations/claude-code-agent-runtime.js";
import { getAgentRuntimeEngine } from "../preferences/local-preferences.js";
import {
  RECALL_CLAUDE_CODE_MODEL,
  RECALL_CODEX_PROVIDER_MODEL,
  RECALL_STELLA_MODEL,
  type RecallModelRoute,
} from "../agent-runtime/recall-route.js";
import {
  canResolveLlmRoute,
  resolveLlmRoute,
  resolveLlmRouteForCatalogEnrichment,
  resolvedLlmSupportsCredentiallessCalls,
  type ResolvedLlmRoute,
} from "../model-routing.js";
import { withStellaModelCatalogMetadata } from "../stella-model-catalog.js";
import {
  createImageDescriptionService,
  IMAGE_DESCRIPTION_AGENT_TYPE,
  IMAGE_DESCRIPTION_MODEL_ID,
} from "../agent-runtime/image-description.js";
import type { RunnerContext } from "./types.js";

export const createRunnerSiteConfig = (context: RunnerContext) => ({
  baseUrl: context.state.convexSiteUrl,
  getAuthToken: () => context.state.authToken?.trim(),
  hasConnectedAccount: () => context.state.hasConnectedAccount,
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
    modelCatalogUpdatedAt: context.state.modelCatalogUpdatedAt,
    stellaDataDir: context.stellaDataDir,
    reasoningEffort,
  });
};

export const imageDescriptionModelReferenceForRoute = (
  route: ResolvedLlmRoute,
): string => {
  if (route.route === "stella") {
    return `stella/${IMAGE_DESCRIPTION_MODEL_ID}`;
  }
  if (route.model.provider === "openrouter") {
    return `openrouter/${IMAGE_DESCRIPTION_MODEL_ID}`;
  }
  if (route.model.provider === "vercel-ai-gateway") {
    return `vercel-ai-gateway/${IMAGE_DESCRIPTION_MODEL_ID}`;
  }
  return IMAGE_DESCRIPTION_MODEL_ID;
};

export const createRunnerImageDescriptionService = (
  context: RunnerContext,
  primaryRoute: ResolvedLlmRoute,
) =>
  createImageDescriptionService({
    resolveRoute: () =>
      resolveRunnerLlmRouteWithMetadata(
        context,
        IMAGE_DESCRIPTION_AGENT_TYPE,
        imageDescriptionModelReferenceForRoute(primaryRoute),
      ),
  });

export const resolveRunnerRecallLlmRoute = async (
  context: RunnerContext,
  agentType: string,
  modelConfigSnapshot?: AgentModelConfigSnapshot,
): Promise<RecallModelRoute> => {
  const activeEngine =
    modelConfigSnapshot?.engine ?? getAgentRuntimeEngine(context.stellaDataDir);
  if (activeEngine === "claude_code_local") {

    return {
      activeEngine,
      executionEngine: "claude-code",
      modelId: `claude-code/${RECALL_CLAUDE_CODE_MODEL}`,
      claudeCodeModel: RECALL_CLAUDE_CODE_MODEL,
    };
  }
  if (activeEngine === "codex_cli") {
    const resolvedLlm = resolveRunnerLlmRoute(
      context,
      agentType,
      RECALL_CODEX_PROVIDER_MODEL,
    );
    return {
      activeEngine,
      executionEngine: "native",
      modelId: `${resolvedLlm.model.provider}/${resolvedLlm.model.id}`,
      resolvedLlm,
    };
  }
  const activeRouteModel = modelConfigSnapshot?.routeModel?.trim();
  if (activeRouteModel) {
    const resolvedLlm = await resolveRunnerLlmRouteWithMetadata(
      context,
      agentType,
      activeRouteModel,
      "low",
    );
    return {
      activeEngine,
      executionEngine: "native",
      modelId: `${resolvedLlm.model.provider}/${resolvedLlm.model.id}`,
      resolvedLlm,
    };
  }
  const resolvedLlm = await resolveRunnerLlmRouteWithMetadata(
    context,
    agentType,
    RECALL_STELLA_MODEL,
    "low",
  );
  return {
    activeEngine,
    executionEngine: "native",
    modelId: RECALL_STELLA_MODEL,
    resolvedLlm,
  };
};

export const RUNNER_UTILITY_PINNED_MODEL = "stella/light";

export const resolveRunnerUtilityLlmRoute = async (
  context: RunnerContext,
  agentType: string,
  fallbackModelName: string | undefined,
): Promise<ResolvedLlmRoute> => {
  const candidates = [RUNNER_UTILITY_PINNED_MODEL, fallbackModelName].filter(
    (candidate, index, all) => all.indexOf(candidate) === index,
  );
  for (const candidate of candidates) {
    let route: ResolvedLlmRoute;
    try {
      route = resolveRunnerLlmRoute(context, agentType, candidate);
    } catch {
      continue;
    }

    if (
      shouldUseClaudeCodeAgentRuntime({
        stellaAppDir: context.stellaDataDir,
        modelId: route.model.id,
      })
    ) {
      return route;
    }
    let enriched: ResolvedLlmRoute;
    try {
      enriched = await resolveRunnerLlmRouteWithMetadata(
        context,
        agentType,
        candidate,
      );
    } catch {
      continue;
    }
    if (resolvedLlmSupportsCredentiallessCalls(enriched)) {
      return enriched;
    }
    const apiKey = (await enriched.getApiKey())?.trim();
    if (apiKey) return enriched;
  }
  return await resolveRunnerLlmRouteWithMetadata(
    context,
    agentType,
    fallbackModelName,
  );
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
