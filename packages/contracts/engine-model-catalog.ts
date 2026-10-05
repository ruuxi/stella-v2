/**
 * Hand-maintained model lists for the subscription engines (Claude Code and
 * ChatGPT). Pickers show these when they can't ask the provider: a signed-in
 * ChatGPT account's own list (`GET /v1/models`, `engines.listModels` for the
 * cloud) replaces the ChatGPT one. Update this file when a provider ships new
 * models.
 */
export type EngineModelOption = {
  id: string;
  name: string;
  description?: string;
};

/**
 * Claude Code aliases. The CLI resolves these for local execution; the cloud
 * relay converts them to Messages API model IDs in model-catalog. Update that
 * cloud mapping when Anthropic changes its recommended alias versions.
 */
export const CLAUDE_ENGINE_MODELS: readonly EngineModelOption[] = [
  {
    id: "default",
    name: "Default",
    description: "Recommended model for your Claude account",
  },
  {
    id: "best",
    name: "Best",
    description: "Most capable model available to you",
  },
  {
    id: "fable",
    name: "Fable",
    description: "Long, hard tasks and deep autonomy",
  },
  {
    id: "opus",
    name: "Opus",
    description: "Latest Opus for complex reasoning",
  },
  {
    id: "sonnet",
    name: "Sonnet",
    description: "Latest Sonnet for everyday work",
  },
  {
    id: "haiku",
    name: "Haiku",
    description: "Fast and efficient for simple tasks",
  },
];

/** ChatGPT plan models, newest family only. */
export const CHATGPT_ENGINE_MODELS: readonly EngineModelOption[] = [
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    description: "Balanced default for everyday coding",
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    description: "Most capable for hard, long tasks",
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    description: "Fast and low-cost",
  },
];

export type EngineModelCatalog = {
  claude: EngineModelOption[];
  chatgpt: EngineModelOption[];
};

export const ENGINE_MODEL_CATALOG: EngineModelCatalog = {
  claude: [...CLAUDE_ENGINE_MODELS],
  chatgpt: [...CHATGPT_ENGINE_MODELS],
};
