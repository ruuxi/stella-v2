import type { MODELS } from "./models.generated.js";

export type ModelRegistry = typeof MODELS;

let loadedRegistry: ModelRegistry | undefined;
let registryLoad: Promise<ModelRegistry> | undefined;

export function loadModelRegistry(): Promise<ModelRegistry> {
  if (loadedRegistry) return Promise.resolve(loadedRegistry);
  registryLoad ??= import("./models.generated.js").then(({ MODELS }) => {
    loadedRegistry = MODELS;
    return loadedRegistry;
  });
  return registryLoad;
}

export function getLoadedModelRegistry(): ModelRegistry {
  if (loadedRegistry) return loadedRegistry;
  throw new Error(
    "Model registry is not loaded. Call and await loadModelRegistry() during host startup before using synchronous model APIs.",
  );
}
