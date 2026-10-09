/**
 * The models Stella knows, by provider: the vendored catalog
 * (`@stella/contracts/model-registry`, loaded at host startup) and the
 * Stella models the backend's catalog publishes (`stella-model-catalog.ts`).
 * It is what the model picker lists and what model routes resolve ids
 * against. Requests themselves run on upstream pi-ai (`llm-completion.ts`,
 * and `@stella/agent` for chats).
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  RuntimeModelCatalogModel,
  RuntimeModelCatalogSnapshot,
} from "@stella/contracts/model-catalog";
import { getLoadedModelRegistry } from "@stella/contracts/model-registry";
import { isRetiredAssistantProvider } from "@stella/contracts/provider-display";

let builtins: ReadonlyMap<string, readonly Model<Api>[]> | undefined;
/** Models a host publishes for one provider (the backend's Stella models). */
const managed = new Map<string, readonly Model<Api>[]>();
// Ordered across worker restarts, so a renderer keeps the newest listing.
const revision = Date.now() * 1_000;

const builtinModels = (): ReadonlyMap<string, readonly Model<Api>[]> =>
  (builtins ??= new Map(
    Object.entries(getLoadedModelRegistry())
      .filter(
        ([providerId]) =>
          providerId !== "grok" && !isRetiredAssistantProvider(providerId),
      )
      .map(([providerId, models]) => [
        providerId,
        Object.values(models) as unknown as Model<Api>[],
      ]),
  ));

/** The models one provider offers; a published list replaces the vendored one. */
export const getModels = (providerId: string): Model<Api>[] => [
  ...(managed.get(providerId) ?? builtinModels().get(providerId) ?? []),
];

export const getModelProviders = (): string[] =>
  [...new Set([...builtinModels().keys(), ...managed.keys()])].sort();

export const getAllModels = (): Model<Api>[] =>
  getModelProviders().flatMap((providerId) => getModels(providerId));

/** Publish the models a provider offers now (the backend's Stella models). */
export const setManagedProviderModels = (
  providerId: string,
  models: readonly Model<Api>[],
): void => {
  managed.set(providerId, [...models]);
};

/**
 * Whether a user-facing model reference names a known model. Both the
 * catalog's provider namespace and the model's own provider are accepted,
 * because routing supports both shapes.
 */
export const isRegisteredModelReference = (rawReference: string): boolean => {
  const reference = rawReference.trim();
  if (!reference) return false;
  return getModelProviders().some((providerId) =>
    getModels(providerId).some(
      (model) =>
        reference === model.id ||
        reference === `${providerId}/${model.id}` ||
        reference === `${model.provider}/${model.id}`,
    ),
  );
};

const listingModel = (model: Model<Api>): RuntimeModelCatalogModel => ({
  id: model.id,
  name: model.name,
  provider: model.provider,
  api: model.api,
  baseUrl: model.baseUrl,
  reasoning: model.reasoning,
  input: model.input,
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
});

/** The catalog as the model picker lists it. */
export const modelCatalogSnapshot = (): RuntimeModelCatalogSnapshot => ({
  revision,
  models: getAllModels().map(listingModel),
  runtimeManagedProviders: [],
  refreshedAt: null,
});
