import type { Api, Model } from "../../ai/types.js";

/** A registry-independent model; override only what a test asserts on. */
export const testModel = <TApi extends Api = "openai-completions">(
  overrides: Partial<Model<TApi>> = {},
): Model<TApi> => ({
  id: "test-model",
  name: "Test model",
  api: "openai-completions" as TApi,
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
  ...overrides,
});
