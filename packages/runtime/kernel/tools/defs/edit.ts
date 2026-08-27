import { handleEdit } from "../file.js";
import type { ToolDefinition } from "../types.js";

export const editTool: ToolDefinition = {
  name: "Edit",
  description:
    "Edit an existing text file. PREFERRED: address lines with anchors from Read output — pass anchor (the LINE#HASH prefix of the first line to replace, e.g. '42#a4f'), optionally end_anchor (last line of the range, inclusive), and new_string (full replacement text; '' deletes the range; set insert_after=true to insert new_string after the anchor line instead). FALLBACK: pass old_string (exact text currently in the file) and new_string. Use replace_all only with old_string mode. file_path MUST be an absolute path (e.g. /Users/you/projects/foo/bar.ts); relative paths are rejected and the file tools do NOT follow the shell's cwd.",
  promptSnippet: "Replace text inside an existing file",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description:
          "Absolute path to edit. Must be absolute (~ / $HOME expansion allowed); relative paths are rejected.",
      },
      anchor: {
        type: "string",
        description:
          "LINE#HASH anchor from Read output (e.g. '42#a4f') for the first line of the target range. When set, old_string is ignored.",
      },
      end_anchor: {
        type: "string",
        description:
          "LINE#HASH anchor of the last line of the range (inclusive). Omit to target only the anchor line.",
      },
      insert_after: {
        type: "boolean",
        description:
          "Anchor mode only: insert new_string after the anchor line instead of replacing it. Defaults to false.",
      },
      old_string: {
        type: "string",
        description:
          "Exact-match mode: exact text to replace. Must identify the intended span. Not needed when anchor is set.",
      },
      new_string: {
        type: "string",
        description:
          "Replacement text. May be empty to delete text (or, with anchor, the whole range).",
      },
      replace_all: {
        type: "boolean",
        description:
          "Exact-match mode only: replace every occurrence of old_string. Defaults to false.",
      },
    },
    required: ["file_path", "new_string"],
  },
  execute: (args, context) => handleEdit(args, context),
};
