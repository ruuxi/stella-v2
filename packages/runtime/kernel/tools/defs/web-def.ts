/**
 * The `web` tool's model-visible surface — name, description, parameter
 * schema — and the search-capability contract, split from the executable
 * definition so hosts that assemble their own tool list (the cloud
 * orchestrator DO runs in workerd and cannot import the desktop tool host)
 * still expose the byte-identical tool to the model. `web.ts` composes
 * this with the executable handler for tool-host consumers.
 */

export type WebSearchCapability = (
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

export const WEB_TOOL_NAME = "web";

export const WEB_TOOL_DESCRIPTION =
  "Search the live web (provide query) or fetch a known URL (provide url). Pass exactly one of query or url. Use this for facts that change over time, recent news, current documentation, or any specific page you need to read.";

export const WEB_TOOL_PROMPT_SNIPPET = "Search the web or fetch a URL";

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
        "Optional focus hint when using query. Most searches should omit it.",
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
