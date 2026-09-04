/**
 * `Write` — replace or create a whole text file.
 */

import { handleWrite } from "../file.js";
import type { ToolDefinition } from "../types.js";
import {
  WRITE_TOOL_DESCRIPTION,
  WRITE_TOOL_NAME,
  WRITE_TOOL_PARAMETERS,
} from "./write-def.js";

export { WRITE_TOOL_PARAMETERS } from "./write-def.js";

export const writeTool: ToolDefinition = {
  name: WRITE_TOOL_NAME,
  description: WRITE_TOOL_DESCRIPTION,
  parameters: WRITE_TOOL_PARAMETERS,
  promptSnippet: "Create or overwrite a text file",
  execute: (args, context) => handleWrite(args, context),
};
