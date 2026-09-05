import type { Api, Model, ModelThinkingLevel } from "./types.js";

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function getSupportedThinkingLevels<TApi extends Api>(
  model: Model<TApi>,
): ModelThinkingLevel[] {
  if (!model.reasoning) return ["off"];

  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh") return mapped !== undefined || supportsXhigh(model);
    return true;
  });
}

export function clampThinkingLevel<TApi extends Api>(
  model: Model<TApi>,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  const availableLevels = getSupportedThinkingLevels(model);
  if (availableLevels.includes(level)) return level;

  const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) return availableLevels[0] ?? "off";

  for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) return candidate;
  }
  return availableLevels[0] ?? "off";
}

/**
 * Backwards-compatible xhigh check for Stella code that has not migrated to
 * model-level thinkingLevelMap yet.
 */
export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
  if (model.thinkingLevelMap?.xhigh !== undefined)
    return model.thinkingLevelMap.xhigh !== null;
  if (
    model.id.includes("gpt-5.2") ||
    model.id.includes("gpt-5.3") ||
    model.id.includes("gpt-5.4") ||
    model.id.includes("gpt-5.5") ||
    model.id.includes("gpt-5.6")
  )
    return true;
  if (model.api === "anthropic-messages")
    return model.id.includes("opus-4-6") || model.id.includes("opus-4.6");
  return false;
}
