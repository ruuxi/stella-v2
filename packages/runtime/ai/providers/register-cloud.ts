import { registerLazyApiProvider } from "../api-registry.js";

/** Register only the provider adapters used by Stella's cloud model relay. */
export function registerCloudApiProviders(): void {
  registerLazyApiProvider({
    api: "anthropic-messages",
    load: async () => {
      const { streamAnthropic, streamSimpleAnthropic } = await import(
        "./anthropic.js"
      );
      return { stream: streamAnthropic, streamSimple: streamSimpleAnthropic };
    },
  });

  registerLazyApiProvider({
    api: "openai-completions",
    load: async () => {
      const { streamOpenAICompletions, streamSimpleOpenAICompletions } =
        await import("./openai-completions.js");
      return {
        stream: streamOpenAICompletions,
        streamSimple: streamSimpleOpenAICompletions,
      };
    },
  });

  registerLazyApiProvider({
    api: "openai-responses",
    load: async () => {
      const { streamOpenAIResponses, streamSimpleOpenAIResponses } =
        await import("./openai-responses.js");
      return {
        stream: streamOpenAIResponses,
        streamSimple: streamSimpleOpenAIResponses,
      };
    },
  });

  registerLazyApiProvider({
    api: "openai-codex-responses",
    load: async () => {
      const { streamOpenAICodexResponses, streamSimpleOpenAICodexResponses } =
        await import("./openai-codex-responses.js");
      return {
        stream: streamOpenAICodexResponses,
        streamSimple: streamSimpleOpenAICodexResponses,
      };
    },
  });
}
