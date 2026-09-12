import { describe, expect, it, vi } from "vitest";

import {
  createWebTool,
  WEB_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/web";

vi.mock("@stella/runtime/kernel/tools/local-tool-overrides", () => ({
  localWebFetch: vi.fn(async (args: Record<string, unknown>) =>
    JSON.stringify(args),
  ),
}));

describe("unified web tool", () => {
  it("publishes the XOR search/fetch schema and canonical fetch formats", () => {
    expect(WEB_TOOL_PARAMETERS).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        category: {
          enum: ["company", "people", "research paper"],
          description:
            "Optional focus hint when using query. Most searches should omit it.",
        },
        format: { enum: ["text", "markdown", "html"] },
      },
      oneOf: [
        { required: ["query"], not: { required: ["url"] } },
        { required: ["url"], not: { required: ["query"] } },
      ],
    });
  });

  it("rejects invalid modes and search-only fetch options", async () => {
    const tool = createWebTool({
      webSearch: vi.fn(async () => ({ text: "ok" })),
    });
    await expect(tool.execute({})).resolves.toMatchObject({
      error: expect.stringContaining("required"),
    });
    await expect(
      tool.execute({ query: "news", url: "https://example.test" }),
    ).resolves.toMatchObject({ error: expect.stringContaining("not both") });
    await expect(
      tool.execute({ query: "news", format: "markdown" }),
    ).resolves.toMatchObject({ error: expect.stringContaining("only apply") });
    await expect(
      tool.execute({ url: "https://example.test", format: "pdf" }),
    ).resolves.toMatchObject({
      error: expect.stringContaining("text, markdown, html"),
    });
  });

  it("forwards fetch format and optional prompt", async () => {
    const tool = createWebTool();
    const result = await tool.execute({
      url: "https://example.test",
      prompt: "pricing",
      format: "markdown",
    });
    expect(result).toMatchObject({
      details: {
        mode: "fetch",
        url: "https://example.test",
        prompt: "pricing",
        format: "markdown",
      },
    });
    expect(result.result).toContain('"format":"markdown"');
  });
});
