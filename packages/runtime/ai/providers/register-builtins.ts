import { clearApiProviders, registerLazyApiProvider } from "../api-registry.js";

export function registerBuiltInApiProviders(): void {
	registerLazyApiProvider({
		api: "anthropic-messages",
		load: async () => {
			const { streamAnthropic, streamSimpleAnthropic } = await import("./anthropic.js");
			return { stream: streamAnthropic, streamSimple: streamSimpleAnthropic };
		},
	});

	registerLazyApiProvider({
		api: "openai-completions",
		load: async () => {
			const { streamOpenAICompletions, streamSimpleOpenAICompletions } = await import(
				"./openai-completions.js"
			);
			return { stream: streamOpenAICompletions, streamSimple: streamSimpleOpenAICompletions };
		},
	});

	registerLazyApiProvider({
		api: "openai-responses",
		load: async () => {
			const { streamOpenAIResponses, streamSimpleOpenAIResponses } = await import(
				"./openai-responses.js"
			);
			return { stream: streamOpenAIResponses, streamSimple: streamSimpleOpenAIResponses };
		},
	});

	registerLazyApiProvider({
		api: "azure-openai-responses",
		load: async () => {
			const { streamAzureOpenAIResponses, streamSimpleAzureOpenAIResponses } = await import(
				"./azure-openai-responses.js"
			);
			return {
				stream: streamAzureOpenAIResponses,
				streamSimple: streamSimpleAzureOpenAIResponses,
			};
		},
	});

	registerLazyApiProvider({
		api: "openai-codex-responses",
		load: async () => {
			const { streamOpenAICodexResponses, streamSimpleOpenAICodexResponses } = await import(
				"./openai-codex-responses.js"
			);
			return {
				stream: streamOpenAICodexResponses,
				streamSimple: streamSimpleOpenAICodexResponses,
			};
		},
	});

	registerLazyApiProvider({
		api: "google-generative-ai",
		load: async () => {
			const { streamGoogle, streamSimpleGoogle } = await import("./google.js");
			return { stream: streamGoogle, streamSimple: streamSimpleGoogle };
		},
	});

	registerLazyApiProvider({
		api: "google-vertex",
		load: async () => {
			const { streamGoogleVertex, streamSimpleGoogleVertex } = await import("./google-vertex.js");
			return { stream: streamGoogleVertex, streamSimple: streamSimpleGoogleVertex };
		},
	});

	registerLazyApiProvider({
		api: "bedrock-converse-stream",
		load: async () => {
			const { streamBedrock, streamSimpleBedrock } = await import("./amazon-bedrock.js");
			return { stream: streamBedrock, streamSimple: streamSimpleBedrock };
		},
	});
}

export function resetApiProviders(): void {
	clearApiProviders();
	registerBuiltInApiProviders();
}

registerBuiltInApiProviders();
