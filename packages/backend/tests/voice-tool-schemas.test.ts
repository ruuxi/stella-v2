import { describe, expect, it } from "bun:test";

import {
  getVoiceToolSchemas,
  normalizeVoiceToolSchemas,
} from "../convex/tools/voice_schemas";

const runtimeTools = [
  {
    type: "function",
    name: "Read",
    description: "Read a file from the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

describe("voice tool schemas", () => {
  it("accepts the exact runtime tool catalog supplied by the desktop", () => {
    expect(normalizeVoiceToolSchemas(runtimeTools)).toEqual(runtimeTools);
  });

  it("removes Realtime-incompatible root constraints from runtime tools", () => {
    expect(
      normalizeVoiceToolSchemas([
        {
          ...runtimeTools[0],
          name: "image_gen",
          parameters: {
            ...runtimeTools[0].parameters,
            allOf: [{ not: { required: ["tooManyReferences"] } }],
          },
        },
      ]),
    ).toEqual([
      {
        ...runtimeTools[0],
        name: "image_gen",
      },
    ]);
  });

  it("rejects malformed catalogs instead of falling back to perform_action", () => {
    expect(
      normalizeVoiceToolSchemas([
        {
          type: "function",
          name: "Read",
          description: "Read a file.",
          parameters: { type: "string" },
        },
      ]),
    ).toBeNull();
    expect(normalizeVoiceToolSchemas([])).toBeNull();
  });

  it("retains legacy controls but advertises the unified web contract", () => {
    const tools = getVoiceToolSchemas();
    expect(tools.some((tool) => tool.name === "perform_action")).toBe(true);
    expect(tools.find((tool) => tool.name === "web_search")).toMatchObject({
      parameters: { required: ["query"] },
    });
    expect(tools.find((tool) => tool.name === "web")).toMatchObject({
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          url: { type: "string" },
          category: {
            type: "string",
            enum: ["company", "people", "research paper"],
          },
          prompt: { type: "string" },
          format: {
            type: "string",
            enum: ["text", "markdown", "html"],
          },
        },
      },
    });
  });
});
