import {
  USER_ASK_FIELD_TYPES,
  USER_ASK_MAX_FIELDS,
  USER_ASK_URGENCY_NAMES,
} from "@stella/contracts/user-ask";
import {
  handleRequestSecureInput,
  handleUseSecureValue,
  type UserToolsConfig,
} from "../user.js";
import type { ToolDefinition } from "../types.js";

export type SecureInputOptions = {
  requestSecureInput?: UserToolsConfig["requestSecureInput"];
  useSecureValue?: UserToolsConfig["useSecureValue"];
};

export const createRequestSecureInputTool = (
  options: SecureInputOptions,
): ToolDefinition => ({
  name: "request_secure_input",
  label: "Ask for information securely",
  workingText: "Asking for details",
  replay: "unsafe",
  description:
    "Ask the user for information through a secure card, describing exactly the fields you need this time. Non-sensitive fields (an address, a one-time code) come back as values you can read. Sensitive fields (passwords, card numbers) never reach you: you get a handle instead, which `use_secure_value` can type into a browser field, pass to a command, or store in the keychain. Mark each field sensitive yourself; the user can override it. The user may answer on another device and the value travels end-to-end encrypted to this one.",
  promptSnippet:
    "Ask for information the user has to supply (`request_secure_input`) — describe the fields; sensitive ones come back as handles you use, never as values",
  parameters: {
    type: "object",
    properties: {
      purpose: {
        type: "string",
        description:
          "One line on what you need and why, e.g. \"Sign in to the airline to change the seat\".",
      },
      detail: {
        type: "string",
        description: "Optional extra context shown under the purpose.",
      },
      fields: {
        type: "array",
        minItems: 1,
        maxItems: USER_ASK_MAX_FIELDS,
        description: "Exactly the fields you need for this request.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Short stable id you will read the value back under.",
            },
            label: { type: "string", description: "What to show above the input." },
            type: {
              type: "string",
              enum: [...USER_ASK_FIELD_TYPES],
              description:
                "text (ordinary), secret (masked), code (short one-time code), choice (pick from choices).",
            },
            sensitive: {
              type: "boolean",
              description:
                "True when you must never see the value. Defaults to true for secret fields.",
            },
            placeholder: { type: "string" },
            hint: { type: "string" },
            optional: { type: "boolean" },
            choices: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                },
                required: ["id", "label"],
              },
            },
          },
          required: ["id", "label", "type"],
        },
      },
      urgency: {
        type: "string",
        enum: [...USER_ASK_URGENCY_NAMES],
        description:
          "How far this may escalate if unanswered. The user's ceiling, quiet hours, and rate limit always win.",
      },
    },
    required: ["purpose", "fields"],
  },
  execute: (args, context) =>
    handleRequestSecureInput(
      { requestSecureInput: options.requestSecureInput },
      args,
      context,
    ),
});

export const createUseSecureValueTool = (
  options: SecureInputOptions,
): ToolDefinition => ({
  name: "use_secure_value",
  label: "Use a stored secret",
  workingText: "Using it",
  replay: "unsafe",
  description:
    "Use a sensitive value you hold a handle for, without ever seeing it. Types it into a browser field, substitutes it into one command, or stores it in the OS keychain. You get back confirmation that it was used, never the value.",
  parameters: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description: "The handle returned by `request_secure_input`.",
      },
      into: {
        type: "object",
        description:
          'Where the value goes: {"kind":"browser_field","selector":"#password","tabId":"…"}, {"kind":"command","command":"login --token {{secret}}"}, or {"kind":"keychain","service":"…","account":"…"}.',
        properties: {
          kind: {
            type: "string",
            enum: ["browser_field", "command", "keychain"],
          },
          selector: { type: "string" },
          tabId: { type: "string" },
          command: { type: "string" },
          placeholder: {
            type: "string",
            description: "Token replaced by the secret. Defaults to {{secret}}.",
          },
          cwd: { type: "string" },
          service: { type: "string" },
          account: { type: "string" },
        },
        required: ["kind"],
      },
    },
    required: ["handle", "into"],
  },
  execute: (args, context) =>
    handleUseSecureValue(
      { useSecureValue: options.useSecureValue },
      args,
      context,
    ),
});
