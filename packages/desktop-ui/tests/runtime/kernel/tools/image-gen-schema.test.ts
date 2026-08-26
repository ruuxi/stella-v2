import { describe, expect, it } from "vitest";

import { createImageGenTool } from "../../../../../runtime/kernel/tools/defs/image-gen.js";

describe("image_gen tool schema", () => {
  it("uses a provider-compatible root object", () => {
    const tool = createImageGenTool({});

    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["prompt"],
      properties: {
        referenceImagePaths: { type: "array", maxItems: 4 },
        referenceImageUrls: { type: "array", maxItems: 4 },
      },
    });
    expect(tool.parameters).not.toHaveProperty("oneOf");
    expect(tool.parameters).not.toHaveProperty("anyOf");
    expect(tool.parameters).not.toHaveProperty("allOf");
  });

  it("still rejects more than four combined references at execution", async () => {
    const tool = createImageGenTool({});
    const result = await tool.execute(
      {
        prompt: "A test image",
        referenceImagePaths: ["one.png", "two.png", "three.png"],
        referenceImageUrls: [
          "https://example.test/four.png",
          "https://example.test/five.png",
        ],
      },
      {
        conversationId: "conversation-1",
        requestId: "request-1",
        runId: "run-1",
        agentType: "orchestrator",
      },
    );

    expect(result).toMatchObject({
      error: "image_gen accepts at most 4 reference images.",
      details: {
        status: "failed",
        error: { code: "managed_reference_count_exceeded" },
      },
    });
  });
});
