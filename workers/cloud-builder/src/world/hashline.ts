const HASH_TAG_LENGTH = 3;
const HASH_SPACE = 36 ** HASH_TAG_LENGTH;

export type HashLineAnchor = { line: number; hash: string };

export const hashLineTag = (line: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < line.length; index += 1) {
    hash ^= line.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % HASH_SPACE).toString(36).padStart(HASH_TAG_LENGTH, "0");
};

export const parseAnchor = (raw: unknown): HashLineAnchor => {
  const match = /^\s*(\d+)#([0-9a-z]+)\s*$/.exec(String(raw ?? ""));
  if (!match) {
    throw new Error(
      `Invalid anchor '${String(raw ?? "")}'. Anchors come from Read output and look like '123#a4f' (LINE#HASH).`,
    );
  }
  return { line: Number(match[1]), hash: match[2] ?? "" };
};

export const formatWithHashLines = (
  rawLines: string[],
  displayLines: string[],
  offset = 1,
  limit = 2000,
): { header: string; body: string } => {
  const startLine = Math.max(0, offset - 1);
  const endLine = Math.min(rawLines.length, startLine + limit);
  const rows: string[] = [];
  for (let index = startLine; index < endLine; index += 1) {
    const lineNumber = index + 1;
    const tag = hashLineTag(rawLines[index] ?? "");
    const display = displayLines[index] ?? "";
    rows.push(
      `${String(lineNumber).padStart(6, " ")}#${tag}\t${display.length > 2000 ? `${display.slice(0, 2000)}...` : display}`,
    );
  }
  return {
    header:
      `File has ${rawLines.length} lines. Showing ${startLine + 1}-${endLine}. ` +
      "Each line is prefixed with a LINE#HASH anchor usable with Edit's anchor parameters.",
    body: rows.join("\n"),
  };
};

const resolveAnchor = (lines: string[], anchor: HashLineAnchor): number => {
  const hintIndex = anchor.line - 1;
  if (hintIndex >= 0 && hintIndex < lines.length && hashLineTag(lines[hintIndex] ?? "") === anchor.hash) {
    return hintIndex;
  }
  let best = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (hashLineTag(lines[index] ?? "") !== anchor.hash) continue;
    if (best === -1 || Math.abs(index - hintIndex) < Math.abs(best - hintIndex)) best = index;
  }
  if (best !== -1) return best;
  const context: string[] = [];
  for (let index = Math.max(0, hintIndex - 2); index < Math.min(lines.length, hintIndex + 3); index += 1) {
    const line = lines[index] ?? "";
    context.push(`${index + 1}#${hashLineTag(line)}\t${line.length > 100 ? `${line.slice(0, 100)}...` : line}`);
  }
  throw new Error(
    `Anchor ${anchor.line}#${anchor.hash} does not match the current file — the content changed since it was read.\n` +
      (context.length > 0 ? `Current lines near ${anchor.line}:\n${context.join("\n")}\n` : "") +
      "Re-read the file and retry with fresh anchors.",
  );
};

const stripHashLinePrefixes = (text: string): string => {
  const lines = text.split("\n");
  const prefixed = /^\s*\d+(#[0-9a-z]+)?\t/;
  const meaningful = lines.filter((line) => line.trim().length > 0);
  if (meaningful.length === 0 || !meaningful.every((line) => prefixed.test(line))) return text;
  return lines.map((line) => line.replace(prefixed, "")).join("\n");
};

export const applyAnchoredEdit = (
  content: string,
  input: {
    anchor: HashLineAnchor;
    endAnchor?: HashLineAnchor;
    newText: string;
    insertAfter?: boolean;
  },
): {
  content: string;
  startLine: number;
  endLine: number;
  linesRemoved: number;
  linesAdded: number;
} => {
  const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const startIndex = resolveAnchor(lines, input.anchor);
  const endIndex = input.endAnchor ? resolveAnchor(lines, input.endAnchor) : startIndex;
  if (endIndex < startIndex) {
    throw new Error(
      `end_anchor (line ${endIndex + 1}) resolves before anchor (line ${startIndex + 1}). The range must run top to bottom; re-read the file if lines moved.`,
    );
  }
  const newText = stripHashLinePrefixes(
    input.newText.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
  );
  const replacementLines = newText === "" && !input.insertAfter ? [] : newText.split("\n");
  const next = [...lines];
  if (input.insertAfter) {
    next.splice(startIndex + 1, 0, ...replacementLines);
    return { content: next.join("\n"), startLine: startIndex + 1, endLine: startIndex + 1, linesRemoved: 0, linesAdded: replacementLines.length };
  }
  const removed = endIndex - startIndex + 1;
  next.splice(startIndex, removed, ...replacementLines);
  return { content: next.join("\n"), startLine: startIndex + 1, endLine: endIndex + 1, linesRemoved: removed, linesAdded: replacementLines.length };
};
