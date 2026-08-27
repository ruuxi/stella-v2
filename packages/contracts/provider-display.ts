const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  "amazon-bedrock": "Amazon Bedrock",
  anthropic: "Anthropic",
  "azure-openai-responses": "Azure OpenAI",
  cerebras: "Cerebras",
  "github-copilot": "GitHub Copilot",
  google: "Google",
  "google-vertex": "Google Vertex",
  huggingface: "Hugging Face",
  local: "Local",
  "kimi-coding": "Kimi",
  meta: "Meta",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax China",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  openai: "OpenAI",

  "openai-codex": "ChatGPT",
  openrouter: "OpenRouter",
  stella: "Stella",
  "vercel-ai-gateway": "Vercel AI Gateway",
  xai: "xAI",
  zai: "Z.AI",
};

const RETIRED_ASSISTANT_PROVIDERS = new Set(["groq", "mistral", "fal"]);

export function isRetiredAssistantProvider(provider: string): boolean {
  return RETIRED_ASSISTANT_PROVIDERS.has(provider.trim().toLowerCase());
}

export function getProviderDisplayName(provider: string): string {
  const normalized = provider.trim();
  const mapped = PROVIDER_DISPLAY_NAMES[normalized];
  if (mapped) return mapped;
  return normalized
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}
