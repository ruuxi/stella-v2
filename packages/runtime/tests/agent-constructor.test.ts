import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "../ai/types.js";

vi.mock("@stella/contracts/model-registry", () => ({
  getLoadedModelRegistry: () => {
    throw new Error("registry unavailable");
  },
  loadModelRegistry: async () => {
    throw new Error("registry unavailable");
  },
}));

const { Agent } = await import("../kernel/agent-core/agent.js");
const { ExplicitModelAgent } =
  await import("../kernel/agent-core/explicit-model-agent.js");

const explicitModel = {
  id: "explicit-model",
  name: "Explicit model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} satisfies Model<Api>;

describe("Agent constructor model initialization", () => {
  it.each([Agent, ExplicitModelAgent])("uses an explicit initial model without reading the default registry in %s", (Constructor) => {
    const agent = new Constructor({
      initialState: {
        model: explicitModel,
        systemPrompt: "custom prompt",
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      },
    });

    expect(agent.state.model).toBe(explicitModel);
    expect(agent.state.systemPrompt).toBe("custom prompt");
    expect(agent.state.messages).toEqual([
      { role: "user", content: "hello", timestamp: 1 },
    ]);
  });

  it("keeps the default model lookup when no initial model is supplied", () => {
    expect(() => new Agent()).toThrow("registry unavailable");
  });
});
