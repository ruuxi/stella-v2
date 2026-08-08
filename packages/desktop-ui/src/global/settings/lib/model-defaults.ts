import { MODEL_SETTINGS_AGENTS } from "@stella/contracts/agent-runtime";
import { STELLA_DEFAULT_MODEL } from "@/shared/stella-api";

export type ModelDefaultEntry = {
  agentType: string;
  model: string;
  resolvedModel: string;
};

export function getLocalModelDefaults(
  defaultModels: Record<string, string> | undefined,
  serverDefaults: readonly ModelDefaultEntry[] | undefined,
): ModelDefaultEntry[] {
  const serverDefaultByAgent = new Map(
    (serverDefaults ?? []).map((entry) => [entry.agentType, entry]),
  );

  return MODEL_SETTINGS_AGENTS.map((agent) => {
    const serverDefault = serverDefaultByAgent.get(agent.key);
    const model =
      serverDefault?.model ??
      defaultModels?.[agent.key] ??
      STELLA_DEFAULT_MODEL;
    return {
      agentType: agent.key,
      model,
      resolvedModel: serverDefault?.resolvedModel ?? model,
    };
  });
}

export function buildModelDefaultsMap(
  defaults: readonly ModelDefaultEntry[] | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};

  for (const entry of defaults ?? []) {
    const agentType = entry.agentType.trim();
    const model = entry.model.trim();
    if (!agentType || !model) {
      continue;
    }
    map[agentType] = model;
  }

  return map;
}

export function buildResolvedModelDefaultsMap(
  defaults: readonly ModelDefaultEntry[] | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};

  for (const entry of defaults ?? []) {
    const agentType = entry.agentType.trim();
    const model = entry.resolvedModel.trim();
    if (!agentType || !model) {
      continue;
    }
    map[agentType] = model;
  }

  return map;
}

export function getConfigurableAgents(
  defaults: readonly ModelDefaultEntry[] | undefined,
): Array<{ key: string; label: string; desc: string }> {
  if (defaults === undefined) {
    return [];
  }
  const availableAgentTypes = new Set(
    (defaults ?? []).map((entry) => entry.agentType),
  );
  return MODEL_SETTINGS_AGENTS.filter((agent) =>
    availableAgentTypes.has(agent.key),
  );
}

export function normalizeModelOverrides(
  overrides: Record<string, string>,
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [agentType, value] of Object.entries(overrides)) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    normalized[agentType] = trimmed;
  }

  return normalized;
}

export function getModelDisplayLabel(
  modelId: string,
  modelNamesById: ReadonlyMap<string, string>,
): string {
  return modelNamesById.get(modelId) ?? modelId;
}

/** Friendly names for Claude Code CLI model aliases. */
const CLAUDE_CODE_ALIAS_LABELS: Record<string, string> = {
  default: "Default",
  best: "Best",
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  opusplan: "Opus Plan",
  "sonnet[1m]": "Sonnet · 1M",
  "opus[1m]": "Opus · 1M",
};

/**
 * Display label for a saved override id, engine routes and local models
 * included. Shared by the sidebar picker and the composer's pinned mini
 * picker so both render the same names.
 */
export function getModelPickerDisplayLabel(
  modelId: string,
  modelNamesById: ReadonlyMap<string, string>,
): string {
  if (modelId.startsWith("claude-code/")) {
    const engineModel = modelId.slice("claude-code/".length);
    return `Claude Code · ${CLAUDE_CODE_ALIAS_LABELS[engineModel] ?? engineModel}`;
  }
  if (modelId.startsWith("codex-cli/")) {
    return `ChatGPT · ${modelId.slice("codex-cli/".length)}`;
  }
  if (modelId.startsWith("local/")) {
    const localId = modelId.slice("local/".length);
    const slash = localId.indexOf("/");
    if (slash > 0) {
      const maybeBaseUrl = decodeURIComponent(localId.slice(0, slash));
      const customModel = localId.slice(slash + 1).trim();
      if (/^https?:\/\//i.test(maybeBaseUrl) && customModel) {
        return `Local ${customModel}`;
      }
    }
    return `Local ${localId}`;
  }
  return getModelDisplayLabel(modelId, modelNamesById);
}

export function getDefaultModelOptionLabel(
  agentType: string,
  defaultModels: Record<string, string>,
  resolvedDefaultModels: Record<string, string>,
  modelNamesById: ReadonlyMap<string, string>,
): string {
  const defaultModel = defaultModels[agentType];
  if (!defaultModel) {
    return "Stella Default";
  }

  const resolvedModel = resolvedDefaultModels[agentType] ?? defaultModel;
  const resolvedLabel = getModelDisplayLabel(resolvedModel, modelNamesById);
  return `Stella Default (${resolvedLabel})`;
}
