import { localWebFetch } from "../local-tool-overrides.js";
import type { ToolDefinition } from "../types.js";

export type WebToolOptions = {
  webSearch?: (
    query: string,
    options?: { category?: string },
  ) => Promise<{
    text: string;
    results?: Array<{
      title: string;
      url: string;
      snippet: string;
      image?: string;
      favicon?: string;
    }>;
  }>;
};

export const WEB_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  description:
    "Either search the live web (provide query) or fetch a known URL (provide url). Pass exactly one of query or url.",
  properties: {
    query: {
      type: "string",
      description:
        "Web search query. Returns ranked results with title, URL, and snippet.",
    },
    url: {
      type: "string",
      description:
        "URL to fetch. Returns the page rendered as readable text with HTML stripped.",
    },
    category: {
      type: "string",
      enum: ["company", "people", "research paper"],
      description:
        "Optional Exa category hint when using query. Most searches should omit it.",
    },
    prompt: {
      type: "string",
      description:
        "Optional follow-up prompt used by the local fetcher to extract just the relevant slice of a long page.",
    },
    format: {
      type: "string",
      enum: ["text", "markdown", "html"],
      description:
        "Fetch output format. Defaults to text. Only applies when url is provided.",
    },
  },
  oneOf: [
    { required: ["query"], not: { required: ["url"] } },
    { required: ["url"], not: { required: ["query"] } },
  ],
};

export const createWebTool = (
  options: WebToolOptions = {},
): ToolDefinition => ({
  name: "web",
  description:
    "Search the live web (provide query) or fetch a known URL (provide url). Pass exactly one of query or url. Use this for facts that change over time, recent news, current documentation, or any specific page you need to read.",
  promptSnippet: "Search the web or fetch a URL",
  parameters: WEB_TOOL_PARAMETERS,
  execute: async (args) => {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const url = typeof args.url === "string" ? args.url.trim() : "";
    const prompt =
      typeof args.prompt === "string"
        ? args.prompt.trim() || undefined
        : undefined;
    const hasExplicitFormat = typeof args.format === "string";
    const format =
      args.format === "markdown" ||
      args.format === "html" ||
      args.format === "text"
        ? args.format
        : "text";

    if (hasExplicitFormat && format !== args.format) {
      return { error: "format must be one of: text, markdown, html." };
    }

    if (!query && !url) {
      return { error: "Either query or url is required." };
    }
    if (query && url) {
      return { error: "Pass either query or url, not both." };
    }

    if (query) {
      if (prompt || hasExplicitFormat) {
        return { error: "prompt and format only apply when url is provided." };
      }
      if (!options.webSearch) {
        return { error: "web search is not available on this device." };
      }
      const category =
        typeof args.category === "string"
          ? args.category.trim() || undefined
          : undefined;
      try {
        const result = await options.webSearch(query, {
          ...(category ? { category } : {}),
        });
        return {
          result: result.text || "No results found.",
          details: {
            mode: "search",
            query,
            ...(Array.isArray(result.results)
              ? { results: result.results }
              : {}),
          },
        };
      } catch (error) {
        return { error: `web search failed: ${(error as Error).message}` };
      }
    }

    const text = await localWebFetch({
      url,
      format,
      ...(prompt ? { prompt } : {}),
    });
    return {
      result: text,
      details: {
        mode: "fetch",
        url,
        format,
        ...(prompt ? { prompt } : {}),
      },
    };
  },
});
