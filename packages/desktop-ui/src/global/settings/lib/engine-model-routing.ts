import type { CatalogModel } from "./model-catalog";
import { DEFAULT_CODEX_MODEL } from "@stella/contracts/agent-engine";

export type ModelPickerEngine = "default" | "codex_cli" | "claude_code_local";

export type EngineRoutingPreferences = {
  modelOverrides: Record<string, string>;
  stellaConversationModelOverrides: Record<string, string>;
  assistantPropagatedAgents: string[];
  agentRuntimeEngine: ModelPickerEngine;
  codexModel: string;
  claudeCodeModel: string;
};

export type EngineReasoningEffort =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type EngineReasoningPreferences = {
  agentRuntimeEngine: ModelPickerEngine;
  reasoningEfforts: Record<string, EngineReasoningEffort>;
  stellaConversationReasoningEfforts: Record<string, EngineReasoningEffort>;
  codexReasoningEffort: EngineReasoningEffort;
  claudeCodeReasoningEffort: EngineReasoningEffort;
};

export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const DEFAULT_CHATGPT_MODEL = DEFAULT_CODEX_MODEL;
export const DEFAULT_CLAUDE_CODE_MODEL = "default";

const CONVERSATION_AGENT_KEYS = ["orchestrator", "general"] as const;

export function listChatGptCatalogModels(
  models: readonly CatalogModel[],
): CatalogModel[] {
  return models.filter((model) => model.provider === OPENAI_CODEX_PROVIDER);
}

export type LiveCodexModel = {
  id: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  additionalSpeedTiers?: string[];
  serviceTiers?: Array<{
    id: string;
    name?: string;
    description?: string;
  }>;
  defaultServiceTier?: string | null;
};

export function codexModelSupportsFast(
  model: LiveCodexModel | null | undefined,
): boolean {
  if (!model) return false;
  return (
    model.serviceTiers?.some((tier) => tier.id === "priority") === true ||
    model.additionalSpeedTiers?.includes("fast") === true
  );
}

export function intersectChatGptModels(
  catalog: readonly CatalogModel[],
  liveModels: readonly LiveCodexModel[],
): CatalogModel[] {
  const liveIds = new Set(
    liveModels.filter((model) => !model.hidden).map((model) => model.id),
  );
  return listChatGptCatalogModels(catalog).filter((model) =>
    liveIds.has(model.modelId),
  );
}

export function resolveChatGptModelSelection(
  requested: string | undefined,
  available: readonly string[],
  fallback: string,
): string | null {
  if (available.length === 0) return null;
  const req = requested?.trim();
  if (req && available.includes(req)) return req;
  const fb = fallback.trim();
  if (fb && available.includes(fb)) return fb;
  return available[0];
}

export type ChatGptModelResolution =

  | { kind: "available"; modelId: string }

  | { kind: "transient-gap"; modelId: string }

  | { kind: "rerouted"; modelId: string; savedModel: string }

  | { kind: "unavailable" };

export function resolveChatGptEngineModel(
  savedModel: string | undefined,
  liveIds: readonly string[],
  registryIds: readonly string[],
  fallback: string,
): ChatGptModelResolution {
  const saved = savedModel?.trim();
  if (saved && liveIds.includes(saved)) {
    return { kind: "available", modelId: saved };
  }
  if (saved && registryIds.includes(saved)) {
    return { kind: "transient-gap", modelId: saved };
  }
  const resolved = resolveChatGptModelSelection(saved, liveIds, fallback);
  if (!resolved) return { kind: "unavailable" };
  return { kind: "rerouted", modelId: resolved, savedModel: saved ?? "" };
}

export function normalizeClaudeCodeReasoningEffort(
  effort: EngineReasoningEffort,
): EngineReasoningEffort {
  return effort === "minimal" ? "low" : effort;
}

export function toOpenAiCodexModelId(modelId: string): string {
  const trimmed = modelId.trim();
  return trimmed.startsWith(`${OPENAI_CODEX_PROVIDER}/`)
    ? trimmed
    : `${OPENAI_CODEX_PROVIDER}/${trimmed}`;
}

export function fromOpenAiCodexModelId(modelId: string): string | null {
  const prefix = `${OPENAI_CODEX_PROVIDER}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : null;
}

export function buildEngineRoutingPatch(
  preferences: EngineRoutingPreferences,
  engine: ModelPickerEngine,
  modelId?: string,
): Partial<EngineRoutingPreferences> {
  const nextOverrides = { ...preferences.modelOverrides };
  const stellaOverrides = { ...preferences.stellaConversationModelOverrides };
  const nextPropagated = preferences.assistantPropagatedAgents.filter(
    (key) => !CONVERSATION_AGENT_KEYS.some((agentKey) => agentKey === key),
  );

  for (const key of CONVERSATION_AGENT_KEYS) {
    const shouldCapture =
      preferences.agentRuntimeEngine === "default" ||
      !Object.prototype.hasOwnProperty.call(stellaOverrides, key);
    if (shouldCapture) {
      if (
        nextOverrides[key] &&
        fromOpenAiCodexModelId(nextOverrides[key]) === null
      ) {
        stellaOverrides[key] = nextOverrides[key];
      } else delete stellaOverrides[key];
    }
  }

  if (engine === "codex_cli") {
    const selectedModel = modelId?.trim() || preferences.codexModel;
    const routeModel = toOpenAiCodexModelId(selectedModel);
    nextOverrides.orchestrator = routeModel;
    nextOverrides.general = routeModel;
    return {
      agentRuntimeEngine: engine,
      codexModel: selectedModel,
      modelOverrides: nextOverrides,
      stellaConversationModelOverrides: stellaOverrides,
      assistantPropagatedAgents: nextPropagated,
    };
  }

  for (const key of CONVERSATION_AGENT_KEYS) {
    if (stellaOverrides[key]) nextOverrides[key] = stellaOverrides[key];
    else delete nextOverrides[key];
  }
  return {
    agentRuntimeEngine: engine,
    ...(engine === "claude_code_local" && modelId?.trim()
      ? { claudeCodeModel: modelId.trim() }
      : {}),
    modelOverrides: nextOverrides,
    stellaConversationModelOverrides: stellaOverrides,
    assistantPropagatedAgents: nextPropagated,
  };
}

type ModelSelectionPreferences = EngineRoutingPreferences &
  EngineReasoningPreferences;

export type RecentEngineModelSelection = {
  engine: Exclude<ModelPickerEngine, "default">;
  modelId: string;
};

const RECENT_ENGINE_PREFIXES = {
  codex_cli: "codex-cli/",
  claude_code_local: "claude-code/",
} as const satisfies Record<Exclude<ModelPickerEngine, "default">, string>;

export function parseRecentEngineModelId(
  modelId: string,
): RecentEngineModelSelection | null {
  const routes = [
    [RECENT_ENGINE_PREFIXES.codex_cli, "codex_cli"],
    [RECENT_ENGINE_PREFIXES.claude_code_local, "claude_code_local"],
  ] as const;
  for (const [prefix, engine] of routes) {
    if (!modelId.startsWith(prefix)) continue;
    const selectedModel = modelId.slice(prefix.length).trim();
    return selectedModel ? { engine, modelId: selectedModel } : null;
  }
  return null;
}

export function formatRecentEngineModelId(
  engine: ModelPickerEngine,
  modelId: string | undefined,
): string | null {
  if (engine === "default") return null;
  const trimmed = modelId?.trim();
  if (!trimmed) return null;
  return `${RECENT_ENGINE_PREFIXES[engine]}${trimmed}`;
}

type ModelSelectionTarget =
  | { assistant: true; configurableAgentKeys: readonly string[] }
  | { assistant?: false; agentKey: string };

const isStellaModelId = (modelId: string): boolean =>
  modelId === "" || modelId.startsWith("stella/");

export function buildModelSelectionPatch(
  preferences: ModelSelectionPreferences,
  value: string,
  target: ModelSelectionTarget,
): Partial<ModelSelectionPreferences> {
    const engineRevertPatch = preferences.agentRuntimeEngine !== "default"
        ? {
            ...buildEngineRoutingPatch(preferences, "default"),
            ...buildEngineTransitionReasoningPatch(preferences, "default"),
        }
        : null;
    const basePreferences = engineRevertPatch
        ? { ...preferences, ...engineRevertPatch }
        : preferences;
    const previousOverrides = { ...basePreferences.modelOverrides };
    const previousPropagated = [
        ...(basePreferences.assistantPropagatedAgents ?? []),
    ];
    const nextOverrides = { ...previousOverrides };
    let nextPropagated = previousPropagated;
    if (target.assistant) {

        for (const propagatedKey of previousPropagated) {
            delete nextOverrides[propagatedKey];
        }
        for (const key of CONVERSATION_AGENT_KEYS) {
            if (value === "") {
                delete nextOverrides[key];
            }
            else {
                nextOverrides[key] = value;
            }
        }
        if (value !== "" && !isStellaModelId(value)) {

            const propagateTargets = target.configurableAgentKeys.filter((key) => !CONVERSATION_AGENT_KEYS.some((agentKey) => agentKey === key));
            const written = [];
            for (const key of propagateTargets) {
                const hadManualOverride = previousOverrides[key] !== undefined &&
                    !previousPropagated.includes(key);
                if (hadManualOverride)
                    continue;
                nextOverrides[key] = value;
                written.push(key);
            }
            nextPropagated = written;
        }
        else {
            nextPropagated = [];
        }
    }
    else {

        if (value === "") {
            delete nextOverrides[target.agentKey];
        }
        else {
            nextOverrides[target.agentKey] = value;
        }
        nextPropagated = previousPropagated.filter((key) => key !== target.agentKey);
    }

    const nextStellaConversationModelOverrides = {
        ...(basePreferences.stellaConversationModelOverrides ?? {}),
    };
    for (const key of CONVERSATION_AGENT_KEYS) {
        if (nextOverrides[key]) {
            nextStellaConversationModelOverrides[key] = nextOverrides[key];
        }
        else {
            delete nextStellaConversationModelOverrides[key];
        }
    }
    return {
        ...(engineRevertPatch ?? {}),

        agentRuntimeEngine: "default" as const,
        modelOverrides: nextOverrides,
        assistantPropagatedAgents: nextPropagated,
        stellaConversationModelOverrides: nextStellaConversationModelOverrides,
    };
}

type RecentModelSelectionPreferences = ModelSelectionPreferences & {
  codexModelExplicit?: boolean;
};

export function buildRecentModelSelectionPatch(
  preferences: RecentModelSelectionPreferences,
  modelId: string,
  target: ModelSelectionTarget,
): Partial<RecentModelSelectionPreferences> {
  const engineSelection = parseRecentEngineModelId(modelId);
  if (!engineSelection) {
    return buildModelSelectionPatch(preferences, modelId, target);
  }
  return {
    ...buildEngineRoutingPatch(
      preferences,
      engineSelection.engine,
      engineSelection.modelId,
    ),
    ...buildEngineTransitionReasoningPatch(
      preferences,
      engineSelection.engine,
    ),
    ...(engineSelection.engine === "codex_cli"
      ? { codexModelExplicit: true }
      : {}),
  };
}

export function buildEngineReasoningPatch(
  preferences: EngineReasoningPreferences,
  engine: ModelPickerEngine,
  effort: EngineReasoningEffort,
  agentKeys: readonly string[],
): Partial<EngineReasoningPreferences> {
  const nextReasoning = { ...preferences.reasoningEfforts };
  const stellaReasoning = {
    ...preferences.stellaConversationReasoningEfforts,
  };

  if (engine === "default") {
    for (const key of agentKeys) {
      if (effort === "default") delete nextReasoning[key];
      else nextReasoning[key] = effort;
    }
    for (const key of agentKeys) {
      if (nextReasoning[key]) stellaReasoning[key] = nextReasoning[key];
      else delete stellaReasoning[key];
    }
    return {
      reasoningEfforts: nextReasoning,
      stellaConversationReasoningEfforts: stellaReasoning,
    };
  }

  if (engine === "codex_cli") {
    delete nextReasoning.general;
    if (effort === "default") delete nextReasoning.orchestrator;
    else nextReasoning.orchestrator = effort;
    return {
      reasoningEfforts: nextReasoning,
      codexReasoningEffort: effort,
    };
  }

  for (const key of agentKeys) delete nextReasoning[key];
  return {
    reasoningEfforts: nextReasoning,
    claudeCodeReasoningEffort: normalizeClaudeCodeReasoningEffort(effort),
  };
}

export function buildEngineTransitionReasoningPatch(
  preferences: EngineReasoningPreferences,
  engine: ModelPickerEngine,
): Partial<EngineReasoningPreferences> {
  const next = { ...preferences.reasoningEfforts };
  const stellaReasoning = {
    ...preferences.stellaConversationReasoningEfforts,
  };
  for (const key of CONVERSATION_AGENT_KEYS) {
    const shouldCapture =
      preferences.agentRuntimeEngine === "default" ||
      !Object.prototype.hasOwnProperty.call(stellaReasoning, key);
    if (shouldCapture) {
      const effort = next[key];
      if (effort && effort !== "default") stellaReasoning[key] = effort;
      else delete stellaReasoning[key];
    }
  }
  if (engine === "default") {
    for (const key of CONVERSATION_AGENT_KEYS) {
      const effort = stellaReasoning[key];
      if (effort && effort !== "default") next[key] = effort;
      else delete next[key];
    }
  } else if (engine === "codex_cli") {
    delete next.general;
    if (preferences.codexReasoningEffort === "default")
      delete next.orchestrator;
    else next.orchestrator = preferences.codexReasoningEffort;
  } else {
    delete next.orchestrator;
    delete next.general;
  }
  return {
    reasoningEfforts: next,
    stellaConversationReasoningEfforts: stellaReasoning,
  };
}
