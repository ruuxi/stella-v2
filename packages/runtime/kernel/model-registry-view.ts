import type { Api, Model } from "../ai/types.js";

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
    const normalized = models.find((model) => model.id === normalizedCandidate);
    if (normalized) return normalized;
  }
  return null;
};
