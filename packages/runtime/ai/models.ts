import type { ModelRegistry } from "@stella/contracts/model-registry";
import { modelRuntime } from "./model-runtime.js";
import type { Api, Model } from "./types.js";

type RegisteredProvider = keyof ModelRegistry;

type ModelApi<
  TProvider extends RegisteredProvider,
  TModelId extends keyof ModelRegistry[TProvider],
> = ModelRegistry[TProvider][TModelId] extends { api: infer TApi }
  ? TApi extends Api
    ? TApi
    : never
  : never;

export function getModel<
  TProvider extends RegisteredProvider,
  TModelId extends keyof ModelRegistry[TProvider],
>(
  provider: TProvider,
  modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
  return modelRuntime.getModel(provider, modelId as string) as Model<
    ModelApi<TProvider, TModelId>
  >;
}

export function getModels<TProvider extends RegisteredProvider>(
  provider: TProvider,
): Model<ModelApi<TProvider, keyof ModelRegistry[TProvider]>>[] {
  return modelRuntime.getModels(provider) as Model<
    ModelApi<TProvider, keyof ModelRegistry[TProvider]>
  >[];
}

export function getModelProviders(): string[] {
  return modelRuntime.getProviderIds();
}

export function getAllModels(): Model<Api>[] {
  return modelRuntime.getAllModels();
}

/**
 * Whether a user-facing model reference names an entry already present in the
 * registry. Both the registry namespace and the model's provider namespace
 * are accepted because routing supports both shapes.
 */
export function isRegisteredModelReference(rawReference: string): boolean {
  return modelRuntime.isRegisteredReference(rawReference);
}

/**
 * Register a model at runtime (e.g., from extensions).
 * If the provider doesn't exist in the registry, it is created.
 */
export function registerModel(provider: string, model: Model<Api>): void {
  modelRuntime.registerModel(provider, model);
}

/**
 * Remove a model from the runtime registry.
 *
 * Used by extension hot-reload so deleted or renamed extension models do not
 * linger until the worker restarts.
 */
export function unregisterModel(provider: string, modelId: string): void {
  modelRuntime.unregisterModel(provider, modelId);
}
