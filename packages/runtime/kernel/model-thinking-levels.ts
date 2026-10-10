/**
 * The thinking levels a model takes. Kept apart from `model-catalog.ts` so
 * modules that only look models up (the tool host among them) do not load
 * pi-ai.
 */

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";

/**
 * Models that take xhigh although the vendored catalog has no thinking map
 * entry saying so (it predates the maps).
 */
const takesXhigh = (model: Model<Api>): boolean =>
  /gpt-5\.[2-6]/.test(model.id) ||
  (model.api === "anthropic-messages" && /opus-4[.-]6/.test(model.id));

/** The thinking levels a model takes, as pi-ai reads its catalog entry. */
export const supportedThinkingLevels = (
  model: Model<Api>,
): ModelThinkingLevel[] => {
  const levels = getSupportedThinkingLevels(model);
  return model.reasoning &&
    !levels.includes("xhigh") &&
    model.thinkingLevelMap?.xhigh === undefined &&
    takesXhigh(model)
    ? [...levels, "xhigh"]
    : levels;
};
