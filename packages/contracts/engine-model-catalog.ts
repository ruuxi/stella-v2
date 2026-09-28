/**
 * Hand-maintained model lists for the subscription engines (Claude Code and
 * Codex). The backend serves these to every client picker, so no surface has
 * to ask a paired computer's CLI what it supports. Update this file when a
 * provider ships new models.
 */
export type EngineModelOption = {
  id: string;
  name: string;
  description?: string;
};

/**
 * Claude Code aliases. The `claude` CLI and the cloud binding both resolve
 * these to the newest model in each family, so the list stays current without
 * pinning versions.
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

/** Codex (ChatGPT subscription) models, newest family only. */
export const CODEX_ENGINE_MODELS: readonly EngineModelOption[] = [
  {
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
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
  codex: EngineModelOption[];
};

export const ENGINE_MODEL_CATALOG: EngineModelCatalog = {
  claude: [...CLAUDE_ENGINE_MODELS],
  codex: [...CODEX_ENGINE_MODELS],
};
