import type { Api, Model } from "../ai/types.js";

export type RegistryModelFinder = (
  registryProvider: string,
  requestedCandidates: string[],
) => Model<Api> | null;

let registeredFinder: RegistryModelFinder | undefined;

export const findModelCandidate = (
  models: readonly Model<Api>[],
  requestedCandidates: readonly string[],
): Model<Api> | null => {
  for (const candidate of requestedCandidates) {
    const exact = models.find((model) => model.id === candidate);
    if (exact) return exact;
  }
  for (const candidate of requestedCandidates) {
    const canonical = models.find(
      (model) => `${model.provider}/${model.id}` === candidate,
    );
    if (canonical) return canonical;
  }
  for (const candidate of requestedCandidates) {
    const normalizedCandidate = candidate.replace(/\./g, "-");
    const normalized = models.find(
      (model) => model.id === normalizedCandidate,
    );
    if (normalized) return normalized;
  }
  return null;
};

/** Preserve live ModelRuntime overlays when that compatibility layer is loaded. */
export const registerRegistryModelFinder = (
  finder: RegistryModelFinder,
): (() => void) => {
  const previous = registeredFinder;
  registeredFinder = finder;
  return () => {
    if (registeredFinder === finder) registeredFinder = previous;
  };
};

export const registeredRegistryModelFinder =
  (): RegistryModelFinder | undefined => registeredFinder;
