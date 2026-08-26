import type { Api, AssistantMessage, Tool } from "./runtime_ai/types";

export const MOBILE_CHAT_TOOL_NAMES = [
  "remember",
  "forget",
  "recall",
  "map",
  "pdf",
  "web",
  "image_gen",
] as const;

export type MobileChatToolName = (typeof MOBILE_CHAT_TOOL_NAMES)[number];

export type MobileChatNativeToolCall = {
  id: string;
  name: MobileChatToolName;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
};

export type MobileChatAssistantSource = {
  api: Api;
  provider: string;
  model: string;
};

export type MobileChatToolMessage =
  | {
      role: "assistant";
      text: string;
      toolCalls: MobileChatNativeToolCall[];
      source?: MobileChatAssistantSource;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: MobileChatToolName;
      text: string;
      isError: boolean;
    };

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const MOBILE_CHAT_TOOLS: Tool[] = [
  {
    name: "remember",
    description:
      "Store a durable fact about the user for future mobile conversations, such as their name, location, stable preference, or ongoing situation.",
    parameters: objectSchema(
      {
        key: {
          type: "string",
          description: "Short stable label for the fact.",
        },
        value: { type: "string", description: "The fact to remember." },
      },
      ["key", "value"],
    ),
  },
  {
    name: "forget",
    description: "Remove a previously stored durable user fact.",
    parameters: objectSchema(
      {
        key: { type: "string", description: "The stored fact key to remove." },
      },
      ["key"],
    ),
  },
  {
    name: "recall",
    description:
      "Search earlier messages in this mobile conversation when the answer depends on something said previously.",
    parameters: objectSchema(
      {
        query: {
          type: "string",
          description: "Terms to find in earlier messages.",
        },
      },
      ["query"],
    ),
  },
  {
    name: "map",
    description:
      "Display an interactive map with place pins or a route. Supply either places or both origin and destination.",
    parameters: objectSchema({
      places: {
        type: "array",
        items: { type: "string" },
        description: "Named places or addresses to pin.",
      },
      origin: { type: "string", description: "Route starting place." },
      destination: { type: "string", description: "Route destination." },
      mode: {
        type: "string",
        description:
          "Travel mode such as driving, walking, cycling, or transit.",
      },
      title: { type: "string", description: "Optional map card title." },
    }),
  },
  {
    name: "pdf",
    description:
      "Generate a PDF on the phone and attach it to the conversation. Put the complete Markdown document in content.",
    parameters: objectSchema(
      {
        title: {
          type: "string",
          description: "Human-readable document title.",
        },
        content: {
          type: "string",
          description: "Complete Markdown document body.",
        },
        filename: { type: "string", description: "Optional PDF filename." },
      },
      ["content"],
    ),
  },
  {
    name: "web",
    description:
      "Search the live web or fetch a known URL. Supply exactly one of query or url. Use this whenever current or source-backed information is needed.",
    parameters: objectSchema({
      query: { type: "string", description: "Live web search query." },
      url: { type: "string", description: "Known URL to fetch." },
      category: {
        type: "string",
        description: "Optional search category hint.",
      },
      prompt: {
        type: "string",
        description: "Optional extraction instructions for a URL.",
      },
      format: {
        type: "string",
        enum: ["text", "markdown", "html"],
        description: "Fetch output format.",
      },
    }),
  },
  {
    name: "image_gen",
    description:
      "Generate one or more images and display them directly in the conversation.",
    parameters: objectSchema(
      {
        prompt: {
          type: "string",
          description: "Detailed image-generation prompt.",
        },
        aspectRatio: {
          type: "string",
          description: "Optional aspect ratio such as 4:3.",
        },
        numImages: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "Number of images to create.",
        },
      },
      ["prompt"],
    ),
  },
];

// Four mobile tool rounds can each contain one assistant message plus up to
// eight results. Keep the whole bounded loop so earlier calls never become
// orphaned when a later round uses parallel tools.
const MAX_TOOL_MESSAGES = 40;
const MAX_TOOL_CALLS_PER_MESSAGE = 8;
const MAX_TOOL_ID_CHARS = 256;
const MAX_TOOL_TEXT_CHARS = 30_000;
const MAX_TOOL_SIGNATURE_CHARS = 20_000;
const MAX_TOOL_SOURCE_CHARS = 256;
const TOOL_NAME_SET = new Set<string>(MOBILE_CHAT_TOOL_NAMES);
const API_SET = new Set<Api>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asBoundedString = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";

const asToolName = (value: unknown): MobileChatToolName | null =>
  typeof value === "string" && TOOL_NAME_SET.has(value)
    ? (value as MobileChatToolName)
    : null;

const asAssistantSource = (
  value: unknown,
): MobileChatAssistantSource | null => {
  const record = asRecord(value);
  const api = record?.api;
  const provider = asBoundedString(
    record?.provider,
    MAX_TOOL_SOURCE_CHARS,
  ).trim();
  const model = asBoundedString(record?.model, MAX_TOOL_SOURCE_CHARS).trim();
  return typeof api === "string" && API_SET.has(api as Api) && provider && model
    ? { api: api as Api, provider, model }
    : null;
};

export const parseMobileChatToolMessages = (
  raw: unknown,
): MobileChatToolMessage[] => {
  if (!Array.isArray(raw)) return [];

  const messages: MobileChatToolMessage[] = [];
  for (const value of raw.slice(-MAX_TOOL_MESSAGES)) {
    const record = asRecord(value);
    if (!record) continue;

    if (record.role === "assistant" && Array.isArray(record.toolCalls)) {
      const toolCalls: MobileChatNativeToolCall[] = [];
      for (const rawCall of record.toolCalls.slice(
        0,
        MAX_TOOL_CALLS_PER_MESSAGE,
      )) {
        const call = asRecord(rawCall);
        if (!call) continue;
        const id = asBoundedString(call.id, MAX_TOOL_ID_CHARS).trim();
        const name = asToolName(call.name);
        const args = asRecord(call.arguments);
        if (!id || !name || !args) continue;
        const thoughtSignature = asBoundedString(
          call.thoughtSignature,
          MAX_TOOL_SIGNATURE_CHARS,
        );
        toolCalls.push({
          id,
          name,
          arguments: args,
          ...(thoughtSignature ? { thoughtSignature } : {}),
        });
      }
      if (toolCalls.length > 0) {
        const source = asAssistantSource(record.source);
        messages.push({
          role: "assistant",
          text: asBoundedString(record.text, MAX_TOOL_TEXT_CHARS),
          toolCalls,
          ...(source ? { source } : {}),
        });
      }
      continue;
    }

    if (record.role === "toolResult") {
      const toolCallId = asBoundedString(
        record.toolCallId,
        MAX_TOOL_ID_CHARS,
      ).trim();
      const toolName = asToolName(record.toolName);
      if (!toolCallId || !toolName) continue;
      messages.push({
        role: "toolResult",
        toolCallId,
        toolName,
        text: asBoundedString(record.text, MAX_TOOL_TEXT_CHARS),
        isError: record.isError === true,
      });
    }
  }
  return messages;
};

/** Tool-only responses are actionable output; whitespace-only responses are not. */
export const assistantMessageHasMobileOutput = (
  message: AssistantMessage,
): boolean =>
  message.content.some(
    (block) =>
      (block.type === "text" && block.text.trim().length > 0) ||
      block.type === "toolCall",
  );
