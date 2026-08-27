import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { getProviderSecretKey } from "./providers";

type KeyLookupCtx = { runQuery: ActionCtx["runQuery"] };

export async function getUserProviderKey(
  ctx: KeyLookupCtx,
  ownerId: string,
  secretKey: string,
): Promise<string | null> {
  try {
    return await ctx.runQuery(internal.data.secrets.getDecryptedLlmKey, {
      ownerId,
      provider: secretKey,
    });
  } catch {
    return null;
  }
}

export type ByokKeyResult = {
  apiKey: string;
  source: "direct" | "openrouter";
};

export async function resolveByokApiKey(
  ctx: KeyLookupCtx,
  ownerId: string,
  provider: string,
): Promise<ByokKeyResult | null> {

  const secretKey = getProviderSecretKey(provider);
  if (secretKey) {
    const key = await getUserProviderKey(ctx, ownerId, secretKey);
    if (key) return { apiKey: key, source: "direct" };
  }

  const openrouterKey = await getUserProviderKey(
    ctx,
    ownerId,
    "llm:openrouter",
  );
  if (openrouterKey) return { apiKey: openrouterKey, source: "openrouter" };

  return null;
}

export const PROVIDER_ENV_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  azure: "AZURE_API_KEY",
  "azure-cognitive-services": "AZURE_COGNITIVE_SERVICES_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_TOKEN",
  vercel: "AI_GATEWAY_API_KEY",
  zenmux: "ZENMUX_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  kilo: "KILO_API_KEY",
  "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
  gitlab: "GITLAB_TOKEN",
  "github-copilot": "GITHUB_TOKEN",
  "github-copilot-enterprise": "GITHUB_TOKEN",
  "sap-ai-core": "AICORE_SERVICE_KEY",
  opencode: "OPENCODE_API_KEY",
  inception: "INCEPTION_API_KEY",
  baseten: "BASETEN_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  meta: "META_MODEL_API_KEY",
};

export function resolvePlatformApiKey(provider: string): string | null {
  const envKey = PROVIDER_ENV_KEY_MAP[provider];
  if (envKey) {
    const value = process.env[envKey];
    if (value) return value;
  }

  if (provider === "google-vertex" || provider === "google-vertex-anthropic") {
    return (
      process.env.GOOGLE_VERTEX_ACCESS_TOKEN?.trim() ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim() ||
      null
    );
  }
  return null;
}
