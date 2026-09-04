/**
 * `Edit` — replace text inside an existing file.
 *
 * Two addressing modes:
 *  - Anchor mode (preferred): reference lines by the `LINE#HASH` anchors
 *    shown in `Read` output. No need to echo the old text back, and
 *    anchors survive whitespace drift and line shifts (hash relocation).
 *  - Exact mode (fallback): classic old_string/new_string replacement.
 */

import { handleEdit } from "../file.js";
import type { ToolDefinition } from "../types.js";
import {
  EDIT_TOOL_DESCRIPTION,
  EDIT_TOOL_NAME,
  EDIT_TOOL_PARAMETERS,
} from "./edit-def.js";

export { EDIT_TOOL_PARAMETERS } from "./edit-def.js";

export const editTool: ToolDefinition = {
  name: EDIT_TOOL_NAME,
  description: EDIT_TOOL_DESCRIPTION,
  parameters: EDIT_TOOL_PARAMETERS,
  promptSnippet: "Replace text inside an existing file",
  execute: (args, context) => handleEdit(args, context),
};
