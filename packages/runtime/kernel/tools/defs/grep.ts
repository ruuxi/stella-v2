/**
 * `Grep` — local ripgrep wrapper used by the Explore subagent.
 */

import { handleGrep } from "../search.js";
import type { ToolDefinition } from "../types.js";
import {
  GREP_TOOL_DESCRIPTION,
  GREP_TOOL_NAME,
  GREP_TOOL_PARAMETERS,
} from "./grep-def.js";

export { GREP_TOOL_PARAMETERS } from "./grep-def.js";

export const grepTool: ToolDefinition = {
  name: GREP_TOOL_NAME,
  description: GREP_TOOL_DESCRIPTION,
  parameters: GREP_TOOL_PARAMETERS,
  execute: (args, context) => handleGrep(args, context),
};
