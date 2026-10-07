import {
  USER_ASK_MAX_OPTIONS,
  USER_ASK_MIN_OPTIONS,
  USER_ASK_URGENCY_NAMES,
} from "@stella/contracts/user-ask";
import { handleAskUser, type UserToolsConfig } from "../user.js";
import type { ToolDefinition } from "../types.js";

export type AskUserOptions = {
  askUser?: UserToolsConfig["askUser"];
};

export const createAskUserTool = (options: AskUserOptions): ToolDefinition => ({
  name: "ask_user",
  label: "Ask the user",
  workingText: "Asking",
  replay: "unsafe",
  description:
    "Ask the user one short question instead of guessing or stalling. Shows a card with your options in the chat on every device; answering once clears it everywhere. Prefer a timed ask: set a default_choice and the work continues with that default if nobody answers, and you adapt if an answer arrives later. Set blocking only for actions that are hard to undo (spending money, deleting things, sending as the user). Keep working on anything that does not depend on the answer.",
  promptSnippet:
    "Ask the user a short question with options (`ask_user`) rather than guessing; use a default_choice and a timeout unless the action is hard to undo",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "One short question, plain language, no preamble.",
      },
      detail: {
        type: "string",
        description:
          "Optional one or two lines of context shown under the question.",
      },
      options: {
        type: "array",
        minItems: USER_ASK_MIN_OPTIONS,
        maxItems: USER_ASK_MAX_OPTIONS,
        description: `Between ${USER_ASK_MIN_OPTIONS} and ${USER_ASK_MAX_OPTIONS} concrete, tappable answers. "Something else" is always added for you.`,
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Short stable id you will read back, e.g. `keep`.",
            },
            label: { type: "string", description: "Button text." },
            hint: { type: "string", description: "Optional sub-label." },
          },
          required: ["id", "label"],
        },
      },
      default_choice: {
        type: "string",
        description:
          "Option id to proceed with when the timer runs out. Required unless blocking is true.",
      },
      timeout_ms: {
        type: "number",
        description:
          "How long to wait before proceeding with default_choice. Defaults to five minutes.",
      },
      blocking: {
        type: "boolean",
        description:
          "Wait indefinitely with no default. Only for hard-to-undo actions: spending money, deleting things, sending as the user.",
      },
      urgency: {
        type: "string",
        enum: [...USER_ASK_URGENCY_NAMES],
        description:
          "How far this ask may escalate if unanswered: chat (message only), notify (desktop notification), alert (sound plus phone push), breakthrough (push that pierces focus mode and repeats). The user's own ceiling, quiet hours, and rate limit always win.",
      },
    },
    required: ["question", "options"],
  },
  execute: (args, context) =>
    handleAskUser({ askUser: options.askUser }, args, context),
});
