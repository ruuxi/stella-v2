import {
  USER_ASK_MAX_OPTIONS,
  USER_ASK_MAX_QUESTIONS,
  USER_ASK_MAX_TIMEOUT_MS,
  USER_ASK_MIN_OPTIONS,
  USER_ASK_MIN_TIMEOUT_MS,
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
    "Ask the user a short question instead of guessing or stalling, or up to four related questions at once; they appear in one card, one question at a time, on every device, and answering once clears it everywhere. For each question the user picks an option, types their own answer, or skips it; a skipped question comes back as skipped. Prefer a timed ask: give every question a default_choice and the work continues with those defaults if nobody answers, and you adapt if an answer arrives later. Set blocking only for actions that are hard to undo (spending money, deleting things, sending as the user). Keep working on anything that does not depend on the answer.",
  promptSnippet:
    "Ask the user short questions with options (`ask_user`) rather than guessing; give each a default_choice and use a timeout unless the action is hard to undo",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: USER_ASK_MAX_QUESTIONS,
        description: `One question, or up to ${USER_ASK_MAX_QUESTIONS} related ones the user answers in a single pass.`,
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "Short stable id you will read back, e.g. `scope`. Optional.",
            },
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
              description: `Between ${USER_ASK_MIN_OPTIONS} and ${USER_ASK_MAX_OPTIONS} concrete, tappable answers. The user can always type their own answer or skip instead.`,
              items: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    description:
                      "Short stable id you will read back, e.g. `keep`.",
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
          },
          required: ["question", "options"],
        },
      },
      timeout_ms: {
        type: "number",
        minimum: USER_ASK_MIN_TIMEOUT_MS,
        maximum: USER_ASK_MAX_TIMEOUT_MS,
        description:
          "How long to wait before proceeding with the defaults, at most three minutes. Defaults to three minutes.",
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
    required: ["questions"],
  },
  execute: (args, context) =>
    handleAskUser({ askUser: options.askUser }, args, context),
});
