import { describe, expect, it } from "vitest";

import {
  convertResponsesTools,
  normalizeOpenAIFunctionName,
} from "@stella/runtime/ai/providers/openai-responses-shared";

describe("runtime OpenAI Responses function names", () => {
  it("keeps canonical underscore tool names unchanged", () => {
    expect(normalizeOpenAIFunctionName("multi_tool_use_parallel")).toBe(
      "multi_tool_use_parallel",
    );
  });

  it("migrates the legacy dotted parallel tool name", () => {
    expect(normalizeOpenAIFunctionName("multi_tool_use.parallel")).toBe(
      "multi_tool_use_parallel",
    );
  });

  it("rejects unknown invalid tool names instead of silently rewriting them", () => {
    expect(() => normalizeOpenAIFunctionName("some.tool")).toThrow(
      "Invalid OpenAI Responses function name",
    );
  });
});

describe("runtime OpenAI Responses tool schemas", () => {
  it("loosens root alternatives into a provider-compatible object", () => {
    const [tool] = convertResponsesTools([
      {
        name: "choose_action",
        description: "Choose one action",
        parameters: {
          oneOf: [
            {
              type: "object",
              properties: { create: { type: "string" } },
              required: ["create"],
            },
            {
              type: "object",
              properties: { remove: { type: "string" } },
              required: ["remove"],
            },
          ],
        } as never,
      },
    ]);

    expect(tool?.parameters).toEqual({
      type: "object",
      properties: {
        create: { type: "string" },
        remove: { type: "string" },
      },
      required: [],
    });
  });
});
