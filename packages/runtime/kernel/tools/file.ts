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
import {
  applyEditsToContent,
  applyStringReplacement,
  parseEditSpecs,
  prepareEditArguments,
} from "./edit-text.js";

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
    const applied = applyStringReplacement(
      normalizeToLF(content),
      args.oldString,
      args.newString,
      replaceAll,
    );
    if (applied.noChange) {
      return { path: filePath, replacements: 0, noChange: true };
    }

    const final = bom + restoreLineEndings(applied.content, originalEnding);
    await writeFileWithNulGuard(filePath, final);

    return { path: filePath, replacements: applied.replacements };
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

/**
 * Multi-edit form: every entry matches the ORIGINAL file inside one write
 * lock, overlaps are rejected, and the file is written once or not at all.
 */
export const applyEditsToFile = async (
  args: { filePath: unknown; edits: unknown },
  context?: ToolContext,
): Promise<{ path: string; edits: number; lines: number[] }> => {
  const filePath = resolveFilePath(args.filePath, context);
  const pathBlock = isBlockedPath(filePath, context);
  if (pathBlock) {
    throw new Error(pathBlock);
  }
  const specs = parseEditSpecs(args.edits);

  return withFileWriteLock(filePath, async () => {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      throw new Error(`Error reading file: ${(error as Error).message}`);
    }

    const { bom, text } = stripBom(rawContent);
    const originalEnding = detectLineEnding(text);
    const applied = applyEditsToContent(normalizeToLF(text), specs);
    const final = bom + restoreLineEndings(applied.content, originalEnding);
    await writeFileWithNulGuard(filePath, final);
    return { path: filePath, edits: specs.length, lines: applied.lines };
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
    const prepared = prepareEditArguments(args);
    if (prepared.edits !== undefined) {
      if (prepared.replace_all === true) {
        throw new Error(
          "replace_all is not supported with edits[]; make a single old_string call with replace_all=true instead.",
        );
      }
      const applied = await applyEditsToFile(
        { filePath: prepared.file_path, edits: prepared.edits },
        context,
      );
      return {
        result: `Applied ${applied.edits} edit(s) to ${applied.path} (at line${applied.lines.length === 1 ? "" : "s"} ${applied.lines.join(", ")})`,
      };
    }

    if (args.new_string === undefined || args.new_string === null) {
      throw new Error(
        'new_string is required (use "" to delete), or pass edits[] for several replacements.',
      );
    }
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
