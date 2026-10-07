/**
 * `ask_stella` — the one tool a BYOK realtime voice model gets.
 *
 * GPT-Live delegates through `session.delegation.created`. The Realtime API
 * (OpenAI BYOK, and xAI's event-compatible Voice Agent) has no delegation
 * channel, but it does have function calling — so the same two-brain shape is
 * expressed as a single function the voice model calls when the user wants
 * something done. Its handler runs the identical `voice.orchestratorChat`
 * path and returns the orchestrator's answer as the function result.
 *
 * Deliberately ONE tool. The per-tool catalog this replaced gave the voice
 * model its own actions and its own idea of what had happened, which is the
 * desync the delegation design exists to remove.
 */

export const ASK_STELLA_TOOL_NAME = "ask_stella";

export type RealtimeFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export const ASK_STELLA_TOOL: RealtimeFunctionTool = {
  type: "function",
  name: ASK_STELLA_TOOL_NAME,
  description:
    "Hand the user's request to Stella's backend, which is the only thing that can act: it reads and writes their files, opens and controls apps, drives the browser, searches the live web, reaches their connected accounts, remembers, and runs longer work in the background. Use it whenever the user wants something done, or when the answer depends on their machine, their accounts, or current information. Say one short preamble first, then call this. It returns the answer to tell the user.",
  parameters: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description:
          "One plain-language sentence describing what the user wants, in your own words, with anything the backend needs that only came up in speech (names, which item they meant, the file or app in question). Do not include spoken filler.",
      },
    },
    required: ["request"],
    additionalProperties: false,
  },
};

/** The single BYOK tool, as realtime session config wants it. */
export const ASK_STELLA_SESSION_TOOLS: readonly RealtimeFunctionTool[] = [
  ASK_STELLA_TOOL,
];

/**
 * Pull the request out of a function call's arguments. Realtime delivers them
 * as a JSON string; a model that calls the tool with nothing usable still gets
 * a delegation, built from the transcript alone.
 */
export const parseAskStellaRequest = (rawArguments: unknown): string => {
  if (typeof rawArguments !== "string" || !rawArguments.trim()) return "";
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (!parsed || typeof parsed !== "object") return "";
    const request = (parsed as Record<string, unknown>).request;
    return typeof request === "string" ? request.trim() : "";
  } catch {
    return "";
  }
};
