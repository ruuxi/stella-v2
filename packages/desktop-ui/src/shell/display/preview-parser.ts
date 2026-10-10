import {
  parseDelimitedRows,
  rowsForDelimitedPreview,
} from "./parse-delimited-rows";
import {
  parseApplyPatchPreview,
  buildGeneratedFilePreview,
  type DiffLine,
} from "./parse-diff-preview";

export const DIFF_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const DIFF_PREVIEW_MAX_LINES = 10_000;
export const PREVIEW_MAX_LINE_CHARS = 2_000;
/**
 * Past Streamdown's parse budget a document renders as one plaintext block,
 * so this bounds how much of that block the renderer has to lay out.
 */
export const MARKDOWN_PREVIEW_MAX_BYTES = 512 * 1024;
export type PreviewRequest =
  | {
      kind: "table";
      bytes: Uint8Array;
      delimiter: "," | "\t";
      truncated: boolean;
    }
  | {
      kind: "diff";
      bytes?: Uint8Array;
      patch?: string;
      filePath: string;
      truncated: boolean;
    }
  | {
      kind: "markdown";
      bytes: Uint8Array;
      truncated: boolean;
    };
export type PreviewResult = {
  rows: string[][];
  lines: (DiffLine | { kind: "header"; text: string })[];
  /** Decoded markdown source; empty when the document is only whitespace. */
  text?: string;
  limited: boolean;
};

export function parsePreview(request: PreviewRequest): PreviewResult {
  if (request.kind === "table") {
    const parsed = parseDelimitedRows(
      new TextDecoder().decode(request.bytes),
      request.delimiter,
    );
    let limited =
      request.truncated || parsed.hitLimit || !!parsed.columnsTruncated;
    const rows = rowsForDelimitedPreview(parsed, request.truncated).map((row) =>
      row.map((cell) => {
        if (cell.length <= PREVIEW_MAX_LINE_CHARS) return cell;
        limited = true;
        return cell.slice(0, PREVIEW_MAX_LINE_CHARS) + "…";
      }),
    );
    return { rows, lines: [], limited };
  }
  if (request.kind === "markdown") {
    let text = new TextDecoder().decode(request.bytes);
    // A byte cap can split a line or a UTF-8 sequence; end on a whole line.
    const lastNewline = request.truncated ? text.lastIndexOf("\n") : -1;
    if (lastNewline > 0) text = text.slice(0, lastNewline);
    return {
      rows: [],
      lines: [],
      text: text.trim().length > 0 ? text : "",
      limited: request.truncated,
    };
  }
  let text = request.patch ?? new TextDecoder().decode(request.bytes);
  let limited = request.truncated || text.length > DIFF_PREVIEW_MAX_BYTES;
  text = text.slice(0, DIFF_PREVIEW_MAX_BYTES);
  if (limited) text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
  // Bound intermediate allocations too, including a single enormous line.
  const sourceLines = text.split("\n");
  if (sourceLines.length > DIFF_PREVIEW_MAX_LINES) limited = true;
  text = sourceLines
    .slice(0, DIFF_PREVIEW_MAX_LINES)
    .map((line) => {
      if (line.length <= PREVIEW_MAX_LINE_CHARS) return line;
      limited = true;
      return line.slice(0, PREVIEW_MAX_LINE_CHARS) + "…";
    })
    .join("\n");
  const sections =
    request.patch !== undefined
      ? parseApplyPatchPreview(text)
      : buildGeneratedFilePreview(request.filePath, text);
  const lines: PreviewResult["lines"] = [];
  for (const section of sections) {
    lines.push({ kind: "header", text: section.title });
    lines.push(...section.lines);
  }
  return { rows: [], lines, limited };
}
