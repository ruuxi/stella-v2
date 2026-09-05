import type { Api, Model, Usage } from "./types.js";

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
	usage.cost.input = (model.cost.input / 1_000_000) * usage.input;
	usage.cost.output = (model.cost.output / 1_000_000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1_000_000) * usage.cacheWrite;
	usage.cost.total =
		usage.cost.input +
		usage.cost.output +
		usage.cost.cacheRead +
		usage.cost.cacheWrite;
	return usage.cost;
}
