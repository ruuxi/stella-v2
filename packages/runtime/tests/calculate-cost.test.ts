import { describe, expect, it } from "vitest";
import { calculateCost as calculateCostFromModels } from "../ai/models.js";
import { calculateCost } from "../ai/cost.js";
import type { Api, Model, Usage } from "../ai/types.js";

const model = {
	id: "test-model",
	name: "Test model",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 },
	contextWindow: 128_000,
	maxTokens: 4_096,
} satisfies Model<Api>;

const usage = (): Usage => ({
	input: 1_000_000,
	output: 500_000,
	cacheRead: 2_000_000,
	cacheWrite: 250_000,
	totalTokens: 3_750_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("calculateCost", () => {
	it("preserves the models public export and mutates usage cost in place", () => {
		const directUsage = usage();
		const exportedUsage = usage();

		expect(calculateCost(model, directUsage)).toBe(directUsage.cost);
		expect(calculateCostFromModels(model, exportedUsage)).toBe(exportedUsage.cost);
		expect(directUsage.cost).toEqual({
			input: 2,
			output: 4,
			cacheRead: 1,
			cacheWrite: 0.75,
			total: 7.75,
		});
		expect(exportedUsage.cost).toEqual(directUsage.cost);
	});
});
