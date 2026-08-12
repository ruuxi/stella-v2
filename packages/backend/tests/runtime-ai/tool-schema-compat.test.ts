import { describe, expect, it } from "bun:test";

import { convertTools as convertChatTools } from "../../convex/runtime_ai/openai_completions";
import { convertResponsesTools } from "../../convex/runtime_ai/openai_responses_shared";
import type { Tool } from "../../convex/runtime_ai/types";

const originalParameters = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    payload: { anyOf: [{ type: "string" }, { type: "number" }] },
  },
  required: ["prompt"],
  allOf: [{ not: { required: ["tooManyReferences"] } }],
};

const tool: Tool = {
  name: "image_gen",
  description: "Generate an image",
  parameters: originalParameters,
};

const expectCompatibleSchema = (schema: Record<string, unknown>) => {
  expect(schema).not.toHaveProperty("oneOf");
  expect(schema).not.toHaveProperty("anyOf");
  expect(schema).not.toHaveProperty("allOf");
  expect(schema).toMatchObject({
    type: "object",
    properties: {
      prompt: { type: "string" },
      payload: { anyOf: [{ type: "string" }, { type: "number" }] },
    },
    required: ["prompt"],
  });
};

describe("backend provider tool-schema compatibility", () => {
  it("normalizes OpenAI-compatible chat tools", () => {
    const [converted] = convertChatTools([tool], {
      supportsStrictMode: true,
    } as never);
    expectCompatibleSchema(converted!.function.parameters);
    expect(originalParameters).toHaveProperty("allOf");
  });

  it("normalizes OpenAI Responses tools", () => {
    const [converted] = convertResponsesTools([tool]);
    expectCompatibleSchema(converted!.parameters);
    expect(originalParameters).toHaveProperty("allOf");
  });
});
