import { clearApiProviders, registerLazyApiProvider } from "../api-registry.js";
import { registerCloudApiProviders } from "./register-cloud.js";

// NOTE: provider implementation modules are imported LAZILY (via the
// `load` closures below) rather than statically. Each module statically
// imports its heavy SDK (@anthropic-ai/sdk, openai, @google/genai, …);
// pulling that whole graph in eagerly would have to be parsed+evaluated
// before the worker can answer INTERNAL_WORKER_INITIALIZE. Registering
// loader closures keeps boot cheap — the SDK for a given api is only
// imported when `stream()` is first called for it (see ai/stream.ts +
// api-registry.ts `resolveApiProviderInternal`).

export function registerBuiltInApiProviders(): void {
  registerCloudApiProviders();

  registerLazyApiProvider({
    api: "google-generative-ai",
    load: async () => {
      const { streamGoogle, streamSimpleGoogle } = await import("./google.js");
      return { stream: streamGoogle, streamSimple: streamSimpleGoogle };
    },
  });
}

export function resetApiProviders(): void {
  clearApiProviders();
  registerBuiltInApiProviders();
}
