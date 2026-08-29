/**
 * Byte budget for `display:readFile`.
 *
 * Without `maxBytes` the handler keeps its original all-or-nothing contract:
 * files above the absolute cap are refused outright. A caller that only needs
 * a preview (spreadsheet tabs parse the first rows) passes `maxBytes` and gets
 * a bounded prefix instead, so a multi-hundred-MB CSV never has to be read and
 * parsed in full on the UI thread.
 */
export const MAX_DISPLAY_FILE_BYTES = 200 * 1024 * 1024;

export type DisplayReadBytePlan =
  | { ok: true; readBytes: number; truncated: boolean }
  | { ok: false; error: string };

export const planDisplayFileRead = (
  fileSize: number,
  requestedMaxBytes: unknown,
  absoluteMax: number = MAX_DISPLAY_FILE_BYTES,
): DisplayReadBytePlan => {
  if (requestedMaxBytes === undefined) {
    if (fileSize > absoluteMax) {
      return {
        ok: false,
        error: `File too large to display (${fileSize} bytes, limit ${absoluteMax}).`,
      };
    }
    return { ok: true, readBytes: fileSize, truncated: false };
  }

  if (
    typeof requestedMaxBytes !== "number" ||
    !Number.isFinite(requestedMaxBytes) ||
    requestedMaxBytes < 1
  ) {
    return {
      ok: false,
      error: "display:readFile maxBytes must be a positive finite number.",
    };
  }

  const cap = Math.min(absoluteMax, Math.floor(requestedMaxBytes));
  const readBytes = Math.min(fileSize, cap);
  return {
    ok: true,
    readBytes,
    truncated: readBytes < fileSize,
  };
};
