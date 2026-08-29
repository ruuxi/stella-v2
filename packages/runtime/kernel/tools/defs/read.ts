/**
 * `Read` — local text and image file reader.
 *
 * The host's `handleRead` applies the runtime file-access policy.
 *
 * The model-visible surface (name, description, parameters) lives in
 * `read-def.ts` so workerd hosts expose the identical tool; this file adds the
 * executable handler for tool-host consumers.
 */

import { handleRead } from "../file.js";
import type { ToolDefinition } from "../types.js";
import {
  READ_TOOL_DESCRIPTION,
  READ_TOOL_NAME,
  READ_TOOL_PARAMETERS,
} from "./read-def.js";

export { READ_TOOL_PARAMETERS } from "./read-def.js";

export const readTool: ToolDefinition = {
  name: READ_TOOL_NAME,
  description: READ_TOOL_DESCRIPTION,
  parameters: READ_TOOL_PARAMETERS,
  execute: (args, context) => handleRead(args, context),
};
