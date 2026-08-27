import "../http-proxy.js";

export { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from "./anthropic.js";

export {
	getGitHubCopilotBaseUrl,
	githubCopilotOAuthProvider,
	loginGitHubCopilot,
	normalizeDomain,
	refreshGitHubCopilotToken,
} from "./github-copilot.js";

export { loginOpenAICodex, openaiCodexOAuthProvider, refreshOpenAICodexToken } from "./openai-codex.js";

export { xaiOAuthProvider } from "./xai.js";

export * from "./types.js";

import { anthropicOAuthProvider } from "./anthropic.js";
import { githubCopilotOAuthProvider } from "./github-copilot.js";
import { openaiCodexOAuthProvider } from "./openai-codex.js";
import { xaiOAuthProvider } from "./xai.js";
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInterface } from "./types.js";

const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
	anthropicOAuthProvider,
	githubCopilotOAuthProvider,
	openaiCodexOAuthProvider,
	xaiOAuthProvider,
];

const oauthProviderRegistry = new Map<string, OAuthProviderInterface>(
	BUILT_IN_OAUTH_PROVIDERS.map((provider) => [provider.id, provider]),
);

export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return oauthProviderRegistry.get(id);
}

export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	oauthProviderRegistry.set(provider.id, provider);
}

export function unregisterOAuthProvider(id: string): void {
	const builtInProvider = BUILT_IN_OAUTH_PROVIDERS.find((provider) => provider.id === id);
	if (builtInProvider) {
		oauthProviderRegistry.set(id, builtInProvider);
		return;
	}
	oauthProviderRegistry.delete(id);
}

export function resetOAuthProviders(): void {
	oauthProviderRegistry.clear();
	for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
		oauthProviderRegistry.set(provider.id, provider);
	}
}

export function getOAuthProviders(): OAuthProviderInterface[] {
	return Array.from(oauthProviderRegistry.values());
}

export async function getOAuthApiKey(
	providerId: OAuthProviderId,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}

	let creds = credentials[providerId];
	if (!creds) {
		return null;
	}

	if (Date.now() >= creds.expires) {
		try {
			creds = await provider.refreshToken(creds);
		} catch (error) {
			throw new Error(
				`Failed to refresh OAuth token for ${providerId}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}

	const apiKey = provider.getApiKey(creds);
	return { newCredentials: creds, apiKey };
}
