export type VoiceToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const MAX_VOICE_TOOLS = 128;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_TOOL_DESCRIPTION_CHARS = 8_192;
const MAX_TOOL_PARAMETERS_CHARS = 65_536;
const UNSUPPORTED_REALTIME_ROOT_SCHEMA_KEYS = [
  "oneOf",
  "anyOf",
  "allOf",
  "enum",
  "const",
  "not",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function normalizeVoiceToolSchemas(
  value: unknown,
): VoiceToolSchema[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_VOICE_TOOLS
  ) {
    return null;
  }

  const seen = new Set<string>();
  const tools: VoiceToolSchema[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || candidate.type !== "function") return null;

    const name =
      typeof candidate.name === "string" ? candidate.name.trim() : "";
    const description =
      typeof candidate.description === "string"
        ? candidate.description.trim()
        : "";
    const parameters = candidate.parameters;
    if (
      !name ||
      name.length > MAX_TOOL_NAME_CHARS ||
      !description ||
      description.length > MAX_TOOL_DESCRIPTION_CHARS ||
      !isRecord(parameters) ||
      parameters.type !== "object" ||
      seen.has(name)
    ) {
      return null;
    }

    let parametersLength = 0;
    try {
      parametersLength = JSON.stringify(parameters).length;
    } catch {
      return null;
    }
    if (parametersLength > MAX_TOOL_PARAMETERS_CHARS) return null;

    const providerParameters = { ...parameters };
    for (const key of UNSUPPORTED_REALTIME_ROOT_SCHEMA_KEYS) {
      delete providerParameters[key];
    }

    seen.add(name);
    tools.push({
      type: "function",
      name,
      description,
      parameters: {
        ...providerParameters,
        type: "object",
        properties: isRecord(providerParameters.properties)
          ? providerParameters.properties
          : {},
      },
    });
  }
  return tools;
}

export function getVoiceToolSchemas(): VoiceToolSchema[] {
  return [
    {
      type: "function",
      name: "web",
      description:
        "Search the live web (provide query) or fetch a known URL (provide url). Pass exactly one of query or url. " +
        "Use this for facts that change over time, recent news, current documentation, or any specific page you need to read.",
      parameters: {
        type: "object",
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
              "Optional follow-up prompt used by the fetcher to extract just the relevant slice of a long page.",
          },
          format: {
            type: "string",
            enum: ["text", "markdown", "html"],
            description:
              "Fetch output format. Defaults to text. Only applies when url is provided.",
          },
        },
      },
    },
    {
      type: "function",
      name: "web_search",
      description:
        "Legacy alias for web query mode. Search the web for current information using a natural-language query.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language web search query.",
          },
          category: {
            type: "string",
            enum: ["company", "people", "research paper"],
            description: "Optional Exa category hint.",
          },
        },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "perform_action",
      description:
        "Execute an action on behalf of the user. Call this for ANY request that involves doing something beyond casual conversation or web search: " +
        "opening/closing the dashboard, creating content, managing files, running tasks, setting reminders, browsing specific URLs, or complex multi-step operations.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      type: "function",
      name: "look_at_screen",
      description:
        "Look at the user's screen to understand visible UI elements, buttons, menus, tabs, icons, or anything visible. " +
        "Prefer this whenever visual guidance would help: 'where is...', 'show me...', 'find the...', 'how do I...', 'what do I click...', 'what is this button...', or questions about the current app or current screen. " +
        "Err on the side of calling this for on-screen guidance instead of answering with words alone. " +
        "This captures the relevant screen(s) and passes the image directly into the voice conversation.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What to look for on the screen, in the user's own words.",
          },
        },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "no_response",
      description:
        'Stay silent and wait for the user to finish. Call this when the user is still thinking — filler sounds like "hmm," "um," "uh," half-finished sentences, trailing off, or any indication they haven\'t completed their thought yet. Also use for ambient noise or unclear audio that isn\'t a real utterance. Examples: "I want to..." / "So maybe we could" / "Hmm" / "Let me think" / "What if we—"',
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      type: "function",
      name: "goodbye",
      description:
        "End the voice conversation. Call this when the user says goodbye, bye, see you later, goodnight, or otherwise indicates they want to stop talking.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  ];
}
