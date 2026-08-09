/**
 * Hash-anchored line addressing for file edits.
 *
 * `Read` tags every line with a short content hash (`123#a4f`). `Edit` can
 * then address a line or range by anchor instead of echoing the exact text
 * back (`old_string`). Anchors survive whitespace drift and small-model
 * copy errors: the hash is computed from the file's real content, so the
 * model only ever copies the tag, never reconstructs the line. When the
 * file changed since the read, anchors relocate by hash (nearest match to
 * the hinted line number) before giving up.
 */

import { normalizeToLF } from "./utils.js";

/** Number of base36 characters in a line hash tag. */
const HASH_TAG_LENGTH = 3;
const HASH_SPACE = 36 ** HASH_TAG_LENGTH;

/**
 * FNV-1a over the exact line content (leading whitespace included, trailing
 * `\r` excluded via LF normalization upstream), folded into a short base36
 * tag. Stable across runs — anchors from an old Read remain valid as long
 * as the line content is unchanged.
 */
export const hashLineTag = (line: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < line.length; index++) {
    hash ^= line.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % HASH_SPACE).toString(36).padStart(HASH_TAG_LENGTH, "0");
};

export interface HashLineAnchor {
  /** 1-based line number hint from the tag. */
  line: number;
  /** Short content hash from the tag. */
  hash: string;
}

const ANCHOR_PATTERN = /^\s*(\d+)#([0-9a-z]+)\s*$/;

export const parseAnchor = (raw: unknown): HashLineAnchor => {
  const match = ANCHOR_PATTERN.exec(String(raw ?? ""));
  if (!match) {
    throw new Error(
      `Invalid anchor '${String(raw ?? "")}'. Anchors come from Read output and look like '123#a4f' (LINE#HASH).`,
    );
  }
  return { line: Number(match[1]), hash: match[2] };
};

/**
 * Format file content for the model with `LINE#HASH<TAB>content` rows.
 * `displayLines` lets the caller show sanitized text while hashes are
 * computed from the raw on-disk lines (`rawLines`), so anchors always
 * verify against the real file at edit time.
 */
export const formatWithHashLines = (
  rawLines: string[],
  displayLines: string[],
  offset = 1,
  limit = 2000,
): { header: string; body: string } => {
  const startLine = Math.max(0, offset - 1);
  const endLine = Math.min(rawLines.length, startLine + limit);

  const rows: string[] = [];
  for (let index = startLine; index < endLine; index++) {
    const lineNumber = index + 1;
    const tag = hashLineTag(rawLines[index] ?? "");
    const display = displayLines[index] ?? "";
    const truncated =
      display.length > 2000 ? `${display.slice(0, 2000)}...` : display;
    rows.push(`${String(lineNumber).padStart(6, " ")}#${tag}\t${truncated}`);
  }

  return {
    header:
      `File has ${rawLines.length} lines. Showing ${startLine + 1}-${endLine}. ` +
      `Each line is prefixed with a LINE#HASH anchor usable with Edit's anchor parameters.`,
    body: rows.join("\n"),
  };
};

/**
 * Resolve an anchor against the current file lines.
 *
 * Resolution order:
 *  1. Exact: the hinted line still carries the hash.
 *  2. Relocate: the content moved — pick the line with the same hash
 *     closest to the hint (handles edits above the target shifting lines).
 *  3. Fail with a re-read hint.
 */
export const resolveAnchor = (
  lines: string[],
  anchor: HashLineAnchor,
): number => {
  const hintIndex = anchor.line - 1;
  if (
    hintIndex >= 0 &&
    hintIndex < lines.length &&
    hashLineTag(lines[hintIndex] ?? "") === anchor.hash
  ) {
    return hintIndex;
  }

  let best = -1;
  for (let index = 0; index < lines.length; index++) {
    if (hashLineTag(lines[index] ?? "") !== anchor.hash) continue;
    if (best === -1 || Math.abs(index - hintIndex) < Math.abs(best - hintIndex)) {
      best = index;
    }
  }
  if (best !== -1) {
    return best;
  }

  const context: string[] = [];
  for (
    let index = Math.max(0, hintIndex - 2);
    index < Math.min(lines.length, hintIndex + 3);
    index++
  ) {
    const line = lines[index] ?? "";
    const snippet = line.length > 100 ? `${line.slice(0, 100)}...` : line;
    context.push(`${index + 1}#${hashLineTag(line)}\t${snippet}`);
  }
  throw new Error(
    `Anchor ${anchor.line}#${anchor.hash} does not match the current file — the content changed since it was read.\n` +
      (context.length > 0
        ? `Current lines near ${anchor.line}:\n${context.join("\n")}\n`
        : "") +
      `Re-read the file and retry with fresh anchors.`,
  );
};

/**
 * Strip `LINE#HASH<TAB>` (or plain `LINE<TAB>`) prefixes when the model
 * pasted them back from Read output. Only applies when every non-empty
 * line carries a prefix — mixed content is left untouched.
 */
export const stripHashLinePrefixes = (text: string): string => {
  const lines = text.split("\n");
  const prefixed = /^\s*\d+(#[0-9a-z]+)?\t/;
  const meaningful = lines.filter((line) => line.trim().length > 0);
  if (meaningful.length === 0 || !meaningful.every((line) => prefixed.test(line))) {
    return text;
  }
  return lines.map((line) => line.replace(prefixed, "")).join("\n");
};

export interface AnchoredEdit {
  /** Anchor of the first line of the target range. */
  anchor: HashLineAnchor;
  /** Anchor of the last line of the range (inclusive). Defaults to `anchor`. */
  endAnchor?: HashLineAnchor;
  /** Replacement text ('' deletes the range). Ignored when `insertAfter`. */
  newText: string;
  /** Insert `newText` after the anchor line instead of replacing it. */
  insertAfter?: boolean;
}

export interface AnchoredEditResult {
  content: string;
  /** 1-based line range affected in the ORIGINAL content. */
  startLine: number;
  endLine: number;
  linesRemoved: number;
  linesAdded: number;
}

/**
 * Apply one anchored edit to LF-normalized content and return the new
 * content. Throws with a model-actionable message when anchors are stale.
 */
export const applyAnchoredEdit = (
  content: string,
  edit: AnchoredEdit,
): AnchoredEditResult => {
  const lines = content.split("\n");
  const startIndex = resolveAnchor(lines, edit.anchor);
  const endIndex = edit.endAnchor
    ? resolveAnchor(lines, edit.endAnchor)
    : startIndex;
  if (endIndex < startIndex) {
    throw new Error(
      `end_anchor (line ${endIndex + 1}) resolves before anchor (line ${startIndex + 1}). ` +
        `The range must run top to bottom; re-read the file if lines moved.`,
    );
  }

  const newText = normalizeToLF(stripHashLinePrefixes(edit.newText));
  const replacementLines =
    newText === "" && !edit.insertAfter ? [] : newText.split("\n");

  const next = [...lines];
  if (edit.insertAfter) {
    next.splice(startIndex + 1, 0, ...replacementLines);
    return {
      content: next.join("\n"),
      startLine: startIndex + 1,
      endLine: startIndex + 1,
      linesRemoved: 0,
      linesAdded: replacementLines.length,
    };
  }

  const removed = endIndex - startIndex + 1;
  next.splice(startIndex, removed, ...replacementLines);
  return {
    content: next.join("\n"),
    startLine: startIndex + 1,
    endLine: endIndex + 1,
    linesRemoved: removed,
    linesAdded: replacementLines.length,
  };
};
