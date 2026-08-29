/**
 * The `Read` tool's model-visible surface, split from the executable
 * definition so workerd hosts advertise the byte-identical tool. `handleRead`
 * applies the runtime file-access policy through `node:fs`.
 */

export const READ_TOOL_NAME = "Read";

export const READ_TOOL_DESCRIPTION =
  "Read a text file or inspect a local PNG, JPG, JPEG, GIF, or WEBP image. Image files are attached to the conversation as vision input.";

export const READ_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    file_path: {
      type: "string",
      description:
        "Absolute text or image file path. Must be absolute (~ / $HOME expansion allowed); relative paths are rejected.",
    },
    offset: { type: "number" },
    limit: { type: "number" },
  },
  required: ["file_path"],
};
