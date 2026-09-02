import {
  resolveManagedGatewayApiKeyFromEnv,
  type ManagedGatewayConfig,
} from "@stella/model-catalog/managed-gateway";

export * from "@stella/model-catalog/managed-gateway";

/**
 * Resolve the managed upstream API key for a gateway from Convex env,
 * honoring any documented env-var aliases (`apiKeyEnvVarFallbacks`).
 */
export function resolveManagedGatewayApiKey(
  config: ManagedGatewayConfig,
): string | undefined {
  return resolveManagedGatewayApiKeyFromEnv(config, process.env);
}
