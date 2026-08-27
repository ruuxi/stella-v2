export type SdkType =
  | "anthropic"
  | "openai"
  | "amazon-bedrock"
  | "google"
  | "gitlab"
  | "baseten";

export const PROVIDER_SDK_MAP: Record<string, SdkType> = {

  anthropic: "anthropic",
  zenmux: "anthropic",

  openai: "openai",
  openrouter: "openai",
  azure: "openai",
  "azure-cognitive-services": "openai",
  "cloudflare-workers-ai": "openai",
  "cloudflare-ai-gateway": "openai",
  "google-vertex": "openai",
  "google-vertex-anthropic": "openai",
  vercel: "openai",
  cerebras: "openai",
  kilo: "openai",
  "sap-ai-core": "openai",
  "github-copilot": "openai",
  "github-copilot-enterprise": "openai",
  opencode: "openai",
  moonshotai: "openai",
  zai: "openai",
  inception: "openai",
  fireworks: "openai",
  deepseek: "openai",
  meta: "openai",

  baseten: "baseten",

  "amazon-bedrock": "amazon-bedrock",
  google: "google",
  gitlab: "gitlab",
};

export const NODE_ONLY_PROVIDERS = new Set([
  "amazon-bedrock",
  "google-vertex",
  "google-vertex-anthropic",
  "gitlab",
  "sap-ai-core",
  "baseten",
]);

export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_SDK_MAP);

export const PROVIDER_SECRET_KEYS: Record<string, string> = {
  anthropic: "llm:anthropic",
  openai: "llm:openai",
  google: "llm:google",
  azure: "llm:azure",
  "azure-cognitive-services": "llm:azure-cognitive-services",
  "cloudflare-workers-ai": "llm:cloudflare-workers-ai",
  vercel: "llm:vercel",
  zenmux: "llm:zenmux",
  cerebras: "llm:cerebras",
  kilo: "llm:kilo",
  "amazon-bedrock": "llm:amazon-bedrock",
  "google-vertex": "llm:google-vertex",
  "google-vertex-anthropic": "llm:google-vertex-anthropic",
  "cloudflare-ai-gateway": "llm:cloudflare-ai-gateway",
  gitlab: "llm:gitlab",
  "github-copilot": "llm:github-copilot",
  "github-copilot-enterprise": "llm:github-copilot-enterprise",
  "sap-ai-core": "llm:sap-ai-core",
  opencode: "llm:opencode",
  inception: "llm:inception",
  baseten: "llm:baseten",
  fireworks: "llm:fireworks",
  deepseek: "llm:deepseek",
};

export function extractProvider(modelString: string): string | null {
  const slash = modelString.indexOf("/");
  if (slash <= 0) return null;
  return modelString.slice(0, slash);
}

export function extractModelName(modelString: string): string {
  const slash = modelString.indexOf("/");
  if (slash <= 0) return modelString;
  return modelString.slice(slash + 1);
}

export function getSdkType(provider: string): SdkType {
  return PROVIDER_SDK_MAP[provider] ?? "openai";
}

export function isNodeOnlyProvider(provider: string): boolean {
  return NODE_ONLY_PROVIDERS.has(provider);
}

export function getProviderSecretKey(provider: string): string | null {
  return PROVIDER_SECRET_KEYS[provider] ?? null;
}
