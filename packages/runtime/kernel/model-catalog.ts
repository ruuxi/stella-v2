/**
 * Model lookups over the composed catalog (`model-runtime.ts`): what model
 * routes resolve ids against and tool arguments name.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { modelRuntime } from "./model-runtime.js";

/** The models one provider offers, composed from every source. */
export const getModels = (providerId: string): Model<Api>[] =>
  modelRuntime.getModels(providerId);

export const getModelProviders = (): string[] => modelRuntime.getProviderIds();

export const getAllModels = (): Model<Api>[] => modelRuntime.getAllModels();

/** Publish the models a provider offers now (the backend's Stella models). */
export const setManagedProviderModels = (
  providerId: string,
  models: readonly Model<Api>[],
): void => modelRuntime.setManagedProviderModels(providerId, models);

/**
 * Whether a user-facing model reference names a known model. Both the
 * catalog's provider namespace and the model's own provider are accepted,
 * because routing supports both shapes.
 */
export const isRegisteredModelReference = (rawReference: string): boolean =>
  modelRuntime.isRegisteredReference(rawReference);
