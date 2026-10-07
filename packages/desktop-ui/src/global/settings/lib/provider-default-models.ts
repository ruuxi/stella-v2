export const ASSISTANT_AGENT_KEYS = ["orchestrator", "general"] as const;

export const DEFAULT_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  openai: "openai/gpt-5.5",
  anthropic: "anthropic/claude-opus-4.7",
  google: "google/gemini-3.1-pro",
  meta: "meta/muse-spark-1.2",
  openrouter: "openrouter/anthropic/claude-opus-4.7",
  xai: "xai/grok-4.5",
};

export const API_KEY_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "xai",
] as const;
