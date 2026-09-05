import { describe, expect, it, vi } from "vitest";
import { testModel } from "./fixtures/model.js";

vi.mock("@stella/contracts/model-registry", () => ({
  getLoadedModelRegistry: () => {
    throw new Error("registry unavailable");
  },
  loadModelRegistry: async () => {
    throw new Error("registry unavailable");
  },
}));

const { Agent } = await import("../kernel/agent-core/agent.js");
const { ExplicitModelAgent } = await import(
  "../kernel/agent-core/explicit-model-agent.js"
);

const explicitModel = testModel({
  id: "explicit-model",
  name: "Explicit model",
});

describe("Agent constructor model initialization", () => {
  it.each([
    { name: "Agent", Constructor: Agent },
    { name: "ExplicitModelAgent", Constructor: ExplicitModelAgent },
  ])(
    "uses an explicit initial model without reading the default registry in $name",
    ({ Constructor }) => {
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
    },
  );
});
