import { clearApiProviders, registerLazyApiProvider } from "../api-registry.js";
import { registerCloudApiProviders } from "./register-cloud.js";

// NOTE: provider implementation modules are imported LAZILY (via the
// `load` closures below) rather than statically. Each module statically
// imports its heavy SDK (@anthropic-ai/sdk, openai, @google/genai,
// @aws-sdk/client-bedrock-runtime, …); pulling that
// whole graph in eagerly would have to be parsed+evaluated before the
// worker can answer INTERNAL_WORKER_INITIALIZE. Registering loader
// closures keeps boot cheap — the SDK for a given api is only imported
// when `stream()` is first called for it (see ai/stream.ts +
// api-registry.ts `resolveApiProviderInternal`).

export function registerBuiltInApiProviders(): void {
  registerCloudApiProviders();

  registerLazyApiProvider({
    api: "azure-openai-responses",
    load: async () => {
      const { streamAzureOpenAIResponses, streamSimpleAzureOpenAIResponses } =
        await import("./azure-openai-responses.js");
      return {
        stream: streamAzureOpenAIResponses,
        streamSimple: streamSimpleAzureOpenAIResponses,
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
      const { streamGoogleVertex, streamSimpleGoogleVertex } = await import(
        "./google-vertex.js"
      );
      return {
        stream: streamGoogleVertex,
        streamSimple: streamSimpleGoogleVertex,
      };
    },
  });

  registerLazyApiProvider({
    api: "bedrock-converse-stream",
    load: async () => {
      const { streamBedrock, streamSimpleBedrock } = await import(
        "./amazon-bedrock.js"
      );
      return { stream: streamBedrock, streamSimple: streamSimpleBedrock };
    },
  });
}

export function resetApiProviders(): void {
  clearApiProviders();
  registerBuiltInApiProviders();
}
