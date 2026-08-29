/**
 * `apply_patch` tool — JSON wrapper around Stella's patch envelope.
 *
 * Accepts a single `input` string with the full
 * `*** Begin Patch` ... `*** End Patch` envelope. File paths in the envelope
 * MUST be absolute; the file tools do not resolve relative to any cwd.
 *
 * The model-visible surface (name, description, parameters) lives in
 * `apply-patch-def.ts` so workerd hosts expose the identical tool; this file
 * adds the executable handler for tool-host consumers.
 */

import { handleApplyPatch } from "../apply-patch.js";
import type { ToolDefinition } from "../types.js";
import {
  APPLY_PATCH_TOOL_DESCRIPTION,
  APPLY_PATCH_TOOL_NAME,
  APPLY_PATCH_TOOL_PARAMETERS,
  APPLY_PATCH_TOOL_PROMPT_SNIPPET,
} from "./apply-patch-def.js";

export { APPLY_PATCH_TOOL_PARAMETERS } from "./apply-patch-def.js";

export const applyPatchTool: ToolDefinition = {
  name: APPLY_PATCH_TOOL_NAME,
  description: APPLY_PATCH_TOOL_DESCRIPTION,
  promptSnippet: APPLY_PATCH_TOOL_PROMPT_SNIPPET,
  parameters: APPLY_PATCH_TOOL_PARAMETERS,
  execute: (args, context) => handleApplyPatch(args, context),
};
