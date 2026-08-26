import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type {
  AgentModelConfigSnapshot,
  AgentModelReasoningEffort,
  AgentRuntimeEngine,
  CloudExecutionSelection,
  CodexServiceTier,
  SpawnEngineSelection,
} from "@stella/contracts/agent-engine";
import { getCodexRuntimePreferences } from "../integrations/codex-agent-runtime.js";
import {
  getClaudeCodeAgentModelId,
  getClaudeCodeRuntimeEffortLevel,
} from "../integrations/claude-code-agent-runtime.js";
import type { ResolvedLlmRoute } from "../model-routing.js";

export const normalizeCapturedReasoningEffort = (
  value: string | undefined,
): AgentModelReasoningEffort | undefined => {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
};

export const exactRouteModelReference = (
  resolvedLlm: ResolvedLlmRoute,
  configuredModel: string | undefined,
): string => {
  if (resolvedLlm.route === "stella") {
    const upstreamModel = (
      resolvedLlm.model as ResolvedLlmRoute["model"] & {
        upstreamModelId?: string;
      }
    ).upstreamModelId;
    const resolvedModel =
      resolvedLlm.toolPolicyModel?.id.trim() ||
      upstreamModel?.trim() ||
      resolvedLlm.model.id.trim();
    return `stella/${resolvedModel}`;
  }
  if (configuredModel?.trim()) return configuredModel.trim();
  const id = resolvedLlm.model.id.trim();
  return id.includes("/") ? id : `${resolvedLlm.model.provider}/${id}`;
};

export const captureEffectiveModelConfig = (args: {
  stellaDataDir: string;
  agentType?: string;
  engine: AgentRuntimeEngine;
  subscriptionHarnessEnabled?: boolean;
  configuredModel?: string;
  engineModelOverride?: string;
  serviceTierOverride?: CodexServiceTier;
  /** Engine preferences, including an intentional absent effort, were frozen. */
  engineConfigSampled?: boolean;
  spawnEngine?: SpawnEngineSelection;
  resolvedLlm: ResolvedLlmRoute;
  reasoningEffort?: string;
}): AgentModelConfigSnapshot => {
  if (args.engine === "codex_cli") {
    const codex = getCodexRuntimePreferences(
      args.stellaDataDir,
      args.configuredModel,
      args.engineModelOverride,
    );
    const codexModel =
      args.subscriptionHarnessEnabled &&
      args.resolvedLlm.model.provider === "openai-codex"
        ? args.resolvedLlm.model.id
        : codex.model;
    const routeModel = args.subscriptionHarnessEnabled
      ? `openai-codex/${codexModel}`
      : exactRouteModelReference(args.resolvedLlm, args.configuredModel);
    const effort =
      normalizeCapturedReasoningEffort(args.reasoningEffort) ??
      (args.engineConfigSampled
        ? undefined
        : normalizeCapturedReasoningEffort(codex.reasoningEffort));
    return {
      engine: args.engine,
      subscriptionHarnessEnabled: args.subscriptionHarnessEnabled === true,
      routeModel,
      engineModel: codexModel,
      ...(effort ? { reasoningEffort: effort } : {}),
      serviceTier: args.serviceTierOverride ?? codex.serviceTier,
      ...(args.spawnEngine ? { executionProfile: "spawn_override" } : {}),
    };
  }
  const routeModel = exactRouteModelReference(
    args.resolvedLlm,
    args.configuredModel,
  );
  if (args.engine === "claude_code_local") {
    const model = getClaudeCodeAgentModelId(
      args.stellaDataDir,
      args.configuredModel,
      args.agentType ?? AGENT_IDS.ORCHESTRATOR,
      args.engineModelOverride,
    ).replace(/^claude-code\//, "");
    const effort =
      normalizeCapturedReasoningEffort(args.reasoningEffort) ??
      (args.engineConfigSampled
        ? undefined
        : normalizeCapturedReasoningEffort(
            getClaudeCodeRuntimeEffortLevel(args.stellaDataDir),
          ));
    return {
      engine: args.engine,
      subscriptionHarnessEnabled: args.subscriptionHarnessEnabled === true,
      routeModel,
      engineModel: model,
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(args.spawnEngine ? { executionProfile: "spawn_override" } : {}),
    };
  }
  const effort = normalizeCapturedReasoningEffort(args.reasoningEffort);
  return {
    engine: args.engine,
    routeModel,
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(args.spawnEngine ? { executionProfile: "spawn_override" } : {}),
  };
};

export const restoreSpawnEngineFromModelConfig = (
  snapshot: AgentModelConfigSnapshot | undefined,
): SpawnEngineSelection | undefined => {
  if (snapshot?.executionProfile !== "spawn_override") return undefined;
  if (snapshot.engine === "default") return { engine: "default" };
  return {
    engine: snapshot.engine,
    ...(snapshot.engineModel ? { model: snapshot.engineModel } : {}),
  };
};

export const toCloudExecutionSelection = (
  snapshot: AgentModelConfigSnapshot,
): CloudExecutionSelection => {
  const reasoningEffort = snapshot.reasoningEffort ?? "default";
  if (snapshot.engine === "default") {
    const model = snapshot.routeModel.trim();
    const localOnlyManagedPrefix = [
      "stella/local/",
      "stella/ollama/",
      "stella/lmstudio/",
      "stella/openai-codex/",
    ].find((prefix) => model.startsWith(prefix));
    if (
      !model.startsWith("stella/") ||
      model.length === "stella/".length ||
      localOnlyManagedPrefix
    ) {
      throw new Error(
        `Cloud agents cannot use the desktop-only model route "${model || "unknown"}". Select a Stella-managed model, Claude, or Codex for this cloud task.`,
      );
    }
    return {
      engine: "stella",
      provider: "stella",
      model,
      reasoningEffort,
    };
  }
  const model = snapshot.engineModel?.trim();
  if (!model) {
    throw new Error(
      `Cloud agents cannot use ${snapshot.engine} without an exact engine model.`,
    );
  }
  if (snapshot.engine === "claude_code_local") {
    return {
      engine: "anthropic",
      provider: "anthropic",
      model,
      reasoningEffort,
    };
  }
  return {
    engine: "openai-codex",
    provider: "openai-codex",
    model,
    reasoningEffort,
  };
};

export const resolveAgentEngineForRun = (
  configuredEngine: AgentRuntimeEngine,
  spawnEngine?: SpawnEngineSelection,
): AgentRuntimeEngine => spawnEngine?.engine ?? configuredEngine;
