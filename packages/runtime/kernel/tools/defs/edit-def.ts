/**
 * The `Edit` tool's model-visible surface, split from the executable
 * definition so workerd hosts advertise the byte-identical tool. The Node
 * host applies the runtime file-access policy; the cloud world Durable Object
 * serves the same surface over its own filesystem.
 */

export const EDIT_TOOL_NAME = "Edit";

export const EDIT_TOOL_DESCRIPTION =
  "Edit an existing text file. PREFERRED: address lines with anchors from Read output — pass anchor (the LINE#HASH prefix of the first line to replace, e.g. '42#a4f'), optionally end_anchor (last line of the range, inclusive), and new_string (full replacement text; '' deletes the range; set insert_after=true to insert new_string after the anchor line instead). FALLBACK: pass old_string (exact text currently in the file) and new_string. Use replace_all only with old_string mode. SEVERAL CHANGES IN ONE FILE: pass edits, an array of entries shaped like either mode ({ old_string, new_string } or { anchor, end_anchor?, insert_after?, new_string }) instead of the top-level fields; every entry matches the ORIGINAL file (not the result of earlier entries), entries must not overlap (merge nearby changes into one entry), and all apply together or none do. file_path MUST be an absolute path (e.g. /Users/you/projects/foo/bar.ts); relative paths are rejected and the file tools do NOT follow the shell's cwd.";

export const EDIT_TOOL_PARAMETERS: Record<string, unknown> = {
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
        "Replacement text. May be empty to delete text (or, with anchor, the whole range). Required unless edits is used.",
    },
    replace_all: {
      type: "boolean",
      description:
        "Exact-match mode only: replace every occurrence of old_string. Defaults to false.",
    },
    edits: {
      type: "array",
      description:
        "Several disjoint changes to this file in one atomic call, used instead of the top-level old_string/anchor fields. Each entry is matched against the original file; entries must not overlap.",
      items: {
        type: "object",
        properties: {
          old_string: {
            type: "string",
            description:
              "Exact current text for this entry; must be unique in the original file.",
          },
          anchor: {
            type: "string",
            description:
              "LINE#HASH anchor from Read output for this entry's first line (instead of old_string).",
          },
          end_anchor: {
            type: "string",
            description: "Anchor entries only: last line of the range (inclusive).",
          },
          insert_after: {
            type: "boolean",
            description:
              "Anchor entries only: insert new_string after the anchor line.",
          },
          new_string: {
            type: "string",
            description: "Replacement text for this entry ('' deletes).",
          },
        },
        required: ["new_string"],
      },
    },
  },
  required: ["file_path"],
};
