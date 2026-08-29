/**
 * The `apply_patch` tool's model-visible surface, split from the executable
 * definition so workerd hosts advertise the byte-identical tool. The patch
 * handler behind it writes through `node:fs`.
 */

export const APPLY_PATCH_TOOL_NAME = "apply_patch";

export const APPLY_PATCH_TOOL_DESCRIPTION =
  "Edit files via a *** Begin Patch / *** End Patch envelope. Supports Add File, Update File (with optional Move to), Delete File. Each Update File hunk is anchored by 3 lines of context above and below the change. File paths in the envelope MUST be absolute (e.g. /Users/you/projects/foo/bar.ts); relative paths are rejected and the file tools do NOT follow the shell's cwd. Required: input (the full patch text).";

export const APPLY_PATCH_TOOL_PROMPT_SNIPPET = "Edit files with patch envelopes";

export const APPLY_PATCH_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    input: {
      type: "string",
      description:
        "The entire contents of the apply_patch envelope. All file paths inside must be absolute.",
    },
  },
  required: ["input"],
};
