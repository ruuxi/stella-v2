import { handleAskUser, type UserToolsConfig } from "../user.js";
import type { ToolDefinition } from "../types.js";
import {
  ASK_USER_TOOL_DESCRIPTION,
  ASK_USER_TOOL_LABEL,
  ASK_USER_TOOL_NAME,
  ASK_USER_TOOL_PARAMETERS,
  ASK_USER_TOOL_PROMPT_SNIPPET,
  ASK_USER_TOOL_WORKING_TEXT,
} from "./ask-user-def.js";

export type AskUserOptions = {
  askUser?: UserToolsConfig["askUser"];
};

export const createAskUserTool = (options: AskUserOptions): ToolDefinition => ({
  name: ASK_USER_TOOL_NAME,
  label: ASK_USER_TOOL_LABEL,
  workingText: ASK_USER_TOOL_WORKING_TEXT,
  replay: "unsafe",
  description: ASK_USER_TOOL_DESCRIPTION,
  promptSnippet: ASK_USER_TOOL_PROMPT_SNIPPET,
  parameters: ASK_USER_TOOL_PARAMETERS,
  execute: (args, context) =>
    handleAskUser({ askUser: options.askUser }, args, context),
});
