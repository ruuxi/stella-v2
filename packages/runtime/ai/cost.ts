import type { Api, Model, Usage } from "./types.js";

/**
 * Anthropic bills 1-hour cache writes at twice the base input rate; the
 * model's `cost.cacheWrite` is the 5-minute rate (1.25x input). Same rule as
 * the gateway's `LONG_CACHE_WRITE_INPUT_MULTIPLIER` in
 * `@stella/model-catalog/pricing`.
 */
export const LONG_CACHE_WRITE_INPUT_MULTIPLIER = 2;

/**
 * Apply a model's per-million-token rates to provider-reported usage.
 *
 * This deliberately has no model-registry dependency: provider adapters can
 * account for a completed request without loading the generated catalog.
 */
export function calculateCost<TApi extends Api>(
  model: Model<TApi>,
  usage: Usage,
): Usage["cost"] {
  const longCacheWrite = Math.min(
    usage.cacheWrite,
    Math.max(0, usage.cacheWrite1h ?? 0),
  );
  usage.cost.input = (model.cost.input / 1_000_000) * usage.input;
  usage.cost.output = (model.cost.output / 1_000_000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
  usage.cost.cacheWrite =
    (model.cost.cacheWrite / 1_000_000) * (usage.cacheWrite - longCacheWrite) +
    ((LONG_CACHE_WRITE_INPUT_MULTIPLIER * model.cost.input) / 1_000_000) *
      longCacheWrite;
  usage.cost.total =
    usage.cost.input +
    usage.cost.output +
    usage.cost.cacheRead +
    usage.cost.cacheWrite;
  return usage.cost;
}
