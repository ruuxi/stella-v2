/**
 * File tools: Read, Write, Edit handlers.
 * File writes are direct filesystem writes; no staging interception.
 */

import { promises as fs } from "fs";
import path from "path";
import {
  TOOL_RESULT_AUTHORIZED_IMAGES,
  type ToolContext,
  type ToolResult,
} from "./types.js";
import {
  expandHomePath,
  detectLineEnding,
  fuzzyFindText,
  MAX_FILE_BYTES,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./utils.js";
import {
  applyAnchoredEdit,
  formatWithHashLines,
  parseAnchor,
  type AnchoredEditResult,
} from "./hashline.js";
import { isBlockedPath } from "./command-safety.js";
import { sanitizeToolVisibleText } from "./safety.js";
import { withFileWriteLock, writeFileWithNulGuard } from "./file-write-lock.js";
import { resolveImageMimeType } from "../shared/image-mime.js";
import {
  getSkillReadDedupStub,
  isSkillInstructionPath,
  recordFullSkillRead,
} from "./skill-read-dedup.js";
import { readWorkspaceFileNoFollow } from "./workspace-file-boundary.js";
import { decodeAndValidateImage } from "./image-decode-validation.js";

const isPathInsideRoot = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

export const requireAbsoluteFilePath = (rawPath: unknown): string => {
  const raw = String(rawPath ?? "");
  const expandedPath = expandHomePath(raw);
  if (!path.isAbsolute(expandedPath)) {
    throw new Error(
      `File tool paths must be absolute. Received relative path '${raw}'. ` +
        `Pass a full absolute path (e.g. /Users/you/projects/foo/bar.ts); ` +
        `the file tools do not resolve relative to the shell's working directory.`,
    );
  }
  return path.resolve(expandedPath);
};

export const resolveFilePath = (
  rawPath: unknown,
  context?: ToolContext,
): string => {
  const resolvedPath = requireAbsoluteFilePath(rawPath);
  const scopedRoot = context?.toolWorkspaceRoot?.trim()
    ? path.resolve(context.toolWorkspaceRoot)
    : null;

  if (scopedRoot && !isPathInsideRoot(resolvedPath, scopedRoot)) {
    throw new Error("Path is outside the shared session workspace.");
  }

  return resolvedPath;
};

export const readTextFile = async (
  rawPath: unknown,
  context?: ToolContext,
): Promise<{ path: string; content: string }> => {
  const filePath = resolveFilePath(rawPath, context);
  const pathBlock = isBlockedPath(filePath, context);
  if (pathBlock) {
    throw new Error(pathBlock);
  }

  const scopedRoot = context?.toolWorkspaceRoot?.trim();
  if (scopedRoot) {
    try {
      const read = await readWorkspaceFileNoFollow(
        filePath,
        scopedRoot,
        MAX_FILE_BYTES,
        context?.toolProcessIdentity
          ? { owner: context.toolProcessIdentity }
          : undefined,
      );
      return { path: read.path, content: read.bytes.toString("utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`File not found: ${filePath}`);
      }
      throw error;
    }
  }

  let metadata: Awaited<ReturnType<typeof fs.stat>>;
  try {
    metadata = await fs.stat(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  if (metadata.size > MAX_FILE_BYTES) {
    throw new Error(
      `File too large to read safely (${metadata.size} bytes): ${filePath}`,
    );
  }
  return { path: filePath, content: await fs.readFile(filePath, "utf8") };
};

export const writeTextFile = async (
  rawPath: unknown,
  content: string,
  context?: ToolContext,
): Promise<{ path: string; created: boolean }> => {
  const filePath = resolveFilePath(rawPath, context);
  const pathBlock = isBlockedPath(filePath, context);
  if (pathBlock) {
    throw new Error(pathBlock);
  }

  // The whole read-current-state → write cycle runs under the per-path lock
  // so parallel Write/Edit calls against the same file cannot interleave.
  return withFileWriteLock(filePath, async () => {
    let existed = false;
    let originalEnding: "\r\n" | "\n" = "\n";

    try {
      const rawContent = await fs.readFile(filePath, "utf-8");
      existed = true;
      const { text } = stripBom(rawContent);
      originalEnding = detectLineEnding(text);
    } catch {
      existed = false;
    }

    const normalizedContent = normalizeToLF(content);
    const finalContent = existed
      ? restoreLineEndings(normalizedContent, originalEnding)
      : content;

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileWithNulGuard(filePath, finalContent);

    return { path: filePath, created: !existed };
  });
};

export const replaceTextInFile = async (
  args: {
    filePath: unknown;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  },
  context?: ToolContext,
): Promise<{ path: string; replacements: number; noChange?: boolean }> => {
  const filePath = resolveFilePath(args.filePath, context);
  const replaceAll = Boolean(args.replaceAll ?? false);

  const pathBlock = isBlockedPath(filePath, context);
  if (pathBlock) {
    throw new Error(pathBlock);
  }

  // Read → apply → write must be atomic relative to sibling edits of the
  // same file: parallel tool calls otherwise clobber each other's hunks.
  return withFileWriteLock(filePath, async () => {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      throw new Error(`Error reading file: ${(error as Error).message}`);
    }

    const { bom, text: content } = stripBom(rawContent);
    const originalEnding = detectLineEnding(content);
    const normalizedContent = normalizeToLF(content);
    const normalizedOld = normalizeToLF(args.oldString);
    const normalizedNew = normalizeToLF(args.newString);

    if (!normalizedOld.trim()) {
      throw new Error(
        "old_string is empty or only whitespace; provide non-blank text to match.",
      );
    }

    const editAlreadyApplied =
      normalizedNew.length >= 8 &&
      normalizedContent.includes(normalizedNew) &&
      (normalizedOld === normalizedNew ||
        !normalizedContent.includes(normalizedOld));
    if (editAlreadyApplied) {
      return { path: filePath, replacements: 0, noChange: true };
    }

    const exactLocations: number[] = [];
    let exactCursor = 0;
    while (exactCursor <= normalizedContent.length - normalizedOld.length) {
      const index = normalizedContent.indexOf(normalizedOld, exactCursor);
      if (index === -1) break;
      exactLocations.push(index);
      exactCursor = index + Math.max(1, normalizedOld.length);
    }

    if (!replaceAll && exactLocations.length > 1) {
      const lineAt = (index: number) =>
        normalizedContent.slice(0, index).split("\n").length;
      const snippets = exactLocations.slice(0, 5).map((index) => {
        const lineNumber = lineAt(index);
        const line = normalizedContent.split("\n")[lineNumber - 1] ?? "";
        const snippet = line.trim().replace(/\s+/g, " ").slice(0, 100);
        return `L${lineNumber}: ${snippet}`;
      });
      throw new Error(
        `old_string matches ${exactLocations.length} locations. Add surrounding context or set replace_all=true.\nMatches:\n${snippets.join("\n")}${
          exactLocations.length > snippets.length
            ? `\n… and ${exactLocations.length - snippets.length} more.`
            : ""
        }`,
      );
    }

    if (replaceAll) {
      const occurrences = normalizedContent.split(normalizedOld).length - 1;
      if (occurrences === 0) {
        throw new Error("old_string not found in file.");
      }
      const replaced = normalizedContent
        .split(normalizedOld)
        .join(normalizedNew);
      const final = bom + restoreLineEndings(replaced, originalEnding);
      await writeFileWithNulGuard(filePath, final);
      return { path: filePath, replacements: occurrences };
    }

    const matchResult = fuzzyFindText(normalizedContent, normalizedOld);
    if (!matchResult.found) {
      const oldAnchor = normalizedOld
        .split("\n")
        .filter((line) => line.trim().length >= 4)
        .sort((left, right) => right.trim().length - left.trim().length)[0];
      const lines = normalizedContent.split("\n");
      const matchingLines = oldAnchor
        ? lines
            .map((line, index) => ({ line, index }))
            .filter(({ line }) => line.trim() === oldAnchor.trim())
        : [];
      const hintParts: string[] = [];
      if (matchingLines.length > 0) {
        hintParts.push(
          `Matching anchor location${matchingLines.length === 1 ? "" : "s"}:\n${matchingLines
            .slice(0, 5)
            .map(
              ({ line, index }) =>
                `L${index + 1}: ${line.trim().replace(/\s+/g, " ").slice(0, 100)}`,
            )
            .join("\n")}`,
        );
        const whitespaceMatch = matchingLines.find(
          ({ line }) => line !== oldAnchor,
        );
        if (whitespaceMatch) {
          const visualize = (line: string) => {
            const leading = line.match(/^[\t ]*/)?.[0] ?? "";
            return `${leading.replaceAll("\t", "→").replaceAll(" ", "·")}${line.slice(leading.length)}`;
          };
          hintParts.push(
            `Leading whitespace differs:\nfile has: ${visualize(whitespaceMatch.line)}\nyou sent: ${visualize(oldAnchor)}`,
          );
        }
      }
      hintParts.push(
        matchingLines.length > 0
          ? "Re-read around those lines and retry with unique surrounding context."
          : "Re-read the file and retry with current, unique text.",
      );
      throw new Error(
        `old_string not found in file.\n\n${hintParts.join("\n\n")}`,
      );
    }

    const baseContent = matchResult.contentForReplacement;
    const replaced =
      baseContent.substring(0, matchResult.index) +
      normalizedNew +
      baseContent.substring(matchResult.index + matchResult.matchLength);

    if (baseContent === replaced) {
      throw new Error(
        "old_string and new_string are identical — no changes made.",
      );
    }

    const final = bom + restoreLineEndings(replaced, originalEnding);
    await writeFileWithNulGuard(filePath, final);

    return { path: filePath, replacements: 1 };
  });
};

export const applyAnchoredEditToFile = async (
  args: {
    filePath: unknown;
    anchor: unknown;
    endAnchor?: unknown;
    newText: string;
    insertAfter?: boolean;
  },
  context?: ToolContext,
): Promise<{ path: string } & AnchoredEditResult> => {
  const filePath = resolveFilePath(args.filePath, context);
  const pathBlock = isBlockedPath(filePath, context);
  if (pathBlock) {
    throw new Error(pathBlock);
  }

  const anchor = parseAnchor(args.anchor);
  const endAnchor =
    args.endAnchor === undefined ||
    args.endAnchor === null ||
    args.endAnchor === ""
      ? undefined
      : parseAnchor(args.endAnchor);

  // Same atomicity contract as replaceTextInFile: anchors resolve against
  // the file as it exists inside the lock, so sibling edits that shifted
  // lines are absorbed by hash relocation instead of clobbered.
  return withFileWriteLock(filePath, async () => {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      throw new Error(`Error reading file: ${(error as Error).message}`);
    }

    const { bom, text } = stripBom(rawContent);
    const originalEnding = detectLineEnding(text);
    const normalizedContent = normalizeToLF(text);

    const applied = applyAnchoredEdit(normalizedContent, {
      anchor,
      newText: args.newText,
      ...(endAnchor ? { endAnchor } : {}),
      ...(args.insertAfter ? { insertAfter: true } : {}),
    });

    if (applied.content === normalizedContent) {
      return { path: filePath, ...applied };
    }

    const final = bom + restoreLineEndings(applied.content, originalEnding);
    await writeFileWithNulGuard(filePath, final);
    return { path: filePath, ...applied };
  });
};

export const handleRead = async (
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  try {
    const filePath = resolveFilePath(args.file_path, context);
    const pathBlock = isBlockedPath(filePath, context);
    if (pathBlock) {
      throw new Error(pathBlock);
    }
    const scopedRoot = context?.toolWorkspaceRoot?.trim();
    const opened = scopedRoot
      ? await readWorkspaceFileNoFollow(
          filePath,
          scopedRoot,
          MAX_FILE_BYTES,
          context?.toolProcessIdentity
            ? { owner: context.toolProcessIdentity }
            : undefined,
        )
      : await (async () => {
          const stat = await fs.stat(filePath);
          if (!stat.isFile()) {
            throw new Error(`Path is not a file: ${filePath}`);
          }
          if (stat.size > MAX_FILE_BYTES) {
            throw new Error(
              `File too large to read safely (${stat.size} bytes): ${filePath}`,
            );
          }
          return {
            path: filePath,
            bytes: await fs.readFile(filePath),
            stat,
          };
        })();
    const stat = opened.stat;
    const header = opened.bytes.subarray(0, 12);
    const imageMimeType = resolveImageMimeType(opened.path, header);
    if (imageMimeType) {
      if (context?.toolProcessIdentity) {
        // The generic marker is reopened later by the root agent adapter. A
        // concurrently running tool-UID shell could swap that pathname after
        // this authorized read, so carry the bytes already read from the
        // checked descriptor directly to the native MCP response instead.
        const decoded = await decodeAndValidateImage(opened.bytes);
        if (!decoded || decoded.mimeType !== imageMimeType) {
          return {
            result: `Image file could not be decoded safely: ${opened.path}`,
            details: { path: opened.path, mimeType: imageMimeType },
          };
        }
        return {
          result: `Image file: ${opened.path} (${decoded.width}x${decoded.height})`,
          details: {
            path: opened.path,
            mimeType: decoded.mimeType,
            width: decoded.width,
            height: decoded.height,
          },
          [TOOL_RESULT_AUTHORIZED_IMAGES]: [
            {
              data: opened.bytes,
              mimeType: decoded.mimeType,
              sourcePath: opened.path,
            },
          ],
        };
      }
      return {
        result: `[stella-attach-image] inline=${imageMimeType} ${opened.path}`,
        details: { path: opened.path, mimeType: imageMimeType },
      };
    }

    const skillSignature = `${stat.mtimeMs}:${stat.size}`;
    const skillDedupStub = getSkillReadDedupStub({
      filePath,
      signature: skillSignature,
      ...(context ? { context } : {}),
    });
    if (skillDedupStub) {
      return {
        result: skillDedupStub,
        details: { path: filePath, unchanged: true, dedup: true },
      };
    }

    const textFilePath = opened.path;
    const content = opened.bytes.toString("utf8");
    const offset = Number(args.offset ?? 1);
    const limit = Number(args.limit ?? 2000);
    // Hashes come from the raw LF-normalized lines (what Edit verifies
    // against at apply time); the displayed text stays sanitized.
    const rawLines = normalizeToLF(content).split("\n");
    const displayLines = normalizeToLF(
      sanitizeToolVisibleText(content, { codeFile: true }),
    ).split("\n");
    const formatted = formatWithHashLines(
      rawLines,
      displayLines,
      offset,
      limit,
    );
    const totalLines = content.split("\n").length;
    const startLine = Math.max(1, Number.isFinite(offset) ? offset : 1);
    const safeLimit = Math.max(0, Number.isFinite(limit) ? limit : 2000);
    const servedEveryLine =
      startLine === 1 &&
      safeLimit >= totalLines &&
      !content.split("\n").some((line) => line.length > 2000);
    if (isSkillInstructionPath(textFilePath) && servedEveryLine) {
      recordFullSkillRead({
        filePath: textFilePath,
        signature: skillSignature,
        ...(context ? { context } : {}),
      });
    }
    return {
      result: `File: ${textFilePath}\n${formatted.header}\n\n${formatted.body}`,
    };
  } catch (error) {
    return { error: `Error reading file: ${(error as Error).message}` };
  }
};

export const handleWrite = async (
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  const content = String(args.content ?? "");

  try {
    const { path: filePath, created } = await writeTextFile(
      args.file_path,
      content,
      context,
    );
    return {
      result: created ? `Created ${filePath}` : `Wrote ${filePath}`,
    };
  } catch (error) {
    return { error: `Error writing file: ${(error as Error).message}` };
  }
};

export const handleEdit = async (
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  try {
    const hasAnchor =
      args.anchor !== undefined && args.anchor !== null && args.anchor !== "";
    if (hasAnchor) {
      const { path: filePath, ...applied } = await applyAnchoredEditToFile(
        {
          filePath: args.file_path,
          anchor: args.anchor,
          endAnchor: args.end_anchor,
          newText: String(args.new_string ?? ""),
          insertAfter: Boolean(args.insert_after ?? false),
        },
        context,
      );
      const range =
        applied.startLine === applied.endLine
          ? `line ${applied.startLine}`
          : `lines ${applied.startLine}-${applied.endLine}`;
      const action = applied.linesRemoved === 0 ? "Inserted after" : "Replaced";
      return {
        result: `${action} ${range} in ${filePath} (-${applied.linesRemoved}/+${applied.linesAdded} lines)`,
      };
    }

    const {
      path: filePath,
      replacements,
      noChange,
    } = await replaceTextInFile(
      {
        filePath: args.file_path,
        oldString: String(args.old_string ?? ""),
        newString: String(args.new_string ?? ""),
        replaceAll: Boolean(args.replace_all ?? false),
      },
      context,
    );
    if (noChange) {
      return {
        result: `Edit already applied to ${filePath}; no write was needed.`,
      };
    }
    return {
      result: `Replaced ${replacements} occurrence(s) in ${filePath}`,
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
};
